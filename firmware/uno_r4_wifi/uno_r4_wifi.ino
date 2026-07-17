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

// The NES pin ISR bodies execute from RAM (.code_in_ram is the FSP linker
// script's sanctioned RAM-code section, copied out of flash by startup with
// the rest of .data). Zero-wait-state fetches cut the strobe fast path's
// cycle cost versus flash, and that entry-to-release span must beat the
// console's second post-strobe read (Golf: 7.8 µs). TAStm32 runs its latch
// handler from RAM for the same reason (.ramcode). Verify placement after a
// build: the three handlers must land at 0x2000xxxx in the .map.
#define TASDECK_RAM_ISR __attribute__((section(".code_in_ram")))

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
constexpr const char* kFirmwareId = "tasdeck-uno-r4-serial-latchwin-v50";
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
// Revision 7 cedes 128 rows (3.6 KB) to the RAM-resident NES pin ISRs
// (.code_in_ram, ~2.6 KB): the strobe fast path's entry-to-release span must
// beat Golf's 7.8 µs second read, and flash wait states priced that budget
// at 0.75 cycles/byte. 384 rows still hold seconds of history at every
// observed row rate, and the anomaly freeze preserves evidence regardless.
constexpr uint16_t kTasTraceCapacity = 384;

// The loop-side pre-advance is best-effort: a blocking USB CDC write can stall
// the main loop for tens of milliseconds (measured: every bridge exchange cost
// ~50-65 ms and pushed ~17% of windows onto the in-ISR fallback path during
// chunk streaming). A 1 kHz hardware timer services window expiry regardless
// of what the loop is doing. Its interrupt priority is strictly below the NES
// latch (0) and clock (1) pins, and the expiry commit stays short.
constexpr float kTasServiceTimerHz = 1000.0f;
constexpr uint8_t kTasServiceTimerPriority = 12;

// After an anomaly, keep recording this many trace rows of context and
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
  // could sample it). bits 1-3: TasEdgeKind of the window-opening edge. Bit 4
  // marks an anomaly, and bit 5 identifies a strobe-edge row.
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
volatile uint8_t controllerCompletedClockedMask = 0;
volatile uint8_t controller2CompletedClockedMask = 0;
volatile bool controllerCompletedPollSinceLatch = false;
volatile bool controller2CompletedPollSinceLatch = false;
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
volatile uint32_t tasBareStrobeCount = 0;
volatile uint32_t tasTornStrobeCount = 0;
// NVIC slots for the NES pin IRQs, resolved once at setup (on the RA4M1 the
// IELSR slot index doubles as the IRQn). -1 = not found.
volatile int8_t nesLatchIrqSlot = -1;
volatile int8_t nesPort1ClockIrqSlot = -1;
volatile int8_t nesPort2ClockIrqSlot = -1;
// True while strobe-mode NVIC priorities are applied (clocks 0, latch 1).
// Gates the clock ISRs' software strobe-first ordering check.
volatile bool nesStrobePrioritiesActive = false;
// Set when playback ends on its own (Complete/Underrun) while strobe
// priorities are installed; loop() restores the windowed layout. Deferred to
// main context because completion surfaces inside the latch ISR (which must
// not rewrite its own active IRQ's priority) and inside the service-timer
// ISR. Cleared by applyNesPinInterruptPriorities, so TAS_BEGIN/TAS_CANCEL
// always supersede a pending restore.
volatile bool nesStrobePriorityRestorePending = false;
// Latch ISR residency in CPU cycles (DWT->CYCCNT, 48 cycles = 1 µs): entry to
// return, excluding NVIC/core dispatch. In strobe mode the higher-priority
// clock ISRs preempt the tail and their time is included, so this reads as
// "time the latch context occupied" — the head counters below carry the
// deadline-facing number.
volatile uint32_t tasLatchIsrLastCycles = 0;
volatile uint32_t tasLatchIsrMaxCycles = 0;
// Strobe fast-path critical span: ISR entry to PRIMASK release (dispatch
// still excluded), the stretch that must clear before the console's second
// post-strobe read (Golf: 7.8 µs after the edge). Steady-state (PreAdvanced)
// edges only. A clock preempting the unmasked pre-head lands in this number
// too, so per-frame spikes flag the pre-head race in-band.
volatile uint32_t tasLatchHeadLastCycles = 0;
volatile uint32_t tasLatchHeadMaxCycles = 0;
NesTasPlayback tasPlayback;
FspTimer tasServiceTimer;

// Strobe mode records one trace row per active port for every accepted latch
// edge, but those rows must not be written from the latch ISR: clock edges
// cannot preempt it (latch is priority 0, clocks priority 1), each clock IRQ
// holds a single NVIC pending bit, and a latch ISR that outlives the console's
// second read after the strobe collapses two pended clock edges into one and
// tears the train one bit late (measured 2026-07-15: in-ISR row writes tore
// 386 of 387 SMB1 records and 232 of 232 Golf records). The latch ISR instead
// stages one compact event per accepted edge and the 1 kHz service timer
// expands it into trace-ring rows mid-gap.
struct TasStrobeEdgeEvent {
  uint32_t timestampMicros = 0;
  uint32_t tasFrame = 0;
  uint32_t latchCount = 0;
  uint32_t clockCount = 0;
  uint32_t clock2Count = 0;
  uint8_t clocksSinceLatch = 0;
  uint8_t clocks2SinceLatch = 0;
  uint8_t shiftIndex = 0;
  uint8_t shift2Index = 0;
  uint8_t clockedMask = 0;
  uint8_t clocked2Mask = 0;
  uint8_t mask = 0;
  uint8_t mask2 = 0;
  uint8_t lineLow = 0;
  uint8_t line2Low = 0;
  uint8_t windowKind = 0;
  uint8_t result = 0;
};

// Single-producer (latch ISR) / single-consumer (service timer) ring with
// free-running uint8 indices; the capacity must divide 256 so the wraparound
// arithmetic stays exact. 16 entries covers >50 ms of edges even for games
// that strobe five times per frame.
constexpr uint8_t kTasStrobeEdgeEventCapacity = 16;
static_assert(
  (256 % kTasStrobeEdgeEventCapacity) == 0,
  "free-running uint8 ring indices require the capacity to divide 256");
TasStrobeEdgeEvent tasStrobeEdgeEvents[kTasStrobeEdgeEventCapacity] = {};
volatile uint8_t tasStrobeEdgeEventHead = 0;
volatile uint8_t tasStrobeEdgeEventTail = 0;
volatile uint16_t tasStrobeEdgeEventDropCount = 0;

// Each run has one trace-ring writer context: the clock ISRs in windowed
// modes, or the 1 kHz service timer draining latch-ISR-staged edge events in
// strobe mode. Trace pages are read from the main loop. A timestamp of zero
// marks a slot while it is being replaced;
// the real timestamp is published last. This lets the loop retry a preempted
// copy without ever masking the latency-sensitive NES pin interrupts.
inline void tasTraceCompilerBarrier() {
  __asm__ __volatile__("" ::: "memory");
}

bool copyTasTraceEntryStable(uint16_t index, TasTraceEntry& destination) {
  constexpr uint8_t kMaxAttempts = 4;
  for (uint8_t attempt = 0; attempt < kMaxAttempts; ++attempt) {
    const uint32_t timestampBefore = tasTrace[index].timestampMicros;
    if (timestampBefore == 0) {
      continue;
    }

    tasTraceCompilerBarrier();
    destination = tasTrace[index];
    tasTraceCompilerBarrier();
    const uint32_t timestampAfter = tasTrace[index].timestampMicros;
    if (
      timestampBefore == timestampAfter &&
      destination.timestampMicros == timestampBefore) {
      return true;
    }
  }

  return false;
}

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
void noteTasAnomalyMasked(uint8_t kind);
void drainStrobeEdgeTraceEvents();
void recordTasTraceEntry(const TasTraceEntry& source);
void recordTasTrace(TasPlaybackResult result, uint32_t tasFrame, uint8_t port, uint8_t polledMask, uint8_t clockedMask);
void restoreDiagnosticForcedMask();
void raiseNesPinInterruptPriority();
void applyNesPinInterruptPriorities(bool strobeMode);
void serviceStrobePriorityRestore();
void serviceLatchPendBeforeClock();
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

void setupCycleCounter() {
  // Free-running CPU cycle counter (48 MHz → 48 cycles per µs). The latch ISR
  // reports its body duration through TAS_STATUS so ISR-budget regressions
  // show up in captures instead of only as game-specific desyncs.
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

void setup() {
  pinMode(kStatusLedPin, OUTPUT);
  digitalWrite(kStatusLedPin, LOW);
  setupCycleCounter();
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
  serviceStrobePriorityRestore();
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
  Serial.println("Protocol: PING | STATUS | BUTTON [1|2] <button> <down|up> | TAS_BEGIN <frames> poll|latch|strobe [ports] [window_us] | TAS_CHUNK <start> <count> [ports] <hex_masks> <checksum> | TAS_START [delay_frames] | TAS_CANCEL | TAS_END | TAS_STATUS | TAS_TRACE [count] [start] | TAS_TRACE_RESUME");
  Serial.println("NES pins: P1 latch D2 clock D3 data D6, P2 clock D8 data D7 (latch shared from D2)");
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
  // The NES drives one shared latch/strobe for both controller connectors, so
  // port 2 has no latch pin: D2 is the sole latch source and one console
  // strobe cannot run two latch ISRs.
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
  // at the shared default priority. Resolve the slots once, then apply the
  // windowed-mode layout; TAS_BEGIN re-applies per sync mode.
  for (uint32_t slot = 0; slot < BSP_ICU_VECTOR_MAX_ENTRIES; ++slot) {
    const uint32_t event = R_ICU->IELSR[slot] & R_ICU_IELSR_IELS_Msk;
    if (event == ELC_EVENT_ICU_IRQ1) {
      nesLatchIrqSlot = static_cast<int8_t>(slot);  // shared latch (D2)
    } else if (event == ELC_EVENT_ICU_IRQ0) {
      nesPort1ClockIrqSlot = static_cast<int8_t>(slot);  // P1 clock (D3)
    } else if (event == ELC_EVENT_ICU_IRQ9) {
      nesPort2ClockIrqSlot = static_cast<int8_t>(slot);  // P2 clock (D8)
    }
  }
  applyNesPinInterruptPriorities(false);
}

// Windowed modes: the latch outranks the clocks. When edges pend behind a
// blocked stretch (the core masks interrupts briefly in its USB serial
// paths), equal priorities fall back to exception-number order and IRQ0 —
// the clock — would run before the strobe that frames it, see a stale shift
// register, drop the first shift, and end the train at 7 of 8 clocks. With
// the latch strictly first, a delayed train replays in the right order.
//
// Strobe mode inverts the layout: the clocks outrank the latch so the
// console's post-strobe reads preempt the latch ISR's tail instead of
// merging in the clock IRQ's single NVIC pending bit (Golf's title reads
// $4016 5.6 and 7.8 µs after the strobe, 2.2 µs apart — closer together
// than the latch ISR's dispatch + bookkeeping, so v48/v49 lost one shift
// per frame no matter how much the ISR body was trimmed). The latch ISR
// guards its state mutations with a PRIMASK critical head, and the clock
// ISRs re-create the strobe-first pend ordering in software by running a
// pended latch edge before shifting (see serviceLatchPendBeforeClock).
void applyNesPinInterruptPriorities(bool strobeMode) {
  const uint32_t latchPriority = strobeMode ? 1 : 0;
  const uint32_t clockPriority = strobeMode ? 0 : 1;
  if (nesLatchIrqSlot >= 0) {
    NVIC_SetPriority(static_cast<IRQn_Type>(nesLatchIrqSlot), latchPriority);
  }
  if (nesPort1ClockIrqSlot >= 0) {
    NVIC_SetPriority(static_cast<IRQn_Type>(nesPort1ClockIrqSlot), clockPriority);
  }
  if (nesPort2ClockIrqSlot >= 0) {
    NVIC_SetPriority(static_cast<IRQn_Type>(nesPort2ClockIrqSlot), clockPriority);
  }
  nesStrobePrioritiesActive = strobeMode;
  nesStrobePriorityRestorePending = false;
}

// Runs from loop(). Completion cannot restore the windowed priorities where
// it is detected: the latch ISR must not change its own active IRQ's
// priority, and the expiry service also runs at service-timer priority. Only
// the two completion sites set the flag, so the armed gap between TAS_BEGIN
// and TAS_START (output disabled, strobe priorities intentional) never
// triggers a restore.
void serviceStrobePriorityRestore() {
  if (!nesStrobePriorityRestorePending) {
    return;
  }
  noInterrupts();
  if (nesStrobePriorityRestorePending) {
    applyNesPinInterruptPriorities(false);
  }
  interrupts();
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
  uint32_t bareStrobesSnapshot = 0;
  uint32_t tornStrobesSnapshot = 0;
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
  bareStrobesSnapshot = tasBareStrobeCount;
  tornStrobesSnapshot = tasTornStrobeCount;
  errorSnapshot = tasPlayback.error();

  snprintf(
    response,
    responseLength,
    "OK %s fw=%s latch_edge=%s clock_edge=%s active=%u ready=%u start_requested=%u started=%u complete=%u receiving_complete=%u current=%lu total=%lu received=%lu buffered=%u capacity=%u ports=%u mask=%02X mask2=%02X pressed=%02X latched=%02X index=%u data=%u pressed2=%02X latched2=%02X index2=%u data2=%u output_enabled=%u start_delay_polls=%lu window_us=%lu sync=%s latch=%lu clock=%lu clock2=%lu bare_strobes=%lu torn_strobes=%lu error=%s anomaly_count=%lu anomaly_seq=%lu anomaly_kind=%u trace_frozen=%u latch_isr_last_cyc=%lu latch_isr_max_cyc=%lu latch_head_last_cyc=%lu latch_head_max_cyc=%lu",
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
    static_cast<unsigned long>(bareStrobesSnapshot),
    static_cast<unsigned long>(tornStrobesSnapshot),
    tasPlaybackResultName(errorSnapshot),
    static_cast<unsigned long>(tasAnomalyCount),
    static_cast<unsigned long>(tasAnomalySequence),
    tasAnomalyKind,
    tasTraceFrozen ? 1 : 0,
    static_cast<unsigned long>(tasLatchIsrLastCycles),
    static_cast<unsigned long>(tasLatchIsrMaxCycles),
    static_cast<unsigned long>(tasLatchHeadLastCycles),
    static_cast<unsigned long>(tasLatchHeadMaxCycles));
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

  // Never wrap this copy in noInterrupts(): an NES controller clock train is
  // only a few dozen microseconds long, so a trace page copy can collapse two
  // clock edges into one pending IRQ and corrupt the value seen by the game.
  // Sequence N always occupies slot N modulo capacity. Each entry publishes
  // its timestamp last, and the sequence counter is published after the whole
  // entry, so a main-loop copy can validate and retry if the ISR preempts it.
  constexpr uint8_t kMaxPageAttempts = 4;
  for (uint8_t attempt = 0; attempt < kMaxPageAttempts; ++attempt) {
    nextSequenceSnapshot = tasTraceNextSequence;
    totalSnapshot = nextSequenceSnapshot < kTasTraceCapacity
      ? static_cast<uint16_t>(nextSequenceSnapshot)
      : kTasTraceCapacity;
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

    bool copied = true;
    for (uint8_t index = 0; index < pageCount; ++index) {
      const uint32_t sequence = pageStart + index;
      const uint16_t traceIndex = static_cast<uint16_t>(sequence % kTasTraceCapacity);
      if (!copyTasTraceEntryStable(traceIndex, page[index])) {
        copied = false;
        break;
      }
    }

    const uint32_t nextAfterCopy = tasTraceNextSequence;
    const uint32_t firstAfterCopy = nextAfterCopy > kTasTraceCapacity
      ? nextAfterCopy - kTasTraceCapacity
      : 0;
    if (copied && pageStart >= firstAfterCopy) {
      break;
    }

    pageCount = 0;
  }

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
      applyNesPinInterruptPriorities(
        command.syncMode == tasdeck::TasSyncMode::Strobe);
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
      // No strobe-specific frame-0 release is needed here: the expiry service
      // pre-pops frame 0 for strobe runs too (windowExpiryDue), putting its
      // first-bit levels on the wire within a service tick of TAS_START.
    }
    interrupts();
  } else if (command.type == CommandType::TasCancel) {
    noInterrupts();
    tasOutputEnabled = false;
    tasPlayback.reset();
    applyNesPinInterruptPriorities(false);
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
  controllerCompletedClockedMask = 0;
  controller2CompletedClockedMask = 0;
  controllerCompletedPollSinceLatch = false;
  controller2CompletedPollSinceLatch = false;
  tasStrobeEdgeEventHead = 0;
  tasStrobeEdgeEventTail = 0;
  tasStrobeEdgeEventDropCount = 0;
  tasTraceFrozen = false;
  tasTraceFreezeCountdown = 0;
  tasAnomalyCount = 0;
  tasAnomalySequence = 0;
  tasAnomalyKind = 0;
  tasAnomalyPendingMark = 0;
  tasBareStrobeCount = 0;
  tasTornStrobeCount = 0;
  tasLatchIsrLastCycles = 0;
  tasLatchIsrMaxCycles = 0;
  tasLatchHeadLastCycles = 0;
  tasLatchHeadMaxCycles = 0;
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

// For anomaly notes from the strobe fast path's preemptible tail: the
// counters are shared with the clock ISRs, which outrank the latch there, so
// the rare note itself masks interrupts. Never needed from windowed paths or
// masked sections — call noteTasAnomaly directly in those.
void noteTasAnomalyMasked(uint8_t kind) {
  const uint32_t primask = __get_PRIMASK();
  __disable_irq();
  noteTasAnomaly(kind);
  __set_PRIMASK(primask);
}

void recordTasTraceEntry(const TasTraceEntry& source) {
  if (tasTraceFrozen) {
    return;
  }

  const uint16_t index = tasTraceHead;
  TasTraceEntry& entry = tasTrace[index];
  entry.timestampMicros = 0;
  tasTraceCompilerBarrier();
  entry.tasFrame = source.tasFrame;
  entry.latchCount = source.latchCount;
  entry.clockCount = source.clockCount;
  entry.clocksSinceLatch = source.clocksSinceLatch;
  entry.polledMask = source.polledMask;
  entry.nextMask = source.nextMask;
  entry.latchedMask = source.latchedMask;
  entry.shiftIndex = source.shiftIndex;
  entry.result = source.result;
  entry.clockedMask = source.clockedMask;
  entry.diag = static_cast<uint8_t>(source.diag | (tasAnomalyPendingMark != 0 ? 0x10 : 0));
  entry.port = source.port;
  tasAnomalyPendingMark = 0;

  tasTraceCompilerBarrier();
  // micros() returning zero is only plausible at boot, before TAS playback,
  // but keep zero reserved as the in-progress marker regardless.
  entry.timestampMicros = source.timestampMicros == 0 ? 1 : source.timestampMicros;
  tasTraceCompilerBarrier();
  tasTraceHead = static_cast<uint16_t>((tasTraceHead + 1) % kTasTraceCapacity);
  if (tasTraceCount < kTasTraceCapacity) {
    tasTraceCount += 1;
  }
  tasTraceNextSequence += 1;

  if (tasTraceFreezeCountdown > 0) {
    tasTraceFreezeCountdown -= 1;
    if (tasTraceFreezeCountdown == 0) {
      tasTraceFrozen = true;
    }
  }
}

void drainStrobeEdgeTraceEvents() {
  // Sole trace-ring writer in strobe mode. Runs from the 1 kHz service timer
  // (priority 12), so the latch ISR can stage new events while a row is being
  // written without two writers ever interleaving on the ring itself.
  while (tasStrobeEdgeEventHead != tasStrobeEdgeEventTail) {
    const uint8_t head = tasStrobeEdgeEventHead;
    const TasStrobeEdgeEvent event = tasStrobeEdgeEvents[head % kTasStrobeEdgeEventCapacity];
    tasTraceCompilerBarrier();
    tasStrobeEdgeEventHead = static_cast<uint8_t>(head + 1);

    TasTraceEntry row = {};
    row.timestampMicros = event.timestampMicros;
    row.tasFrame = event.tasFrame;
    row.latchCount = event.latchCount;
    row.clockCount = event.clockCount;
    row.clocksSinceLatch = event.clocksSinceLatch;
    row.polledMask = event.mask;
    row.nextMask = event.mask;
    row.latchedMask = event.mask;
    row.shiftIndex = event.shiftIndex;
    row.result = event.result;
    row.clockedMask = event.clockedMask;
    row.diag = static_cast<uint8_t>(
      (event.lineLow & 0x01) |
      (event.windowKind << 1) |
      0x20);
    row.port = 1;
    recordTasTraceEntry(row);

    if (tasPlayback.portCount() >= tasdeck::kNesControllerPortCount) {
      row.clockCount = event.clock2Count;
      row.clocksSinceLatch = event.clocks2SinceLatch;
      row.polledMask = event.mask2;
      row.nextMask = event.mask2;
      row.latchedMask = event.mask2;
      row.shiftIndex = event.shift2Index;
      row.clockedMask = event.clocked2Mask;
      row.diag = static_cast<uint8_t>(
        (event.line2Low & 0x01) |
        (event.windowKind << 1) |
        0x20);
      row.port = 2;
      recordTasTraceEntry(row);
    }
  }
}

void recordTasTrace(TasPlaybackResult result, uint32_t tasFrame, uint8_t port, uint8_t polledMask, uint8_t clockedMask) {
  TasTraceEntry entry = {};
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
    (controllerDiagWindowKind << 1));
  entry.port = port;
  recordTasTraceEntry(entry);
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
      if (nesStrobePrioritiesActive) {
        nesStrobePriorityRestorePending = true;
      }
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
  // Drain only here: the timer is the staging ring's single consumer, keeping
  // strobe-mode trace rows single-writer (the main-loop expiry calls above
  // must not also drain).
  drainStrobeEdgeTraceEvents();
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

// Pre-reset snapshot of the inter-strobe interval that just ended, shared by
// the strobe fast path and the general edge path. Plain fields, no default
// initializers: the general path declares one unconditionally, and windowed
// edges must not pay for zeroing state only strobe mode reads. The clocked
// masks start as raw register copies; resolveStrobeEdgeClockedMasks folds
// them into the per-train reconstruction outside the fast path's critical
// head.
struct TasStrobeEdgeCapture {
  uint8_t clocksSinceLatch;
  uint8_t clocks2SinceLatch;
  uint32_t clockCount;
  uint32_t clock2Count;
  uint8_t shiftIndex;
  uint8_t shift2Index;
  uint8_t clockedMask;
  uint8_t clocked2Mask;
  uint8_t completedClockedMask;
  uint8_t completed2ClockedMask;
  bool completedPollSinceLatch;
  bool completed2PollSinceLatch;
};

// Raw pre-reset copies only. This runs inside the strobe fast path's PRIMASK
// head — the resets that follow destroy these values — so it must stay
// straight-line loads and stores; every byte here extends the masked stretch
// that must release before the console's second post-strobe read. Analysis
// belongs in resolveStrobeEdgeClockedMasks/countStrobeEdge on the way out.
// Strobe mode only (the v47 regression came from running edge capture on
// windowed paths).
inline TasStrobeEdgeCapture captureStrobeEdgeRaw() {
  TasStrobeEdgeCapture capture;
  capture.clocksSinceLatch = controllerClocksSinceLatch;
  capture.clocks2SinceLatch = controller2ClocksSinceLatch;
  capture.clockCount = controllerClockCount;
  capture.clock2Count = controller2ClockCount;
  capture.shiftIndex = controllerShiftIndex;
  capture.shift2Index = controller2ShiftIndex;
  capture.clockedMask = controllerClockedMask;
  capture.clocked2Mask = controller2ClockedMask;
  capture.completedClockedMask = controllerCompletedClockedMask;
  capture.completed2ClockedMask = controller2CompletedClockedMask;
  capture.completedPollSinceLatch = controllerCompletedPollSinceLatch;
  capture.completed2PollSinceLatch = controller2CompletedPollSinceLatch;
  return capture;
}

// Folds the raw register copies into the clocked-mask reconstruction the
// trace rows report: a completed 8-clock read wins, otherwise a mid-train
// mask counts only if the train actually started.
inline void resolveStrobeEdgeClockedMasks(TasStrobeEdgeCapture& capture) {
  if (capture.completedPollSinceLatch) {
    capture.clockedMask = capture.completedClockedMask;
  } else if (
    capture.shiftIndex < 1 || capture.shiftIndex > tasdeck::kNesButtonCount) {
    capture.clockedMask = 0;
  }
  if (capture.completed2PollSinceLatch) {
    capture.clocked2Mask = capture.completed2ClockedMask;
  } else if (
    capture.shift2Index < 1 || capture.shift2Index > tasdeck::kNesButtonCount) {
    capture.clocked2Mask = 0;
  }
}

// Bare/torn accounting for a captured edge. Fast-path edges run this in the
// preemptible tail: the counters are written only from latch-edge context,
// and the worst a nested inline edge (a clock ISR retiring a pended latch
// over this tail) can do is lose one diagnostic count — gameplay state is
// untouched. latchCountAtEdge is the pre-increment latch count: the first
// edge of a run has no prior interval and is exempt.
inline void countStrobeEdge(
  const TasStrobeEdgeCapture& capture, uint32_t latchCountAtEdge) {
  if (!tasOutputEnabled || latchCountAtEdge == 0) {
    return;
  }
  if (capture.clocksSinceLatch == 0) {
    tasBareStrobeCount += 1;
  }
  if (capture.shiftIndex >= 1 && capture.shiftIndex < tasdeck::kNesButtonCount) {
    tasTornStrobeCount += 1;
  }
  if (
    capture.shift2Index >= 1 &&
    capture.shift2Index < tasdeck::kNesButtonCount &&
    tasPlayback.portCount() >= tasdeck::kNesControllerPortCount) {
    tasTornStrobeCount += 1;
  }
}

// General-path strobe edges hold PRIMASK end to end, so capture, resolution,
// and counting run together there.
inline TasStrobeEdgeCapture captureAndCountStrobeEdge() {
  TasStrobeEdgeCapture capture = captureStrobeEdgeRaw();
  resolveStrobeEdgeClockedMasks(capture);
  countStrobeEdge(capture, controllerLatchCount);
  return capture;
}

// Stages one compact strobe-edge event for the 1 kHz service timer to expand
// into per-port trace rows mid-gap (see TasStrobeEdgeEvent). Reads the
// post-commit pressed masks and line-low diags from their globals. The slot
// index is reserved under PRIMASK because the fast path stages from its
// preemptible tail, where a clock ISR can retire a pended latch edge inline
// (serviceLatchPendBeforeClock) and stage a second event mid-call; with the
// reservation atomic, each staging fills its own slot. Fills stay unmasked:
// the consumer runs at service-timer priority and can never preempt latch or
// clock context, so a bumped tail with an in-flight fill is never read early.
inline void stageStrobeEdgeEvent(
  uint32_t timestampMicros,
  uint32_t tasFrame,
  uint8_t result,
  uint8_t windowKind,
  const TasStrobeEdgeCapture& capture) {
  const uint32_t stagePrimask = __get_PRIMASK();
  __disable_irq();
  const uint8_t stagingTail = tasStrobeEdgeEventTail;
  if (
    static_cast<uint8_t>(stagingTail - tasStrobeEdgeEventHead) >=
    kTasStrobeEdgeEventCapacity) {
    tasStrobeEdgeEventDropCount += 1;
    __set_PRIMASK(stagePrimask);
    return;
  }
  tasStrobeEdgeEventTail = static_cast<uint8_t>(stagingTail + 1);
  __set_PRIMASK(stagePrimask);
  TasStrobeEdgeEvent& event =
    tasStrobeEdgeEvents[stagingTail % kTasStrobeEdgeEventCapacity];
  event.timestampMicros = timestampMicros;
  event.tasFrame = tasFrame;
  event.latchCount = controllerLatchCount;
  event.clockCount = capture.clockCount;
  event.clock2Count = capture.clock2Count;
  event.clocksSinceLatch = capture.clocksSinceLatch;
  event.clocks2SinceLatch = capture.clocks2SinceLatch;
  event.shiftIndex = capture.shiftIndex;
  event.shift2Index = capture.shift2Index;
  event.clockedMask = capture.clockedMask;
  event.clocked2Mask = capture.clocked2Mask;
  event.mask = controllerPressedMask;
  event.mask2 = controller2PressedMask;
  event.lineLow = controllerDiagLineLowAtLatch;
  event.line2Low = controller2DiagLineLowAtLatch;
  event.windowKind = windowKind;
  event.result = result;
  tasTraceCompilerBarrier();
}

// Latch ISR residency, excluding core dispatch: entry to return. Not a head
// budget — in strobe mode the clock ISRs preempt the tail and their time is
// included. Keeping the max visible in TAS_STATUS turns "is the ISR budget
// blown?" into a number in every capture instead of a per-game desync hunt.
inline void recordLatchIsrCycles(uint32_t cyclesAtEntry) {
  const uint32_t elapsed = DWT->CYCCNT - cyclesAtEntry;
  tasLatchIsrLastCycles = elapsed;
  if (elapsed > tasLatchIsrMaxCycles) {
    tasLatchIsrMaxCycles = elapsed;
  }
}

// Strobe fast-path critical span: ISR entry to PRIMASK release. The caller
// reads DWT->CYCCNT before releasing PRIMASK (one load inside the head) and
// runs this bookkeeping in the preemptible tail, so the head budget itself
// stays untouched. Neither this nor the residency counter sees core dispatch;
// scope D2-edge to the TASDECK_ISR_DEBUG_PIN rise for that.
inline void recordLatchHeadCycles(uint32_t elapsed) {
  tasLatchHeadLastCycles = elapsed;
  if (elapsed > tasLatchHeadMaxCycles) {
    tasLatchHeadMaxCycles = elapsed;
  }
}

TASDECK_RAM_ISR void handleLatchEdge() {
  const uint32_t cyclesAtEntry = DWT->CYCCNT;
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif
  // Capture the pin states, then drive the pending mask's first bit before
  // any bookkeeping: the console samples bit 0 only a few microseconds after
  // the strobe edge, and in the steady state the window pre-advance has
  // already loaded controllerPressedMask with the mask this strobe serves.
  const uint16_t pinsAtEntry = R_PORT1->PIDR;
  const tasdeck::TasSyncMode syncMode = tasPlayback.syncMode();
  const bool strobeMode = syncMode == tasdeck::TasSyncMode::Strobe;

  // Strobe steady-state fast path. In strobe mode the clocks outrank this
  // ISR (see applyNesPinInterruptPriorities); the console's post-strobe reads
  // preempt the unmasked stretches, and reads arriving during the PRIMASK
  // head pend in each clock IRQ's single NVIC bit — TWO same-port reads
  // pending there merge into one shift, so the head must release before the
  // console's second post-strobe read, and the served first bit must be on
  // the wire before the first (the mid-gap pre-advance guarantees that).
  // v50 measured entry-to-release at 367 cycles (7.65 µs) with the edge
  // analysis run before the head, and Golf's 5.6/7.8 µs title read pair
  // merged on every frame. The head is therefore stripped to the state the
  // clock ISRs touch: mask commit, pin write, raw pre-reset snapshot (its
  // inputs are destroyed by the resets), resets. Torn/bare accounting,
  // clocked-mask resolution, line diags, anomaly compares, micros(), and
  // staging all run in the preemptible tail. In windowed modes (latch at
  // priority 0) PRIMASK is a semantic no-op. This block mirrors the general
  // path's bookkeeping for a committed strobe edge — keep the two in sync.
  if (strobeMode && kDiagnosticForcedMask == 0) {
    const uint32_t primask = __get_PRIMASK();
    __disable_irq();
    tasdeck::TasFrameMasks fastMasks = {};
    if (tasPlayback.tryCommitPreAdvancedMasks(fastMasks)) {
      writeDataPinsForMasks(fastMasks);
      TasStrobeEdgeCapture strobeCapture = captureStrobeEdgeRaw();
      const uint32_t latchCountAtEdge = controllerLatchCount;

      controllerLatchCount = latchCountAtEdge + 1;
      controllerClocksSinceLatch = 0;
      controller2ClocksSinceLatch = 0;
      controllerCompletedClockedMask = 0;
      controller2CompletedClockedMask = 0;
      controllerCompletedPollSinceLatch = false;
      controller2CompletedPollSinceLatch = false;
      controllerPollsInWindow = 0;
      controller2PollsInWindow = 0;

      controllerPressedMask = fastMasks.port1;
      controller2PressedMask = fastMasks.port2;
      controllerLatchedMask = fastMasks.port1;
      controller2LatchedMask = fastMasks.port2;
      controllerShiftIndex = 0;
      controller2ShiftIndex = 0;
      controllerClockedMask = 0;
      controller2ClockedMask = 0;

      const uint32_t cyclesAtHeadRelease = DWT->CYCCNT;
      __set_PRIMASK(primask);
      recordLatchHeadCycles(cyclesAtHeadRelease - cyclesAtEntry);

      // Preemptible tail, all working off head snapshots and locals: the
      // staging ring reserves its slot atomically, the timestamp consumers
      // run at timer priority, and a nested inline edge (clock ISR retiring
      // a pended latch over this tail) costs at most one diagnostic count.
      controllerDiagLineLowAtLatch =
        (pinsAtEntry & kPort1DataBit) == 0 ? 1 : 0;
      controller2DiagLineLowAtLatch =
        (pinsAtEntry & kPort2DataBit) == 0 ? 1 : 0;
      resolveStrobeEdgeClockedMasks(strobeCapture);
      countStrobeEdge(strobeCapture, latchCountAtEdge);
      if (tasOutputEnabled) {
        const uint8_t expectedLow = (fastMasks.port1 & 0x01) != 0 ? 1 : 0;
        if (controllerDiagLineLowAtLatch != expectedLow) {
          noteTasAnomalyMasked(kTasAnomalyLineMismatch);
        }
        const uint8_t expected2Low = (fastMasks.port2 & 0x01) != 0 ? 1 : 0;
        if (controller2DiagLineLowAtLatch != expected2Low) {
          noteTasAnomalyMasked(kTasAnomalyLineMismatch);
        }
      }
      controllerDiagWindowKind =
        static_cast<uint8_t>(tasdeck::TasEdgeKind::PreAdvanced);
      const uint32_t fastLatchMicros = micros();
      controllerLastLatchMicros = fastLatchMicros;
      tasPlayback.noteLatchTimestamp(fastLatchMicros);
      stageStrobeEdgeEvent(
        fastLatchMicros,
        tasPlayback.currentFrame(),
        static_cast<uint8_t>(TasPlaybackResult::Ok),
        controllerDiagWindowKind,
        strobeCapture);
      recordLatchIsrCycles(cyclesAtEntry);
#if TASDECK_ISR_DEBUG_PIN >= 0
      setIsrDebugPin(false);
#endif
      return;
    }
    __set_PRIMASK(primask);
  }

  const uint32_t latchMicros = micros();

  // General path (windowed edges; strobe start/fallback/complete edges).
  // Held under PRIMASK end to end: a no-op in windowed modes (this ISR is
  // priority 0 there), and in strobe mode it keeps the out-of-line playback
  // advance atomic against the higher-priority clock ISRs. Strobe edges that
  // take this path can still merge the tightest read pairs — acceptable for
  // the rare non-steady-state edges it serves.
  const uint32_t generalPrimask = __get_PRIMASK();
  __disable_irq();
  // Strobe-edge traces describe the inter-strobe interval that just ended;
  // capture before any reset below. Unlike the fast path this runs inside
  // the full-length PRIMASK hold — the rare edges served here (start,
  // fallback, completion) accept the longer masked stretch. Never on
  // windowed edges (the v47 regression).
  TasStrobeEdgeCapture strobeCapture;
  if (strobeMode) {
    strobeCapture = captureAndCountStrobeEdge();
  }
  const uint32_t previousLatchMicros = controllerLastLatchMicros;
  const bool sameHardwareWindow = strobeMode
    ? false
    : latchWithinCurrentWindow(latchMicros, previousLatchMicros);
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
  const uint8_t shift2AtStrobe = controller2ShiftIndex;
  if (
    tasOutputEnabled &&
    syncMode == tasdeck::TasSyncMode::Poll &&
    shiftAtStrobe >= 1 &&
    shiftAtStrobe < tasdeck::kNesButtonCount) {
    noteTasAnomaly(kTasAnomalyTornTrain);
  }
  if (
    tasOutputEnabled &&
    syncMode == tasdeck::TasSyncMode::Poll &&
    shift2AtStrobe >= 1 &&
    shift2AtStrobe < tasdeck::kNesButtonCount) {
    noteTasAnomaly(kTasAnomalyTornTrain);
  }

  controllerLatchCount += 1;
  controllerClocksSinceLatch = 0;
  controllerClockedMask = 0;
  controller2ClocksSinceLatch = 0;
  controller2ClockedMask = 0;
  if (strobeMode) {
    controllerCompletedClockedMask = 0;
    controller2CompletedClockedMask = 0;
    controllerCompletedPollSinceLatch = false;
    controller2CompletedPollSinceLatch = false;
  }
  controllerLastLatchMicros = latchMicros;

  // Latch edges drive playback. Windowed modes coalesce nearby edges into one
  // console frame; strobe mode deliberately treats every edge as a new event.
  // The edge tracker runs from TAS_BEGIN (before TAS_START it never changes
  // the output) so arming a windowed run mid-frame still waits for a boundary.
  if (kDiagnosticForcedMask == 0 && tasPlayback.active()) {
    if (!sameHardwareWindow) {
      controllerPollsInWindow = 0;
      controller2PollsInWindow = 0;
      tasdeck::TasFrameMasks nextMasks = {
        controllerPressedMask,
        controller2PressedMask,
      };
      const TasPlaybackResult result = tasPlayback.onLatchEdge(latchMicros, nextMasks);
      // R08 replay devices consume one input record per accepted latch, even
      // when the game clocks fewer than eight controller bits. Poll mode keeps
      // requiring a completed read; latch mode grants the window immediately.
      if (!strobeMode) {
        tasPlayback.noteLatchObserved();
      }
      if (
        result == TasPlaybackResult::Ok ||
        result == TasPlaybackResult::Complete ||
        result == TasPlaybackResult::Underrun) {
        controllerPressedMask = nextMasks.port1;
        controller2PressedMask = nextMasks.port2;
      }
      if (result == TasPlaybackResult::Complete || result == TasPlaybackResult::Underrun) {
        tasOutputEnabled = false;
        if (nesStrobePrioritiesActive) {
          nesStrobePriorityRestorePending = true;
        }
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

      if (strobeMode && kind != tasdeck::TasEdgeKind::NotStartedWait) {
        // Stage one compact event per playback-relevant edge; the 1 kHz
        // service timer expands it into the per-port trace rows mid-gap.
        // Building the rows here kept this ISR running past the console's
        // second read and tore the train (see TasStrobeEdgeEvent).
        stageStrobeEdgeEvent(
          latchMicros,
          tasPlayback.currentFrame(),
          static_cast<uint8_t>(result),
          controllerDiagWindowKind,
          strobeCapture);
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
  __set_PRIMASK(generalPrimask);
  recordLatchIsrCycles(cyclesAtEntry);

#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(false);
#endif
}

// Strobe-mode priorities put the clocks above the latch, so a latch edge that
// pended behind a masked stretch (USB serial paths) would otherwise dispatch
// AFTER the clock its strobe frames — the windowed layout prevented exactly
// that by priority. Re-create the strobe-first ordering in software: if the
// latch IRQ is pending when a clock ISR enters, retire it inline first, then
// shift the freshly latched train. Clearing the ICU flag before handling means
// a genuinely new edge arriving mid-handler re-pends and runs as its own.
TASDECK_RAM_ISR void serviceLatchPendBeforeClock() {
  const int8_t slot = nesLatchIrqSlot;
  if (slot < 0) {
    return;
  }
  const IRQn_Type irq = static_cast<IRQn_Type>(slot);
  if (!NVIC_GetPendingIRQ(irq)) {
    return;
  }
  R_ICU->IELSR[slot] &= ~R_ICU_IELSR_IR_Msk;
  __DSB();
  NVIC_ClearPendingIRQ(irq);
  handleLatchEdge();
}

TASDECK_RAM_ISR void handlePort1Clock() {
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif
  if (nesStrobePrioritiesActive) {
    serviceLatchPendBeforeClock();
  }

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
  uint8_t betweenPollMask = controllerPressedMask;
  if (
    controllerShiftIndex >= tasdeck::kNesButtonCount &&
    tasPlayback.syncMode() == tasdeck::TasSyncMode::Strobe &&
    tasPlayback.willAdvanceOnEdge()) {
    betweenPollMask = tasPlayback.stagedNextMask();
  }
  const bool high = controllerShiftIndex >= tasdeck::kNesButtonCount
    ? (betweenPollMask & 0x01) == 0
    : (controllerLatchedMask & static_cast<uint8_t>(1 << controllerShiftIndex)) == 0;

  if (high) {
    driveDataPinHigh();
  } else {
    driveDataPinLow();
  }

  if (completedPoll) {
    controllerCompletedClockedMask = controllerClockedMask;
    controllerCompletedPollSinceLatch = true;
    // Completed 8-clock reads gate poll-mode playback. Windowed traces record
    // them; strobe traces retain the reconstruction for the next edge row and
    // suppress this writer so the higher-priority latch ISR is the sole writer.
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
    if (traceActive && tasPlayback.syncMode() != tasdeck::TasSyncMode::Strobe) {
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

TASDECK_RAM_ISR void handlePort2Clock() {
#if TASDECK_ISR_DEBUG_PIN >= 0
  setIsrDebugPin(true);
#endif
  if (nesStrobePrioritiesActive) {
    serviceLatchPendBeforeClock();
  }

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

  uint8_t betweenPollMask = controller2PressedMask;
  if (
    controller2ShiftIndex >= tasdeck::kNesButtonCount &&
    tasPlayback.syncMode() == tasdeck::TasSyncMode::Strobe &&
    tasPlayback.willAdvanceOnEdge()) {
    betweenPollMask = tasPlayback.stagedNextMasks().port2;
  }
  const bool high = controller2ShiftIndex >= tasdeck::kNesButtonCount
    ? (betweenPollMask & 0x01) == 0
    : (controller2LatchedMask & static_cast<uint8_t>(1 << controller2ShiftIndex)) == 0;

  if (high) {
    drivePort2DataPinHigh();
  } else {
    drivePort2DataPinLow();
  }

  if (completedPoll) {
    controller2CompletedClockedMask = controller2ClockedMask;
    controller2CompletedPollSinceLatch = true;
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
      if (traceActive && tasPlayback.syncMode() != tasdeck::TasSyncMode::Strobe) {
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
