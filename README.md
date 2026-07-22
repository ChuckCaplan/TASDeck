# TASDeck

TASDeck lets you control a real NES from a browser and play tool-assisted speedrun (TAS) files on
real hardware using an Arduino UNO R4. The browser provides live controller input and TAS
controls, a small Node middleware owns the Arduino USB connection, and the firmware drives the NES controller ports.

## Why This Project Exists

Other projects can already play TAS files on real NES hardware, but I wanted something that could run on a single Arduino UNO
R4 board — no physical shift register, breadboard, resistors, or other external components —
with the controller ports wired directly to the Arduino's pins.

## TASDeck In Action

### Main TASDeck Screen

![Main TASDeck browser interface with controller, playback controls, connection status, and event log](docs/images/TASDeck.png)

### Arduino UNO R4 WiFi (Two Controller Ports Connected)

<img src="docs/images/arduino.jpg" alt="Arduino UNO R4 WiFi wired to the NES controller ports for TASDeck" width="600">

## Get Started

Follow the [Installation guide](INSTALL.md) for prerequisites, controller-port wiring, firmware
upload, TAS preparation, and the first real-console run.

Once TASDeck is installed and the firmware is uploaded, start the web app and middleware with:

```sh
npm start
```

Open `http://localhost:8000`, or use one of the printed LAN URLs from a phone on the same network. Press `Connect` in the web app to open the Arduino USB bridge. Rotate the phone to landscape mode for the touch controller view; the layout is designed to feel like a handheld controller for driving the real NES.

TASDeck supports live controller input from the on-screen controls or keyboard, routes input to NES
port 1 or port 2, and plays versioned `.tdmask` streams or raw `.r08` replay files on a real NES. A
`.tdmask` is generated from an `.fm2` (FCEUX) or `.bk2` (BizHawk) TAS movie using the converter
scripts in `scripts/` (see the [Installation guide](INSTALL.md)); an `.r08` can be played
directly with no conversion, defaulting to a per-strobe mode that matches default TAStm32
replay semantics.

During hardware TAS playback, the on-screen controller lights up the buttons for the selected NES port, so you can watch the inputs as they're sent to the NES, and a run timer shows elapsed and
total time — exact for .tdmask movies, and estimated for.r08. The event log can capture firmware traces for diagnosing
playback alignment and hardware timing.

Keyboard input uses common NES emulator mapping:

| NES button | Keyboard |
| --- | --- |
| D-pad | Arrow keys |
| `B` | `Z` |
| `A` | `X` |
| `Start` | `Enter` |
| `Select` | `Shift` |

## How It Fits Together

```txt
Browser UI  <-- WebSocket -->  Node middleware  <-- USB serial -->  UNO R4 firmware  -->  NES
```

- `apps/web` contains the dependency-free browser control deck and TAS parsing helpers.
- `scripts/bridge-server.js` serves the app, owns the serial port, and streams hardware TAS data.
- `firmware/uno_r4_wifi` implements the serial protocol and NES controller-port timing.

## Documentation

- [Installation](INSTALL.md) — complete first-time setup, prerequisites, wiring, firmware upload,
  and initial verification.
- [Hardware TAS playback and troubleshooting](docs/hardware-tas-workflow.md) — understand the
  `.tdmask` and `.r08` formats and perform advanced trace-based desync diagnosis.
- [Firmware guide](firmware/uno_r4_wifi/README.md) — pin assignments, serial protocol, firmware
  behavior, compilation, upload, and diagnostic builds.
- [Web app guide](apps/web/README.md) — browser controls, middleware connection, TAS playback
  options, event-log tracing, and web-specific test commands.
- [Contributor and agent guide](AGENTS.md) — repository architecture, development constraints,
  testing guidance, and the manual QA checklist.

## Verified TAS Runs

The following runs have completed successfully on real NES hardware with TASDeck:

| Game and run | Time | Link | Original Format | Hardware |
| --- | ---: | --- | --- | --- |
| Super Mario Bros. — "warps" by HappyLee | 04:57.31 | [1715M](https://tasvideos.org/1715M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. — "warpless" by HappyLee & Mars608 | 18:36.78 | [3728M](https://tasvideos.org/3728M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. — "Playaround" | 23:30.36 | [User File](https://tasvideos.org/UserFiles/Info/638765452219459600) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. — "maximum score" | 19:01 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.r08` | EverDrive N8 Pro |
| Super Mario Bros. 2 (FDS / Japan) — "all items, Mario" by Kzwbz, Argentu-M & Endless Wind | 23:33 | [5049M](https://tasvideos.org/5049M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. 2 (FDS / Japan) — "warps, Mario" by HappyLee | 08:04.83 | [3348M](https://tasvideos.org/3348M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. 2 (FDS / Japan) — "SMB2J ACE Total Control example" | 14:44 | [GitHub](https://github.com/threecreepio/smb2j-ace-tc) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. 2 (USA) — "warpless" by Aglar, andrewg & Alyosha | 18:24 | [6366M](https://tasvideos.org/6366M) | `.bk2` | EverDrive N8 Pro |
| Super Mario Bros. 2 (USA) — "warps" by Aglar & andrewg | 07:41.16 | [1724M](https://tasvideos.org/1724M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. 3 — "all levels" (100%) by Lord_Tom & Tompa | 1:04:37 | [2835M](https://tasvideos.org/2835M) | `.fm2` | EverDrive N8 Pro |
| Super Mario Bros. 3 — "warps" by Lord_Tom, Maru & Tompa | 10:24.338 | [3922M](https://tasvideos.org/3922M) | `.fm2` | Real cartridge |
| Super Mario Bros. 3 — Lord_Tom & Tompa's NES Super Mario Bros. 3 | 02:54.98 | [4288S](https://tasvideos.org/4288S) | `.fm2` | Real cartridge & EverDrive N8 Pro |
| Double Dragon by Alyosha | 08:52 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.r08` | EverDrive N8 Pro |
| Double Dragon II — 2 players by Alyosha | 08:23 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.r08` | EverDrive N8 Pro |
| Tetris — "maximum score" by r57shell & Archanfel | 02:53.13 | [4853M](https://tasvideos.org/4853M) | `.fm2` | EverDrive N8 Pro |
| Pac-Man (Tengen) by Alyosha | 12:04 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.bk2` | EverDrive N8 Pro |
| Donkey Kong by Alyosha | 01:16 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.bk2`, `.r08` | EverDrive N8 Pro |
| The Legend of Zelda — Baxter & jprofit22 | 22:38.13 | [1685M](https://tasvideos.org/1685M) | `.fm2` | EverDrive N8 Pro |
| The Legend of Zelda "Swordless Challenge" by Lord Tom | 24:39.71 | [3289M](https://tasvideos.org/3289M) | `.fm2` | EverDrive N8 Pro |
| Ghosts 'n Goblins - Arc & Koh1fds | 08:07.55 | [3173M](https://tasvideos.org/3173M) | `.fm2` | EverDrive N8 Pro |
| Lode Runner by Alyosha | 17:42 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.r08` | EverDrive N8 Pro |
| Monopoly by Alyosha | 00:31 | [Replay Files](https://github.com/alyosha-tas/NES_replay_files) | `.r08` | EverDrive N8 Pro |
| Disney's The Little Mermaid - McBobX | 06:41.32 | [3298M](https://tasvideos.org/3298M) | `.fm2` | EverDrive N8 Pro |

## Background

TASDeck was inspired by [TAStm32](https://github.com/Ownasaurus/TAStm32), [TASBot](https://tas.bot/),
[NESBot](https://www.instructables.com/NESBot-Arduino-Powered-Robot-beating-Super-Mario-/), and
[VeriTAS](https://github.com/bigbass1997/VeriTAS).

Created by [Chuck Caplan](https://github.com/ChuckCaplan).
