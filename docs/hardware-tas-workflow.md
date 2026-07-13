# Hardware TAS Playback And Troubleshooting

This guide covers the details beyond the first-time setup in [Installation](../INSTALL.md): the
`.tdmask` format, console synchronization, and advanced trace-based desync diagnosis. For
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

Streams begin with an eight-byte header and contain interleaved port 1 and port 2 bytes:

```txt
"TD2P", 01, 02, 0D, 0A, p1_frame0, p2_frame0, p1_frame1, p2_frame1, ...
```

The versioned header identifies a two-port stream even when every port-2 mask is zero. `.tdmask` is
currently specific to TASDeck.

## Generate A Stream

Use the same ROM targeted by the movie. On macOS, the FM2 converter locates FCEUX through
`FCEUX_BIN`, on `PATH`, or at `/opt/homebrew/bin/fceux`:

```sh
scripts/convert-fm2-to-tasdeck-mask.sh \
  "movie.fm2" \
  "game.nes" \
  "movie.tdmask"
```

On macOS, an existing `.r08` input dump can be converted directly without an emulator:

```sh
scripts/convert-r08-to-tasdeck-mask.sh \
  "movie.r08" \
  "game.nes" \
  "movie.tdmask"
```

An `.r08` already contains interleaved port 1 / port 2 bytes for non-lag NES frames, in the same bit
serialization order used by the NES controller protocol. The converter validates the byte pairs,
reverses each byte into TASDeck's A-through-Right bit order, and adds the `TD2P` header. The ROM path
is required and checked, but the ROM is not opened; because `.r08` has no ROM metadata, the
converter cannot prove that its contents match.

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

Each converter also creates `<output>.trace.csv`. The FCEUX trace has one row per completed emulator
poll and includes poll-level diagnostic fields. The BizHawk trace maps each emitted mask pair to its
source BK2 movie frame. Because `.r08` has already discarded lag frames, its trace maps each mask
pair to the corresponding zero-based `.r08` frame instead of to the original movie timeline.

The ROM, movie, and initial console state must match. A different ROM revision, header, save state,
or startup path can change lag and controller polling enough to desynchronize the run.

## Console Synchronization

The `.tdmask` supplies controller values; the NES latch signal supplies playback timing. Firmware
holds the same mask across controller rereads within a latch window and advances only after a window
that contained a completed controller read. This prevents boot strobes and same-frame rereads from
consuming additional masks.

This is important for games such as SMB3 and Tetris. DPCM sample DMA can corrupt a controller read,
causing the game to reread until two consecutive values match. Serving a new mask for every poll
would drift the stream, while serving one mask per latch window gives each reread the same value.

Before arming playback:

- Put the cartridge or EverDrive and game at the exact state expected by the movie.
- Use `Start delay` to wait a fixed number of completed controller-read windows before releasing
  frame 0.
- Use `Skip first` to discard masks from the front of the uploaded stream.

For a power-on movie, upload the `.tdmask` and press `Play` once to arm it. While the NES is off or
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
header before starting another run. TASDeck retrieves the completed-poll ring, logs compact rows and
anomaly summaries, and asks the middleware to save the full event log under `logs/trace/`. The
bridge also saves a full-fidelity trace artifact containing CSV rows so exact poll timestamps remain
available for comparison.

Compare the hardware rows near the first visible desync with the converter's
`<output>.trace.csv`. Two-port traces contain separate rows tagged by port; correlate them by
sequence and timestamp.

Trace filenames use local time and its UTC offset:

```txt
<local_timestamp_with_utc_offset>_<tdmask_filename_without_.tdmask>.trace
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
