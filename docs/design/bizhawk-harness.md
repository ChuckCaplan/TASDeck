# Headless BizHawk Harness

`npm run bk2` plays BizHawk movies on BizHawk's own NES core, built from source, without BizHawk
installed. It converts a `.bk2` to TASDeck's `.r08` and `.tdmask`, and it checks how a file will play
by serving it the way TASDeck firmware does and comparing the ending with the movie's. Usage is in
[Convert And Check A BizHawk Movie](../hardware-tas-workflow.md#convert-and-check-a-bizhawk-movie).
This page covers how it works.

The [SMB3 0.32](../games/smb3/README.md), [SMB2 game-end glitch](../games/smb2/README.md), SMB1 FDS
and [Battletoads](../games/battletoads/real-cartridge.md#research-harnesses) findings came from
earlier, hand-built versions of the same harness.

## Files

| File | Role |
| --- | --- |
| [`scripts/bizhawk-harness.js`](../../scripts/bizhawk-harness.js) | CLI: `setup`, `convert`, `check` |
| [`scripts/bizhawk-harness/build.js`](../../scripts/bizhawk-harness/build.js) | Finds or installs .NET, fetches and patches BizHawk, builds |
| [`scripts/bizhawk-harness/profiles.js`](../../scripts/bizhawk-harness/profiles.js) | BizHawk versions and the source edits each needs |
| [`scripts/bizhawk-harness/movie.js`](../../scripts/bizhawk-harness/movie.js) | `.bk2` reading, `.r08`/`.tdmask`/trace writing |
| [`scripts/bizhawk-harness/check.js`](../../scripts/bizhawk-harness/check.js) | Which runs a check makes and how they read as a verdict |
| [`scripts/bizhawk-harness/Harness.cs`](../../scripts/bizhawk-harness/Harness.cs) | The C# program: movie and replay jobs, the firmware model |
| [`scripts/bizhawk-harness/Stubs.cs`](../../scripts/bizhawk-harness/Stubs.cs) | Stand-ins for BizHawk pieces not built |

Everything built or downloaded lives under `.cache/bizhawk-harness/` (ignored by git;
`TASDECK_HARNESS_CACHE` moves it): the .NET SDK when none is on `PATH` (`TASDECK_DOTNET` names
one), a sparse checkout of each BizHawk version, each build, cached movie runs, and check output.

## Build

`build.js` uses a .NET 8 or newer SDK, installing one with Microsoft's `dotnet-install` script when
none is found. It sparse-clones the BizHawk release tag with only `BizHawk.Common`,
`BizHawk.BizInvoke`, `BizHawk.Emulation.Common`, the NES and SubNESHawk cores, the 6502 CPU, sound,
`CoreNames.cs` and `Assets/gamedb`, resets the checkout, applies the edits in `profiles.js`, and
compiles those sources with `Harness.cs` and `Stubs.cs` into one `net8.0` program. A build is reused
until its profile or C# sources change.

| Version | Used for | Differences handled |
| --- | --- | --- |
| 2.6.3 | Movies recorded before 2.8 | Strobe hook in `write_joyport` |
| 2.11.1 | Movies recorded on 2.8 or later | `strobe_joyport` applies the write on the CPU's next get-to-put transition; newer `CoreComm`, file-provider and game-database signatures; four extra NuGet packages |

The edits are literal find-and-replace on BizHawk's files, in the files' own CRLF line endings, and a
missing or ambiguous match stops the build:

- callbacks on every `$4016` strobe write, every joypad read, and every CPU read of `$2000-$7FFF`;
- a level for reads past the eighth clock since a latch, per port (BizHawk returns 1s otherwise);
- `PPU.idleSynch` and SubNESHawk's `_nesCore`, `pass_new_input` and `pass_a_frame` made public;
- a SubNESHawk soft reset that can leave the PPU running and then run a callback.

`Stubs.cs` replaces the core registration attributes, `ReflectionCache`, the generated version
constants, and `BlipBuffer`, whose native library is not needed because audio is not rendered.

## Movie Jobs

A NesHawk movie plays on a plain NES core, one Input Log row per frame. A SubNESHawk movie plays on
SubNESHawk, one row per `FrameAdvance`, including its Reset Cycle. The bk2's `SyncSettings.json`
configures the core. Each falling strobe write inside the movie records that moment's pads as one
`.r08` record, and each frame the core does not flag as lag records one `.tdmask` mask, the rule
`emu.islagged()` gives the Windows Lua exporter. A SubNESHawk movie whose pads change between latches
inside one frame gets no `.tdmask`.

The job saves the screen at every Nth latch (a fortieth of the movie) and every screen in a
61-frame window around 60, 300 and 600 frames after the last latch, for replays to compare against.

## Replay Jobs And The Firmware Model

A replay runs on SubNESHawk and serves records through `TasDeckModel`, a port of
`NesTasPlayback.cpp` timed by the console's CPU cycle counter (8000 µs = 14,318 cycles):

- The rising strobe write is the latch interrupt. It runs the window-expiry service for the time that
  has passed, then the edge logic for `strobe`, `poll` or `latch` mode, and sets the pads BizHawk
  latches on the falling write.
- `poll` mode credits a window when a port reads eight clocks with the strobe low; `latch` mode
  credits every latch.
- Start delay, the guarded strobe prefix, and the level after the eighth clock (`preadvance`,
  `pressed`, `released`, or in windowed modes the current mask's A) behave as in the firmware.

An EverDrive launch runs the game from power-on with blank pads for a number of frames, resets it at
a chosen CPU cycle without resetting the PPU, applies the loader's RAM image (zero page cleared,
`00 00 00 00 FF FF FF FF` elsewhere), and only then arms the model. The frames before the reset stand
in for the menu: they leave the PPU, the APU's DMC timer and the CPU/PPU phase wherever they happen
to be.

A replay matches the movie when it serves every record and each screen 60, 300 and 600 frames after
its last record matches, within 30 frames either way, at least 90% of the movie's pixels at half
resolution. Where it does not, the first checkpoint after which no checkpoint matches again is
reported and saved side by side as `divergence.png`. Checkpoints are only compared when the file's
records are the movie's own latches.

## Validation

- Converted `.r08` files are byte-identical to the files that won on the console: Super Mario
  Bros. 3 in 0.32 seconds (598 records, 2.6.3 SubNESHawk), the Super Mario Bros. 2 game-end glitch
  (the replay corpus's 1,730 records, 2.11.1 SubNESHawk), and Prince of Persia (49,075 records; the
  file that won carried 36 more blank records latched after the movie ended).
- Converted `.tdmask` files are byte-identical to the Windows converter's for Pac-Man (Tengen), Super
  Mario Bros. 2 warpless, Castlevania, Donkey Kong (all items) and Arkanoid warpless. The one
  exception is Excitebike (`lordtom-excitebike.fm2.bk2`, recorded on an unnamed development build):
  both harness versions keep one more polled frame at boot than the Windows file. The harness's
  `.r08` matches the replay corpus's console-verified `Excite_Bike.r08` record for record (the corpus
  file adds two trailing records), so the Windows export is the one that differs. The Arkanoid movie
  that uses the Vaus paddle is rejected, as the Windows converter rejects it.
- The Super Mario Bros. FDS game-end glitch (7167M, `--bios disksys.rom`) converts on 2.11.1 to the
  same 19,140 records as the dump made on its February 2026 recording build.
- `check` gives the hardware results for all three wins: every simulated EverDrive launch reaches
  the ending at `Start delay 1`. For the Super Mario Bros. 2 game-end glitch it passes only with
  `--overread pressed`, and the plain corpus file at TASDeck's defaults loses from every start, as it
  did on the console.
- `apps/web/tests/bizhawk-harness.test.js` builds a synthetic NROM whose backdrop colour depends on
  every record's latch, converts a movie of it, and checks it: launches match and a Start delay one
  off does not. It runs when the 2.6.3 build exists or `TASDECK_HARNESS_TESTS=1`.

## Job Files

The CLI writes one JSON job per run and runs `dotnet <build>/out/tasdeck-harness.dll job.json`. A job
written by hand can reach every setting, including ones the CLI does not expose. Field names are
case-insensitive; paths are absolute.

| Field | Job | Meaning |
| --- | --- | --- |
| `mode` | both | `movie` or `replay` |
| `rom`, `gamedb`, `outDir` | both | ROM, BizHawk's `Assets/gamedb` folder, output folder |
| `firmware` | both | FDS BIOS (`disksys.rom`) |
| `syncSettings` | both | The movie's `SyncSettings.json`: controllers, region, WRAM pattern, board properties |
| `core` | movie | `NesHawk` (one row per frame, plain NES core) or `SubNESHawk` (one row per `FrameAdvance`) |
| `rows` | movie | Input Log rows, 7 bytes each: port 1, port 2 (TD2P bit order), flags (1 = Power, 2 = Reset), int32 Reset Cycle |
| `records` | replay | Records to serve, 2 bytes each, TD2P bit order |
| `serve`, `windowUs` | replay | `strobe`, `poll` or `latch`, and the latch window in µs (8000) |
| `startDelay`, `guardUntil` | replay | Start delay in latches or windows; guarded strobe prefix |
| `overread` | replay | `preadvance`, `pressed` or `released` after the eighth clock (`strobe` only) |
| `ports` | replay | 2; with 1, port 2 reads released |
| `startupOffset`, `idleSynch`, `cpuPhase`, `dmcTimer` | both | Power-on state: `ppu.start_up_offset` (default 4), `ppu.idleSynch`, `ppu.cpu_stepcounter` (0-2), `apu.dmc.timer` (1020 at power-on) |
| `ram` | both | `everdrive`, `random:<seed>` or `fill:<byte>`; unset keeps BizHawk's power-on RAM |
| `launchFrames`, `launchCycle` | replay | EverDrive launch: frames run first, and the CPU cycle in the frame to reset at |
| `tailFrames` | both | Frames to run after the last input or record (600) |
| `checkpointEvery`, `checkpointOffset` | both | Screen checkpoint spacing in latches, and the file record number of the job's first record (`Skip first` plus any records a variant drops); checkpoints and `divergence` report file record numbers |
| `reference`, `writeReference` | replay | Reference screens to compare with; or save this run's as one |
| `maxFrames` | replay | Stop a run that never uses its last record |

A movie job writes `summary.json`, `latches.bin` (one record per latch), `frames.bin` (source frame
and pads per polled frame), `latches.csv`, `reference.bin` and `end.png`. A replay job writes
`summary.json`, `end.png`, `divergence.png` when it parted from the movie, and `reference.bin` with
`writeReference`. `check --power-on` sweeps `startupOffset` -4, 0, 4, 8 with both `idleSynch` values
and all three `cpuPhase` values; `dmcTimer` is only reachable from a job file.

## Earlier Harness Features Not In The Tool

The hand-built harnesses behind the research pages had hooks the tool leaves out. Each is a small
patch in `profiles.js`, a job field, and a summary entry if it is needed again:

- **Executed addresses.** The first frame and latch at which a given address runs, or every address
  run after a frame. This is how endings were detected without screenshots (Super Mario Bros. 2 and
  Roger Rabbit) and how the SMB1 FDS payload was traced.
- **CPU write log** for an address range, with the writing instruction's address.
- **RAM dump** at a given record, and a read log of every controller read with the CPU registers.
- **DMC re-read switch**, which turns off the core's DMC controller re-read to tell a program's own
  re-reads from DPCM ones.
- **Screenshots every N frames.**
- **Other BizHawk builds.** Battletoads used the 2021 commit `01c3b14` and, before it, 2.5.2 (see
  [Research Harnesses](../games/battletoads/real-cartridge.md#research-harnesses)); the SMB1 FDS run used its
  recording build `ce0571884`, whose dump 2.11.1 now reproduces byte for byte. A version needs its
  own profile: a git tag or commit, the packages and `#if` differences its sources need, and a
  check that every patch still applies.

Other emulator methods, FCEUX and jsNES among them, are in [Emulator Methods](emulator-methods.md).
