# Emulator Methods

TASDeck investigations have used three emulators. This page lists them and what each is good for;
the pages it links have the details.

| Question | Method |
| --- | --- |
| Convert a `.bk2`, or check how a file will play from a power-on or an EverDrive launch | [BizHawk harness](bizhawk-harness.md) (`npm run bk2`) |
| Convert an `.fm2` | [FCEUX converter](../hardware-tas-workflow.md#generate-a-stream) |
| Replay an FCEUX movie under other RAM fills or PPU cores | [Headless FCEUX](#headless-fceux) |
| Which bits the console actually read, and how little time a bit had | [Read counts and deadlines](#read-counts-and-deadlines) |
| Whether power-on state decides a run | BizHawk harness `check --power-on`, or a job file for the DMC timer |

A BizHawk movie replayed in FCEUX, or the reverse, can desync, and a stream exported from one emulator
carries that emulator's lag model. Use the emulator the movie was recorded on.

## BizHawk Harness

BizHawk's NES core built from source and driven headless. It converts `.bk2` movies, serves records
the way TASDeck firmware does, and simulates EverDrive launches. See [Headless BizHawk
Harness](bizhawk-harness.md), including the research hooks the earlier builds had and the tool does
not.

## FCEUX

`scripts/convert-fm2-to-tasdeck-mask.sh` runs FCEUX with `scripts/fceux-export-tasdeck-mask.lua` to
write a `.polls.r08` and a `.tdmask` from one pass. Its tests run the exporter against a synthetic
NROM with `QT_QPA_PLATFORM=offscreen`.

### Headless FCEUX

FCEUX 2.6.6 (the Qt build, `/opt/homebrew/bin/fceux` on macOS) also runs headless for experiments:

```sh
QT_QPA_PLATFORM=offscreen HOME=/tmp/fceux-home fceux --sound 0 --playmov movie.fm2 --loadlua probe.lua game.nes
```

- Run it once to create `/tmp/fceux-home/.fceux/fceux.cfg`, then edit that file. A throwaway `HOME`
  keeps your own configuration untouched, and `--no-config 1` cannot set values.
- Set `SDL.VideoDriver = 2`. Drivers 0 and 1 crash headless after about 250 frames; 2 and 3 run
  full-length movies.
- `SDL.RamInitMethod` sets power-on RAM: 0 is FCEUX's `00 00 00 00 FF FF FF FF`, 1 all `$FF`, 2 all
  `$00` (the EverDrive N8's fill), 3 random. `--newppu 0|1` picks the PPU core.
- FCEUX runs a Lua script from the script's own folder, so give Lua absolute output paths. Its Lua is
  5.1: no bitwise operators. A screenshot requested on the frame the script exits is not written.
- About 112,000 frames take ten minutes. `--fcmconvert` converts an old `.fcm` movie, which may then
  desync.

## Read Counts And Deadlines

The method that settled [Golf](../games/golf-uninitialized-ram.md) replays an `.r08` one record per latch in
jsNES, whose hooks are easy to reach from JavaScript: the `$4016` write for the strobe's falling
edge, each controller read, and a monotonic CPU cycle counter. The jsNES copy used was local and is
gone. Any emulator with those three hooks works; the BizHawk harness has all three in its core
patches, though it does not write per-read timings yet. Three measurements come out of it:

- **Read count per latch.** Games often stop reading once they find a press. The number of reads the
  console makes after a latch, against the firmware trace's `clocksSinceLatch` for the same record,
  shows whether the console read the bit that mattered. The trace's `clockedMask` cannot show that,
  because it reads TASDeck's own data pin.
- **Per-bit deadlines.** The cycles between read N and read N+1 are how long bit N+1 has to appear on
  the line. Scan the movie for records where consecutive bits differ and rank them by that time;
  Golf's 1,971 records have exactly one change with less than 5 µs.
- **Clock scale.** The Arduino's `micros()` runs about 0.12% slow against the NES (scale 1.001228 on
  the unit measured). Scale the trace by the ratio of its median one-frame gap to the emulator's, and
  the gaps between latches line up with the emulator's to within 0.2 ms over nine seconds, which makes
  "does the console's game state match the movie's" a measurement.
