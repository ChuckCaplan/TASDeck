#include <Arduino.h>
#include <FspTimer.h>
#include <stdio.h>

#include "src/NesControllerState.h"
#include "src/NesDeckProtocol.h"
#include "src/NesTasPlayback.h"

#ifndef TASDECK_DIAGNOSTIC_FORCED_MASK
#define TASDECK_DIAGNOSTIC_FORCED_MASK 0
#endif

#ifndef TASDECK_ISR_DEBUG_PIN
#define TASDECK_ISR_DEBUG_PIN -1
#endif

using tasdeck::Command;
using tasdeck::CommandType;
using tasdeck::NesTasPlayback;
using tasdeck::TasPlaybackResult;
using tasdeck::actionName;
using tasdeck::buttonMask;
using tasdeck::buttonName;
using tasdeck::commandTypeName;
using tasdeck::parseCommand;
using tasdeck::tasSyncModeName;
using tasdeck::tasPlaybackResultName;

namespace {

constexpr unsigned long kBaudRate = 115200;
constexpr const char* kFirmwareId = "tasdeck-uno-r4-serial-latchwin-v44";
constexpr const char* kTransportMode = "serial";
constexpr const char* kLatchEdgeMode = "rising";
constexpr const char* kClockEdgeMode = "rising";
constexpr uint8_t kDiagnosticForcedMask = static_cast<uint8_t>(TASDECK_DIAGNOSTIC_FORCED_MASK);
constexpr int kIsrDebugPin = TASDECK_ISR_DEBUG_PIN;
constexpr uint8_t kStatusLedPin = LED_BUILTIN;
constexpr size_t kLineBufferLength = 320;
// Sized for the largest response: 12 per-port trace rows of ~95 chars plus
// the tas_trace prefix (~1250 bytes total).
constexpr size_t kResponseBufferLength = 1536;
// Per-port rows (28 bytes vs the v40-v42 mirror layout's 32) buy this depth
// back inside the exact RAM footprint that linked as 448 mirror entries;
// 560 entries overflow the linker's 8 KB heap + 1 KB stack reservation.
constexpr uint16_t kTasTraceCapacity = 512;

// The loop-side pre-advance is best-effort: a blocking USB CDC write can stall
// the main loop for tens of milliseconds (measured: every bridge exchange cost
// ~50-65 ms and pushed ~17% of windows onto the in-ISR fallback path during
// chunk streaming). A 1 kHz hardware timer services window expiry regardless
// of what the loop is doing. Its interrupt priority is strictly below the NES
// latch (0) and clock (1) pins, and the expiry commit stays short.
constexpr float kTasServiceTimerHz = 1000.0f;
constexpr uint8_t kTasServiceTimerPriority = 12;

// After an anomaly, keep recording this many completed polls of context and
// then freeze the trace ring so the event survives until the next capture,
// no matter how much later the Trace button is pressed. With two active ports,
// rows are recorded per port read, so the time represented by 240 rows depends
// on the game's polling pattern.
constexpr uint16_t kTasTraceFreezeContextPolls = 240;

// Anomaly kinds reported in tas_status and marked in trace diag bit 4.
constexpr uint8_t kTasAnomalyTornTrain = 1;      // strobe hit a mid-shift register
constexpr uint8_t kTasAnomalyLineMismatch = 2;   // pre-advanced first bit absent at strobe
constexpr uint8_t kTasAnomalyClockedMismatch = 3;  // reconstructed wire != served mask
constexpr uint8_t kTasAnomalyReRead = 4;         // 3rd poll in one window (counted only)
constexpr uint8_t kTasAnomalyReReadStorm = 5;    // 5th poll in one window
constexpr uint8_t kPort1LatchPin = 2;
constexpr uint8_t kPort1ClockPin = 3;
constexpr uint8_t kPort1DataPin = 6;
constexpr uint8_t kPort2LatchPin = 12;
constexpr uint8_t kPort2ClockPin = 8;
constexpr uint8_t kPort2DataPin = 7;
constexpr uint16_t kPort1LatchBit = 1u << 4;  // D2 = P104 on UNO R4 WiFi.
constexpr uint16_t kPort1DataBit = 1u << 11;  // D6 = P111 on UNO R4 WiFi.
constexpr uint16_t kPort2DataBit = 1u << 12;  // D7 = P112 on UNO R4 WiFi.
constexpr uint16_t kPort3D9Bit = 1u << 3;  // D9 = P303 on UNO R4 WiFi.

struct TasTraceEntry {
  uint32_t timestampMicros = 0;
  uint32_t tasFrame = 0;
  uint32_t latchCount = 0;
  uint32_t clockCount = 0;
  uint8_t clocksSinceLatch = 0;
  uint8_t polledMask = 0;
  uint8_t nextMask = 0;
  uint8_t latchedMask = 0;
  uint8_t shiftIndex = 0;
  uint8_t clockedMask = 0;
  uint8_t result = static_cast<uint8_t>(TasPlaybackResult::Ok);
  // bit 0: data line was LOW at the rising strobe edge of this poll's train
  // (i.e. the served mask's A bit was already on the wire before the console
  // could sample it). bits 1-3: TasEdgeKind of the window-opening edge.
  uint8_t diag = 0;
  // Rows are per-port: every field above reflects the port that completed the
  // poll, so two-port runs correlate ports by sequence/timestamp instead of
  // mirror columns (which halved the ring depth in v40-v42).
  uint8_t port = 1;
};

char lineBuffer[kLineBufferLength] = {};
size_t lineLength = 0;
volatile uint8_t controllerPressedMask = 0;
volatile uint8_t controllerLatchedMask = 0;
volatile uint8_t controllerShiftIndex = 0;
volatile uint8_t controllerClockedMask = 0;
volatile uint8_t controller2PressedMask = 0;
volatile uint8_t controller2LatchedMask = 0;
volatile uint8_t controller2ShiftIndex = 0;
volatile uint8_t controller2ClockedMask = 0;
volatile unsigned long controllerLatchCount = 0;
volatile unsigned long controllerClockCount = 0;
volatile unsigned long controller2ClockCount = 0;
volatile uint32_t controllerLastLatchMicros = 0;
volatile uint8_t controllerClocksSinceLatch = 0;
volatile uint8_t controller2ClocksSinceLatch = 0;
volatile uint8_t controllerDiagLineLowAtLatch = 0;
volatile uint8_t controller2DiagLineLowAtLatch = 0;
volatile uint8_t controllerDiagWindowKind = 0;
volatile uint8_t controllerPollsInWindow = 0;
volatile uint8_t controller2PollsInWindow = 0;
volatile bool tasOutputEnabled = false;
TasTraceEntry tasTrace[kTasTraceCapacity] = {};
volatile uint16_t tasTraceHead = 0;
volatile uint16_t tasTraceCount = 0;
volatile uint32_t tasTraceNextSequence = 0;
volatile bool tasTraceFrozen = false;
volatile uint16_t tasTraceFreezeCountdown = 0;
volatile uint32_t tasAnomalyCount = 0;
volatile uint32_t tasAnomalySequence = 0;
volatile uint8_t tasAnomalyKind = 0;
volatile uint8_t tasAnomalyPendingMark = 0;
NesTasPlayback tasPlayback;
FspTimer tasServiceTimer;

void setupNesPins();
void setupDiagnosticPins();
void setupTasServiceTimer();
void printStartupBanner();
void processSerialInput();
bool processCommandLine(const char* line, char* response, size_t responseLength);
void formatOkResponse(const Command& command, char* response, size_t responseLength);
void formatStatusResponse(char* response, size_t responseLength);
void formatTasStatusResponse(const char* commandName, char* response, size_t responseLength);
void formatTasChunkResponse(char* response, size_t responseLength);
void formatTasTraceResponse(const Command& command, char* response, size_t responseLength);
void dispatchCommand(const Command& command);
bool processTasCommand(const Command& command, char* response, size_t responseLength);
void serviceTasWindowExpiry();
void handleTasServiceTimer(timer_callback_args_t* args);
bool latchWindowOpenForPreAdvance(uint32_t nowMicros);
bool latchWithinCurrentWindow(uint32_t nowMicros, uint32_t previousLatchMicros);
void driveDataPinHigh();
void driveDataPinLow();
void drivePort2DataPinHigh();
void drivePort2DataPinLow();
void writeDataPinLevels(bool port1High, bool port2High);
void writeDataPinsForMasks(tasdeck::TasFrameMasks masks);
void applyButtonCommandToOutput(const Command& command);
void resetTasTrace();
void resumeTasTrace();
void noteTasAnomaly(uint8_t kind);
void recordTasTrace(TasPlaybackResult result, uint32_t tasFrame, uint8_t port, uint8_t polledMask, uint8_t clockedMask);
void restoreDiagnosticForcedMask();
void raiseNesPinInterruptPriority();
void refreshControllerOutput();
void writeDataPins();
bool dataLineHigh();
bool port2DataLineHigh();
bool latchLineHigh();
void latchControllers();
void handlePort1Latch();
void handleLatchEdge();
void handlePort1Clock();
void handlePort2Clock();
void setIsrDebugPin(bool high);

}  // namespace

void setup() {
  pinMode(kStatusLedPin, OUTPUT);
  digitalWrite(kStatusLedPin, LOW);
  setupDiagnosticPins();
  setupNesPins();
  setupTasServiceTimer();

  if (kDiagnosticForcedMask != 0) {
    noInterrupts();
    restoreDiagnosticForcedMask();
    writeDataPins();
    interrupts();
    digitalWrite(kStatusLedPin, HIGH);
  }

  Serial.begin(kBaudRate);
  const unsigned long startedAt = millis();
  while (!Serial && millis() - startedAt < 2500) {
  }

  if (Serial) {
    printStartupBanner();
  }
}

void loop() {
  serviceTasWindowExpiry();
  processSerialInput();
}

namespace {

void printStartupBanner() {
  Serial.println("TASDeck Uno R4 serial bridge ready");
  Serial.print("Firmware: ");
  Serial.println(kFirmwareId);
  Serial.print("Transport: ");
  Serial.print(kTransportMode);
  Serial.print(" ");
  Serial.print(kBaudRate);
  Serial.println(" baud");
  Serial.print("NES latch reload edge: ");
  Serial.println(kLatchEdgeMode);
  Serial.print("NES clock shift edge: ");
  Serial.println(kClockEdgeMode);
  Serial.println("Protocol: PING | STATUS | BUTTON [1|2] <button> <down|up> | TAS_BEGIN <frames> poll [ports] [window_us] | TAS_CHUNK <start> <count> [ports] <hex_masks> <checksum> | TAS_START [delay_frames] | TAS_CANCEL | TAS_END | TAS_STATUS | TAS_TRACE [count] [start] | TAS_TRACE_RESUME");
  Serial.println("NES pins: P1 latch D2 clock D3 data D6, P2 latch D12 clock D8 data D7");
  if (kDiagnosticForcedMask != 0) {
    Serial.print("DIAGNOSTIC: forced controller mask 0x");
    if (kDiagnosticForcedMask < 0x10) {
      Serial.print("0");
    }
    Serial.println(kDiagnosticForcedMask, HEX);
  }
  if (kIsrDebugPin >= 0) {
    Serial.print("DIAGNOSTIC: ISR debug pin D");
    Serial.println(kIsrDebugPin);
  }
}

void setupNesPins() {
  pinMode(kPort1LatchPin, INPUT);
  pinMode(kPort1ClockPin, INPUT);
  pinMode(kPort1DataPin, OUTPUT);
  // The NES exposes the same latch/strobe on both controller connectors. D12
  // may stay physically connected for wiring convenience, but D2 is the sole
  // interrupt source so one console strobe cannot run two latch ISRs.
  pinMode(kPort2LatchPin, INPUT_PULLUP);
  // Port 2 is optional. Keep an unwired clock input at its idle HIGH level so
  // noise cannot look like a completed controller read and advance playback.
  pinMode(kPort2ClockPin, INPUT_PULLUP);
  pinMode(kPort2DataPin, OUTPUT);
  digitalWrite(kPort1DataPin, HIGH);
  digitalWrite(kPort2DataPin, HIGH);

  // Reload once per strobe. The data line is already pre-positioned between
  // polls, and avoiding the falling-edge ISR keeps the latch path short enough
  // that pending clock edges do not coalesce into 7-clock torn reads.
  attachInterrupt(digitalPinToInterrupt(kPort1LatchPin), handlePort1Latch, RISING);
  // The NES samples D0 when CLK goes high-to-low; a standard 4021 shifts when
  // CLK returns low-to-high. Shift on the rising edge so D6 stays stable for
  // the full read pulse.
  attachInterrupt(digitalPinToInterrupt(kPort1ClockPin), handlePort1Clock, RISING);
  attachInterrupt(digitalPinToInterrupt(kPort2ClockPin), handlePort2Clock, RISING);
  raiseNesPinInterruptPriority();
}

void raiseNesPinInterruptPriority() {
  // The console gives the controller only a few microseconds between strobe
  // and clock edges. A UART or timer interrupt that delays the latch/clock
  // ISRs past that window corrupts a read, so the NES pin interrupts must
  // preempt everything else. D2 (shared latch) is P104/IRQ1, D3 (P1 clock)
  // is P105/IRQ0, and D8 (P2 clock) is P304/IRQ9; attachInterrupt leaves them
  // at the shared default priority.
  //
  // The latch must outrank the clocks, not just tie them: when edges pend
  // behind a blocked stretch (the core masks interrupts briefly in its USB
  // serial paths), equal priorities fall back to exception-number order and
  // IRQ0 — the clock — would run before the strobe that frames it. The clock
  // ISR would then see a stale shift register, drop the first shift, and the
  // train ends at 7 of 8 clocks: an unrecorded poll that the console pairs
  // against a clean re-read. With the latch strictly first, a delayed train
  // replays in the right order and stays correct.
  for (uint32_t slot = 0; slot < BSP_ICU_VECTOR_MAX_ENTRIES; ++slot) {
    const uint32_t event = R_ICU->IELSR[slot] & R_ICU_IELSR_IELS_Msk;
    if (event == ELC_EVENT_ICU_IRQ1) {
      NVIC_SetPriority(static_cast<IRQn_Type>(slot), 0);  // shared latch (D2)
    } else if (event == ELC_EVENT_ICU_IRQ0) {
      NVIC_SetPriority(static_cast<IRQn_Type>(slot), 1);  // P1 clock (D3)
    } else if (event == ELC_EVENT_ICU_IRQ9) {
      NVIC_SetPriority(static_cast<IRQn_Type>(slot), 1);  // P2 clock (D8)
    }
  }
}

void setupDiagnosticPins() {
  if (kIsrDebugPin < 0) {
    return;
  }

  pinMode(kIsrDebugPin, OUTPUT);
  digitalWrite(kIsrDebugPin, LOW);
}

void setupTasServiceTimer() {
  uint8_t timerType = GPT_TIMER;
  const int8_t timerChannel = FspTimer::get_available_timer(timerType);
  if (timerChannel < 0) {
    return;
  }

  if (!tasServiceTimer.begin(
        TIMER_MODE_PERIODIC,
        timerType,
        static_cast<uint8_t>(timerChannel),
        kTasServiceTimerHz,
        50.0f,
        handleTasServiceTimer,
        nullptr)) {
    return;
  }

  tasServiceTimer.set_period_buffer(false);
  if (!tasServiceTimer.setup_overflow_irq(kTasServiceTimerPriority)) {
    return;
  }
  if (!tasServiceTimer.open()) {
    return;
  }
  tasServiceTimer.start();
}

void processSerialInput() {
  while (Serial.available() > 0) {
    const char incoming = static_cast<char>(Serial.read());

    if (incoming == '\n' || incoming == '\r') {
      if (lineLength > 0) {
        lineBuffer[lineLength] = '\0';
        char response[kResponseBufferLength] = {};
        processCommandLine(lineBuffer, response, sizeof(response));
        Serial.println(response);
        lineLength = 0;
        // A drained serial burst can hold several commands; keep the latch
        // window service running between them so a pre-advance is never late.
        serviceTasWindowExpiry();
      }
      continue;
    }

    if (lineLength < kLineBufferLength - 1) {
      lineBuffer[lineLength] = incoming;
      lineLength += 1;
    } else {
      lineLength = 0;
      Serial.println("ERR line_too_long");
    }
  }
}

bool processCommandLine(const char* line, char* response, size_t responseLength) {
  Command command;
  if (!parseCommand(line, command)) {
    snprintf(response, responseLength, "ERR invalid_command %.64s", line);
    return false;
  }

  if (command.type == CommandType::Status) {
    formatStatusResponse(response, responseLength);
    return true;
  }

  if (
    command.type == CommandType::TasBegin ||
    command.type == CommandType::TasChunk ||
    command.type == CommandType::TasStart ||
    command.type == CommandType::TasCancel ||
    command.type == CommandType::TasEnd ||
    command.type == CommandType::TasStatus ||
    command.type == CommandType::TasTrace ||
    command.type == CommandType::TasTraceResume) {
    return processTasCommand(command, response, responseLength);
  }

  dispatchCommand(command);
  formatOkResponse(command, response, responseLength);
  return true;
}

void formatOkResponse(const Command& command, char* response, size_t responseLength) {
  if (command.type == CommandType::Button) {
    if (command.controllerPort == 1) {
      snprintf(
        response,
        responseLength,
        "OK %s %s %s",
        commandTypeName(command.type),
        buttonName(command.button),
        actionName(command.action));
    } else {
      snprintf(
        response,
        responseLength,
        "OK %s %u %s %s",
        commandTypeName(command.type),
        command.controllerPort,
        buttonName(command.button),
        actionName(command.action));
    }
    return;
  }

  snprintf(response, responseLength, "OK %s", commandTypeName(command.type));
}

void formatStatusResponse(char* response, size_t responseLength) {
  uint8_t pressedSnapshot = 0;
  uint8_t latchedSnapshot = 0;
  uint8_t shiftIndexSnapshot = 0;
  uint8_t pressed2Snapshot = 0;
  uint8_t latched2Snapshot = 0;
  uint8_t shiftIndex2Snapshot = 0;
  bool dataLineHighSnapshot = false;
  bool dataLine2HighSnapshot = false;
  unsigned long latchCountSnapshot = 0;
  unsigned long clockCountSnapshot = 0;
  unsigned long clock2CountSnapshot = 0;
  bool tasActiveSnapshot = false;
  bool tasOutputEnabledSnapshot = false;
  uint32_t tasStartDelayPollsSnapshot = 0;
  bool tasReadySnapshot = false;
  bool tasStartRequestedSnapshot = false;
  bool tasStartedSnapshot = false;
  bool tasCompleteSnapshot = false;
  uint32_t tasCurrentFrameSnapshot = 0;
  uint32_t tasTotalFramesSnapshot = 0;
  uint32_t tasTotalReceivedSnapshot = 0;
  uint16_t tasBufferedFramesSnapshot = 0;
  tasdeck::TasSyncMode tasSyncModeSnapshot = tasdeck::TasSyncMode::Unknown;
  TasPlaybackResult tasErrorSnapshot = TasPlaybackResult::Ok;

  // Field reads are individually atomic on this core, and momentary skew
  // between status fields is harmless. Masking interrupts here would delay
  // the NES pin ISRs while the bridge polls status during playback.
  pressedSnapshot = controllerPressedMask;
  latchedSnapshot = controllerLatchedMask;
  shiftIndexSnapshot = controllerShiftIndex;
  pressed2Snapshot = controller2PressedMask;
  latched2Snapshot = controller2LatchedMask;
  shiftIndex2Snapshot = controller2ShiftIndex;
  dataLineHighSnapshot = dataLineHigh();
  dataLine2HighSnapshot = port2DataLineHigh();
  latchCountSnapshot = controllerLatchCount;
  clockCountSnapshot = controllerClockCount;
  clock2CountSnapshot = controller2ClockCount;
  tasActiveSnapshot = tasPlayback.active();
  tasOutputEnabledSnapshot = tasOutputEnabled;
  tasStartDelayPollsSnapshot = tasPlayback.startDelayRemaining();
  tasReadySnapshot = tasPlayback.ready();
  tasStartRequestedSnapshot = tasPlayback.startRequested();
  tasStartedSnapshot = tasPlayback.started();
  tasCompleteSnapshot = tasPlayback.complete();
  tasCurrentFrameSnapshot = tasPlayback.currentFrame();
  tasTotalFramesSnapshot = tasPlayback.totalFrames();
  tasTotalReceivedSnapshot = tasPlayback.totalReceived();
  tasBufferedFramesSnapshot = tasPlayback.bufferedFrames();
  tasSyncModeSnapshot = tasPlayback.syncMode();
  tasErrorSnapshot = tasPlayback.error();

  snprintf(
    response,
    responseLength,
    "OK status fw=%s transport=%s latch_edge=%s clock_edge=%s forced=%02X debug_pin=%d pressed=%02X latched=%02X index=%u data=%u pressed2=%02X latched2=%02X index2=%u data2=%u latch=%lu clock=%lu clock2=%lu tas_active=%u tas_output_enabled=%u tas_start_delay_polls=%lu tas_ready=%u tas_start_requested=%u tas_started=%u tas_complete=%u tas_current=%lu tas_total=%lu tas_received=%lu tas_buffered=%u tas_ports=%u tas_sync=%s tas_error=%s",
    kFirmwareId,
    kTransportMode,
    kLatchEdgeMode,
    kClockEdgeMode,
    kDiagnosticForcedMask,
    kIsrDebugPin,
    pressedSnapshot,
    latchedSnapshot,
    shiftIndexSnapshot,
    dataLineHighSnapshot ? 1 : 0,
    pressed2Snapshot,
    latched2Snapshot,
    shiftIndex2Snapshot,
    dataLine2HighSnapshot ? 1 : 0,
    latchCountSnapshot,
    clockCountSnapshot,
    clock2CountSnapshot,
    tasActiveSnapshot ? 1 : 0,
    tasOutputEnabledSnapshot ? 1 : 0,
    static_cast<unsigned long>(tasStartDelayPollsSnapshot),
    tasReadySnapshot ? 1 : 0,
    tasStartRequestedSnapshot ? 1 : 0,
    tasStartedSnapshot ? 1 : 0,
    tasCompleteSnapshot ? 1 : 0,
    static_cast<unsigned long>(tasCurrentFrameSnapshot),
    static_cast<unsigned long>(tasTotalFramesSnapshot),
    static_cast<unsigned long>(tasTotalReceivedSnapshot),
    tasBufferedFramesSnapshot,
    tasPlayback.portCount(),
    tasSyncModeName(tasSyncModeSnapshot),
    tasPlaybackResultName(tasErrorSnapshot));
}

void formatTasStatusResponse(const char* commandName, char* response, size_t responseLength) {
  bool activeSnapshot = false;
  bool readySnapshot = false;
  bool startRequestedSnapshot = false;
  bool startedSnapshot = false;
  bool completeSnapshot = false;
  bool receivingCompleteSnapshot = false;
  uint32_t currentFrameSnapshot = 0;
  uint32_t totalFramesSnapshot = 0;
  uint32_t totalReceivedSnapshot = 0;
  uint16_t bufferedFramesSnapshot = 0;
  uint16_t capacitySnapshot = 0;
  tasdeck::TasFrameMasks currentMasksSnapshot = {};
  uint8_t pressedSnapshot = 0;
  uint8_t latchedSnapshot = 0;
  uint8_t shiftIndexSnapshot = 0;
  uint8_t pressed2Snapshot = 0;
  uint8_t latched2Snapshot = 0;
  uint8_t shiftIndex2Snapshot = 0;
  bool dataLineHighSnapshot = false;
  bool dataLine2HighSnapshot = false;
  bool outputEnabledSnapshot = false;
  uint32_t startDelayPollsSnapshot = 0;
  uint32_t latchWindowSnapshot = 0;
  uint8_t portCountSnapshot = 1;
  tasdeck::TasSyncMode syncModeSnapshot = tasdeck::TasSyncMode::Unknown;
  unsigned long latchCountSnapshot = 0;
  unsigned long clockCountSnapshot = 0;
  unsigned long clock2CountSnapshot = 0;
  TasPlaybackResult errorSnapshot = TasPlaybackResult::Ok;

  // Unmasked snapshot: see formatStatusResponse. The bridge polls TAS_STATUS
  // throughout playback, so this path must never delay the NES pin ISRs.
  activeSnapshot = tasPlayback.active();
  readySnapshot = tasPlayback.ready();
  startRequestedSnapshot = tasPlayback.startRequested();
  startedSnapshot = tasPlayback.started();
  completeSnapshot = tasPlayback.complete();
  receivingCompleteSnapshot = tasPlayback.receivingComplete();
  currentFrameSnapshot = tasPlayback.currentFrame();
  totalFramesSnapshot = tasPlayback.totalFrames();
  totalReceivedSnapshot = tasPlayback.totalReceived();
  bufferedFramesSnapshot = tasPlayback.bufferedFrames();
  capacitySnapshot = tasPlayback.capacity();
  currentMasksSnapshot = tasPlayback.currentMasks();
  pressedSnapshot = controllerPressedMask;
  latchedSnapshot = controllerLatchedMask;
  shiftIndexSnapshot = controllerShiftIndex;
  pressed2Snapshot = controller2PressedMask;
  latched2Snapshot = controller2LatchedMask;
  shiftIndex2Snapshot = controller2ShiftIndex;
  dataLineHighSnapshot = dataLineHigh();
  dataLine2HighSnapshot = port2DataLineHigh();
  outputEnabledSnapshot = tasOutputEnabled;
  startDelayPollsSnapshot = tasPlayback.startDelayRemaining();
  latchWindowSnapshot = tasPlayback.latchWindowMicros();
  portCountSnapshot = tasPlayback.portCount();
  syncModeSnapshot = tasPlayback.syncMode();
  latchCountSnapshot = controllerLatchCount;
  clockCountSnapshot = controllerClockCount;
  clock2CountSnapshot = controller2ClockCount;
  errorSnapshot = tasPlayback.error();

  snprintf(
    response,
    responseLength,
    "OK %s fw=%s latch_edge=%s clock_edge=%s active=%u ready=%u start_requested=%u started=%u complete=%u receiving_complete=%u current=%lu total=%lu received=%lu buffered=%u capacity=%u ports=%u mask=%02X mask2=%02X pressed=%02X latched=%02X index=%u data=%u pressed2=%02X latched2=%02X index2=%u data2=%u output_enabled=%u start_delay_polls=%lu window_us=%lu sync=%s latch=%lu clock=%lu clock2=%lu error=%s anomaly_count=%lu anomaly_seq=%lu anomaly_kind=%u trace_frozen=%u",
    commandName,
    kFirmwareId,
    kLatchEdgeMode,
    kClockEdgeMode,
    activeSnapshot ? 1 : 0,
    readySnapshot ? 1 : 0,
    startRequestedSnapshot ? 1 : 0,
    startedSnapshot ? 1 : 0,
    completeSnapshot ? 1 : 0,
    receivingCompleteSnapshot ? 1 : 0,
    static_cast<unsigned long>(currentFrameSnapshot),
    static_cast<unsigned long>(totalFramesSnapshot),
    static_cast<unsigned long>(totalReceivedSnapshot),
    bufferedFramesSnapshot,
    capacitySnapshot,
    portCountSnapshot,
    currentMasksSnapshot.port1,
    currentMasksSnapshot.port2,
    pressedSnapshot,
    latchedSnapshot,
    shiftIndexSnapshot,
    dataLineHighSnapshot ? 1 : 0,
    pressed2Snapshot,
    latched2Snapshot,
    shiftIndex2Snapshot,
    dataLine2HighSnapshot ? 1 : 0,
    outputEnabledSnapshot ? 1 : 0,
    static_cast<unsigned long>(startDelayPollsSnapshot),
    static_cast<unsigned long>(latchWindowSnapshot),
    tasSyncModeName(syncModeSnapshot),
    latchCountSnapshot,
    clockCountSnapshot,
    clock2CountSnapshot,
    tasPlaybackResultName(errorSnapshot),
    static_cast<unsigned long>(tasAnomalyCount),
    static_cast<unsigned long>(tasAnomalySequence),
    tasAnomalyKind,
    tasTraceFrozen ? 1 : 0);
}

void formatTasChunkResponse(char* response, size_t responseLength) {
  const bool activeSnapshot = tasPlayback.active();
  const bool readySnapshot = tasPlayback.ready();
  const bool startedSnapshot = tasPlayback.started();
  const bool completeSnapshot = tasPlayback.complete();
  const bool receivingCompleteSnapshot = tasPlayback.receivingComplete();
  const uint32_t currentFrameSnapshot = tasPlayback.currentFrame();
  const uint32_t totalFramesSnapshot = tasPlayback.totalFrames();
  const uint32_t totalReceivedSnapshot = tasPlayback.totalReceived();
  const uint16_t bufferedFramesSnapshot = tasPlayback.bufferedFrames();
  const uint16_t capacitySnapshot = tasPlayback.capacity();
  const uint8_t portCountSnapshot = tasPlayback.portCount();
  const TasPlaybackResult errorSnapshot = tasPlayback.error();

  snprintf(
    response,
    responseLength,
    "OK tas_chunk active=%u ready=%u started=%u complete=%u receiving_complete=%u current=%lu total=%lu received=%lu buffered=%u capacity=%u ports=%u error=%s anomaly_count=%lu anomaly_seq=%lu anomaly_kind=%u trace_frozen=%u",
    activeSnapshot ? 1 : 0,
    readySnapshot ? 1 : 0,
    startedSnapshot ? 1 : 0,
    completeSnapshot ? 1 : 0,
    receivingCompleteSnapshot ? 1 : 0,
    static_cast<unsigned long>(currentFrameSnapshot),
    static_cast<unsigned long>(totalFramesSnapshot),
    static_cast<unsigned long>(totalReceivedSnapshot),
    bufferedFramesSnapshot,
    capacitySnapshot,
    portCountSnapshot,
    tasPlaybackResultName(errorSnapshot),
    static_cast<unsigned long>(tasAnomalyCount),
    static_cast<unsigned long>(tasAnomalySequence),
    tasAnomalyKind,
    tasTraceFrozen ? 1 : 0);
}

void formatTasTraceResponse(const Command& command, char* response, size_t responseLength) {
  TasTraceEntry page[tasdeck::kTasTracePageLimit] = {};
  uint16_t totalSnapshot = 0;
  uint32_t firstSequenceSnapshot = 0;
  uint32_t nextSequenceSnapshot = 0;
  uint32_t pageStart = 0;
  uint8_t pageCount = 0;

  noInterrupts();
  totalSnapshot = tasTraceCount;
  nextSequenceSnapshot = tasTraceNextSequence;
  firstSequenceSnapshot = nextSequenceSnapshot - totalSnapshot;

  pageStart = command.traceHasStart
    ? command.traceStart
    : (nextSequenceSnapshot > command.traceCount ? nextSequenceSnapshot - command.traceCount : firstSequenceSnapshot);
  if (pageStart < firstSequenceSnapshot) {
    pageStart = firstSequenceSnapshot;
  }
  if (pageStart > nextSequenceSnapshot) {
    pageStart = nextSequenceSnapshot;
  }

  const uint32_t available = nextSequenceSnapshot - pageStart;
  uint32_t requestedCount = command.traceCount;
  if (requestedCount > available) {
    requestedCount = available;
  }
  if (requestedCount > tasdeck::kTasTracePageLimit) {
    requestedCount = tasdeck::kTasTracePageLimit;
  }
  pageCount = static_cast<uint8_t>(requestedCount);

  const uint16_t oldestIndex = static_cast<uint16_t>(
    (tasTraceHead + kTasTraceCapacity - tasTraceCount) % kTasTraceCapacity);
  for (uint8_t index = 0; index < pageCount; ++index) {
    const uint32_t sequence = pageStart + index;
    const uint16_t offset = static_cast<uint16_t>(sequence - firstSequenceSnapshot);
    const uint16_t traceIndex = static_cast<uint16_t>((oldestIndex + offset) % kTasTraceCapacity);
    page[index] = tasTrace[traceIndex];
  }
  interrupts();

  int written = snprintf(
    response,
    responseLength,
    "OK tas_trace total=%u capacity=%u first=%lu next=%lu page_start=%lu page_next=%lu count=%u rows=",
    totalSnapshot,
    kTasTraceCapacity,
    static_cast<unsigned long>(firstSequenceSnapshot),
    static_cast<unsigned long>(nextSequenceSnapshot),
    static_cast<unsigned long>(pageStart),
    static_cast<unsigned long>(pageStart + pageCount),
    pageCount);
  if (written < 0) {
    response[0] = '\0';
    return;
  }
  size_t used = static_cast<size_t>(written);
  if (used >= responseLength) {
    response[responseLength - 1] = '\0';
    return;
  }

  for (uint8_t index = 0; index < pageCount; ++index) {
    const TasTraceEntry& entry = page[index];
    written = snprintf(
      response + used,
      responseLength - used,
      "%s%lu,%lu,%lu,%lu,%lu,%u,%02X,%02X,%02X,%u,%s,%02X,%02X,%u",
      index == 0 ? "" : "|",
      static_cast<unsigned long>(pageStart + index),
      static_cast<unsigned long>(entry.timestampMicros),
      static_cast<unsigned long>(entry.tasFrame),
      static_cast<unsigned long>(entry.latchCount),
      static_cast<unsigned long>(entry.clockCount),
      entry.clocksSinceLatch,
      entry.polledMask,
      entry.nextMask,
      entry.latchedMask,
      entry.shiftIndex,
      tasPlaybackResultName(static_cast<TasPlaybackResult>(entry.result)),
      entry.clockedMask,
      entry.diag,
      entry.port);
    if (written < 0) {
      response[used] = '\0';
      return;
    }

    used += static_cast<size_t>(written);
    if (used >= responseLength) {
      response[responseLength - 1] = '\0';
      return;
    }
  }
}

void dispatchCommand(const Command& command) {
  if (command.type == CommandType::Button) {
    uint8_t pressedSnapshot = 0;

    noInterrupts();
    if (!tasPlayback.active()) {
      applyButtonCommandToOutput(command);
      refreshControllerOutput();
    }
    pressedSnapshot = static_cast<uint8_t>(controllerPressedMask | controller2PressedMask);
    interrupts();

    digitalWrite(kStatusLedPin, pressedSnapshot != 0 ? HIGH : LOW);
    return;
  }

  if (command.type == CommandType::Ping) {
    digitalWrite(kStatusLedPin, HIGH);
    delay(20);
    digitalWrite(kStatusLedPin, (controllerPressedMask | controller2PressedMask) != 0 ? HIGH : LOW);
  }
}

bool processTasCommand(const Command& command, char* response, size_t responseLength) {
  TasPlaybackResult result = TasPlaybackResult::Ok;

  if (command.type == CommandType::TasBegin) {
    noInterrupts();
    result = tasPlayback.begin(command.frameCount, command.syncMode, command.portCount, command.latchWindowMicros);
    if (result == TasPlaybackResult::Ok) {
      tasOutputEnabled = false;
      resetTasTrace();
      controllerLatchCount = 0;
      controllerClockCount = 0;
      controller2ClockCount = 0;
      controllerLastLatchMicros = 0;
      controllerClocksSinceLatch = 0;
      controller2ClocksSinceLatch = 0;
      controllerClockedMask = 0;
      controller2ClockedMask = 0;
    }
    interrupts();
  } else if (command.type == CommandType::TasChunk) {
    // The frame ring is single-producer/single-consumer with free-running
    // indices, so streaming chunks during playback needs no interrupt
    // masking that could delay the NES pin ISRs mid-poll.
    result = tasPlayback.pushChunk(command.startIndex, command.masks, command.chunkCount, command.portCount);
  } else if (command.type == CommandType::TasStart) {
    noInterrupts();
    result = tasPlayback.start(command.startDelayPolls);
    if (result == TasPlaybackResult::Ok) {
      tasOutputEnabled = true;
      resetTasTrace();
      controllerLatchCount = 0;
      controllerClockCount = 0;
      controller2ClockCount = 0;
      controllerLastLatchMicros = 0;
      controllerClocksSinceLatch = 0;
      controller2ClocksSinceLatch = 0;
      controllerClockedMask = 0;
      controller2ClockedMask = 0;
      controllerPressedMask = 0;
      controllerLatchedMask = 0;
      controllerShiftIndex = tasdeck::kNesButtonCount;
      controller2PressedMask = 0;
      controller2LatchedMask = 0;
      controller2ShiftIndex = tasdeck::kNesButtonCount;
      refreshControllerOutput();
    }
    interrupts();
  } else if (command.type == CommandType::TasCancel) {
    noInterrupts();
    tasOutputEnabled = false;
    tasPlayback.reset();
    controllerPressedMask = 0;
    controllerLatchedMask = 0;
    controllerShiftIndex = tasdeck::kNesButtonCount;
    controllerClockedMask = 0;
    controller2PressedMask = 0;
    controller2LatchedMask = 0;
    controller2ShiftIndex = tasdeck::kNesButtonCount;
    controller2ClockedMask = 0;
    refreshControllerOutput();
    interrupts();
  } else if (command.type == CommandType::TasEnd) {
    noInterrupts();
    result = tasPlayback.finishReceiving();
    interrupts();
  } else if (command.type == CommandType::TasStatus) {
    result = TasPlaybackResult::Ok;
  } else if (command.type == CommandType::TasTrace) {
    result = TasPlaybackResult::Ok;
  } else if (command.type == CommandType::TasTraceResume) {
    noInterrupts();
    resumeTasTrace();
    interrupts();
    result = TasPlaybackResult::Ok;
  } else {
    result = TasPlaybackResult::Invalid;
  }

  if (result != TasPlaybackResult::Ok) {
    snprintf(
      response,
      responseLength,
      "ERR tas_%s command=%s",
      tasPlaybackResultName(result),
      commandTypeName(command.type));
    return false;
  }

  if (command.type == CommandType::TasBegin) {
    formatTasStatusResponse("tas_begin", response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasChunk) {
    formatTasChunkResponse(response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasStart) {
    formatTasStatusResponse("tas_start", response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasCancel) {
    formatTasStatusResponse("tas_cancel", response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasEnd) {
    formatTasStatusResponse("tas_end", response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasTrace) {
    formatTasTraceResponse(command, response, responseLength);
    return true;
  }

  if (command.type == CommandType::TasTraceResume) {
    formatTasStatusResponse("tas_trace_resume", response, responseLength);
    return true;
  }

  formatTasStatusResponse("tas_status", response, responseLength);
  return true;
}

void applyButtonCommandToOutput(const Command& command) {
  if (kDiagnosticForcedMask != 0) {
    controllerPressedMask = kDiagnosticForcedMask;
    controller2PressedMask = 0;
    return;
  }

  const uint8_t mask = buttonMask(command.button);
  if (mask == 0) {
    return;
  }

  if (command.action == tasdeck::Action::Down) {
    if (command.controllerPort == 2) {
      controller2PressedMask = static_cast<uint8_t>(controller2PressedMask | mask);
    } else {
      controllerPressedMask = static_cast<uint8_t>(controllerPressedMask | mask);
    }
  } else {
    if (command.controllerPort == 2) {
      controller2PressedMask = static_cast<uint8_t>(controller2PressedMask & ~mask);
    } else {
      controllerPressedMask = static_cast<uint8_t>(controllerPressedMask & ~mask);
    }
  }
}

void resetTasTrace() {
  tasTraceHead = 0;
  tasTraceCount = 0;
  tasTraceNextSequence = 0;
  controllerDiagLineLowAtLatch = 0;
  controller2DiagLineLowAtLatch = 0;
  controllerDiagWindowKind = 0;
  controllerPollsInWindow = 0;
  controller2PollsInWindow = 0;
  tasTraceFrozen = false;
  tasTraceFreezeCountdown = 0;
  tasAnomalyCount = 0;
  tasAnomalySequence = 0;
  tasAnomalyKind = 0;
  tasAnomalyPendingMark = 0;
}

void resumeTasTrace() {
  tasTraceFrozen = false;
  tasTraceFreezeCountdown = 0;
  tasAnomalyCount = 0;
  tasAnomalySequence = 0;
  tasAnomalyKind = 0;
  tasAnomalyPendingMark = 0;
}

void noteTasAnomaly(uint8_t kind) {
  // Called from the pin ISRs when a poll looks corrupted. Record the first
  // event, then let the ring capture a little more context and freeze it so
  // the evidence survives until the user presses Trace — however late.
  // Single guard re-reads (kind 4) are counted but do not freeze: the console
  // performs them legitimately when DPCM DMA corrupts its own read of a
  // healthy line, and burning the freeze on one could hide a later fault.
  tasAnomalyCount += 1;
  tasAnomalyPendingMark = 1;
  const bool freezeWorthy = kind != kTasAnomalyReRead;
  // Freeze-worthy events own anomaly_kind/anomaly_seq. A benign re-read only
  // fills them provisionally while nothing worse has been seen, so a later
  // real fault still reports its own kind and sequence.
  if (tasAnomalyKind == 0 || (freezeWorthy && tasAnomalyKind == kTasAnomalyReRead)) {
    tasAnomalyKind = kind;
    tasAnomalySequence = tasTraceNextSequence;
  }
  if (freezeWorthy && !tasTraceFrozen && tasTraceFreezeCountdown == 0) {
    tasTraceFreezeCountdown = kTasTraceFreezeContextPolls;
  }
}

void recordTasTrace(TasPlaybackResult result, uint32_t tasFrame, uint8_t port, uint8_t polledMask, uint8_t clockedMask) {
  if (tasTraceFrozen) {
    return;
  }

  const uint16_t index = tasTraceHead;
  TasTraceEntry& entry = tasTrace[index];
  entry.timestampMicros = micros();
  entry.tasFrame = tasFrame;
  entry.latchCount = controllerLatchCount;
  entry.clockCount = port == 2 ? controller2ClockCount : controllerClockCount;
  entry.clocksSinceLatch = port == 2 ? controller2ClocksSinceLatch : controllerClocksSinceLatch;
  entry.polledMask = polledMask;
  entry.nextMask = port == 2 ? controller2PressedMask : controllerPressedMask;
  entry.latchedMask = port == 2 ? controller2LatchedMask : controllerLatchedMask;
  entry.shiftIndex = port == 2 ? controller2ShiftIndex : controllerShiftIndex;
  entry.result = static_cast<uint8_t>(result);
  entry.clockedMask = clockedMask;
  entry.diag = static_cast<uint8_t>(
    ((port == 2 ? controller2DiagLineLowAtLatch : controllerDiagLineLowAtLatch) & 0x01) |
    (controllerDiagWindowKind << 1) |
    (tasAnomalyPendingMark != 0 ? 0x10 : 0));
  entry.port = port;
  tasAnomalyPendingMark = 0;

  tasTraceNextSequence += 1;
  tasTraceHead = static_cast<uint16_t>((tasTraceHead + 1) % kTasTraceCapacity);
  if (tasTraceCount < kTasTraceCapacity) {
    tasTraceCount += 1;
  }

  if (tasTraceFreezeCountdown > 0) {
    tasTraceFreezeCountdown -= 1;
    if (tasTraceFreezeCountdown == 0) {
      tasTraceFrozen = true;
    }
  }
}

void restoreDiagnosticForcedMask() {
  controllerPressedMask = kDiagnosticForcedMask;
  controllerLatchedMask = kDiagnosticForcedMask;
  controllerShiftIndex = 0;
  controllerClockedMask = 0;
  controller2PressedMask = 0;
  controller2LatchedMask = 0;
  controller2ShiftIndex = 0;
  controller2ClockedMask = 0;
}

void refreshControllerOutput() {
  if (latchLineHigh()) {
    latchControllers();
  }
  writeDataPins();
}

void serviceTasWindowExpiry() {
  // Advance to the next mask as soon as the latch window closes instead of
  // waiting for the next strobe. The console samples bit 0 (A) only a few
  // microseconds after the strobe edge — sooner than the latch ISR can update
  // the data line — so the next frame's bit 0 must already be on the wire
  // when the strobe arrives. This runs mid-gap, milliseconds away from any
  // expected edge, so the short interrupt-masked section is harmless. If the
  // loop ever misses a window, the latch ISR falls back to advancing in
  // place, and the trace diag field records which path served each window.
  if (kDiagnosticForcedMask != 0) {
    return;
  }

  uint32_t nowMicros = micros();
  if (latchWindowOpenForPreAdvance(nowMicros) || !tasPlayback.windowExpiryDue(nowMicros)) {
    return;
  }

  noInterrupts();
  nowMicros = micros();
  if (latchWindowOpenForPreAdvance(nowMicros) || !tasPlayback.windowExpiryDue(nowMicros)) {
    interrupts();
    return;
  }
  tasdeck::TasFrameMasks nextMasks = {
    controllerPressedMask,
    controller2PressedMask,
  };
  const TasPlaybackResult result = tasPlayback.onWindowExpired(nowMicros, nextMasks);
  if (
    result == TasPlaybackResult::Ok ||
    result == TasPlaybackResult::Complete ||
    result == TasPlaybackResult::Underrun) {
    controllerPressedMask = nextMasks.port1;
    controller2PressedMask = nextMasks.port2;
    if (result != TasPlaybackResult::Ok) {
      tasOutputEnabled = false;
    }
    // Re-latch, do not just rewrite the pin. Games that read controller 2
    // (SMB3) pulse the shared strobe line without clocking port 1, leaving
    // controllerShiftIndex at 0 with the previous frame's latched mask, and a
    // bare writeDataPins() would keep driving that stale first bit. The next
    // strobe re-latches identically, so this only moves that work off the
    // critical strobe-to-first-read path.
    controllerLatchedMask = nextMasks.port1;
    controllerShiftIndex = 0;
    controllerClockedMask = 0;
    controller2LatchedMask = nextMasks.port2;
    controller2ShiftIndex = 0;
    controller2ClockedMask = 0;
    writeDataPins();
  }
  interrupts();
}

void handleTasServiceTimer(timer_callback_args_t* args) {
  (void) args;
  serviceTasWindowExpiry();
}

bool latchWindowOpenForPreAdvance(uint32_t nowMicros) {
  const uint32_t lastLatchMicros = controllerLastLatchMicros;
  return latchWithinCurrentWindow(nowMicros, lastLatchMicros);
}

bool latchWithinCurrentWindow(uint32_t nowMicros, uint32_t previousLatchMicros) {
  // Signed comparison: micros() read from the latch ISR (priority 0) can race
  // the core's 1 kHz tick and transiently report +1 ms (observed as ...010
  // timestamps stepping backwards in traces). A backwards step must count as
  // "same window"; unsigned it wraps to a huge gap, opens a phantom window in
  // the middle of a poll cluster, and double-advances the movie (the
  // 2026-07-10 Zelda dungeon-1 desync).
  return previousLatchMicros != 0 &&
    static_cast<int32_t>(nowMicros - previousLatchMicros) <
      static_cast<int32_t>(tasPlayback.latchWindowMicros());
}

void driveDataPinHigh() {
  // PCNTR3 set/reset halves write a single pin atomically: no
  // read-modify-write of PODR that a higher-priority ISR could interleave.
  R_PORT1->PCNTR3 = kPort1DataBit;
}

void driveDataPinLow() {
  R_PORT1->PCNTR3 = static_cast<uint32_t>(kPort1DataBit) << 16;
}

void drivePort2DataPinHigh() {
  R_PORT1->PCNTR3 = kPort2DataBit;
}

void drivePort2DataPinLow() {
  R_PORT1->PCNTR3 = static_cast<uint32_t>(kPort2DataBit) << 16;
}

void writeDataPinLevels(bool port1High, bool port2High) {
  uint32_t setBits = 0;
  uint32_t resetBits = 0;

  if (port1High) {
    setBits |= kPort1DataBit;
  } else {
    resetBits |= kPort1DataBit;
  }

  if (port2High) {
    setBits |= kPort2DataBit;
  } else {
    resetBits |= kPort2DataBit;
  }

  // Keep set and reset operations in separate register writes. A mixed
  // PCNTR3 write (one data pin HIGH while the other goes LOW) was observed to
  // leave the reset pin stale until its clock ISR ran. That loses bit 0 on
  // the first read after an A transition. The writes still target independent
  // pins atomically and run with interrupts masked or from a pin ISR.
  if (resetBits != 0) {
    R_PORT1->PCNTR3 = resetBits << 16;
  }
  if (setBits != 0) {
    R_PORT1->PCNTR3 = setBits;
  }
}

void writeDataPinsForMasks(tasdeck::TasFrameMasks masks) {
  const tasdeck::NesControllerDataLevels levels = tasdeck::firstDataLineLevels(masks);
  writeDataPinLevels(levels.port1High, levels.port2High);
}

void writeDataPins() {
  writeDataPinLevels(dataLineHigh(), port2DataLineHigh());
}

bool dataLineHigh() {
  // Between polls the line pre-positions bit 0 (A) of the mask the next
  // strobe will serve. A real 4021 outputs the live bit-0 state whenever the
  // strobe is high, so the console's first sample — only a few microseconds
  // after the strobe edge — is valid without waiting on latch-ISR latency.
  if (controllerShiftIndex >= tasdeck::kNesButtonCount) {
    return (controllerPressedMask & 0x01) == 0;
  }

  const uint8_t mask = static_cast<uint8_t>(1 << controllerShiftIndex);
  return (controllerLatchedMask & mask) == 0;
}

bool port2DataLineHigh() {
  if (controller2ShiftIndex >= tasdeck::kNesButtonCount) {
    return (controller2PressedMask & 0x01) == 0;
  }

  const uint8_t mask = static_cast<uint8_t>(1 << controller2ShiftIndex);
  return (controller2LatchedMask & mask) == 0;
}

bool latchLineHigh() {
  return (R_PORT1->PIDR & kPort1LatchBit) != 0;
}

void latchControllers() {
  controllerLatchedMask = controllerPressedMask;
  controllerShiftIndex = 0;
  controllerClockedMask = 0;
  controller2LatchedMask = controller2PressedMask;
  controller2ShiftIndex = 0;
  controller2ClockedMask = 0;
}

void handlePort1Latch() {
  handleLatchEdge();
}

void handleLatchEdge() {
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif
  // Capture the pin states, then drive the pending mask's first bit before
  // any bookkeeping: the console samples bit 0 only a few microseconds after
  // the strobe edge, and in the steady state the window pre-advance has
  // already loaded controllerPressedMask with the mask this strobe serves.
  const uint16_t pinsAtEntry = R_PORT1->PIDR;
  const uint32_t previousLatchMicros = controllerLastLatchMicros;
  const uint32_t latchMicros = micros();
  const bool sameHardwareWindow = latchWithinCurrentWindow(latchMicros, previousLatchMicros);
  tasdeck::TasFrameMasks firstBitMasks = {
    controllerPressedMask,
    controller2PressedMask,
  };
  if (
    kDiagnosticForcedMask == 0 &&
    !sameHardwareWindow &&
    tasPlayback.willAdvanceOnEdge()) {
    firstBitMasks = tasPlayback.stagedNextMasks();
  }

  writeDataPinsForMasks(firstBitMasks);
  // Record whether the served first bit was already on the wire before this
  // interrupt touched it. The callback is attached to RISING, but the strobe
  // pulse can already be low again by the time software reads the port.
  controllerDiagLineLowAtLatch = (pinsAtEntry & kPort1DataBit) == 0 ? 1 : 0;
  controller2DiagLineLowAtLatch = (pinsAtEntry & kPort2DataBit) == 0 ? 1 : 0;

  // A strobe should only ever find the shift register idle (8) or freshly
  // latched (0); 1..7 means the previous train ended short — a clock edge was
  // lost and the console just read a duplicated bit.
  const uint8_t shiftAtStrobe = controllerShiftIndex;
  if (tasOutputEnabled && shiftAtStrobe >= 1 && shiftAtStrobe < tasdeck::kNesButtonCount) {
    noteTasAnomaly(kTasAnomalyTornTrain);
  }
  const uint8_t shift2AtStrobe = controller2ShiftIndex;
  if (tasOutputEnabled && shift2AtStrobe >= 1 && shift2AtStrobe < tasdeck::kNesButtonCount) {
    noteTasAnomaly(kTasAnomalyTornTrain);
  }

  controllerLatchCount += 1;
  controllerClocksSinceLatch = 0;
  controllerClockedMask = 0;
  controller2ClocksSinceLatch = 0;
  controller2ClockedMask = 0;
  controllerLastLatchMicros = latchMicros;

  // Latch edges drive playback. Edges separated by less than the latch window
  // belong to the same console frame and re-serve the current mask, so games
  // that strobe and read several times per frame (SMB3, Tetris) consume
  // exactly one mask per frame no matter how many re-reads happen. The edge
  // tracker runs from TAS_BEGIN (before TAS_START it never changes the output)
  // so arming mid-frame holds frame 0 until the next frame boundary.
  if (kDiagnosticForcedMask == 0 && tasPlayback.active()) {
    if (!sameHardwareWindow) {
      controllerPollsInWindow = 0;
      controller2PollsInWindow = 0;
      tasdeck::TasFrameMasks nextMasks = {
        controllerPressedMask,
        controller2PressedMask,
      };
      const TasPlaybackResult result = tasPlayback.onLatchEdge(latchMicros, nextMasks);
      if (
        result == TasPlaybackResult::Ok ||
        result == TasPlaybackResult::Complete ||
        result == TasPlaybackResult::Underrun) {
        controllerPressedMask = nextMasks.port1;
        controller2PressedMask = nextMasks.port2;
      }
      if (result == TasPlaybackResult::Complete || result == TasPlaybackResult::Underrun) {
        tasOutputEnabled = false;
      }
      const tasdeck::TasEdgeKind kind = tasPlayback.lastEdgeKind();
      controllerDiagWindowKind = static_cast<uint8_t>(kind);
      // A pre-advanced, fallback-advanced, or freshly started window must
      // have the served first bit on the wire at the strobe. If the strobe
      // found the opposite level, an A-transition was at risk even if the ISR
      // corrected the pin immediately after entry.
      if (
        tasOutputEnabled &&
        (kind == static_cast<tasdeck::TasEdgeKind>(tasdeck::TasEdgeKind::PreAdvanced) ||
          kind == static_cast<tasdeck::TasEdgeKind>(tasdeck::TasEdgeKind::AdvancedAtEdge) ||
          kind == static_cast<tasdeck::TasEdgeKind>(tasdeck::TasEdgeKind::Started))) {
        const uint8_t expectedLow = (controllerPressedMask & 0x01) != 0 ? 1 : 0;
        if (controllerDiagLineLowAtLatch != expectedLow) {
          noteTasAnomaly(kTasAnomalyLineMismatch);
        }
        const uint8_t expected2Low = (controller2PressedMask & 0x01) != 0 ? 1 : 0;
        if (controller2DiagLineLowAtLatch != expected2Low) {
          noteTasAnomaly(kTasAnomalyLineMismatch);
        }
      }
    }
  }

  controllerLatchedMask = controllerPressedMask;
  controllerShiftIndex = 0;
  controller2LatchedMask = controller2PressedMask;
  controller2ShiftIndex = 0;
  writeDataPinsForMasks({
    controllerLatchedMask,
    controller2LatchedMask,
  });

#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(false);
#endif
}

void handlePort1Clock() {
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif

  controllerClockCount += 1;
  if (controllerClocksSinceLatch < 0xff) {
    controllerClocksSinceLatch += 1;
  }
  bool completedPoll = false;

  if (latchLineHigh()) {
    controllerLatchedMask = controllerPressedMask;
    controllerShiftIndex = 0;
    controllerClockedMask = 0;
  } else if (controllerShiftIndex < tasdeck::kNesButtonCount) {
    if ((R_PORT1->PIDR & kPort1DataBit) == 0) {
      controllerClockedMask = static_cast<uint8_t>(
        controllerClockedMask | static_cast<uint8_t>(1 << controllerShiftIndex));
    }
    controllerShiftIndex = static_cast<uint8_t>(controllerShiftIndex + 1);
    completedPoll = controllerShiftIndex >= tasdeck::kNesButtonCount;
  }

  // After the 8th shift the line pre-positions bit 0 (A) for the next strobe
  // (see dataLineHigh); same-frame re-polls arrive ~120 microseconds later
  // and must not race the latch ISR for the first bit.
  const bool high = controllerShiftIndex >= tasdeck::kNesButtonCount
    ? (controllerPressedMask & 0x01) == 0
    : (controllerLatchedMask & static_cast<uint8_t>(1 << controllerShiftIndex)) == 0;

  if (high) {
    driveDataPinHigh();
  } else {
    driveDataPinLow();
  }

  if (completedPoll) {
    // Completed 8-clock reads gate playback: a latch window must contain one
    // before the next window advances, so bare boot strobes and latch noise
    // never consume masks. They are also recorded so traces still show every
    // poll the console performed, tagged with the frame index and the result
    // of the frame's latch-window decision.
    tasPlayback.notePollCompleted(1);
    if (controllerPollsInWindow < 0xff) {
      controllerPollsInWindow += 1;
    }
    if (tasOutputEnabled) {
      // The reconstructed wire levels must match the served mask, the games
      // this project targets poll at most twice per frame, and more than two
      // extra guard re-reads in one window means the console repeatedly
      // failed to get two matching reads of a supposedly stable line.
      if (controllerClockedMask != controllerLatchedMask) {
        noteTasAnomaly(kTasAnomalyClockedMismatch);
      }
      if (controllerPollsInWindow == 3) {
        noteTasAnomaly(kTasAnomalyReRead);
      } else if (controllerPollsInWindow == 5) {
        noteTasAnomaly(kTasAnomalyReReadStorm);
      }
    }
    const bool traceActive = tasPlayback.started() || tasPlayback.startDelayRemaining() > 0;
    if (traceActive) {
      recordTasTrace(
        tasPlayback.lastWindowResult(),
        tasPlayback.currentFrame(),
        1,
        controllerLatchedMask,
        controllerClockedMask);
    }
    controllerClockedMask = 0;
  }

#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(false);
#endif
}

void handlePort2Clock() {
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif

  controller2ClockCount += 1;
  if (controller2ClocksSinceLatch < 0xff) {
    controller2ClocksSinceLatch += 1;
  }
  bool completedPoll = false;

  if (latchLineHigh()) {
    controller2LatchedMask = controller2PressedMask;
    controller2ShiftIndex = 0;
    controller2ClockedMask = 0;
  } else if (controller2ShiftIndex < tasdeck::kNesButtonCount) {
    if ((R_PORT1->PIDR & kPort2DataBit) == 0) {
      controller2ClockedMask = static_cast<uint8_t>(
        controller2ClockedMask | static_cast<uint8_t>(1 << controller2ShiftIndex));
    }
    controller2ShiftIndex = static_cast<uint8_t>(controller2ShiftIndex + 1);
    completedPoll = controller2ShiftIndex >= tasdeck::kNesButtonCount;
  }

  const bool high = controller2ShiftIndex >= tasdeck::kNesButtonCount
    ? (controller2PressedMask & 0x01) == 0
    : (controller2LatchedMask & static_cast<uint8_t>(1 << controller2ShiftIndex)) == 0;

  if (high) {
    drivePort2DataPinHigh();
  } else {
    drivePort2DataPinLow();
  }

  if (completedPoll) {
    // Legacy one-port streams were exported from $4016 reads only. Ignore
    // port 2 poll credit and diagnostics for those runs so a connected second
    // port cannot change their frame-advance behavior. TD2P uploads retain
    // portCount=2 even when every port 2 mask is released.
    if (tasPlayback.portCount() >= tasdeck::kNesControllerPortCount) {
      tasPlayback.notePollCompleted(2);
      if (controller2PollsInWindow < 0xff) {
        controller2PollsInWindow += 1;
      }
      if (tasOutputEnabled) {
        if (controller2ClockedMask != controller2LatchedMask) {
          noteTasAnomaly(kTasAnomalyClockedMismatch);
        }
        if (controller2PollsInWindow == 3) {
          noteTasAnomaly(kTasAnomalyReRead);
        } else if (controller2PollsInWindow == 5) {
          noteTasAnomaly(kTasAnomalyReReadStorm);
        }
      }
      const bool traceActive = tasPlayback.started() || tasPlayback.startDelayRemaining() > 0;
      if (traceActive) {
        recordTasTrace(
          tasPlayback.lastWindowResult(),
          tasPlayback.currentFrame(),
          2,
          controller2LatchedMask,
          controller2ClockedMask);
      }
    }
    controller2ClockedMask = 0;
  }

#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(false);
#endif
}

void setIsrDebugPin(bool high) {
  if (kIsrDebugPin < 0) {
    return;
  }

#if TASDECK_ISR_DEBUG_PIN == 9
  if (high) {
    R_PORT3->PODR = static_cast<uint16_t>(R_PORT3->PODR | kPort3D9Bit);
  } else {
    R_PORT3->PODR = static_cast<uint16_t>(R_PORT3->PODR & ~kPort3D9Bit);
  }
#else
  digitalWrite(kIsrDebugPin, high ? HIGH : LOW);
#endif
}

}  // namespace
