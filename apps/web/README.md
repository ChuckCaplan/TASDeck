# TASDeck Web

Browser control deck for one on-screen NES controller that can target NES port 1 or port 2, TAS file
parsing, hardware TAS upload/control, and network manual input through the TASDeck middleware. The
browser never opens USB serial directly; the middleware owns the Arduino serial port.

## Run

From the repository root:

```sh
npm start
```

Your default browser opens at `http://localhost:8000`. The middleware also prints LAN URLs that can
be opened from an iPhone on the same Wi-Fi network.

For long runs on macOS, `caffeinate -d npm start` prevents idle sleep from interrupting the
middleware. This is not an npm script because `caffeinate` is macOS-specific; see the root README
and hardware TAS workflow for continuous trace-stream usage.

Set `PORT` to serve on a different port:

```sh
PORT=8765 npm start
```

To serve without opening a browser:

```sh
npm run serve:web
```

To force a specific Arduino serial device:

```sh
SERIAL_PORT=/dev/cu.usbmodemXXXX npm start
```

## Hardware Bridge

Use the connection panel at the top of the page:

Press `Connect` to open the WebSocket transport to the local middleware, which writes the UNO R4 USB
serial port at `115200` baud.

Close Arduino Serial Monitor before connecting. Hardware mode sends manual controller button events
as text protocol commands from the middleware to the firmware:

```txt
BUTTON a down
BUTTON a up
BUTTON 2 a down
BUTTON 2 a up
```

The controller shell contains a `P1` / `P2` toggle. Pointer and keyboard input go to the selected
NES port; switching ports releases any currently held on-screen buttons first. Keyboard controls use
the common NES emulator mapping: arrow keys for the D-pad, `Z` for `B`, `X` for `A`, `Enter` for
`Start`, and `Shift` for `Select`.

Hardware TAS playback accepts versioned `TD2P` `.tdmask` streams and raw `.r08` replay files. TD2P
stores interleaved port-1 and port-2 masks in TASDeck button-bit order; its header records format
version 1 and two ports even when every player-2 byte is zero. R08 is header-less; TASDeck reads it
as two controller bytes per record in NES serial bit order (reversed while importing) under the
replay-device convention and its assumptions documented in the
[hardware TAS workflow guide](../../docs/hardware-tas-workflow.md#r08-format).

`.tdmask` always uses completed-read advancement. `.r08` defaults to per-strobe advancement and
exposes an inline picker in the Status field for completed-read, accepted-window, or per-strobe
advancement. The picker is hidden for `.tdmask` loads. The TAS panel also exposes two alignment
controls:

- `Start delay`: waits before mask 0 and counts blank windows in windowed modes or accepted edges in
  per-strobe mode. It prefills to the mode's default — 1 in per-strobe mode (TAStm32 `--blank 1`
  parity), otherwise 0 — until a value is entered by hand, which then survives mode changes.
- `Skip first`: discards this many masks from the front of the uploaded stream before the bridge
  sends data to the Arduino.

### TAS Controller Preview

During hardware TAS playback, the on-screen controller highlights the buttons in the current TAS
mask. The `P1` / `P2` selector chooses which port to display for two-controller streams; switching
the preview does not change the hardware playback data.

After `Start` is pressed, the preview stays blank until firmware status confirms that playback has
started and the NES has produced controller activity. Completed-read mode waits for controller
clock activity, while the accepted-window and per-strobe modes wait for latch activity. The preview then anchors itself
to the firmware's current mask index, animates at the expected NES frame rate between status
updates, and corrects its position whenever another firmware status arrives. `Start delay` and
`Skip first` are included in the effective preview position.

The preview is display-only: it does not send TAS button events, alter the uploaded masks, or affect
firmware timing. It is intentionally approximate and may appear about half a second to one second
after the console begins polling or make a small correction in games with unusual controller-read
timing. Hardware playback continues independently of the browser preview.

The NES event log keeps the newest 120 browser-visible events. `Copy` copies the visible log to the
clipboard. `Trace` asks the firmware for the latest TAS trace rows, logs compact rows and anomaly
summaries, and asks the middleware to save the full event log under `logs/trace/` with a
`<timestamp>_<tas-file-base>.trace` filename. Firmware trace rows include the active port plus
line/mask fields from the port data line held through each controller read pulse. The current
firmware and web UI capture 512 completed polls per trace request.

## Tests

```sh
npm run lint:web
npm run test:web
npm run test:ui
```

The linter covers the web source, tests, and middleware script. The tests exercise the pure TAS
helper module in `src/tas.js`, the serial command formatting helper in `src/transport.js`, and key
middleware helpers. The Playwright UI tests cover mobile controller layout and touch input.
