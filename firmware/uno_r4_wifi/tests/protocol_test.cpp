#include <cassert>
#include <cstring>
#include <iostream>

#include "../src/NesControllerState.h"
#include "../src/NesDeckProtocol.h"
#include "../src/NesTasPlayback.h"

using tasdeck::Action;
using tasdeck::Button;
using tasdeck::Command;
using tasdeck::CommandType;
using tasdeck::NesControllerState;
using tasdeck::NesControllerDataLevels;
using tasdeck::NesTasPlayback;
using tasdeck::TasFrameMasks;
using tasdeck::TasEdgeKind;
using tasdeck::TasPlaybackResult;
using tasdeck::TasSyncMode;
using tasdeck::actionName;
using tasdeck::buttonMask;
using tasdeck::buttonName;
using tasdeck::commandTypeName;
using tasdeck::parseCommand;
using tasdeck::tasChunkChecksum;
using tasdeck::tasPlaybackResultName;
using tasdeck::tasSyncModeName;

namespace {

void testPing() {
  Command command;
  assert(parseCommand("  PING  ", command));
  assert(command.type == CommandType::Ping);
  assert(std::strcmp(commandTypeName(command.type), "ping") == 0);
}

void testStatus() {
  Command command;
  assert(parseCommand("  STATUS  ", command));
  assert(command.type == CommandType::Status);
  assert(std::strcmp(commandTypeName(command.type), "status") == 0);

  assert(!parseCommand("STATUS now", command));
  assert(command.type == CommandType::Invalid);
}

void testButtonCommand() {
  Command command;
  assert(parseCommand("BUTTON a down", command));
  assert(command.type == CommandType::Button);
  assert(command.controllerPort == 1);
  assert(command.button == Button::A);
  assert(command.action == Action::Down);
  assert(std::strcmp(buttonName(command.button), "a") == 0);
  assert(std::strcmp(actionName(command.action), "down") == 0);

  assert(parseCommand("btn sel release", command));
  assert(command.button == Button::Select);
  assert(command.action == Action::Up);

  assert(parseCommand("BUTTON 2 b down", command));
  assert(command.type == CommandType::Button);
  assert(command.controllerPort == 2);
  assert(command.button == Button::B);
  assert(command.action == Action::Down);

  assert(parseCommand("BUTTON p2 start up", command));
  assert(command.controllerPort == 2);
  assert(command.button == Button::Start);
  assert(command.action == Action::Up);
}

void testTasProtocolCommands() {
  Command command;
  assert(parseCommand("TAS_BEGIN 81 poll", command));
  assert(command.type == CommandType::TasBegin);
  assert(command.frameCount == 81);
  assert(command.portCount == 1);
  assert(command.syncMode == TasSyncMode::Poll);
  assert(command.latchWindowMicros == tasdeck::kTasDefaultLatchWindowMicros);
  assert(std::strcmp(commandTypeName(command.type), "tas_begin") == 0);
  assert(std::strcmp(tasSyncModeName(command.syncMode), "poll") == 0);

  assert(parseCommand("TAS_BEGIN 81 poll 5000", command));
  assert(command.type == CommandType::TasBegin);
  assert(command.latchWindowMicros == 5000);

  assert(parseCommand("TAS_BEGIN 81 poll 2", command));
  assert(command.type == CommandType::TasBegin);
  assert(command.portCount == 2);
  assert(command.latchWindowMicros == tasdeck::kTasDefaultLatchWindowMicros);

  assert(parseCommand("TAS_BEGIN 81 poll 2 5000", command));
  assert(command.type == CommandType::TasBegin);
  assert(command.portCount == 2);
  assert(command.latchWindowMicros == 5000);

  assert(parseCommand("TAS_BEGIN 81 latch 12000", command));
  assert(command.type == CommandType::TasBegin);
  assert(command.syncMode == TasSyncMode::Latch);
  assert(std::strcmp(tasSyncModeName(command.syncMode), "latch") == 0);
  assert(command.latchWindowMicros == 12000);

  assert(parseCommand("TAS_CHUNK 0 3 010080 82", command));
  assert(command.type == CommandType::TasChunk);
  assert(command.startIndex == 0);
  assert(command.portCount == 1);
  assert(command.chunkCount == 3);
  assert(command.masks[0].port1 == 0x01);
  assert(command.masks[0].port2 == 0x00);
  assert(command.masks[1].port1 == 0x00);
  assert(command.masks[2].port1 == 0x80);
  assert(command.checksum == 0x82);

  const uint8_t masks[] = {0x0A, 0x0B};
  assert(tasChunkChecksum(24, masks, 2) == 0x1B);
  assert(parseCommand("TAS_CHUNK 24 2 0A0B 1B", command));

  const TasFrameMasks twoPortMasks[] = {{0x01, 0x02}, {0x00, 0x00}, {0x80, 0x08}};
  assert(tasChunkChecksum(0, twoPortMasks, 3, 2) == 0x8A);
  assert(parseCommand("TAS_CHUNK 0 3 2 010200008008 8A", command));
  assert(command.type == CommandType::TasChunk);
  assert(command.portCount == 2);
  assert(command.chunkCount == 3);
  assert(command.masks[0].port1 == 0x01);
  assert(command.masks[0].port2 == 0x02);
  assert(command.masks[2].port1 == 0x80);
  assert(command.masks[2].port2 == 0x08);

  assert(parseCommand("TAS_START", command));
  assert(command.type == CommandType::TasStart);
  assert(command.startDelayPolls == 0);

  assert(parseCommand("TAS_START 120", command));
  assert(command.type == CommandType::TasStart);
  assert(command.startDelayPolls == 120);

  assert(parseCommand("TAS_CANCEL", command));
  assert(command.type == CommandType::TasCancel);

  assert(parseCommand("TAS_END", command));
  assert(command.type == CommandType::TasEnd);

  assert(parseCommand("TAS_STATUS", command));
  assert(command.type == CommandType::TasStatus);

  assert(parseCommand("TAS_TRACE", command));
  assert(command.type == CommandType::TasTrace);
  assert(command.traceCount == tasdeck::kTasTracePageLimit);
  assert(!command.traceHasStart);

  assert(parseCommand("TAS_TRACE 4 120", command));
  assert(command.type == CommandType::TasTrace);
  assert(command.traceCount == 4);
  assert(command.traceHasStart);
  assert(command.traceStart == 120);

  assert(parseCommand("TAS_TRACE_RESUME", command));
  assert(command.type == CommandType::TasTraceResume);
  assert(std::strcmp(commandTypeName(command.type), "tas_trace_resume") == 0);
}

void testInvalidCommandsResetOutput() {
  Command command;
  assert(parseCommand("BUTTON a down", command));

  assert(!parseCommand("BUTTON a down now", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("BUTTON 3 a down", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("AIM 128 120", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("BUTTON turbo down", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("BUTTON a hold", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 0 poll", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 60", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 frame 0 4", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 frame 8000 999", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 poll 499", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 poll 15001", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 poll 3", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_BEGIN 10 poll 2 499", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_CHUNK 0 3 010080 00", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_CHUNK 0 4 010080 82", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_CHUNK 0 3 3 010200008008 8A", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_START now", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_START 3601", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_CANCEL now", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_TRACE 0", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_TRACE 13", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_TRACE 2 now", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("TAS_TRACE_RESUME now", command));
  assert(command.type == CommandType::Invalid);

  assert(!parseCommand("UNKNOWN", command));
  assert(command.type == CommandType::Invalid);
}

void testButtonMasksUseNesShiftOrder() {
  assert(buttonMask(Button::A) == 0x01);
  assert(buttonMask(Button::B) == 0x02);
  assert(buttonMask(Button::Select) == 0x04);
  assert(buttonMask(Button::Start) == 0x08);
  assert(buttonMask(Button::Up) == 0x10);
  assert(buttonMask(Button::Down) == 0x20);
  assert(buttonMask(Button::Left) == 0x40);
  assert(buttonMask(Button::Right) == 0x80);
}

void testControllerStateUsesActiveLowData() {
  NesControllerState state;

  assert(state.setButton(Button::A, true));
  state.latch();
  assert(!state.dataLineHigh());

  state.advance();
  assert(state.dataLineHigh());
}

void testControllerStateSnapshotsOnLatch() {
  NesControllerState state;

  assert(state.setButton(Button::B, true));
  assert(state.setButton(Button::Right, true));
  state.latch();

  assert(state.dataLineHigh());
  state.advance();
  assert(!state.dataLineHigh());

  assert(state.setButton(Button::B, false));
  assert(!state.dataLineHigh());

  for (int index = 0; index < 6; ++index) {
    state.advance();
  }

  assert(!state.dataLineHigh());
  state.advance();
  assert(state.dataLineHigh());
}

void testControllerStateReportsOneAfterEightReads() {
  NesControllerState state;

  state.latch();
  for (int index = 0; index < tasdeck::kNesButtonCount; ++index) {
    state.advance();
  }

  assert(state.dataLineHigh());
}

void testControllerStateAppliesButtonCommandsOnly() {
  NesControllerState state;
  Command command;

  assert(parseCommand("BUTTON left down", command));
  assert(state.applyCommand(command));
  assert(state.pressedMask() == 0x40);

  assert(parseCommand("BUTTON left up", command));
  assert(state.applyCommand(command));
  assert(state.pressedMask() == 0x00);

  assert(parseCommand("PING", command));
  assert(!state.applyCommand(command));
  assert(state.pressedMask() == 0x00);
}

void testControllerFirstDataLineLevelsKeepPortsIndependent() {
  NesControllerDataLevels levels = tasdeck::firstDataLineLevels({0x05, 0x00});
  assert(!levels.port1High);
  assert(levels.port2High);

  levels = tasdeck::firstDataLineLevels({0x00, 0x01});
  assert(levels.port1High);
  assert(!levels.port2High);

  levels = tasdeck::firstDataLineLevels({0x01, 0x01});
  assert(!levels.port1High);
  assert(!levels.port2High);
}

void testTasPlaybackServesOneMaskPerLatchWindow() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x00, 0x80};
  uint8_t nextMask = 0xff;

  assert(playback.begin(3, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.latchWindowMicros() == 8000);
  assert(playback.pushChunk(0, masks, 3) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.ready());

  // Latches before TAS_START must not consume frames.
  assert(playback.onLatchEdge(1000, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x00);
  assert(!playback.started());

  assert(playback.start(0) == TasPlaybackResult::Ok);
  assert(playback.startRequested());

  // SMB3-style frame: several strobe edges ~120us apart consume one mask.
  assert(playback.onLatchEdge(20000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.started());
  assert(playback.currentFrame() == 0);
  assert(playback.bufferedFrames() == 2);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(20120, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  // A DPCM-triggered game re-read stays inside the same window.
  assert(playback.onLatchEdge(20360, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);
  assert(playback.bufferedFrames() == 2);
  playback.notePollCompleted();

  // The next console frame starts a new window.
  assert(playback.onLatchEdge(36600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);
  assert(playback.lastEdgeKind() == TasEdgeKind::AdvancedAtEdge);
  playback.notePollCompleted();

  // A lag frame with no polls widens the gap but still advances exactly once.
  assert(playback.onLatchEdge(69900, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x80);
  assert(playback.currentFrame() == 2);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(86500, nextMask) == TasPlaybackResult::Complete);
  assert(nextMask == 0x00);
  assert(playback.complete());
  assert(playback.currentFrame() == 3);
}

void testTasPlaybackIgnoresStrobesWithoutCompletedReads() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x08, 0x00};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  // SMB3 boot: bare strobes with no 8-clock reads. Frame 0 is served but the
  // following windows must not advance past it, or the movie's held Start
  // never reaches the console.
  assert(playback.onLatchEdge(100000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);

  assert(playback.onLatchEdge(150000, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);
  assert(playback.lastEdgeKind() == TasEdgeKind::ReadlessHold);

  assert(playback.onLatchEdge(200000, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);

  // First real read train: still frame 0, and its completed poll arms the
  // next window to advance.
  playback.notePollCompleted();
  assert(playback.onLatchEdge(216600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackStartMidTrainWaitsForNextWindow() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x08, 0x00};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);

  // Console already polling; TAS_START lands between two strobes of the same
  // frame. Frame 0 must wait for the next frame boundary instead of tearing
  // the in-progress read.
  assert(playback.onLatchEdge(50000, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.start(0) == TasPlaybackResult::Ok);
  assert(playback.onLatchEdge(50120, nextMask) == TasPlaybackResult::Waiting);
  assert(!playback.started());

  assert(playback.onLatchEdge(66600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);
}

void testTasPlaybackStartDelayCountsLatchWindows() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(2) == TasPlaybackResult::Ok);
  assert(playback.startDelayRemaining() == 2);

  // A read-less window (boot strobes) does not consume delay.
  assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 2);
  playback.notePollCompleted();

  // Re-reads within the window do not consume delay either.
  assert(playback.onLatchEdge(10120, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 2);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 1);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(43200, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 0);
  assert(!playback.started());
  playback.notePollCompleted();

  assert(playback.onLatchEdge(59800, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(76400, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(93000, nextMask) == TasPlaybackResult::Complete);
  assert(playback.complete());
}

void testTasLatchPlaybackAdvancesWithoutEightClockRead() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(1) == TasPlaybackResult::Ok);

  // This exercises a single blank-latch of start delay: latch mode consumes the
  // delay on that latch without requiring an eight-clock controller read. Note
  // the wire-level meaning of TAStm32 --blank 1 is not settled here: its
  // uploader appears to serve an implicit reset-buffer blank plus the explicit
  // queued blank, so the equivalent TASDeck delay may be more than one.
  assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x00);
  assert(playback.startDelayRemaining() == 0);
  playback.noteLatchObserved();

  // The gap after the blank latch pre-positions R08 record 0 for the next
  // strobe, even though the previous train may have contained only 7 clocks.
  assert(playback.onWindowExpired(18000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);

  assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  playback.noteLatchObserved();
  assert(playback.onWindowExpired(34600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
}

void testTasLatchPlaybackHonorsStartDelays() {
  const uint8_t masks[] = {0x01, 0x02};

  for (uint32_t delay = 0; delay <= 2; ++delay) {
    NesTasPlayback playback;
    uint8_t nextMask = 0xff;
    uint32_t nowMicros = 10000;

    assert(playback.begin(2, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
    assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
    assert(playback.finishReceiving() == TasPlaybackResult::Ok);
    assert(playback.start(delay) == TasPlaybackResult::Ok);

    for (uint32_t blank = 0; blank < delay; ++blank) {
      assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Waiting);
      assert(nextMask == 0x00);
      assert(playback.startDelayRemaining() == delay - blank - 1);
      playback.noteLatchObserved();

      // A reread in the same window must not consume another delay unit.
      assert(playback.onLatchEdge(nowMicros + 120, nextMask) == TasPlaybackResult::Waiting);
      assert(playback.startDelayRemaining() == delay - blank - 1);
      nowMicros += 16600;
    }

    assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Ok);
    assert(nextMask == 0x01);
    assert(playback.started());
    assert(playback.currentFrame() == 0);
  }
}

void testTasLatchPlaybackGroupsSameWindowRereads() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02, 0x04};
  uint8_t nextMask = 0xff;

  assert(playback.begin(3, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 3) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  playback.noteLatchObserved();

  assert(playback.onLatchEdge(10120, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);

  assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
}

void testTasLatchPlaybackDiffersFromPollModeAfterShortRead() {
  const uint8_t masks[] = {0x01, 0x02};
  NesTasPlayback latchPlayback;
  NesTasPlayback pollPlayback;
  uint8_t latchMask = 0xff;
  uint8_t pollMask = 0xff;

  assert(latchPlayback.begin(2, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
  assert(pollPlayback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(latchPlayback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(pollPlayback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(latchPlayback.finishReceiving() == TasPlaybackResult::Ok);
  assert(pollPlayback.finishReceiving() == TasPlaybackResult::Ok);
  assert(latchPlayback.start(0) == TasPlaybackResult::Ok);
  assert(pollPlayback.start(0) == TasPlaybackResult::Ok);

  assert(latchPlayback.onLatchEdge(10000, latchMask) == TasPlaybackResult::Ok);
  assert(pollPlayback.onLatchEdge(10000, pollMask) == TasPlaybackResult::Ok);
  latchPlayback.noteLatchObserved();

  // Model a short train by withholding notePollCompleted(). Latch mode still
  // advances, while completed-read mode holds the previously served mask.
  assert(latchPlayback.onLatchEdge(26600, latchMask) == TasPlaybackResult::Ok);
  assert(latchMask == 0x02);
  assert(latchPlayback.currentFrame() == 1);
  assert(pollPlayback.onLatchEdge(26600, pollMask) == TasPlaybackResult::Waiting);
  assert(pollMask == 0x01);
  assert(pollPlayback.currentFrame() == 0);
}

void testTasLatchPlaybackCompletesAndReportsUnderrun() {
  {
    NesTasPlayback playback;
    const uint8_t masks[] = {0x01, 0x02};
    uint8_t nextMask = 0xff;

    assert(playback.begin(2, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
    assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
    assert(playback.finishReceiving() == TasPlaybackResult::Ok);
    assert(playback.start(0) == TasPlaybackResult::Ok);
    assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Ok);
    playback.noteLatchObserved();
    assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Ok);
    playback.noteLatchObserved();
    assert(playback.onLatchEdge(43200, nextMask) == TasPlaybackResult::Complete);
    assert(nextMask == 0x00);
    assert(playback.complete());
  }

  NesTasPlayback playback;
  uint8_t chunk[tasdeck::kTasChunkFrameLimit] = {};
  uint32_t startIndex = 0;
  uint8_t nextMask = 0xff;
  uint32_t nowMicros = 100000;

  assert(playback.begin(200, TasSyncMode::Latch, 8000) == TasPlaybackResult::Ok);
  for (int chunkIndex = 0; chunkIndex < 4; ++chunkIndex) {
    assert(playback.pushChunk(startIndex, chunk, tasdeck::kTasChunkFrameLimit) == TasPlaybackResult::Ok);
    startIndex += tasdeck::kTasChunkFrameLimit;
  }
  assert(playback.start(0) == TasPlaybackResult::Ok);

  for (uint32_t frame = 0; frame < startIndex; ++frame) {
    assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Ok);
    playback.noteLatchObserved();
    nowMicros += 16600;
  }

  assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Underrun);
  assert(nextMask == 0x00);
  assert(playback.hasError());
}

void testTasLatchPlaybackServesTwoControllerMasks() {
  NesTasPlayback playback;
  const TasFrameMasks masks[] = {{0x01, 0x02}, {0x80, 0x40}};
  TasFrameMasks nextMasks = {};

  assert(playback.begin(2, TasSyncMode::Latch, 2, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onLatchEdge(10000, nextMasks) == TasPlaybackResult::Ok);
  assert(nextMasks.port1 == 0x01);
  assert(nextMasks.port2 == 0x02);
  playback.noteLatchObserved();

  assert(playback.onLatchEdge(26600, nextMasks) == TasPlaybackResult::Ok);
  assert(nextMasks.port1 == 0x80);
  assert(nextMasks.port2 == 0x40);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackHandlesTimestampWraparound() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onLatchEdge(4294960000u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  playback.notePollCompleted();

  // 120us later, still the same frame.
  assert(playback.onLatchEdge(4294960120u, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x01);
  playback.notePollCompleted();

  // 16.6ms later the counter has wrapped; unsigned math must still advance.
  assert(playback.onLatchEdge(9304u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackPreAdvancesAtWindowExpiry() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x00, 0x80};
  uint8_t nextMask = 0xff;

  assert(playback.begin(3, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 3) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  // Armed before the first strobe: frame 0 is released from the main loop so
  // its bit 0 is on the wire before the console ever strobes.
  assert(playback.windowExpiryDue(500));
  assert(playback.onWindowExpired(500, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.started());
  assert(playback.currentFrame() == 0);

  // The first strobe just consumes the pre-advanced frame.
  assert(playback.onLatchEdge(20000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);
  assert(playback.lastEdgeKind() == TasEdgeKind::PreAdvanced);
  playback.notePollCompleted();

  // Same-frame re-read stays inside the window.
  assert(playback.onLatchEdge(20120, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x01);
  assert(playback.lastEdgeKind() == TasEdgeKind::SameWindow);
  playback.notePollCompleted();

  // The window closes 8ms after the last strobe, not the first.
  assert(!playback.windowExpiryDue(28119));
  assert(playback.onWindowExpired(28119, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.currentFrame() == 0);

  assert(playback.windowExpiryDue(28120));
  assert(playback.onWindowExpired(28120, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);

  // Only one pre-advance per polled window, even across a long lag gap.
  assert(!playback.windowExpiryDue(28121));
  assert(playback.onWindowExpired(40000, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.currentFrame() == 1);

  // The next strobe serves the pre-advanced mask without advancing again.
  assert(playback.onLatchEdge(36600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);
  playback.notePollCompleted();

  assert(playback.onWindowExpired(44600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x80);
  assert(playback.currentFrame() == 2);

  assert(playback.onLatchEdge(69900, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x80);
  playback.notePollCompleted();

  // Movie end is committed at expiry so the output drops before the next
  // strobe instead of racing it.
  assert(playback.onWindowExpired(77900, nextMask) == TasPlaybackResult::Complete);
  assert(nextMask == 0x00);
  assert(playback.complete());
  assert(playback.currentFrame() == 3);
  assert(playback.onLatchEdge(86500, nextMask) == TasPlaybackResult::Inactive);
}

// KQ5 (Konami) reads the pad twice back-to-back within one frame (~71us apart)
// and ANDs the two reads, with no re-read-on-mismatch fallback. Both reads land
// in the same latch window and must consume exactly one mask per frame, and a
// torn read (one burst that never completes its 8 clocks) must NOT double-advance
// or misalign the movie: the second read's poll credit still gates the next
// frame. This locks the frame-advance logic for that pattern; the physical
// lost-clock corruption it suffers is a separate ISR-timing issue.
void testTasPlaybackHandlesKq5DoubleReadAndFrames() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x02, 0x00, 0x02};  // B, none, B (Konami-skip style)
  uint8_t nextMask = 0xff;

  assert(playback.begin(3, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 3) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  // Loop-side pre-advance releases frame 0 before the console's first strobe.
  assert(playback.onWindowExpired(500, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);

  // Frame 0: read1 serves the pre-advanced mask; read2 is torn (never completes
  // its 8-clock poll, so no notePollCompleted). read1's credit still arms expiry.
  assert(playback.onLatchEdge(20000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.lastEdgeKind() == TasEdgeKind::PreAdvanced);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();          // read1 completes
  assert(playback.onLatchEdge(20071, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x02);              // same window keeps serving frame 0
  assert(playback.lastEdgeKind() == TasEdgeKind::SameWindow);
  // read2 torn: intentionally no notePollCompleted here.

  // Window closes 8ms after the last strobe; expiry pre-advances exactly once.
  assert(playback.onWindowExpired(28071, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);

  // Frame 1: both reads clean this time.
  assert(playback.onLatchEdge(36639, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);
  playback.notePollCompleted();
  assert(playback.onLatchEdge(36710, nextMask) == TasPlaybackResult::Waiting);
  playback.notePollCompleted();

  assert(playback.onWindowExpired(44710, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 2);

  // Frame 2 is the last mask; movie completion is committed at expiry.
  assert(playback.onLatchEdge(53278, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  playback.notePollCompleted();
  assert(playback.onWindowExpired(61278, nextMask) == TasPlaybackResult::Complete);
  assert(playback.complete());
  assert(playback.currentFrame() == 3);
}

void testTasPlaybackPreAdvanceRequiresCompletedPoll() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x08, 0x00};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onWindowExpired(1000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x08);
  assert(playback.onLatchEdge(100000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);

  // Boot-style bare strobe window: no completed read, so expiry must not
  // consume the next mask.
  assert(!playback.windowExpiryDue(108000));
  assert(playback.onWindowExpired(108000, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.currentFrame() == 0);

  assert(playback.onLatchEdge(150000, nextMask) == TasPlaybackResult::Waiting);
  assert(nextMask == 0x08);
  assert(playback.currentFrame() == 0);

  // A window with a real read arms the pre-advance again.
  playback.notePollCompleted();
  assert(playback.onWindowExpired(158000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackPreAdvanceHonorsStartDelay() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(2) == TasPlaybackResult::Ok);

  // Frame 0 must not be released while delay windows remain.
  assert(!playback.windowExpiryDue(1000));
  assert(playback.onWindowExpired(1000, nextMask) == TasPlaybackResult::Waiting);
  assert(!playback.started());

  assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Waiting);
  playback.notePollCompleted();
  assert(playback.onWindowExpired(18000, nextMask) == TasPlaybackResult::Waiting);
  assert(!playback.started());

  assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 1);
  playback.notePollCompleted();

  assert(playback.onLatchEdge(43200, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.startDelayRemaining() == 0);
  assert(!playback.started());
  playback.notePollCompleted();

  // Delay exhausted: the expiry of the current window releases frame 0 so the
  // next strobe serves it pre-positioned.
  assert(playback.onWindowExpired(51200, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.started());

  assert(playback.onLatchEdge(59800, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  assert(playback.onWindowExpired(67800, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.onLatchEdge(76400, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
  playback.notePollCompleted();

  assert(playback.onWindowExpired(84400, nextMask) == TasPlaybackResult::Complete);
  assert(playback.complete());
}

void testTasPlaybackWindowExpiryHandlesTimestampWraparound() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onWindowExpired(4294950000u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.onLatchEdge(4294960000u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  playback.notePollCompleted();

  // The counter wraps between the strobe and the window close; unsigned math
  // keeps the 8ms measurement exact.
  assert(playback.onWindowExpired(700u, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.onWindowExpired(704u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.onLatchEdge(9304u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x02);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackHoldsWindowThroughBackwardsTimeStep() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x40, 0x40, 0x00};
  uint8_t nextMask = 0xff;

  assert(playback.begin(3, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 3) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  // A window opens normally and its first read completes.
  assert(playback.onLatchEdge(100000u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x40);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  // micros() raced the 1 kHz tick and reported ~+1 ms; the strobe is really
  // ~120 us into the window (2026-07-10 Zelda dungeon-1 desync capture).
  assert(playback.onLatchEdge(101122u, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.lastEdgeKind() == TasEdgeKind::SameWindow);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  // With the glitched-high time stored, the expiry service must not see the
  // window as already over and pre-advance mid-poll-cluster.
  assert(!playback.windowExpiryDue(100240u));

  // The next strobe reads true time again — a backwards step. It must stay
  // in the same window rather than consuming a second mask this frame.
  assert(playback.onLatchEdge(100370u, nextMask) == TasPlaybackResult::Waiting);
  assert(playback.lastEdgeKind() == TasEdgeKind::SameWindow);
  assert(nextMask == 0x40);
  assert(playback.currentFrame() == 0);
  playback.notePollCompleted();

  // The real next frame still advances exactly once.
  assert(playback.onLatchEdge(116600u, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x40);
  assert(playback.currentFrame() == 1);
}

void testTasPlaybackStagesFallbackMasks() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x00};
  uint8_t nextMask = 0xff;

  assert(playback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.stagedNextMask() == 0x01);
  assert(playback.start(0) == TasPlaybackResult::Ok);
  assert(playback.willAdvanceOnEdge());
  assert(playback.stagedNextMask() == 0x01);

  assert(playback.onLatchEdge(10000, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x01);
  assert(playback.stagedNextMask() == 0x00);
  assert(!playback.willAdvanceOnEdge());

  playback.notePollCompleted();
  assert(playback.willAdvanceOnEdge());
  assert(playback.stagedNextMask() == 0x00);
  assert(playback.onLatchEdge(26600, nextMask) == TasPlaybackResult::Ok);
  assert(nextMask == 0x00);
  assert(playback.stagedNextMask() == 0x00);

  playback.notePollCompleted();
  assert(playback.willAdvanceOnEdge());
  assert(playback.onLatchEdge(43200, nextMask) == TasPlaybackResult::Complete);
  assert(nextMask == 0x00);
}

void testTasPlaybackServesTwoControllerMasks() {
  NesTasPlayback playback;
  const TasFrameMasks masks[] = {{0x01, 0x02}, {0x80, 0x08}};
  TasFrameMasks nextMasks = {};

  assert(playback.begin(2, TasSyncMode::Poll, 2, 8000) == TasPlaybackResult::Ok);
  assert(playback.portCount() == 2);
  assert(playback.pushChunk(0, masks, 2, 1) == TasPlaybackResult::Invalid);
  assert(playback.pushChunk(0, masks, 2, 2) == TasPlaybackResult::Ok);
  assert(playback.finishReceiving() == TasPlaybackResult::Ok);
  assert(playback.stagedNextMasks().port1 == 0x01);
  assert(playback.stagedNextMasks().port2 == 0x02);
  assert(playback.start(0) == TasPlaybackResult::Ok);

  assert(playback.onWindowExpired(500, nextMasks) == TasPlaybackResult::Ok);
  assert(nextMasks.port1 == 0x01);
  assert(nextMasks.port2 == 0x02);
  assert(playback.currentMasks().port1 == 0x01);
  assert(playback.currentMasks().port2 == 0x02);
  assert(playback.stagedNextMasks().port1 == 0x80);
  assert(playback.stagedNextMasks().port2 == 0x08);

  assert(playback.onLatchEdge(20000, nextMasks) == TasPlaybackResult::Ok);
  assert(nextMasks.port1 == 0x01);
  assert(nextMasks.port2 == 0x02);
  playback.notePollCompleted(2);

  assert(playback.onWindowExpired(28000, nextMasks) == TasPlaybackResult::Ok);
  assert(nextMasks.port1 == 0x80);
  assert(nextMasks.port2 == 0x08);
}

void testTasPlaybackIgnoresUnavailableControllerPolls() {
  const uint8_t masks[] = {0x01, 0x80};
  uint8_t nextMask = 0;

  NesTasPlayback onePortPlayback;
  assert(onePortPlayback.begin(2, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(onePortPlayback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(onePortPlayback.finishReceiving() == TasPlaybackResult::Ok);
  assert(onePortPlayback.start(0) == TasPlaybackResult::Ok);
  assert(onePortPlayback.onWindowExpired(500, nextMask) == TasPlaybackResult::Ok);
  assert(onePortPlayback.onLatchEdge(20000, nextMask) == TasPlaybackResult::Ok);

  onePortPlayback.notePollCompleted(2);
  assert(onePortPlayback.onWindowExpired(28000, nextMask) == TasPlaybackResult::Waiting);
  assert(onePortPlayback.currentFrame() == 0);

  onePortPlayback.notePollCompleted(1);
  assert(onePortPlayback.onWindowExpired(29000, nextMask) == TasPlaybackResult::Ok);
  assert(onePortPlayback.currentFrame() == 1);
  assert(nextMask == 0x80);

  const TasFrameMasks twoPortMasks[] = {{0x01, 0x00}, {0x80, 0x00}};
  TasFrameMasks nextMasks = {};
  NesTasPlayback twoPortPlayback;
  assert(twoPortPlayback.begin(2, TasSyncMode::Poll, 2, 8000) == TasPlaybackResult::Ok);
  assert(twoPortPlayback.pushChunk(0, twoPortMasks, 2, 2) == TasPlaybackResult::Ok);
  assert(twoPortPlayback.finishReceiving() == TasPlaybackResult::Ok);
  assert(twoPortPlayback.start(0) == TasPlaybackResult::Ok);
  assert(twoPortPlayback.onWindowExpired(500, nextMasks) == TasPlaybackResult::Ok);
  assert(twoPortPlayback.onLatchEdge(20000, nextMasks) == TasPlaybackResult::Ok);

  twoPortPlayback.notePollCompleted(2);
  assert(twoPortPlayback.onWindowExpired(28000, nextMasks) == TasPlaybackResult::Ok);
  assert(twoPortPlayback.currentFrame() == 1);
  assert(nextMasks.port1 == 0x80);
}

void testTasPlaybackRejectsInvalidLatchWindow() {
  NesTasPlayback playback;

  assert(playback.begin(10, TasSyncMode::Poll, 499) == TasPlaybackResult::Invalid);
  playback.reset();
  assert(playback.begin(10, TasSyncMode::Poll, 15001) == TasPlaybackResult::Invalid);
  playback.reset();
  assert(playback.begin(10, TasSyncMode::Poll, 3, 8000) == TasPlaybackResult::Invalid);
}

void testTasPlaybackRejectsOutOfOrderAndOverflowChunks() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};

  assert(playback.begin(10, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(2, masks, 2) == TasPlaybackResult::OutOfOrder);
  assert(playback.hasError());
  assert(std::strcmp(tasPlaybackResultName(playback.error()), "out_of_order") == 0);

  playback.reset();
  assert(playback.begin(1000, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  uint8_t chunk[tasdeck::kTasChunkFrameLimit] = {};
  uint32_t startIndex = 0;
  while (startIndex + tasdeck::kTasChunkFrameLimit <= tasdeck::kTasBufferCapacity) {
    assert(playback.pushChunk(startIndex, chunk, tasdeck::kTasChunkFrameLimit) == TasPlaybackResult::Ok);
    startIndex += tasdeck::kTasChunkFrameLimit;
  }

  assert(playback.pushChunk(startIndex, chunk, tasdeck::kTasChunkFrameLimit) == TasPlaybackResult::Overflow);
  assert(playback.hasError());
}

void testTasPlaybackStartWaitsForPrebuffer() {
  NesTasPlayback playback;
  const uint8_t masks[] = {0x01, 0x02};

  assert(playback.begin(200, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  assert(playback.pushChunk(0, masks, 2) == TasPlaybackResult::Ok);
  assert(!playback.ready());
  assert(playback.start(0) == TasPlaybackResult::Waiting);
  assert(!playback.startRequested());
}

void testTasPlaybackReportsUnderrun() {
  NesTasPlayback playback;
  uint8_t chunk[tasdeck::kTasChunkFrameLimit] = {};
  uint32_t startIndex = 0;
  uint8_t nextMask = 0;
  uint32_t nowMicros = 100000;

  assert(playback.begin(200, TasSyncMode::Poll, 8000) == TasPlaybackResult::Ok);
  for (int chunkIndex = 0; chunkIndex < 4; ++chunkIndex) {
    assert(playback.pushChunk(startIndex, chunk, tasdeck::kTasChunkFrameLimit) == TasPlaybackResult::Ok);
    startIndex += tasdeck::kTasChunkFrameLimit;
  }

  assert(playback.start(0) == TasPlaybackResult::Ok);
  for (uint32_t frame = 0; frame < startIndex; ++frame) {
    assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Ok);
    playback.notePollCompleted();
    nowMicros += 16600;
  }

  assert(playback.onLatchEdge(nowMicros, nextMask) == TasPlaybackResult::Underrun);
  assert(nextMask == 0x00);
  assert(playback.hasError());
}

}  // namespace

int main() {
  testPing();
  testStatus();
  testButtonCommand();
  testTasProtocolCommands();
  testInvalidCommandsResetOutput();
  testButtonMasksUseNesShiftOrder();
  testControllerStateUsesActiveLowData();
  testControllerStateSnapshotsOnLatch();
  testControllerStateReportsOneAfterEightReads();
  testControllerStateAppliesButtonCommandsOnly();
  testControllerFirstDataLineLevelsKeepPortsIndependent();
  testTasPlaybackServesOneMaskPerLatchWindow();
  testTasPlaybackIgnoresStrobesWithoutCompletedReads();
  testTasPlaybackStartMidTrainWaitsForNextWindow();
  testTasPlaybackStartDelayCountsLatchWindows();
  testTasLatchPlaybackAdvancesWithoutEightClockRead();
  testTasLatchPlaybackHonorsStartDelays();
  testTasLatchPlaybackGroupsSameWindowRereads();
  testTasLatchPlaybackDiffersFromPollModeAfterShortRead();
  testTasLatchPlaybackCompletesAndReportsUnderrun();
  testTasLatchPlaybackServesTwoControllerMasks();
  testTasPlaybackHandlesTimestampWraparound();
  testTasPlaybackPreAdvancesAtWindowExpiry();
  testTasPlaybackHandlesKq5DoubleReadAndFrames();
  testTasPlaybackPreAdvanceRequiresCompletedPoll();
  testTasPlaybackPreAdvanceHonorsStartDelay();
  testTasPlaybackWindowExpiryHandlesTimestampWraparound();
  testTasPlaybackHoldsWindowThroughBackwardsTimeStep();
  testTasPlaybackStagesFallbackMasks();
  testTasPlaybackServesTwoControllerMasks();
  testTasPlaybackIgnoresUnavailableControllerPolls();
  testTasPlaybackRejectsInvalidLatchWindow();
  testTasPlaybackRejectsOutOfOrderAndOverflowChunks();
  testTasPlaybackStartWaitsForPrebuffer();
  testTasPlaybackReportsUnderrun();

  std::cout << "firmware protocol tests passed\n";
  return 0;
}
