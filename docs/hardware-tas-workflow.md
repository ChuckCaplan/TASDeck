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

Use the same ROM targeted by the movie. The FM2 converter plays the movie once in FCEUX and writes
two streams from that one pass:

- `<name>.polls.r08`: one record for every rising strobe edge the game writes to `$4016`, in the
  [`.r08` convention](#r08-format). It keeps every latch of a frame that polls several times and
  every latch no controller read follows, so it stays aligned as long as the console latches as
  many times as the emulator did. Play it in `strobe` mode at the prefilled `Start delay 1` (see
  [Console Synchronization](#console-synchronization)). It is the same per-latch dump as the
  `.polls.r08` files in TASBot's replay library: for the three movies compared (Tetris, Zelda, and
  Kirby), every record matches byte for byte, and TASBot's files differ only by blank records
  appended after the movie ends. Like those files, it starts at the first latch FCEUX sees and holds
  no leading blank record.
- `<name>.tdmask`: one record per movie frame that completes a poll, with lag frames removed. It
  plays in `poll` mode, which coalesces every latch inside a frame's latch window onto one record.

On macOS, the converter locates FCEUX through `FCEUX_BIN`, on `PATH`, or at
`/opt/homebrew/bin/fceux`:

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

The output path is optional. An output path ending in `.r08` names the per-latch stream, and the
`.tdmask` is written beside it. The converter also accepts the movie and ROM arguments in the
opposite order. It refuses an output path that names the movie or ROM, however it is spelled, and
refuses two outputs that resolve to the same path.

When it finishes, the FM2 converter reports how many latches the movie made per polled frame, the
exact difference between the latch count and the polled-frame count, and how many latches had no
completed eight-clock read. When the difference is 0, the two streams hold the same number of
records. Otherwise only the `.polls.r08` in `strobe` mode serves every latch its own record. The
converter also warns when a controller read returned input that changed after its latch: the
`.polls.r08` holds each latch's input, so at those reads it differs from what FCEUX delivered.

Try the `.polls.r08` first unless the converter warns that the game wrote `$4015` with the DPCM
enable bit set. On a console, DPCM sample DMA can corrupt a controller read, and games that guard
against it strobe again until two reads agree. Those extra latches depend on console timing, and
FCEUX does not add them: Super Mario Bros. 3 exports exactly four latches on every one of its polled
frames. For those games, start with the `.tdmask`, whose `poll` mode absorbs a re-read inside the
same latch window.

The BizHawk converter writes only the `.tdmask`. `scripts/convert-bk2-to-fm2.js` is not a route to
a per-latch `.r08`: it exists to feed the hardware-trace expander, drops Reset and Power input,
ignores savestate starts, and a NesHawk movie replayed in FCEUX can desync.

For `.bk2`, the BizHawk converter restarts the movie at frame 0 in BizHawk, writes both controller
masks for each non-lag frame, and exits BizHawk when finished. Keep any core/firmware settings
required by the movie in the BizHawk installation used for the export.

Before launching the emulator, both converters inspect the movie's controller configuration and
input columns. They accept only standard NES controller buttons on ports 1 and 2 and fail on Zapper,
Arkanoid paddle, Power Pad, Four Score/P3/P4, microphone, expansion-port, or unknown controller
input. Those devices use protocols or data lines that TASDeck does not drive.

Each converter also creates a trace CSV named after its `.tdmask`, `<name>.tdmask.trace.csv`,
even when the FM2 converter's output path names the `.r08`. The FCEUX trace has one row per
completed emulator poll and includes poll-level diagnostic fields. The BizHawk trace maps each
emitted mask pair to its source BK2 movie frame.

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
| `.polls.r08` from the FM2 converter (one record per latch) | `strobe` |
| A future SubNESHawk per-latch dump | `strobe` |

This is important for games such as SMB3 and Tetris. DPCM sample DMA can corrupt a controller read,
causing the game to reread until two consecutive values match. Serving a new mask for every poll
would drift the stream, while serving one mask per latch window gives each reread the same value.

That coalescing is also a hard boundary. Because `poll` and `latch` collapse every read inside a
window onto one mask, they cannot carry a movie that delivers a *different* byte to each read within
a single frame — the Super Mario Bros. 3 ["game end
glitch"](https://tasvideos.org/7245S) arbitrary-code-execution run writes its payload that way. Such
a movie needs `strobe` mode together with a source dump holding one record per latch; a frame-model
export of it cannot work in any mode, because the per-read variation is already gone from the data.

Before arming playback:

- Put the cartridge or EverDrive and game at the exact state expected by the movie.
- Use `Start delay` to wait before releasing record 0. It counts blank windows in `poll`/`latch`
  mode and accepted edges in `strobe` mode, and strobe-mode `Start delay N` matches TAStm32
  `--blank N`. An `.r08` dump holds no blank record; a replay device adds it at playback. The
  TAStm32 client defaults to `--blank 0`, but the
  [alyosha-tas](https://github.com/alyosha-tas/NES_replay_files) corpus plays power-on runs with
  `--blank 1` and runs that start from reset with `--blank 0`, so strobe mode prefills
  `Start delay 1`. The first FM2 converter `.polls.r08` confirmed on a console,
  [R.B.I. Baseball's](design/rbi-baseball-uninitialized-ram.md), completed from a held-Reset
  cartridge start at `Start delay 0`. None has been confirmed at the prefilled 1 yet; if one
  desyncs within its first records, try `Start delay 0`. A hand-entered delay
  survives mode changes; the prefill applies only while the field is untouched. `.tdmask` always
  uses completed-read windows.
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

In `strobe` mode, `anomaly_count=0` does not validate every completed serial mask because the
deadline-first clock handlers omit completed-read mask-mismatch bookkeeping. Compare the trace's
reconstructed masks with the expected input stream and inspect `bare_strobes` and `torn_strobes`
instead of treating a zero anomaly count as complete proof.

Compare the hardware rows near the first visible desync with the converter's
`<name>.tdmask.trace.csv`. Two-port traces contain separate rows tagged by port; correlate them by
sequence and timestamp.

Trace filenames use local time and its UTC offset:

```txt
<local_timestamp_with_utc_offset>_<tas_filename_without_extension>.trace
```

The trace header records details such as the TAS filename, bridge run ID, original and effective
mask counts, skip and delay values, captured range, and recent firmware status.

## When The Trace Is Clean

A trace can show that every mask TASDeck served matched the converter's expected stream, bit for bit,
with correct record alignment and no anomalies — and the run still desynchronized. This is a real
outcome, not a sign the trace was captured wrong. It establishes the output at the trace's sampling
times. GPIO samples taken after the NES reads the controller cannot prove what the NES saw at that
earlier instant. A clean trace narrows the investigation toward game timing and console state while
leaving electrical timing as a possible cause.

The usual console-side causes:

- **Lag-frame placement.** The console takes one more or one fewer lag frame than the emulator at
  some transition, which shifts the game's RNG phase and breaks a manipulation much later. The first
  visible symptom can be minutes after the actual divergence, so the trace is more reliable than the
  screen for locating it. Comparing the inter-latch gap histograms of a winning and a losing run
  finds the exact record where poll cadence first differs.
- **Power-on phase.** The above is often decided at boot. Because a lag frame is a threshold
  crossing on a continuously varying power-on phase, the result can be stable across several boots
  and then flip, so a handful of identical runs is not proof of determinism. Boot-cycle at least
  three or four times before concluding a movie cannot sync.
- **The flash cart.** An EverDrive N8 Pro leaves the console in a different startup state than an
  original cartridge. A reproducible failure at a fixed location is worth retesting on a real
  cartridge when one is available.
- **Power-on RAM contents.** Movies that depend on a particular uninitialized RAM pattern desync
  from an EverDrive launch, whose loader zero-fills the zero page, and no TASDeck setting
  compensates. Priming RAM and then swapping to a real cartridge under a held Reset does; see
  [Golf](design/golf-uninitialized-ram.md) and [R.B.I. Baseball](design/rbi-baseball-uninitialized-ram.md).
- **Mapper-specific behavior.** Some titles are documented as failing on every replay device, not
  only this one. Nightshade is the standing example: TASVideos testing reports it syncing about one
  attempt in twenty at one startup offset and somewhat better at another, with MMC3 mapper clocking
  the suspected cause. See [NES Console Test
  Runs](https://tasvideos.org/Forum/Topics/18797). Check whether a stubborn game already has a
  reputation before treating it as a TASDeck problem.

When a run fails the same way repeatedly, note the record number where the trace's poll cadence
first departs from a known-good run. That number identifies the retry point and often makes a failed
attempt cost minutes instead of the movie's full length.

## Continuous Trace Capture

For focused diagnosis, start TASDeck with continuous firmware trace capture enabled:

```sh
BRIDGE_TAS_TRACE_STREAM=1 npm start
```

This writes one `<timestamp>_<name>.stream.csv` per run. Streaming is disabled by default because
near-constant USB serial responses can add interrupt pressure during long hardware runs. When
enabled, the bridge pages rows only while the mask buffer is comfortably full, marks overwritten
ranges with `# gap:` comments, and performs a bounded final drain after playback stops or completes.

Streaming competes with record upload for the one serial link. The bridge pauses paging whenever the
firmware reports the mask buffer is not comfortably full, which keeps upload ahead of playback in
normal use, but that check reads a status value that can itself go stale when the link is busy, so it
is a safeguard rather than a guarantee.

The load depends on how many trace rows the run generates. Windowed modes emit one row per completed
poll; `strobe` mode emits one row per port per accepted latch edge, so a two-port strobe-mode `.r08`
produces by far the most rows and carries the most risk. One such run has been observed to starve the
upload badly enough that the mask buffer drained to empty and playback stalled a few hundred records
in — while the trace showed every served mask as correct, which looks like a desync and is not one.
Single-port runs have streamed for tens of thousands of records without trouble.

Streaming a two-port run is therefore worth trying but worth watching. If playback stalls early and
the trace shows correct masks up to the stall, suspect starvation rather than a desync, and recapture
with the event log's `Trace` button, which reads the ring once instead of paging it continuously.

On macOS, prevent idle sleep during long runs with:

```sh
caffeinate -d npm start
```

Combine both settings when collecting a continuous trace:

```sh
BRIDGE_TAS_TRACE_STREAM=1 caffeinate -d npm start
```

On Linux or Windows, use the operating system's normal sleep-prevention settings.
