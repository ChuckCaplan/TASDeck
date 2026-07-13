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
  uint32_t currentFrame() const;
  uint32_t totalFrames() const;
  uint32_t totalReceived() const;
  uint32_t startDelayRemaining() const;
  uint32_t latchWindowMicros() const;
  uint16_t bufferedFrames() const;
  uint16_t capacity() const;
  uint8_t currentMask() const;
  TasFrameMasks currentMasks() const;
  uint8_t portCount() const;
  TasSyncMode syncMode() const;

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
