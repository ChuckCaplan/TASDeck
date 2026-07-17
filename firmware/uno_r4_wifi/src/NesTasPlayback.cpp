#include "NesTasPlayback.h"

namespace tasdeck {

namespace {

// Keeps the compiler from reordering buffer stores past the ring-index commit
// that publishes them to the consumer ISR.
inline void compilerBarrier() {
  __asm__ __volatile__("" ::: "memory");
}

}  // namespace

TasPlaybackResult NesTasPlayback::begin(uint32_t frameCount, TasSyncMode syncMode, uint32_t latchWindowMicros) {
  return begin(frameCount, syncMode, 1, latchWindowMicros);
}

TasPlaybackResult NesTasPlayback::begin(uint32_t frameCount, TasSyncMode syncMode, uint8_t portCount, uint32_t latchWindowMicros) {
  reset();

  if (
    frameCount == 0 ||
    portCount == 0 ||
    portCount > kNesControllerPortCount ||
    (syncMode != TasSyncMode::Poll && syncMode != TasSyncMode::Latch && syncMode != TasSyncMode::Strobe) ||
    latchWindowMicros < kTasMinLatchWindowMicros ||
    latchWindowMicros > kTasMaxLatchWindowMicros) {
    setError(TasPlaybackResult::Invalid);
    return error_;
  }

  totalFrames_ = frameCount;
  portCount_ = portCount;
  syncMode_ = syncMode;
  latchWindowMicros_ = latchWindowMicros;
  return TasPlaybackResult::Ok;
}

TasPlaybackResult NesTasPlayback::pushChunk(uint32_t startIndex, const uint8_t* masks, uint8_t count) {
  if (masks == nullptr || count > kTasChunkFrameLimit) {
    return TasPlaybackResult::Invalid;
  }

  TasFrameMasks frameMasks[kTasChunkFrameLimit] = {};
  for (uint8_t index = 0; index < count; ++index) {
    frameMasks[index].port1 = masks[index];
  }

  return pushChunk(startIndex, frameMasks, count, 1);
}

TasPlaybackResult NesTasPlayback::pushChunk(uint32_t startIndex, const TasFrameMasks* masks, uint8_t count) {
  return pushChunk(startIndex, masks, count, portCount_);
}

TasPlaybackResult NesTasPlayback::pushChunk(
  uint32_t startIndex,
  const TasFrameMasks* masks,
  uint8_t count,
  uint8_t portCount) {
  if (!active() || masks == nullptr || count == 0 || count > kTasChunkFrameLimit) {
    return TasPlaybackResult::Invalid;
  }

  if (portCount != portCount_) {
    return TasPlaybackResult::Invalid;
  }

  if (startIndex != totalReceived_ || startIndex + count > totalFrames_) {
    setError(TasPlaybackResult::OutOfOrder);
    return error_;
  }

  const uint16_t tail = tail_;
  const uint16_t buffered = static_cast<uint16_t>(tail - head_);
  if (count > kTasBufferCapacity - buffered) {
    setError(TasPlaybackResult::Overflow);
    return error_;
  }

  for (uint8_t index = 0; index < count; ++index) {
    TasFrameMasks frame = masks[index];
    if (portCount_ < kNesControllerPortCount) {
      frame.port2 = 0;
    }
    buffer_[static_cast<uint16_t>(tail + index) % kTasBufferCapacity] = frame;
  }

  compilerBarrier();
  tail_ = static_cast<uint16_t>(tail + count);
  totalReceived_ += count;
  if (!startRequested_ && !started_) {
    // Pre-start fill: keep the staged mask pointing at frame 0. After start,
    // every advance re-stages from the consumer side.
    stageNextMask();
  }
  return TasPlaybackResult::Ok;
}

TasPlaybackResult NesTasPlayback::start(uint32_t startDelayFrames) {
  if (!active()) {
    return TasPlaybackResult::Inactive;
  }

  if (!readyToStart()) {
    return TasPlaybackResult::Waiting;
  }

  startRequested_ = true;
  startDelayRemaining_ = startDelayFrames;
  return TasPlaybackResult::Ok;
}

TasPlaybackResult NesTasPlayback::finishReceiving() {
  if (!active()) {
    return TasPlaybackResult::Inactive;
  }

  if (totalReceived_ != totalFrames_) {
    setError(TasPlaybackResult::Incomplete);
    return error_;
  }

  receivingComplete_ = true;
  return TasPlaybackResult::Ok;
}

TasPlaybackResult NesTasPlayback::onLatchEdge(uint32_t nowMicros, uint8_t& nextMask) {
  TasFrameMasks nextMasks = {};
  const TasPlaybackResult result = onLatchEdge(nowMicros, nextMasks);
  nextMask = nextMasks.port1;
  return result;
}

TasPlaybackResult NesTasPlayback::onLatchEdge(uint32_t nowMicros, TasFrameMasks& nextMasks) {
  nextMasks = currentMasks_;

  if (!active()) {
    lastEdgeKind_ = TasEdgeKind::Ended;
    return TasPlaybackResult::Inactive;
  }

  if (syncMode_ == TasSyncMode::Strobe) {
    // Per-strobe playback intentionally has no window or completed-read
    // accounting. Every accepted latch is a playback event, even when two
    // edges share a timestamp or the preceding read was bare or torn. In the
    // steady state the expiry service pre-pops the next record mid-gap, so
    // this edge path is a cheap commit; the in-ISR advance below is the
    // fallback for edges that arrive before the service could run (boot
    // bursts, double-latch games, a starved loop).
    if (tryCommitPreAdvancedEdge(nowMicros, nextMasks)) {
      return lastWindowResult_;
    }

    hasLatched_ = true;
    lastLatchMicros_ = nowMicros;

    TasPlaybackResult result = TasPlaybackResult::Waiting;
    if (!started_) {
      if (!startRequested_ || !readyToStart()) {
        lastEdgeKind_ = TasEdgeKind::NotStartedWait;
        return result;
      }

      if (startDelayRemaining_ > 0) {
        startDelayRemaining_ -= 1;
        lastEdgeKind_ = TasEdgeKind::DelayWait;
        return result;
      }

      started_ = true;
      currentFrame_ = 0;
      currentMasks_ = popFrame();
      stageNextMask();
      nextMasks = currentMasks_;
      result = TasPlaybackResult::Ok;
      lastEdgeKind_ = TasEdgeKind::Started;
    } else {
      result = advanceFrame(nextMasks);
      lastEdgeKind_ = result == TasPlaybackResult::Ok
        ? TasEdgeKind::AdvancedAtEdge
        : TasEdgeKind::Ended;
    }

    lastWindowResult_ = result;
    return result;
  }

  // Signed comparison: the subtraction stays correct across micros()
  // wraparound, and a backwards time step — micros() read from a priority-0
  // ISR can transiently report +1 ms when it races the 1 kHz tick — becomes a
  // negative gap inside the current window instead of wrapping to a huge
  // unsigned one that opens a phantom window mid-poll-cluster and
  // double-advances the movie.
  const bool newWindow = !hasLatched_ ||
    static_cast<int32_t>(nowMicros - lastLatchMicros_) >=
      static_cast<int32_t>(latchWindowMicros_);
  hasLatched_ = true;
  lastLatchMicros_ = nowMicros;

  if (!newWindow) {
    lastEdgeKind_ = TasEdgeKind::SameWindow;
    return TasPlaybackResult::Waiting;
  }

  if (preAdvanced_) {
    // onWindowExpired already consumed this window's poll credit and loaded
    // the mask this strobe should serve, so the data line was valid before
    // the strobe arrived. Just hand the mask back.
    preAdvanced_ = false;
    pollCompletedInWindow_ = false;
    nextMasks = currentMasks_;
    lastEdgeKind_ = TasEdgeKind::PreAdvanced;
    lastWindowResult_ = TasPlaybackResult::Ok;
    return lastWindowResult_;
  }

  const bool previousWindowPolled = pollCompletedInWindow_;
  pollCompletedInWindow_ = false;

  TasPlaybackResult result = TasPlaybackResult::Waiting;
  if (!started_) {
    if (!startRequested_ || !readyToStart()) {
      result = TasPlaybackResult::Waiting;
      lastEdgeKind_ = TasEdgeKind::NotStartedWait;
    } else if (startDelayRemaining_ > 0) {
      if (syncMode_ == TasSyncMode::Latch || previousWindowPolled) {
        startDelayRemaining_ -= 1;
      }
      result = TasPlaybackResult::Waiting;
      lastEdgeKind_ = TasEdgeKind::DelayWait;
    } else {
      started_ = true;
      currentFrame_ = 0;
      currentMasks_ = popFrame();
      stageNextMask();
      nextMasks = currentMasks_;
      result = TasPlaybackResult::Ok;
      lastEdgeKind_ = TasEdgeKind::Started;
    }
  } else if (!previousWindowPolled) {
    // The last window never completed an 8-clock read: boot-time bare strobes,
    // latch-line noise, or a fully torn read. The exporter emits no mask for a
    // frame without a completed poll, so keep serving the current mask.
    result = TasPlaybackResult::Waiting;
    lastEdgeKind_ = TasEdgeKind::ReadlessHold;
  } else {
    result = advanceFrame(nextMasks);
    lastEdgeKind_ = result == TasPlaybackResult::Ok
      ? TasEdgeKind::AdvancedAtEdge
      : TasEdgeKind::Ended;
  }

  lastWindowResult_ = result;
  return result;
}

bool NesTasPlayback::windowExpiryDue(uint32_t nowMicros) const {
  if (!active() || preAdvanced_) {
    return false;
  }

  // Signed for the same reason as onLatchEdge's newWindow check: a stored
  // glitched-high latch time must read as "window still open", or the expiry
  // service pre-advances mid-poll-cluster. In strobe mode the window value is
  // not a coalescing window — every edge is its own event — but it still
  // serves as the post-edge holdoff before the next record is pre-popped.
  if (hasLatched_ &&
      static_cast<int32_t>(nowMicros - lastLatchMicros_) <
        static_cast<int32_t>(latchWindowMicros_)) {
    return false;
  }

  if (!started_) {
    return startRequested_ && readyToStart() && startDelayRemaining_ == 0;
  }

  if (syncMode_ == TasSyncMode::Strobe) {
    // Every accepted edge consumes a record, so no completed-read credit is
    // required before staging the next one for the edge to commit.
    return true;
  }

  return pollCompletedInWindow_;
}

TasPlaybackResult NesTasPlayback::onWindowExpired(uint32_t nowMicros, uint8_t& nextMask) {
  TasFrameMasks nextMasks = {};
  const TasPlaybackResult result = onWindowExpired(nowMicros, nextMasks);
  nextMask = nextMasks.port1;
  return result;
}

TasPlaybackResult NesTasPlayback::onWindowExpired(uint32_t nowMicros, TasFrameMasks& nextMasks) {
  nextMasks = currentMasks_;

  if (!windowExpiryDue(nowMicros)) {
    return TasPlaybackResult::Waiting;
  }

  TasPlaybackResult result = TasPlaybackResult::Waiting;
  if (!started_) {
    // Release frame 0 ahead of the first strobe of the next window (or ahead
    // of the console's very first strobe when armed before power-on).
    started_ = true;
    currentFrame_ = 0;
    currentMasks_ = popFrame();
    stageNextMask();
    nextMasks = currentMasks_;
    result = TasPlaybackResult::Ok;
  } else {
    pollCompletedInWindow_ = false;
    result = advanceFrame(nextMasks);
  }

  lastWindowResult_ = result;
  if (result == TasPlaybackResult::Ok) {
    // Complete and Underrun end playback here; only a served frame leaves a
    // pending window for the next strobe to consume.
    preAdvanced_ = true;
  }
  return result;
}

TasPlaybackResult NesTasPlayback::advanceFrame(TasFrameMasks& nextMasks) {
  if (currentFrame_ + 1 >= totalFrames_) {
    complete_ = true;
    currentFrame_ = totalFrames_;
    currentMasks_ = TasFrameMasks{};
    stagedNextMask1_ = 0;
    stagedNextMask2_ = 0;
    nextMasks = currentMasks_;
    return TasPlaybackResult::Complete;
  }

  if (bufferedFrames() == 0) {
    currentMasks_ = TasFrameMasks{};
    stagedNextMask1_ = 0;
    stagedNextMask2_ = 0;
    nextMasks = currentMasks_;
    setError(TasPlaybackResult::Underrun);
    return error_;
  }

  currentFrame_ += 1;
  currentMasks_ = popFrame();
  stageNextMask();
  nextMasks = currentMasks_;
  return TasPlaybackResult::Ok;
}

void NesTasPlayback::stageNextMask() {
  // Peek the mask the next advance will pop. Runs on the consumer side (latch
  // ISR or interrupt-masked window service) right after head_ moves, and from
  // pushChunk only before playback is requested.
  if (started_ && currentFrame_ + 1 >= totalFrames_) {
    stagedNextMask1_ = 0;
    stagedNextMask2_ = 0;
    return;
  }

  const uint16_t head = head_;
  if (static_cast<uint16_t>(tail_ - head) == 0) {
    stagedNextMask1_ = 0;
    stagedNextMask2_ = 0;
    return;
  }

  const TasFrameMasks masks = buffer_[head % kTasBufferCapacity];
  stagedNextMask1_ = masks.port1;
  stagedNextMask2_ = portCount_ >= kNesControllerPortCount ? masks.port2 : 0;
}

void NesTasPlayback::notePollCompleted(uint8_t controllerPort) {
  if (syncMode_ == TasSyncMode::Strobe || controllerPort == 0 || controllerPort > portCount_) {
    return;
  }

  pollCompletedInWindow_ = true;
}

void NesTasPlayback::noteLatchObserved() {
  if (syncMode_ == TasSyncMode::Latch) {
    pollCompletedInWindow_ = true;
  }
}

bool NesTasPlayback::willAdvanceOnEdge() const {
  // Flag-only mirror of the onLatchEdge decision for a window-opening strobe:
  // a pre-advanced window already has its mask on the wire, a read-less window
  // holds the current mask, and a ready start or started, polled window serves
  // the staged mask. Reads one byte-sized field at a time so it is safe from
  // the latch ISR.
  if (!active() || preAdvanced_) {
    return false;
  }

  if (syncMode_ == TasSyncMode::Strobe) {
    return started_ || (startRequested_ && readyToStart() && startDelayRemaining_ == 0);
  }

  if (!started_) {
    return startRequested_ && readyToStart() && startDelayRemaining_ == 0;
  }

  return pollCompletedInWindow_;
}

uint8_t NesTasPlayback::stagedNextMask() const {
  return stagedNextMask1_;
}

TasFrameMasks NesTasPlayback::stagedNextMasks() const {
  TasFrameMasks masks = {};
  masks.port1 = stagedNextMask1_;
  masks.port2 = stagedNextMask2_;
  return masks;
}

void NesTasPlayback::reset() {
  head_ = 0;
  tail_ = 0;
  totalFrames_ = 0;
  totalReceived_ = 0;
  currentFrame_ = 0;
  currentMasks_ = TasFrameMasks{};
  stagedNextMask1_ = 0;
  stagedNextMask2_ = 0;
  portCount_ = 1;
  latchWindowMicros_ = kTasDefaultLatchWindowMicros;
  lastLatchMicros_ = 0;
  startDelayRemaining_ = 0;
  syncMode_ = TasSyncMode::Unknown;
  error_ = TasPlaybackResult::Ok;
  lastWindowResult_ = TasPlaybackResult::Waiting;
  startRequested_ = false;
  started_ = false;
  receivingComplete_ = false;
  complete_ = false;
  hasLatched_ = false;
  pollCompletedInWindow_ = false;
  preAdvanced_ = false;
  lastEdgeKind_ = TasEdgeKind::SameWindow;
}

bool NesTasPlayback::active() const {
  return totalFrames_ > 0 && !complete_ && error_ == TasPlaybackResult::Ok;
}

bool NesTasPlayback::ready() const {
  return active() && readyToStart();
}

bool NesTasPlayback::startRequested() const {
  return startRequested_;
}

bool NesTasPlayback::started() const {
  return started_;
}

bool NesTasPlayback::complete() const {
  return complete_;
}

TasEdgeKind NesTasPlayback::lastEdgeKind() const {
  return lastEdgeKind_;
}

bool NesTasPlayback::receivingComplete() const {
  return receivingComplete_;
}

bool NesTasPlayback::hasError() const {
  return error_ != TasPlaybackResult::Ok;
}

TasPlaybackResult NesTasPlayback::error() const {
  return error_;
}

TasPlaybackResult NesTasPlayback::lastWindowResult() const {
  return lastWindowResult_;
}

uint32_t NesTasPlayback::totalFrames() const {
  return totalFrames_;
}

uint32_t NesTasPlayback::totalReceived() const {
  return totalReceived_;
}

uint32_t NesTasPlayback::startDelayRemaining() const {
  return startDelayRemaining_;
}

uint32_t NesTasPlayback::latchWindowMicros() const {
  return latchWindowMicros_;
}

uint16_t NesTasPlayback::bufferedFrames() const {
  return static_cast<uint16_t>(tail_ - head_);
}

uint16_t NesTasPlayback::capacity() const {
  return kTasBufferCapacity;
}

uint8_t NesTasPlayback::currentMask() const {
  return currentMasks_.port1;
}

TasFrameMasks NesTasPlayback::currentMasks() const {
  return currentMasks_;
}

bool NesTasPlayback::readyToStart() const {
  const uint16_t buffered = bufferedFrames();
  if (buffered == 0) {
    return false;
  }

  if (totalFrames_ <= kTasStartBufferedFrames) {
    return receivingComplete_ || totalReceived_ == totalFrames_;
  }

  return buffered >= kTasStartBufferedFrames;
}

TasFrameMasks NesTasPlayback::popFrame() {
  const uint16_t head = head_;
  if (static_cast<uint16_t>(tail_ - head) == 0) {
    return TasFrameMasks{};
  }

  TasFrameMasks masks = buffer_[head % kTasBufferCapacity];
  if (portCount_ < kNesControllerPortCount) {
    masks.port2 = 0;
  }
  head_ = static_cast<uint16_t>(head + 1);
  return masks;
}

void NesTasPlayback::setError(TasPlaybackResult result) {
  error_ = result;
  currentMasks_ = TasFrameMasks{};
}

const char* tasPlaybackResultName(TasPlaybackResult result) {
  switch (result) {
    case TasPlaybackResult::Ok:
      return "ok";
    case TasPlaybackResult::Waiting:
      return "waiting";
    case TasPlaybackResult::Complete:
      return "complete";
    case TasPlaybackResult::Invalid:
      return "invalid";
    case TasPlaybackResult::Inactive:
      return "inactive";
    case TasPlaybackResult::OutOfOrder:
      return "out_of_order";
    case TasPlaybackResult::Overflow:
      return "overflow";
    case TasPlaybackResult::Underrun:
      return "underrun";
    case TasPlaybackResult::Incomplete:
      return "incomplete";
    default:
      return "unknown";
  }
}

}  // namespace tasdeck
