# Nightshade R08 Hardware Playback Investigation

## Status

This document records the Nightshade conversion and real-NES playback investigation through July
13, 2026. It includes the user-reported behavior, the converter work, file and ROM validation,
trace findings, firmware experiments, current theories, and the next test to run.

The run is **not yet synchronized**. With latch-mode delays 1 and 2, the latest repeatable gameplay
failure is that Nightshade falls into the first pit instead of walking past it. A subsequent
latch-mode delay-0 test did not reach gameplay at all: the game never started. The latest retained
delay-1 and delay-2 traces show clean electrical reads and the intended mask sequence, so the
investigation has moved from basic conversion and trace corruption toward startup alignment and
initial-console-state differences.

There are two deliberately separate lines of work:

- Converter work is committed and pushed on `agent/add-bizhawk-tdmask-converter`, not `main`.
- General TASDeck playback and diagnostic experiments are uncommitted changes on `main`, as
  requested before making changes unrelated to R08/BK2 conversion.

## User Goal and Source Material

The original goal was to add conversion paths comparable to
`scripts/convert-fm2-to-tasdeck-mask.sh`:

- Convert BizHawk `.bk2` plus its ROM to `.tdmask` on Windows.
- Convert `.r08` plus its ROM to `.tdmask` without requiring Windows or BizHawk.
- Play the resulting Nightshade stream through TASDeck on a real NES without desynchronizing.

Nightshade source material:

- R08: [alyosha-tas/NES_replay_files/Nightshade.r08](https://github.com/alyosha-tas/NES_replay_files/blob/main/Nightshade.r08)
- BK2: `bk2_files/meshuggahv1-nightshade.fm2.bk2` in the same repository
- Console-verification video: [YouTube](https://www.youtube.com/watch?v=jakVqd1nGs0)
- Local working directory: `~/Desktop/Everdrive/TAS/Not Working/Nightshade`

The replay repository says that its files synchronize on a front-loading NES from power-on and,
unless a game is listed as an exception, should be sent with TAStm32 `--blank 1`. Nightshade is not
listed as a RAM-clearing, reset-start, or alternate-blank exception.

## Converter Work

The converter branch contains these commits and is present both locally and on GitHub:

| Commit | Purpose |
| --- | --- |
| `3f7e448` | Add the BizHawk exporter and Windows BK2 converter. |
| `558be61` | Split raw R08 conversion into a standalone shell script. |
| `2345752` | Fix R08 controller bit order. |

### BK2 on Windows

BK2 conversion uses:

- `scripts/convert-bk2-to-tasdeck-mask.ps1`: the PowerShell implementation.
- `scripts/convert-bk2-to-tasdeck-mask.cmd`: a small Command Prompt wrapper that invokes the
  PowerShell script with `-ExecutionPolicy Bypass`.
- `scripts/bizhawk-export-tasdeck-mask.lua`: runs inside BizHawk while the movie replays.

The `.ps1` file contains the actual validation, BizHawk launch, export, and output checks. The
`.cmd` file is only a convenience entry point for Command Prompt. From Git Bash, the same Windows
converter can be invoked through `powershell.exe` or the `.cmd` wrapper; it is still a Windows
process even though the initiating shell is Bash.

Example PowerShell usage:

```powershell
$env:BIZHAWK_BIN = "C:\BizHawk\EmuHawk.exe"
.\scripts\convert-bk2-to-tasdeck-mask.ps1 `
  "movie.bk2" `
  "game.nes" `
  "movie.tdmask"
```

Example from Git Bash:

```sh
BIZHAWK_BIN='C:\BizHawk\EmuHawk.exe' \
  powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File scripts/convert-bk2-to-tasdeck-mask.ps1 \
  movie.bk2 game.nes movie.tdmask
```

BizHawk is needed for BK2 because the exporter must replay the movie with the correct core and ROM
to observe lag frames and emit masks only for frames where the emulated game polls input.

### R08 on macOS or Git Bash

R08 conversion uses only:

```sh
scripts/convert-r08-to-tasdeck-mask.sh movie.r08 game.nes movie.tdmask
```

BizHawk is not needed. R08 is already a lag-stripped stream containing two raw controller bytes per
accepted latch. The converter:

1. Validates that the R08 byte count is nonzero and even.
2. Reverses the bits in every controller byte.
3. Adds the eight-byte `TD2P 01 02 0D 0A` header.
4. Writes interleaved port-1 and port-2 bytes.
5. Writes a sibling `.trace.csv` mapping each output record to its R08 record number.

The ROM argument is required and checked for existence, but R08 contains no ROM metadata, so the
script cannot validate the ROM contents. The converter initially copied each R08 byte without
reversing its bits. That was wrong because R08 stores the NES serial order as Right through A, while
TASDeck masks use A, B, Select, Start, Up, Down, Left, Right from bit 0 through bit 7. Commit
`2345752` fixed this by reversing each byte.

## Input and ROM Validation

The local source files were checked rather than assumed to match by filename.

### R08 identity

- Local size: 57,558 bytes.
- Two bytes per record: 28,779 R08 records.
- Local Git blob SHA-1: `bfade63757a1830442112d4d9b7634ed4b9b2d66`.
- The public repository's `Nightshade.r08` has the same size and blob SHA-1.

The local R08 is therefore byte-for-byte the public verification file.

### ROM identity

- Whole `.nes` file MD5, including its 16-byte iNES header:
  `5a79e31ef253afea61b75d1b68508358`.
- ROM payload MD5 after removing the iNES header:
  `9903087102a9bf59b0e33932d1098548`.
- The BK2 header names `Nightshade (U)` and records MD5
  `9903087102a9bf59b0e33932d1098548`.

The ROM payload is an exact match for the movie. The differing whole-file hash is only the iNES
header being included in that calculation.

### BK2 settings

The public BK2 reports:

- BizHawk v2.0, NesHawk core, NTSC.
- Left NES port: `ControllerNES`.
- Right NES port: `UnpluggedNES`.
- Initial WRAM pattern: `null` rather than a forced clear pattern.
- 29,142 BK2 input-log rows.

The R08 has 28,779 records, 363 fewer than the BK2 input-log row count. That is consistent with R08
having already omitted lag frames. A greedy controller-mask comparison aligned 28,777 of 28,779
R08 records with the BK2 sequence while skipping 365 BK2 rows, mostly blank or lag rows. Because
long blank runs make greedy alignment ambiguous, this is supporting evidence rather than a formal
frame-by-frame proof, but it strongly supports the corrected bit mapping and overall input content.

## New R08 Mask Compared with the Old FM2 Mask

Local outputs:

| File | Bytes | TD2P records |
| --- | ---: | ---: |
| `Nightshade.tdmask` from corrected R08 converter | 57,566 | 28,779 |
| `old/meshuggahv1-nightshade.tdmask` from the older FM2 path | 57,550 | 28,771 |

The files are not identical over their full length: the R08 output has eight more records and a
direct byte comparison finds later positional differences. However, they are byte-for-byte
identical through TD2P record 2682. Their first difference is port 1 of record 2683.

This is important because the current pit failure is associated with input records around
1700-1740. Both converted files contain the same masks in that early section. Fixing the R08 bit
order was necessary, and later differences could explain a later desync, but differences between
these two converted files cannot by themselves explain the early pit failure.

The user originally reported that the old FM2-derived mask desynchronized after roughly one minute
and hoped the corrected R08-derived mask would run farther. Some R08 runs did get farther than
others, but the new stream was initially very inconsistent and eventually settled into the earlier,
repeatable pit failure described below.

## Hardware Test History and User Observations

The observations below preserve distinctions between settings that can otherwise look equivalent.
In particular, delay 0 under `Completed reads` is not the same test as delay 0 under `Latch / R08`.

### Initial R08 runs on the original playback behavior

- With `BRIDGE_TAS_TRACE_STREAM=1`, without it, and across repeated attempts, the movie desynced at
  different points.
- One attempt progressed much farther than the others but still eventually desynchronized.
- The user observed that `Start delay = 1` without continuous trace caused Nightshade to fall into
  a pit shortly after gameplay began.
- With continuous trace enabled, or in an earlier no-delay run, Nightshade instead fought a cop and
  died shortly after gameplay began.
- These differing outcomes initially suggested that diagnostics themselves might be perturbing the
  controller timing.

### Controller 2

The BK2 explicitly expects port 2 to be unplugged. We discussed whether leaving a second controller
connected mattered when every port-2 movie byte was zero. A real connected controller and a
disconnected port are not electrically identical, even if TASDeck intends to send no port-2 button
presses. The user unplugged controller 2 from the NES while leaving the Arduino-side wires in place.
That is sufficient to remove the physical controller. Later firmware status showed `clock2=0`,
confirming that the NES was not clocking the TASDeck port-2 path during these tests.

The user confirmed that controller 2 remained unplugged for all of the later pit-failure tests.
Because the failure remained, controller 2 is no longer a leading explanation.

The R08 source itself also contains no port-2 activity: all 28,779 second-controller bytes are zero.

### Exact EverDrive and TASDeck startup procedure

The user later documented the complete procedure used for Nightshade:

1. Leave the NES powered off with an EverDrive N8 Pro configured to load Nightshade automatically
   at power-on; there is no manual EverDrive menu navigation immediately before the run.
2. Leave controller 2 unplugged from the NES. Its TASDeck wires remain connected to the Arduino,
   but the NES side is disconnected.
3. Flash the current Arduino firmware.
4. Run `npm start`.
5. Click `Connect` in TASDeck.
6. Load `Nightshade.tdmask`.
7. Select `Latch / R08` and set the requested Start delay.
8. Click `Play` to arm the upload, then click `Start`.
9. Wait several seconds with the NES still off.
10. Turn on the NES; the EverDrive automatically launches Nightshade and playback begins from the
    already-armed Arduino.

This is a controlled and repeatable procedure. It rules out accidental manual menu-navigation
inputs and ensures the Arduino is armed well before the first NES latch. The same general startup
procedure successfully plays all TAS runs listed in the root README, including multiple long runs
on an EverDrive N8 Pro. Those successful runs are strong evidence against a general wiring,
Arduino-preparation, web/bridge startup, or EverDrive incompatibility problem.

The official [EverDrive N8 Pro manual](https://krikzz.com/pub/support/everdrive-n8/pro-series/n8-pro-manual.pdf)
calls this option `Boot Last Game` and confirms that it launches the last game automatically at
power-up while skipping the main menu. The manual does not specify the resulting NES CPU WRAM
contents or claim that the automatic handoff reproduces the electrical/CPU history of powering on
an original cartridge.

The remaining startup-state question is narrower: the public Nightshade R08 was verified from
power-on on a front-loading NES with the game cartridge already present, whereas an N8 Pro must
perform its automatic-boot path before presenting the game. Even without visible menu navigation,
that path may leave RAM, mapper, PPU, or APU history different from an original-cartridge cold boot.
This is a Nightshade-specific compatibility possibility, not a claim that the user's general
startup procedure is wrong.

### Delay and sync outcomes

| Firmware/behavior | Sync mode | Start delay | Trace mode | Result or finding |
| --- | --- | ---: | --- | --- |
| Original behavior | Completed reads | 1 | Off | Repeatably fell into the pit. |
| Original behavior | Completed reads | 0 | Varied | Fought a cop and died in an early run. |
| Original behavior | Completed reads | 1 or 0 | Continuous trace in some runs | Outcome changed between runs; at least one went much farther. |
| v45 | Completed reads | 0 | Manual trace | Advanced to record 2081, then stopped advancing when the game produced repeated seven-clock reads. |
| v45 | Completed reads | 1 | Manual trace | Electrically clean through the captured window, but did not solve gameplay. |
| v46 | Latch / R08 | 1 | Off for gameplay; manual trace afterward | No trace anomalies; user still fell into the pit. |
| v46 | Latch / R08 | 2 | Off for gameplay; manual trace afterward | No trace anomalies; user still fell into the pit. |
| v46 | Latch / R08 | 0 | Off | The game did not start at all; gameplay and the pit were never reached. Controller 2 remained disconnected and skip was 0. |

The latch-mode delay-0 test completed the controlled 0/1/2 offset series. Delay 0 is too early for
the startup sequence: one or more short, precisely timed title/startup inputs pass before the game
accepts them, so the game never begins. Delays 1 and 2 both allow the game to start, but both still
lead to the pit. Therefore simply serving the entire stream earlier does not solve the run.

The corrected stream's first Start input is a single record, `0x08` at R08/TAS record 503. Earlier
inputs also include isolated one-record A presses. The one-record Start being served before the title
screen's acceptance window is a concrete explanation for why delay 0 can prevent the game from
starting entirely.

## Trace Interference Finding and v45

A continuous v44 trace contained a real missed-clock event around TAS record 6352. The preceding
window ended after only seven of eight port-1 clocks, and the following trace showed the latch and
clock totals jump in a way consistent with a collapsed clock interrupt.

The likely source was `formatTasTraceResponse`, which copied up to 12 trace rows while wrapped in
`noInterrupts()`. An NES controller clock train is only a few dozen microseconds long. Holding all
interrupts off for a trace-page copy can merge multiple pin edges into one pending interrupt, so the
game receives the wrong serial bit even though the intended mask is correct. This also explains why
turning continuous tracing on could change where the run failed.

The v45 prototype on `main` changed trace storage to publish each row with its timestamp as a
commit marker. The main loop now copies and validates rows without disabling NES pin interrupts.
This removed the trace-page critical section from the latency-sensitive path.

## Seven-Clock Reads and the Need for Latch Mode

The v45 delay-0 completed-read run exposed a separate semantic issue. At TAS record 2081, Nightshade
began producing repeated controller windows with only seven clocks. Firmware status showed port 1
`index=7`; playback remained at record 2081 because completed-read mode requires all eight clock
edges before granting the window credit. The repeated short trains produced 179 torn-train
anomalies while the movie stayed frozen.

This does not necessarily mean TASDeck lost an edge. The same seven-clock behavior repeated at a
stable point, and TAStm32 advances an R08 stream from accepted latch events rather than requiring a
completed eight-clock read. Therefore completed-read gating is not a faithful playback rule for
this raw R08 file once the game performs a short read.

The v46 prototype added a distinct `Latch / R08` mode:

- Each accepted latch window grants advance credit, even if fewer than eight clocks follow.
- Same-window rereads still receive the same mask.
- Torn-train anomalies are suppressed in latch mode because a short clock train is permitted by the
  mode rather than automatically classified as corruption.
- Existing `Completed reads` behavior remains available for FCEUX/BizHawk poll-derived exports.

The bridge, protocol parser, web selector, documentation, and tests were updated to carry this mode.

## v46 Trace Results

The two latest relevant captures are:

- `logs/trace/2026-07-12T23-30-45-452-0400_Nightshade.trace`: latch mode, delay 1.
- `logs/trace/2026-07-12T23-35-13-952-0400_Nightshade.trace`: latch mode, delay 2.

Both report zero anomalies in their captured windows and no port-2 clocks. The delay-1 trace has
the relationship `latch count = TAS record + 2`; delay 2 has `latch count = TAS record + 3`. This is
the expected one-latch shift between the settings. In both traces, the intended, latched, and
clock-reconstructed masks agree.

The delay-2 capture reached TAS record 2427 with 404 records buffered and no underrun. Its captured
rows around the suspected failure contain the same values as `Nightshade.tdmask`. Therefore the
latest failure is not explained by serial upload starvation, port-2 traffic, a detected missed
clock, or the firmware selecting the wrong `.tdmask` record internally.

Trace agreement proves what the Arduino intended and reconstructed at its interrupt times. It does
not absolutely prove which voltage the NES sampled at every edge; that would require a logic
analyzer or oscilloscope observing the NES latch, clock, and data lines.

## Startup Blank Semantics

The replay repository prescribes TAStm32 `--blank 1` for Nightshade. We examined the TAStm32 Python
uploader and firmware rather than treating that option as an abstract emulator-frame delay:

1. `tastm32.py` queues one explicit zero record before R08 record 0 when `--blank 1` is used.
2. `ResetRun()` zeros the firmware's `P1_GPIOC_next` buffer.
3. On an accepted NES latch, `NesSnesLatch()` first drives the already-prepared
   `P1_GPIOC_next[0]`, then later calls `GetNextFrame()` to prepare the following latch.

At the wire-sequence level, that source appears to produce:

| Accepted latch | TAStm32 value with `--blank 1` |
| ---: | --- |
| 1 | Implicit zero from the reset `next` buffer. |
| 2 | Explicit zero queued by `--blank 1`. |
| 3 | R08 record 0. |

That is closest to TASDeck latch mode with delay 2, where R08 record 0 is associated with latch
count 3. However, delay 2 still fell into the pit. Delay 1 also fell into it. This means either the
wire-level startup interpretation is missing another detail of the verification setup, the game
state differs before input becomes sensitive, or a one-latch shift is not the complete cause.

There is also an implementation/documentation issue to revisit: the current v46 test comment says
TAStm32 `--blank 1` means exactly one blank latch, while the TAStm32 source pipeline appears to serve
an implicit initial blank plus the explicit queued blank. That comment should not be treated as
settled until the delay-0 experiment and startup hardware behavior are resolved.

## Input Sequence Near the Pit

The following corrected R08/TASDeck masks occur in the region associated with the early pit. This
region has not yet been aligned to an exact video timestamp, so “near the pit” is based on run timing
and captured records rather than a frame-perfect visual annotation.

| R08/TAS record(s) | Mask | Meaning |
| --- | --- | --- |
| 1692-1697 | `0x90` | Up + Right |
| 1698-1699 | `0x80` | Right |
| 1700 | `0x82` | Right + B |
| 1701 | `0x00` | Neutral |
| 1702-1710 | `0x50` | Up + Left |
| 1711-1736 | `0x10` | Up |
| 1737 | `0x11` | Up + A |
| 1738 | `0x00` | Neutral |
| 1739-1862 | `0x80` | Right |

The user observed that Nightshade appears not to walk one additional pixel upward before moving
right, which would explain falling into the pit. That interpretation is plausible: delaying the
whole stream by one latch delays the start and end of this precise Up/Up+A transition relative to
the game. Even if the count of Up records is unchanged, collision timing can leave the character
one pixel lower when Right begins.

Latch mode with delay 0 directly tested that thought by serving record 0 one accepted latch earlier
than delay 1. The game did not start. The result disproves the simple version of the theory: shifting
the entire stream early enough to change the pit alignment also shifts earlier one-frame inputs out
of their valid startup windows. It remains possible that Nightshade reaches the pit one pixel too
low, but a single global delay change cannot correct that without breaking an earlier event.

## Current Working Theories

### 1. One-latch startup alignment

This has now been tested across latch-mode delays 0, 1, and 2. Delay 0 prevents the game from
starting; delays 1 and 2 start the game but fall into the pit. The user's one-pixel observation may
accurately describe the state at the pit, but a uniform global offset is not a complete remedy.
Delay tuning should stop unless a different startup environment changes the result.

### 2. Initial machine state or EverDrive startup path

The source repository says the run was verified on a front-loading NES from power-on. The local
hardware uses an EverDrive N8 Pro configured to launch Nightshade automatically at power-on, with
TASDeck fully armed several seconds beforehand. There is no manual menu navigation. That removes a
large source of timing and input uncertainty, but an N8 Pro automatic boot is still not necessarily
the same machine history as applying power with an original Nightshade cartridge already mapped.
The cartridge firmware/FPGA must perform some boot and mapping work before handing control to the
game, and that may change RAM or peripheral history relevant to a sensitive power-on movie.

Nightshade is not listed among the replay repository's games that require a forced RAM-clear
pattern, and its BK2 has `InitialWRamStatePattern: null`. That makes exact natural power-on state
more important, not less. Latch-mode delays 0, 1, and 2 have now all failed, although delay 0 fails
earlier by missing the game's startup input. The N8 Pro state remains a leading Nightshade-specific
explanation, but it is weakened by the many README-listed movies that complete successfully through
the same N8 Pro and nearly identical power-on procedure. An original Nightshade cartridge test, if
available, would isolate this variable cleanly.

### 3. NES sampling versus Arduino-side reconstruction

The latest traces are internally clean, but firmware trace reconstruction samples the Arduino's
view of the data line. A marginal change at the wrong side of the NES clock edge could be read
differently by the console without appearing as a trace mismatch. This is lower probability than a
startup offset or machine-state difference because the controller driver works for other movies,
but it remains possible. The definitive test is a logic-analyzer capture of latch, clock, and data
through the pit transition.

### 4. Remaining R08 latch semantics

Latch mode was necessary because completed-read mode freezes on seven-clock trains. There may still
be a Nightshade-specific distinction between every raw latch and TASDeck's 8 ms latch-window
grouping, or a TAStm32 behavior involving repeated latches, DPCM handling, or first-latch output
enable that has not been reproduced exactly. The clean one-latch-per-record relationship in the
latest traces argues against ordinary accidental double-advance, but this remains open if startup
and machine state are ruled out.

### Explanations currently considered unlikely

- Wrong R08 download: exact public blob match.
- Wrong ROM revision: exact BK2 payload MD5 match.
- Reversed button bits: fixed and checked against BK2 masks.
- Controller 2: unplugged, BK2 expects unplugged, and hardware reports `clock2=0`.
- Buffer underrun: latest runs remained well buffered.
- Continuous-trace interrupt blocking in v46: the interrupt-masking trace copy was removed and
  latest captures show no anomaly.
- New-versus-old converter differences at the pit: those output files are identical until record
  2683, well after the suspected pit sequence.

## Current Main-Branch Prototype

The uncommitted `main` work currently spans the web UI, bridge, protocol, firmware, tests, and docs.
Its main behavioral changes are:

- Firmware identifier advanced from v44 through v45 to v46.
- Trace pages are copied without globally disabling interrupts.
- A stable trace-row publish/copy protocol avoids torn main-loop reads.
- `TasSyncMode::Latch` and the `Latch / R08` UI option were added.
- Latch mode grants one movie advance per accepted latch window without requiring eight clocks.
- Bridge and transport validation accept both `poll` and `latch`.
- Tests cover protocol parsing, bridge command formatting, UI selection, startup delay, and
  short-read latch advancement.

Verification already completed for this prototype:

- `npm run lint`: passed.
- Node and host-compiled firmware tests: passed (55 tests in the run observed during this work).
- Playwright UI tests: passed (22 tests in the run observed during this work).
- Arduino firmware compile: passed for `arduino:renesas_uno:unor4wifi`.
- `npm run format` does not exist on the current `main` package, so there was no format script to
  run.

These changes have not been committed because hardware validation has not established that latch
mode and its startup semantics solve Nightshade.

## Recommended Next Tests

### Test 1: isolate machine startup state

The 0/1/2 latch-delay series is complete and did not produce a working alignment. The exact N8 Pro
automatic-start procedure is now documented and does not include manual menu navigation. Before
changing firmware or delay again:

1. If possible, test with an original Nightshade cartridge from true power-off.
2. Record the N8 Pro firmware version and the values of `In-Game Menu` and `Cheats` in its Options
   menu. For a controlled test, disable `In-Game Menu` and `Cheats`, retain `Boot Last Game`, and
   retry latch mode with delay 1. These are reversible settings and remove optional cartridge
   behavior from the game path.
3. Check Nightshade's N8 Pro `Rom Info` screen and record its mapper/submapper plus whether the
   mapper is shown as standard (`STD`) or user-defined (`USR`).
4. Determine whether the N8 Pro has any other power-on mode that hands off to the last game with a
   different RAM-reset policy than the current automatic-load path.
5. Do not add menu-navigation inputs to the R08 stream; they alter the movie alignment.

After reproducing the closest available cold-start environment, retest delay 1 first because it is
the repository-prescribed explicit blank count and it starts the game. Delay 2 is the follow-up
because TAStm32's internal initial blank may make its wire-level sequence equivalent to two TASDeck
blank latches.

### Test 2: capture the failure itself

The 512-row manual trace ring covers only the most recent records. Trigger trace close enough to the
pit that records roughly 1650-1800 remain in the ring, and note the exact visual outcome. Compare
the trace's served masks and latch-to-record offset with the table above.

### Test 3: observe the real wire

If the same deterministic failure remains with controlled startup, capture Arduino/NES port-1
latch, clock, and data using a logic analyzer. Confirm all eight serial bits at the console pins for
the transition from Up/Up+A to Right. This distinguishes correct firmware bookkeeping from what the
NES electrically sampled.

## Relevant Trace Files

Key retained traces under the ignored `logs/trace/` directory:

- `2026-07-12T22-40-40-278-0400_Nightshade.stream.csv`: long v44 continuous trace containing the
  missed-clock evidence near TAS record 6352.
- `2026-07-12T23-14-28-374-0400_Nightshade.trace`: v45 completed-read, delay-0 run frozen at record
  2081 with repeated seven-clock windows and 179 anomalies.
- `2026-07-12T23-15-28-802-0400_Nightshade.trace`: v45 completed-read, delay-1 capture with no
  anomalies in its retained window.
- `2026-07-12T23-30-45-452-0400_Nightshade.trace`: v46 latch-mode, delay-1 capture.
- `2026-07-12T23-35-13-952-0400_Nightshade.trace`: v46 latch-mode, delay-2 capture.

## Bottom Line

The R08 converter's byte mapping is now correct, the local R08 and ROM match the public verified
movie, and v46 delivers the expected masks without detected electrical or buffering anomalies in
the captured windows. Raw R08 playback also needs latch-based advancement because Nightshade can
perform seven-clock reads that permanently stall completed-read mode.

The latch-mode delay series now gives three distinct but non-working outcomes: delay 0 never starts
the game, while delays 1 and 2 start it but fall into the pit. This rules out a simple global
one-latch correction. The N8 Pro procedure is controlled, avoids manual menu navigation, and works
for all README-listed TAS runs, so there is no evidence that the user's general procedure is wrong.
The leading questions are now a Nightshade-specific original-cartridge-versus-N8-Pro initial state,
or a data-line/polling detail that the Arduino's internal trace cannot observe. The investigation
should stop tuning delay values and focus on capturing the exact pit window, isolating cartridge
state if possible, and, if necessary, measuring the actual NES data line.
