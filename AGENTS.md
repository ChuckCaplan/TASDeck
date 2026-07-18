# TASDeck

## Project Overview

This project has three pieces:

- `apps/web`: A dependency-free browser control deck for manual NES input, versioned `TD2P`
  `.tdmask` and raw `.r08` validation/upload/control, event-log copy/trace controls, and a WebSocket transport
  through middleware.
- `scripts/bridge-server.js`: Dependency-free Node middleware that serves the web app, accepts
  browser WebSocket events, owns the USB serial port, sends firmware protocol commands, and streams
  bridge-owned hardware TAS chunks.
- `firmware/uno_r4_wifi`: Arduino UNO R4 WiFi firmware for the hardware bridge side. It accepts a
  tested USB serial command protocol, stores controller state, and drives NES controller data in
  response to console latch/clock polling. The firmware does not start Wi-Fi, run WebSocket, or serve
  the web UI.

The repository intentionally keeps tooling light. There is a root `package.json`, but there are no
runtime npm dependencies. Dev tooling is installed with `npm install` when linting or Playwright UI
tests need local packages.

## How To Run

Serve the web app from the repository root:

```sh
npm start
```

Then visit `http://localhost:8000` on the host computer or the printed LAN URL on an iPhone. Press
`Connect` in the connection panel to open the Arduino USB serial bridge. Hardware TAS playback
expects a pre-generated `.tdmask` mask stream or raw `.r08` replay. Trace captures from the event log are written under
`logs/trace/`, which is intentionally ignored by git. Set `BRIDGE_TAS_TRACE_STREAM=1` when starting
the app to write a continuous `.stream.csv` trace for each hardware TAS run.

## Tests And Checks

Run all executable tests:

```sh
npm run lint
npm test
```

Compile the Arduino sketch:

```sh
npm run compile:firmware
```

Run tests plus firmware compile:

```sh
npm run check
```

The web tests use Node's built-in test runner. Firmware tests compile the protocol, controller
state, and TAS playback helpers with the host C++ compiler. `npm test` also runs Playwright UI
specs. `npm run lint` runs ESLint against the web JavaScript and test files. The Arduino compile
target is `arduino:renesas_uno:unor4wifi`.

## File Map

- `apps/web/index.html`: App structure and controls.
- `apps/web/styles.css`: Responsive visual design for the NES-style control deck.
- `apps/web/src/app.js`: UI state, input handling, network transport behavior, hardware TAS
  playback controls, and UI updates.
- `scripts/bridge-server.js`: Static web server, WebSocket middleware, USB serial connection, and
  disconnect release behavior.
- `apps/web/src/transport.js`: Pure event-to-firmware-command helpers shared by the app and tests.
- `apps/web/src/tas.js`: Pure TAS parsing, mask normalization, validation, and checksum helpers
  shared by the app and tests.
- `apps/web/tests/tas.test.js`: Web helper tests.
- `apps/web/tests/transport.test.js`: Web transport command-formatting tests.
- `apps/web/tests/bridge-server.test.js`: Middleware, WebSocket, serial, upload, and trace tests.
- `apps/web/tests/expand-tdmask-from-hardware-trace.test.js`: Hardware-trace expansion tests.
- `apps/web/tests/ui/*.spec.js`: Playwright UI regression tests.
- `playwright.config.js`: Playwright web-server and browser test configuration.
- `docs/hardware-tas-workflow.md`: FM2/BK2-to-`.tdmask` hardware playback workflow.
- `scripts/convert-fm2-to-tasdeck-mask.sh`: FCEUX wrapper for producing `.tdmask` files.
- `scripts/fceux-export-tasdeck-mask.lua`: FCEUX Lua exporter for lag-stripped mask streams.
- `scripts/convert-bk2-to-tasdeck-mask.sh`: Git Bash BizHawk BK2 converter for Windows.
- `scripts/bizhawk-export-tasdeck-mask.lua`: BizHawk Lua exporter for lag-stripped mask streams.
- `scripts/expand-tdmask-from-hardware-trace.js`: Diagnostic tool that expands a stream using a
  continuous hardware trace, the sibling exporter trace, and the source FM2.
- `firmware/uno_r4_wifi/uno_r4_wifi.ino`: Arduino UNO R4 WiFi serial bridge sketch.
- `firmware/uno_r4_wifi/src/NesDeckProtocol.*`: Testable firmware command protocol parser.
- `firmware/uno_r4_wifi/src/NesTasPlayback.*`: Testable latch-synchronized TAS mask playback.
- `firmware/uno_r4_wifi/src/NesControllerState.*`: Testable NES controller state and active-low
  shift behavior.
- `firmware/uno_r4_wifi/tests/protocol_test.cpp`: Host-compiled firmware protocol tests.
- `scripts/test.sh`: Web and firmware protocol tests.
- `scripts/compile-firmware.sh`: Arduino compile command.
- `scripts/upload-firmware.sh`: Arduino upload command with `--port` and `ARDUINO_PORT` support.
- `scripts/check.sh`: Full local verification.
- `README.md`: User-facing overview and commands.

## Web Core Concepts

### NES Bridge Transports

Outbound web actions flow through the transport boundary in `apps/web/src/app.js`. Keep bridge calls
behind transport objects rather than scattering hardware calls through UI handlers.

Current transport:

- `NetworkBridgeTransport`: sends live manual input and hardware TAS upload/control messages to the
  local middleware over WebSocket.
- `scripts/bridge-server.js`: converts hardware-bound events to UNO R4 firmware commands and writes
  USB serial at `115200` baud.

Important event types:

- `button`: Controller button up/down events.
- `playback`: Human-readable status events.
- `blocked`: Events dropped because the Arduino bridge is disconnected.
- `bridge`: Connection and firmware acknowledgement events.
- `tas_trace`: Browser request for the middleware to page `TAS_TRACE` rows from the firmware.
- `save_event_log`: Browser request for the middleware to persist an event-log snapshot.

The event log keeps the newest 120 entries and displays the retained count. `Copy` copies the
visible log. `Trace` captures the firmware trace ring, logs compact rows and anomaly summaries, and
saves the full event log to `logs/trace/<timestamp>_<tdmask-base>.trace`.

### Controller Input

Controller buttons are pointer-driven and keyboard-driven. The P1/P2 selector routes the shared
on-screen controller to one NES port at a time and releases held input before switching. Press state
is tracked in `state.pressed` and mirrored in the device state text. Manual input uses
`sendButton(button, action, source)` and includes `controllerPort` in the transport event.

Keyboard controls use the common NES emulator mapping:

- Arrow keys: D-pad.
- `Z`: `B`.
- `X`: `A`.
- `Enter`: `Start`.
- `ShiftLeft` and `ShiftRight`: `Select`.

### TAS Playback

Hardware TAS playback uploads a parsed mask stream to the bridge, then the bridge streams chunks to
the Arduino. The Arduino advances through masks according to NES controller latch timing rather than
a browser timer. In the windowed `poll` and `latch` modes, latch edges closer together than the latch window (default 8 ms) are the same
console frame and re-serve the current mask; expiry after a wider gap advances to the next mask, but
only when the previous window contained a completed 8-clock read (bare boot strobes and latch noise
never consume masks) in `poll` mode. `latch` mode grants advancement credit to every accepted window
without requiring a completed read. In `strobe` mode every accepted latch edge consumes one record,
with no window coalescing or completed-read gate. The next latch then serves the pre-positioned mask. Streams start with the
versioned `TD2P` header (`TD2P 02 02 0D 0A` plus a big-endian uint32 source-movie frame count in
version 2; `TD2P 01 02 0D 0A` in still-loadable version 1) and store interleaved port 1 / port 2
bytes per movie frame that polls either controller. Lag frames are
omitted, so games that read the controllers a variable number of times per frame (SMB3, Tetris under
DPCM DMA read corruption) stay in sync; the v2 frame count preserves the movie's true length so the
UI can time the run exactly, with zero meaning unknown.

The normal windowed-mode advance happens when a 1 kHz hardware-timer service detects that the window expired and
calls `onWindowExpired`; the main loop also services expiry as a best effort. It does not normally
wait for the next latch ISR: the console samples the first bit (A) only a few microseconds after the
strobe edge, sooner than the latch ISR can update the data line, so the next mask's bit 0 must already
be on the wire when the strobe arrives. The pre-advance re-latches the shift register, not just the
pin: games that read controller 2 (SMB3) pulse the shared strobe without clocking port 1, leaving
`controllerShiftIndex` at 0 with the stale latched mask, and a plain pin rewrite would keep driving
the old first bit. Between polls the data line carries bit 0 of the mask the next strobe will serve
rather than "not pressed". The in-ISR advance remains only as a fallback if expiry service is missed.
The latch interrupt runs at strictly higher priority than the clock interrupt so edges that pend
behind a blocked stretch replay in strobe-then-clock order. Keep these properties when touching the
firmware: nothing on the serial/command path may mask interrupts long enough to delay the NES pin
ISRs, which is also why the playback frame ring uses free-running
single-producer/single-consumer indices and status snapshots read fields without `noInterrupts()`.

`Start delay` is sent to firmware as `TAS_START <delay_frames>` and waits that many windows in a
windowed mode or that many accepted edges in `strobe` mode before releasing record 0. `Skip first` is bridge-owned; the middleware
slices that many masks from the front of the uploaded stream before sending chunks to the Arduino.

The UI accepts versioned `TD2P` `.tdmask` files with interleaved port 1 / port 2 bytes and raw R08
files with two bytes per record. TD2P bytes use A, B, Select, Start, Up, Down, Left, Right bit order;
R08 bytes are reversed from their NES serial order during import. `.tdmask` always uses completed-read
poll mode. `.r08` defaults to per-strobe playback, which matches default TAStm32 `.r08` semantics by
consuming one two-port record on every accepted latch edge, and prefills `Start delay 1` to mirror
the blank record default TAStm32 dumps prepend (the prefill only applies while the delay field is
untouched). The UI picker can switch an `.r08` to completed-read poll or accepted-latch-window mode
for dumps documented as needing TAStm32 `--dpcm`.

Hardware TAS playback uses the upload/chunk protocol with pre-generated mask bytes. Do not send
browser-timed TAS button diffs to the real hardware bridge.

The FM2-to-mask converter also writes `<output>.trace.csv`, which is the emulator-side comparison
file for firmware trace logs.

## Firmware Core Concepts

The firmware parser accepts newline-terminated serial commands at `115200` baud:

```txt
PING
STATUS
BUTTON [1|2] <a|b|select|start|up|down|left|right> <down|up>
TAS_BEGIN <frames> <poll|latch|strobe> [ports] [window_us]
TAS_CHUNK <start> <count> [ports] <hex_masks> <checksum>
TAS_START [delay_frames]
TAS_CANCEL
TAS_END
TAS_STATUS
TAS_TRACE [count] [start]
TAS_TRACE_RESUME
```

Firmware `TAS_TRACE` returns up to 12 rows per response from a 512-entry trace ring. Windowed runs
write completed-poll rows; strobe runs write one edge row per active port and suppress poll rows. The
middleware pages this into the full trace window requested by the web UI.

Keep the parser in `NesDeckProtocol.*` and controller state in `NesControllerState.*` independent
from Arduino APIs so they remain host-testable. Put hardware-specific serial IO and pin interrupts in
`uno_r4_wifi.ino`.

NES pin map:

- Port 1 ground to Arduino `GND`; latch `D2`, clock `D3`, data `D6`.
- Port 2 ground to Arduino `GND`; clock `D8`, data `D7`. Do not connect its latch wire; `D2` receives
  the NES's shared latch signal for both ports.
- NES `+5V` is not connected to the Arduino on either port.

### Diagnostic Firmware

Diagnostic firmware targets are available for controller-port timing isolation:

```sh
npm run compile:firmware:diagnostic
ARDUINO_PORT=/dev/cu.usbmodemXXXX npm run upload:firmware:diagnostic
```

The diagnostic upload compiles the same sketch with `TASDECK_DIAGNOSTIC_FORCED_MASK=0x01` and
`TASDECK_ISR_DEBUG_PIN=9`. It forces port 1 `A` from boot for manual-input isolation, holds port 2
released, and pulses Arduino `D9` while latch/clock ISRs run. Use it to inspect the shared latch on
`D2`, the `D3`/`D8` clocks, the `D6`/`D7` data lines, and `D9` ISR timing with a scope or logic
analyzer, then re-upload normal firmware with `npm run upload:firmware`.

Diagnostic builds ignore normal button changes, but TAS control commands such as `TAS_BEGIN` and
`TAS_CANCEL` can clear the output mask. Do not use the diagnostic target as proof of TAS
upload/playback behavior.

## Development Guidance

- Keep the web app dependency-free unless the task clearly requires otherwise.
- Prefer small, direct changes in the existing files over introducing new structure.
- Preserve the web transport boundary; add transports rather than wiring bridge calls directly into
  UI handlers.
- Preserve the firmware parser boundary in `NesDeckProtocol.*`.
- Preserve existing event shapes unless the user explicitly wants a bridge contract change.
- Be careful with button release behavior. Playback stops and disconnects should not leave held
  inputs stuck.
- Keep responsive layouts intact. The controls are dense, and mobile breakpoints matter.
- Add or update tests with meaningful behavior changes. Prioritize pure helpers first: TAS parsing,
  FM2 parsing, button and mask normalization, validation, checksums, web transport command
  formatting, firmware command parsing, controller state, and TAS playback behavior.

## Manual QA Checklist

Playwright covers a small browser regression suite, but still verify manually after meaningful UI or
hardware-flow changes:

- App loads without console errors.
- Manual controller button presses log down/up events.
- Switching the on-screen controller between P1 and P2 releases held input on the old port before
  routing new input to the selected port.
- Disconnected Arduino mode blocks events and logs `blocked` entries.
- The Connect button connects through the middleware and logs firmware responses.
- Disconnecting Arduino USB while a button is held sends release commands first.
- The file picker offers `.tdmask` and `.r08`; invalid extensions, TD2P files without a valid
  versioned header, and empty or odd-length R08 files are rejected.
- A generated versioned `TD2P` `.tdmask` file loads as a two-controller console-ready mask stream
  and uploads after Arduino USB is connected, including when all port 2 bytes are zero.
- A raw `.r08` file loads as a two-controller stream, reverses each controller byte, defaults to
  per-strobe sync mode with `Start delay` prefilled to 1, and exposes a selector that can switch the
  upload to poll or latch-window mode.
- The `Start delay` and `Skip first` controls stay editable before arming and disabled during active
  hardware playback.
- The progress row's run timer shows elapsed wall-clock time and the run duration — exact from a
  TD2P v2 source-movie frame count, otherwise a `~` estimate refined by the measured record
  consumption rate every ten elapsed seconds — and notes when the console stops reading input.
- Pressing `Trace` logs trace rows/anomaly status and saves a `.trace` file under `logs/trace/`.
- Event-log actions remain usable at narrow mobile width; `Trace`, `Copy`, and `Clear` should not
  overflow off screen.
- Layout remains usable at desktop width, tablet width, and narrow mobile width.

## Current Limitations

- The web UI does not accept raw FM2 or BK2 files; convert the movie plus its
  matching ROM to `.tdmask` first.
- Frame-model `.tdmask` playback depends on console and emulator lag/poll behavior matching closely.
  Per-strobe `.r08` playback handles multiple consumed reads within one frame, but it cannot recover
  when the console accepts a different number of strobes than the replay encodes.
