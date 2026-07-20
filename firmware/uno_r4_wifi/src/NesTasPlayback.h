#ifndef TASDECK_NES_TAS_PLAYBACK_H
#define TASDECK_NES_TAS_PLAYBACK_H

#include <stdint.h>

#include "NesDeckProtocol.h"

namespace tasdeck {

constexpr uint16_t kTasBufferCapacity = 512;
constexpr uint16_t kTasStartBufferedFrames = 120;

enum class TasPlaybackResult {
  Ok,
  Waiting,
  Complete,
  Invalid,
  Inactive,
  OutOfOrder,
  Overflow,
  Underrun,
  Incomplete,
};

// Which path the most recent onLatchEdge call took. Recorded into trace rows
// so a hardware capture shows whether a window was served by the loop-side
// pre-advance (PreAdvanced), the in-ISR fallback (AdvancedAtEdge), or held
// because the previous window had no completed read (ReadlessHold).
enum class TasEdgeKind : uint8_t {
  SameWindow = 0,
  PreAdvanced = 1,
  AdvancedAtEdge = 2,
  ReadlessHold = 3,
  Started = 4,
  NotStartedWait = 5,
  DelayWait = 6,
  Ended = 7,
};

// Latch-window playback: one mask per console frame that polls the controller.
// Games such as SMB3 and Tetris strobe and read the controller several times
// per frame (and a variable number of times on real hardware, because DPCM DMA
// can corrupt a read and trigger game-side re-reads). Counting completed
// 8-clock polls therefore drifts against the emulator's poll sequence. Instead,
// latch edges closer together than the latch window are treated as the same
// console frame and keep serving the current mask; a latch edge after a wider
// gap starts the next frame.
//
// Advancing additionally requires the previous window to contain at least one
// completed 8-clock read (reported via notePollCompleted). Games fire bare
// strobes with no reads during boot (SMB3 strobes several times before its
// first real read), and the exporter emits no mask for a frame that never
// completes a read, so read-less windows must not consume masks either.
//
// The next mask must already be on the wire before the strobe arrives: the
// console samples bit 0 (A) only a few microseconds after the strobe edge,
// sooner than a latch-ISR advance can update the data line. onWindowExpired
// therefore pre-advances from the main loop once the window closes (mid-gap,
// several milliseconds before the next strobe), and onLatchEdge just serves
// the pre-advanced mask. The in-ISR advance remains as a fallback for the
// rare case where the main loop is starved past the next strobe.
class NesTasPlayback {
 public:
  TasPlaybackResult begin(uint32_t frameCount, TasSyncMode syncMode, uint32_t latchWindowMicros);
  TasPlaybackResult begin(uint32_t frameCount, TasSyncMode syncMode, uint8_t portCount, uint32_t latchWindowMicros);
  TasPlaybackResult pushChunk(uint32_t startIndex, const uint8_t* masks, uint8_t count);
  TasPlaybackResult pushChunk(uint32_t startIndex, const TasFrameMasks* masks, uint8_t count);
  TasPlaybackResult pushChunk(uint32_t startIndex, const TasFrameMasks* masks, uint8_t count, uint8_t portCount);
  TasPlaybackResult start(uint32_t startDelayFrames);
  TasPlaybackResult finishReceiving();
  TasPlaybackResult onLatchEdge(uint32_t nowMicros, uint8_t& nextMask);
  TasPlaybackResult onLatchEdge(uint32_t nowMicros, TasFrameMasks& nextMasks);
  TasPlaybackResult onWindowExpired(uint32_t nowMicros, uint8_t& nextMask);
  TasPlaybackResult onWindowExpired(uint32_t nowMicros, TasFrameMasks& nextMasks);
  bool windowExpiryDue(uint32_t nowMicros) const;
  void notePollCompleted(uint8_t controllerPort = 1);
  void noteLatchObserved();
  void reset();

  // Fast-path helpers for the latch ISR's first data-line write. When a strobe
  // opens a new window that the loop-side pre-advance missed, the ISR must put
  // the *next* frame's bit 0 on the wire within a few microseconds — before
  // popFrame and the window bookkeeping have run. stagedNextMask() is kept
  // pointing at the mask an advance would serve, and willAdvanceOnEdge() is a
  // flag-only replica of the onLatchEdge advance decision.
  bool willAdvanceOnEdge() const;
  uint8_t stagedNextMask() const;
  TasFrameMasks stagedNextMasks() const;

  // Header-inline for the clock ISR (no LTO). The record the next accepted
  // strobe will commit while a pre-advance is armed. After the 8th shift the
  // clock ISR drives this record's bit 0 onto the data line so the next strobe's
  // first read finds the correct level ALREADY on the wire: TASDeck's latch ISR
  // dispatches microseconds after the strobe edge — slower than the console's
  // first post-strobe read on slow-reading games (Archon reads bit 0 ~5.6 µs
  // after the strobe) — so bit 0 must be pre-positioned during the inter-strobe
  // gap, not written reactively in the latch ISR. In the tail-prefetch model
  // (Rev 8) the armed record lives in currentMasks_, one ahead of what the
  // current train is clocking out (controllerPressedMask). willAdvanceOnEdge()
  // is false whenever preAdvanced_ is set, so the ISR must consult this instead.
  bool preAdvanced() const { return preAdvanced_; }
  TasFrameMasks preAdvancedMasks() const {
    return preAdvanced_ ? currentMasks_ : TasFrameMasks{};
  }

  // Latch-ISR fast path for the strobe-mode steady state: commit the record
  // the expiry service pre-popped, with no out-of-line calls. Defined in the
  // header because this build has no LTO and the commit runs inside the latch
  // ISR's PRIMASK critical head — Golf's title screen fires back-to-back
  // $4016 reads ~5.6 and ~7.8 µs after the edge (2.2 µs apart), and the head
  // must release before the second read so the pended clock edges dispatch
  // individually instead of merging in the clock IRQ's single NVIC pending
  // bit (one lost shift, every later bit read one position early — measured
  // 2026-07-15: Golf's Start check landed on the served Select bit and the
  // game never started). The mask commit and the latch-timestamp note are
  // split so micros() stays out of the critical head: the timestamp gates
  // only the expiry-service holdoff, which runs at timer priority and can
  // never preempt the latch ISR, so noting it after the head is safe.
  // Returns false when nothing is pre-advanced (or the run errored); the
  // caller then takes the general onLatchEdge path.
  bool tryCommitPreAdvancedMasks(TasFrameMasks& nextMasks) {
    if (!preAdvanced_ || error_ != TasPlaybackResult::Ok) {
      return false;
    }
    preAdvanced_ = false;
    pollCompletedInWindow_ = false;
    nextMasks = currentMasks_;
    lastEdgeKind_ = TasEdgeKind::PreAdvanced;
    lastWindowResult_ = TasPlaybackResult::Ok;
    return true;
  }

  void noteLatchTimestamp(uint32_t nowMicros) {
    hasLatched_ = true;
    lastLatchMicros_ = nowMicros;
  }

  bool tryCommitPreAdvancedEdge(uint32_t nowMicros, TasFrameMasks& nextMasks) {
    if (!tryCommitPreAdvancedMasks(nextMasks)) {
      return false;
    }
    noteLatchTimestamp(nowMicros);
    return true;
  }

  // Rev 8 (v51): pop the record the *next* accepted strobe edge will serve and
  // arm preAdvanced_, so that next edge takes the fast commit path. Called from
  // the latch ISR's preemptible tail right after the current edge committed —
  // replacing the mid-gap expiry-service pre-advance, which could not re-arm
  // between the sub-8 ms burst latches of poll-wait games (Archon). Advances
  // only the internal record pointer and staged masks: it must NOT be given the
  // live serving mask and must not be reflected onto the data pins, because the
  // current frame's read train has not happened yet when this runs. The caller
  // masks interrupts across this call (the ring is single-consumer in
  // latch-edge context, and serviceLatchPendBeforeClock can nest a latch over
  // this tail from a clock ISR).
  //
  // Arms only when the next record is cleanly available. It deliberately never
  // ends the run: the final served record (currentFrame_+1 == totalFrames_) and
  // a not-yet-buffered record both leave preAdvanced_ clear, so the next
  // accepted edge takes the general path and resolves Complete/Underrun there —
  // exactly one record per edge, and never before the last record has been
  // read out. Returns Ok when it armed, Waiting otherwise.
  TasPlaybackResult prefetchNextRecord(TasFrameMasks& nextMasks) {
    nextMasks = currentMasks_;
    if (!active() || !started_ || preAdvanced_ || error_ != TasPlaybackResult::Ok) {
      return TasPlaybackResult::Waiting;
    }
    if (currentFrame_ + 1 >= totalFrames_ || bufferedFrames() == 0) {
      return TasPlaybackResult::Waiting;
    }
    pollCompletedInWindow_ = false;
    const TasPlaybackResult result = advanceFrame(nextMasks);
    lastWindowResult_ = result;
    if (result == TasPlaybackResult::Ok) {
      preAdvanced_ = true;
    }
    return result;
  }

  bool active() const;
  bool ready() const;
  bool startRequested() const;
  bool started() const;
  bool complete() const;
  TasEdgeKind lastEdgeKind() const;
  bool receivingComplete() const;
  bool hasError() const;
  TasPlaybackResult error() const;
  TasPlaybackResult lastWindowResult() const;
  // Header-inline: read from the latch ISR's strobe fast path (no LTO).
  uint32_t currentFrame() const { return currentFrame_; }
  uint32_t totalFrames() const;
  uint32_t totalReceived() const;
  uint32_t startDelayRemaining() const;
  uint32_t latchWindowMicros() const;
  uint16_t bufferedFrames() const;
  uint16_t capacity() const;
  uint8_t currentMask() const;
  TasFrameMasks currentMasks() const;
  // Header-inline: read from the NES pin ISRs on every edge (no LTO).
  uint8_t portCount() const { return portCount_; }
  TasSyncMode syncMode() const { return syncMode_; }

 private:
  bool readyToStart() const;
  TasFrameMasks popFrame();
  void setError(TasPlaybackResult result);
  TasPlaybackResult advanceFrame(TasFrameMasks& nextMasks);
  void stageNextMask();

  // Single-producer (pushChunk from the main loop) / single-consumer (popFrame
  // from the latch ISR or the interrupt-masked window-expiry service) ring.
  // head_ and tail_ are free-running uint16 indices, so neither side performs
  // a read-modify-write on a field the other side writes and chunk pushes need
  // no interrupt masking. kTasBufferCapacity must divide 65536 for the
  // wraparound arithmetic to stay exact.
  TasFrameMasks buffer_[kTasBufferCapacity] = {};
  volatile uint16_t head_ = 0;
  volatile uint16_t tail_ = 0;
  uint32_t totalFrames_ = 0;
  uint32_t totalReceived_ = 0;
  uint32_t currentFrame_ = 0;
  uint32_t latchWindowMicros_ = kTasDefaultLatchWindowMicros;
  uint32_t lastLatchMicros_ = 0;
  uint32_t startDelayRemaining_ = 0;
  TasFrameMasks currentMasks_ = {};
  volatile uint8_t stagedNextMask1_ = 0;
  volatile uint8_t stagedNextMask2_ = 0;
  uint8_t portCount_ = 1;
  TasSyncMode syncMode_ = TasSyncMode::Unknown;
  TasPlaybackResult error_ = TasPlaybackResult::Ok;
  TasPlaybackResult lastWindowResult_ = TasPlaybackResult::Waiting;
  bool startRequested_ = false;
  bool started_ = false;
  bool receivingComplete_ = false;
  bool complete_ = false;
  bool hasLatched_ = false;
  bool pollCompletedInWindow_ = false;
  bool preAdvanced_ = false;
  TasEdgeKind lastEdgeKind_ = TasEdgeKind::SameWindow;
};

static_assert(
  (65536u % kTasBufferCapacity) == 0,
  "free-running ring indices require the capacity to divide 65536");

const char* tasPlaybackResultName(TasPlaybackResult result);

}  // namespace tasdeck

#endif
