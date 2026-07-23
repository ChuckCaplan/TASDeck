# Hardware TAS Playback And Troubleshooting

This guide covers the details beyond the first-time setup in [Installation](../INSTALL.md): the
`.tdmask` and `.r08` formats, console synchronization, and advanced trace-based desync diagnosis. For
controller-port wiring, the serial protocol, and firmware diagnostics, see the [firmware
guide](../firmware/uno_r4_wifi/README.md).

## `.tdmask` Format

Hardware playback uses a pre-generated mask stream instead of browser-timed button changes. Raw FM2
files are emulator-frame input logs; they can contain lag frames and command or reset markers that
do not map directly to controller reads on a real NES.

A `.tdmask` stream stores one port 1 / port 2 mask pair for each movie frame that polls either
controller. Frames with no controller poll are omitted. Each controller byte uses this layout:

```txt
bit 0: A
bit 1: B
bit 2: Select
bit 3: Start
bit 4: Up
bit 5: Down
bit 6: Left
bit 7: Right
```

Streams begin with a versioned header and contain interleaved port 1 and port 2 bytes. Version 2,
the current export format, follows the eight header bytes with a big-endian uint32 holding the
source movie's total video-frame count (lag frames included), which TASDeck uses to display the
run duration. That display is informational and should not be used for official TAS timing (which
is frame-counted in the emulator), nor for RTA speedrun timing, whose start points are
game-specific and usually later than the movie's beginning — an SMB1 speedrun clock starts at
game-mode selection, slightly after the movie has already begun at power-on:

```txt
"TD2P", 02, 02, 0D, 0A, frames_be32, p1_frame0, p2_frame0, p1_frame1, p2_frame1, ...
```

A frame count of zero means the exporter could not learn the total; TASDeck then estimates the
duration, exactly as it must for a version 1 stream (`"TD2P", 01, 02, 0D, 0A, ...`), which remains
loadable. The versioned header identifies a two-port stream even when every port-2 mask is zero.
`.tdmask` is currently specific to TASDeck.

## `.r08` Format

TASDeck also imports raw R08 replay files directly. R08 is header-less: the bytes carry no ROM
identity, reset timing, controller count, or indication of whether each record is a whole frame or a
single latch. TASDeck therefore reads every `.r08` under the NES replay-device convention that the
public verification files use (for example the
[alyosha-tas](https://github.com/alyosha-tas/NES_replay_files) corpus):

- **Two bytes per record, port 1 then port 2.** One-player runs still carry a port-2 byte of `0x00`.
  Because there is no header, TASDeck cannot distinguish a genuine single-controller stream that
  stores one byte per record from a two-controller stream, and assumes two. An odd-length file is
  rejected, but an even-length single-controller file would be misread, splitting its frames across
  the two ports. Load only two-byte replay-device R08 files.
- **NES serial bit order, Right through A**, which TASDeck reverses into its internal A-through-Right
  mask order while loading.
- **Selectable synchronization.** Because R08 cannot say whether its records are frames or latches,
  TASDeck assumes the common case — one record per strobe, as default TAStm32 settings record —
  and defaults R08 loads to per-strobe mode. The `Sync Mode` picker can select `poll` or `latch`
  for dumps documented as needing TAStm32 `--dpcm` window playback (see
  [Console Synchronization](#console-synchronization)).

These are conventions the file cannot prove, not guarantees. The self-describing successor format
[TASD](https://tasd.io/) records console, port count, and frame-versus-latch semantics in a header,
much as `.tdmask` carries a versioned `TD2P` header; `.r08` carries none of it, so correct playback
depends on the file matching this convention.

## Generate A Stream

Use the same ROM targeted by the movie. On macOS, the FM2 converter locates FCEUX through
`FCEUX_BIN`, on `PATH`, or at `/opt/homebrew/bin/fceux`:

```sh
scripts/convert-fm2-to-tasdeck-mask.sh \
  "movie.fm2" \
  "game.nes" \
  "movie.tdmask"
```

On Windows, download the native [FCEUX Win64 build](https://fceux.com/web/download.html), put
`fceux64.exe` on `PATH`, and run that same command from Git Bash. The wrapper uses the native
Windows FCEUX command-line options and translates its Git Bash input, output, trace, completion, and
Lua-script paths automatically. Override the executable with a Git Bash path when needed:

```sh
FCEUX_BIN=/c/FCEUX/fceux64.exe \
  scripts/convert-fm2-to-tasdeck-mask.sh \
  "movie.fm2" \
  "game.nes" \
  "movie.tdmask"
```

On Windows, use the BizHawk converter for an NES `.bk2` movie. Put `EmuHawk.exe` on `PATH` and run it
from Git Bash:

```sh
scripts/convert-bk2-to-tasdeck-mask.sh \
  "movie.bk2" \
  "game.nes" \
  "movie.tdmask"
```

BizHawk can be overridden when needed, for example with
`BIZHAWK_BIN=/c/BizHawk/EmuHawk.exe`.

The output path is optional. The converter also accepts the movie and ROM arguments in the opposite
order. For `.bk2`, it restarts the movie at frame 0 in BizHawk, writes both controller masks for each
non-lag frame, and exits BizHawk when finished. Keep any core/firmware settings required by the
movie in the BizHawk installation used for the export.

Before launching the emulator, both converters inspect the movie's controller configuration and
input columns. They accept only standard NES controller buttons on ports 1 and 2 and fail on Zapper,
Arkanoid paddle, Power Pad, Four Score/P3/P4, microphone, expansion-port, or unknown controller
input. Those devices use protocols or data lines that TASDeck does not drive.

Each converter also creates `<output>.trace.csv`. The FCEUX trace has one row per completed emulator
poll and includes poll-level diagnostic fields. The BizHawk trace maps each emitted mask pair to its
source BK2 movie frame.

The ROM, movie, and initial console state must match. A different ROM revision, header, save state,
or startup path can change lag and controller polling enough to desynchronize the run.

## Console Synchronization

A `.tdmask` export always advances only after a window containing a completed eight-clock controller
read, and its sync mode is not user-selectable. A raw `.r08` replay defaults to `strobe` mode, which
consumes one record on every accepted latch edge with no window coalescing — the semantics default
TAStm32 settings record and replay. When an R08 file is loaded, the `Sync Mode` picker can instead
select `poll`, or `latch`, which advances once per accepted latch window without a completed-read
gate; both windowed modes exist for dumps documented as needing TAStm32 `--dpcm`.

| Source data | Sync mode |
| --- | --- |
| `.tdmask` from FCEUX/BizHawk (lag-stripped, one record per polled frame) | `poll` |
| `.r08` verified with default TAStm32 settings | `strobe` |
| `.r08` documented as requiring TAStm32 `--dpcm` | `poll` or `latch` |
| A future SubNESHawk per-latch dump | `strobe` |

This is important for games such as SMB3 and Tetris. DPCM sample DMA can corrupt a controller read,
causing the game to reread until two consecutive values match. Serving a new mask for every poll
would drift the stream, while serving one mask per latch window gives each reread the same value.

Before arming playback:

- Put the cartridge or EverDrive and game at the exact state expected by the movie.
- Use `Start delay` to wait before releasing record 0. It counts blank windows in `poll`/`latch`
  mode and accepted edges in `strobe` mode; TAStm32 `--blank N` maps directly to strobe-mode
  `Start delay N`, so strobe mode prefills `Start delay 1` to match the one blank record default
  TAStm32 dumps prepend. A hand-entered delay survives mode changes; the prefill applies only while
  the field is untouched. `.tdmask` always uses completed-read windows.
- Use `Skip first` to discard masks from the front of the uploaded stream.

For a power-on movie, load the `.tdmask` or `.r08` and press `Play` once to arm it. While the NES is off or
held in reset, press `Start` in TASDeck, then power on or release reset so the first controller read
receives frame 0.

Do not include EverDrive menu navigation in the TAS stream. Perform any menu navigation or launch
button as a separate manual step before arming the run; adding those inputs to the movie shifts its
timeline.

## Diagnose A Desync

First rule out the common causes:

- The ROM does not exactly match the movie.
- The console, cartridge, save data, or EverDrive started in a different state.
- `Start delay` or `Skip first` is misaligned.
- Real hardware and the emulator disagree about which frames poll the controllers.
- Firmware reports a buffer, wire, or controller-read anomaly.

If playback desynchronizes while the bridge buffer remains healthy, press `Trace` in the event-log
header before starting another run. TASDeck retrieves the trace ring, logs compact rows and
anomaly summaries, and asks the middleware to save the full event log under `logs/trace/`. The
bridge also saves a full-fidelity trace artifact containing CSV rows so exact poll timestamps remain
available for comparison.

Windowed traces contain completed-poll rows. Strobe traces contain diag-bit-5 edge rows, one per
active port, with the previous read's reconstructed mask carried on the following edge. The trace
header/footer also preserve the run's bare- and torn-strobe counters.

Compare the hardware rows near the first visible desync with the converter's
`<output>.trace.csv`. Two-port traces contain separate rows tagged by port; correlate them by
sequence and timestamp.

Trace filenames use local time and its UTC offset:

```txt
<local_timestamp_with_utc_offset>_<tas_filename_without_extension>.trace
```

The trace header records details such as the TAS filename, bridge run ID, original and effective
mask counts, skip and delay values, captured range, and recent firmware status.

## Continuous Trace Capture

For focused diagnosis, start TASDeck with continuous firmware trace capture enabled:

```sh
BRIDGE_TAS_TRACE_STREAM=1 npm start
```

This writes one `<timestamp>_<name>.stream.csv` per run. Streaming is disabled by default because
near-constant USB serial responses can add interrupt pressure during long hardware runs. When
enabled, the bridge pages rows only while the mask buffer is comfortably full, marks overwritten
ranges with `# gap:` comments, and performs a bounded final drain after playback stops or completes.

On macOS, prevent idle sleep during long runs with:

```sh
caffeinate -d npm start
```

Combine both settings when collecting a continuous trace:

```sh
BRIDGE_TAS_TRACE_STREAM=1 caffeinate -d npm start
```

On Linux or Windows, use the operating system's normal sleep-prevention settings.
