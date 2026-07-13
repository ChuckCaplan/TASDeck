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
TAS_BEGIN <frames> poll [ports] [window_us]
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
fw=tasdeck-uno-r4-serial-latchwin-v46 transport=serial
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

On the latch rising edge, the firmware snapshots the current stored button state. The data line is
already pre-positioned with the next mask's first bit between polls, so the latch ISR only needs one
edge per strobe. The NES samples the controller data line when controller clock goes high-to-low; a
standard 4021 shifts on the following low-to-high edge. The firmware therefore advances the
shifted button bit on the controller clock rising edge. It advances through the standard NES button
order:

```txt
A, B, Select, Start, Up, Down, Left, Right
```

Each data line is active-low: pressed buttons drive `LOW`, released buttons drive `HIGH`. After the
8 standard button bits have been shifted out, the firmware drives `HIGH` so extra reads remain
released instead of looking like phantom button presses.

Send `STATUS` over serial to inspect the flashed firmware id, clock shift edge, current masks,
shift index, and latch/clock counts while debugging controller timing.

TAS playback uses `TAS_BEGIN <frames> <poll|latch> [ports] [window_us]`. `TAS_START` arms frame 0, and the
firmware loads it at the next NES latch window before that controller read is sampled. Playback
in `poll` mode advances only after a completed eight-clock read. `latch` mode, intended for R08
replays, advances after an accepted latch even when the game reads fewer than eight bits.
Two-port TAS chunks use interleaved port 1 / port 2 mask bytes. Use
`TAS_START <delay_polls>` when a run needs a small alignment offset before frame 0 is released; in
`latch` mode this is the exact number of blank latch windows served before frame 0.
Port 1 or port 2 completed reads can grant frame-advance credit for the two-port streams uploaded by
the web UI.

A 1 kHz hardware-timer service normally advances and pre-positions the next mask when the latch
window expires; the main loop provides the same service as a best effort. The latch ISR advances
only as a fallback if expiry service was missed. Keep serial and command handling from delaying the
higher-priority NES latch and clock interrupts.

`TAS_TRACE [count] [start]` reads from the firmware's completed-poll trace ring. The ring stores the
latest 512 completed port reads, and each firmware response returns up to 12 rows so the middleware
can page through larger captures without overflowing the serial response buffer.
`TAS_TRACE_RESUME` clears a frozen trace/anomaly latch after the bridge has saved it, allowing the
next anomaly to freeze a fresh window. Each row includes sequence, timestamp micros, TAS frame,
latch count, clock count, clocks since latch, polled mask, next mask, latched mask, shift index,
result, the `clockedMask`
reconstructed from the active port data-line
level held through each controller read pulse, and the port that completed the poll. Rows are
per-port: each completed port read produces one row, correlated by sequence and timestamp. The web
`Trace` button requests the full 512-row window and saves the trace and resulting event log through
the middleware.

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
