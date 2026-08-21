# TASDeck Arduino UNO R4 WiFi Firmware

Arduino sketch, tested protocol parser, and NES controller-port driver for the hardware bridge side
of TASDeck. This firmware is serial-only: it does not start Wi-Fi, does not run a WebSocket server,
and does not serve the web UI from flash.

## Target

- Board: Arduino UNO R4 WiFi
- FQBN: `arduino:renesas_uno:unor4wifi`
- Sketch: `firmware/uno_r4_wifi/uno_r4_wifi.ino`
- USB serial baud: `115200`

## Serial Protocol

The sketch accepts newline-terminated commands over USB serial:

```txt
PING
STATUS
BUTTON [1|2] <a|b|select|start|up|down|left|right> <down|up>
TAS_BEGIN <frames> <poll|latch|strobe> [ports] [window_us]
TAS_CHUNK <start> <count> [ports] <hex_masks> <checksum>
TAS_START [delay_polls]
TAS_CANCEL
TAS_END
TAS_STATUS
TAS_TRACE [count] [start]
TAS_TRACE_RESUME
```

The tested parser lives in `src/NesDeckProtocol.cpp`, the controller-state helper in
`src/NesControllerState.cpp`, and the latch-window playback helper in `src/NesTasPlayback.cpp`.

The current serial build reports this firmware id in the boot banner and `STATUS` response:

```txt
fw=tasdeck-uno-r4-serial-latchwin-v75 transport=serial
```

## NES Pins

The sketch treats NES latch and clock as Arduino inputs and drives the standard controller data lines.
The NES controller-port ground must also be connected to an Arduino `GND` pin so the NES and Arduino
share the same signal reference:

| NES port | NES signal | Arduino UNO R4 WiFi |
| --- | --- | --- |
| Port 1 | `GND` | `GND` |
| Port 1 | `OUT` / latch | `D2` input |
| Port 1 | `CLK` | `D3` input |
| Port 1 | `D0` standard controller data | `D6` output |
| Port 1 | `+5V` | not connected; insulate |
| Port 2 | `GND` | `GND` |
| Port 2 | `OUT` / latch | not connected; insulate |
| Port 2 | `CLK` | `D8` input with pull-up (safe when unwired) |
| Port 2 | `D0` standard controller data | `D7` output |
| Port 2 | `+5V` | not connected; insulate |

Use either Arduino `GND` header for controller-port ground; the Arduino ground pins are common.
Do not connect NES `+5V` to Arduino `5V`, and do not put a series resistor in the ground path.
Extra zapper pins on NES port 2 are unused.
The NES latch/strobe signal is common inside the console, so the port 1 connection to `D2` supplies
latch timing for both ports. Do not connect the port 2 latch wire; using the shared `D2` signal
ensures each console strobe runs exactly one latch ISR.

On the latch rising edge, the firmware snapshots the current stored button state. After a completed
eight-bit read, its final clock pre-positions the next mask's first bit between polls. The latch ISR
also writes that bit reactively after a short or bare read. The NES samples the controller data line
when controller clock goes high-to-low; a standard 4021 shifts on the following low-to-high edge.
The firmware therefore advances the shifted button bit on the controller clock rising edge. It
advances through the standard NES button order:

```txt
A, B, Select, Start, Up, Down, Left, Right
```

Each data line is active-low: pressed buttons drive `LOW`, released buttons drive `HIGH`. Outside
active strobe playback, the firmware drives `HIGH` after the 8 standard button bits so extra reads
remain released. In strobe mode the 8th clock instead pre-positions bit 0 of the next record before
the next latch edge.

Send `STATUS` over serial to inspect the flashed firmware id, clock shift edge, current masks,
shift index, and latch/clock counts while debugging controller timing.

TAS playback uses `TAS_BEGIN <frames> <poll|latch|strobe> [ports] [window_us]`. `TAS_START` arms record
0, and the firmware loads it before the corresponding controller read is sampled. Playback in
`poll` mode advances only after a latch window containing a completed eight-clock read. `latch`
mode advances once per accepted latch window even when the game reads fewer than eight bits.
`strobe` mode has no latch window: every accepted latch edge consumes exactly one record, including
bare strobes and torn reads. The `window_us` value is not a coalescing window in strobe mode. It only
guards the one-time frame-0 release; after playback starts, each latch tail prepares the next record
for a cheap commit at the following edge.
Two-port TAS chunks use interleaved port 1 / port 2 mask bytes. Use
`TAS_START <delay_polls>` when a run needs a small alignment offset before frame 0 is released; in
windowed modes this counts eligible blank latch windows. In `strobe` mode it counts accepted edges,
so `TAS_START N` is equivalent to TAStm32 `--blank N` for a default-mode R08 replay.
Port 1 or port 2 completed reads can grant frame-advance credit for the two-port streams uploaded by
the web UI.

A 1 kHz hardware-timer service normally advances and pre-positions the next mask when a windowed
mode's latch window expires; the main loop provides the same service as a best effort. In strobe
mode it releases frame 0 once, then the latch ISR tail prepares each later record. The latch ISR
advances in place only as a fallback. Keep serial and command handling from delaying the
higher-priority NES latch and clock interrupts.

Interrupt priorities depend on the sync mode. Windowed modes run the latch at NVIC priority 0 and
the clocks at 1 so simultaneously pended edges replay strobe-first. Strobe mode inverts this
(clocks 0, latch 1): games like Golf read `$4016` twice within 2.2 µs of the strobe — sooner than
the latch ISR can finish — and with the clocks on top those reads preempt the latch ISR's tail
instead of merging in the clock IRQ's single NVIC pending bit (one lost shift, every later bit
served one position late). The latch ISR guards clock-shared state with a short PRIMASK critical
head, and the clock ISRs restore strobe-first ordering in software by running a pended latch edge
inline before shifting. The windowed layout is restored by TAS_CANCEL, by the next windowed
TAS_BEGIN, and — deferred to `loop()`, since completion surfaces in ISR context — when a strobe
run completes or underruns on its own. `TAS_STATUS` reports DWT cycle counters (48 per µs,
core dispatch excluded from all of them): `latch_isr_last_cyc`/`latch_isr_max_cyc` is latch ISR
residency, entry to return — in strobe mode preempting clock ISRs are included, so it is not a
head budget — `latch_head_last_cyc`/`latch_head_max_cyc` is the strobe fast path's
entry-to-PRIMASK-release span, the number that must beat the console's second post-strobe read,
`latch_prefetch_masked_last_cyc`/`latch_prefetch_masked_max_cyc` conservatively brackets the strobe
tail's interrupt-masked preview publication (clock-preempted samples are discarded), and
`clock_write_last_cyc`/`clock_write_max_cyc` is the strobe clock ISR's entry-to-data-write span. The
bridge copies them into `.trace` headers and the `.stream.csv` footer.

`clock_write_max_cyc` is the per-bit deadline. The console samples bit N+1 one read after the
clock edge that carried bit N, so this span must stay under the game's tightest read-to-read
spacing. Golf's shot-setup routine reads `$4016` at CPU cycles 16/25/29/33/39/52 after the strobe,
which makes the Select/Start pair 4 CPU cycles apart (2.23 µs = 107 core cycles) and puts the
bit-4 (Up) sample 6 cycles (3.35 µs = 161 core cycles) after the bit-3 clock, against 13 cycles
(7.26 µs) for bit 5 (Down). That asymmetry is why Down reaches the console on every Golf club
change while Up does not. v74 shortens the span with instruction-count reductions only —
precomputed pending-latch register and mask, an inlined handler, a branchless level select — and
leaves the ICU request-flag clear and its `DSB` drain ahead of the write where they have always
been. v73 moved that clear behind the write and regressed Golf's first stroke on hardware for
reasons not yet established, so treat the ordering as fixed and use `clock_write_max_cyc` to
decide whether more is needed.

v75 removes v74's other clock-blocking interval. The latch-tail prefetch previously kept `PRIMASK`
set across the whole ring pop and staging operation (212 cycles measured on hardware), long enough
to merge two of Golf's 107-cycle-spaced reads. It now builds the ring preview with interrupts
enabled and masks only a validated publication step. If a clock ISR services a nested latch during
the preview, the changed single-consumer head makes the stale publication a no-op. This retains the
per-edge tail prefetch needed by Archon's burst strobes. The generated v75 critical body is 14 ARM
instructions from `cpsid` through `msr PRIMASK` (roughly 22–23 core cycles by Cortex-M4 timing).
Added to v74's measured 62-cycle clock-write maximum and roughly 12 cycles of exception entry, that
is about 96–97 cycles against Golf's 107-cycle tightest spacing. Confirm the exact maximum on
hardware in `latch_prefetch_masked_max_cyc`.

The same firmware also selects the interrupt-handler path automatically at `TAS_BEGIN`. `poll` and
`latch` use the lean window callbacks through the stock Arduino/FSP dispatch path, preserving the
timing that works through SMB3 Total Control's ACE handoff. `strobe` switches the three NES pin
vectors to the RAM-resident direct handlers needed by fast per-strobe `.r08` playback. Canceling or
finishing a strobe run restores the window vectors. This selection is based only on the existing
sync mode; there is no game list, movie-specific firmware, or mode branch on every NES edge.
`TAS_STATUS` reports the active selection as `irq_path=window_fsp` or
`irq_path=strobe_direct`.

`TAS_TRACE [count] [start]` reads from the firmware's trace ring. The ring stores the latest 384
rows, and each firmware response returns up to 12 rows so the middleware
can page through larger captures without overflowing the serial response buffer.
`TAS_TRACE_RESUME` clears a frozen trace/anomaly latch after the bridge has saved it, allowing the
next anomaly to freeze a fresh window. Each row includes sequence, timestamp micros, TAS frame,
latch count, clock count, clocks since latch, polled mask, next mask, latched mask, shift index,
result, the `clockedMask`
reconstructed from the active port data-line
level held through each controller read pulse, and the port that completed the poll. Rows are
per-port. Windowed modes write one row for each completed port read. Strobe mode instead produces one
edge row per active port at each recorded latch and suppresses completed-poll rows; the latch ISR only
stages a compact event and the 1 kHz service writes the rows, keeping the ISR shorter than the
console's second read after the strobe. Diag bit 5 marks
those edge rows, whose clocked mask describes the preceding inter-strobe read. `TAS_STATUS` reports
whole-run `bare_strobes` and `torn_strobes` counters for strobe-mode diagnostics. The web
`Trace` button requests the full 384-row window and saves the trace and resulting event log through
the middleware.

In `strobe` mode, the deadline-first clock handlers deliberately omit completed-read mask-mismatch
and reread anomaly bookkeeping. Consequently, `anomaly_count=0` means only that no enabled anomaly
detector fired; it does not prove that every completed serial mask matched the latched mask. Compare
the strobe trace's `clockedMask` values with the expected input stream and inspect the separate
`bare_strobes` and `torn_strobes` counters when validating a run.

## Tests And Compile

From the repository root:

```sh
npm run test:firmware
npm run compile:firmware
npm run upload:firmware -- --port /dev/cu.usbmodemXXXX
```

Find the upload port with `arduino-cli board list`. You can also set it with:

```sh
ARDUINO_PORT=/dev/cu.usbmodemXXXX npm run upload:firmware
```

On Windows from Git Bash, use the reported COM port:

```sh
ARDUINO_PORT=COM3 npm run upload:firmware
```

Firmware upload requires an explicit port because it is handled by Arduino CLI. This is separate
from running TASDeck: `npm start` automatically looks up the Arduino at connection time on macOS,
Linux, and Windows, including smart COM-port ranking on Windows.

## Forced-A Timing Diagnostic

Upload the diagnostic firmware:

```sh
ARDUINO_PORT=/dev/cu.usbmodemXXXX npm run upload:firmware:diagnostic
```

This compiles the same sketch with:

```txt
TASDECK_DIAGNOSTIC_FORCED_MASK=0x01
TASDECK_ISR_DEBUG_PIN=9
```

In this build, the firmware forces only `A` held from boot, ignores button changes, and pulses
Arduino `D9` high with direct port writes while a latch or clock ISR is running. The NES wiring stays
the same (`D2` shared latch, `D3`/`D8` clocks, `D6`/`D7` data). `D9` is only for a scope or logic
analyzer probe. The forced mask applies to port 1; port 2 is held released, normal button changes
are ignored, and TAS window service is disabled in this diagnostic build.

The boot banner should include:

```txt
DIAGNOSTIC: forced controller mask 0x01
DIAGNOSTIC: ISR debug pin D9
```

`STATUS` should include `forced=01 debug_pin=9 pressed=01`. Probe `D2`, `D3`, `D6`, `D8`, `D7`, and
`D9` with a shared ground. Re-upload the normal bridge firmware when finished:

```sh
ARDUINO_PORT=/dev/cu.usbmodemXXXX npm run upload:firmware
```
