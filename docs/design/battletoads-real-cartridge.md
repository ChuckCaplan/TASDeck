# Battletoads On An Original Cartridge

Status: **no ending on an original cartridge yet, after roughly twenty attempts.** Input delivery is
now verified from the console side and is not the cause. The remaining variable is the console's
power-on timing, which sets a game RNG phase that the game-end-glitch payload depends on. This
document records what was measured on 2026-09-22 and what those measurements rule out.

Companion document: [Battletoads On The EverDrive N8 Pro](battletoads-everdrive-open-bus.md), which
covers the flashcart `$6000-7FFF` work-RAM problem and the v2/v3/v4 patched ROMs. **That problem does
not exist on an original cartridge**, which drives open bus in that range as the reference run
expects. Do not use the v2 D patched ROM on a real cartridge: it exists only to emulate open bus for
the N8, and a patched ROM forfeits a clean verification.

Setup for everything below: original `Battletoads (USA)` cartridge, front-loading NES,
`Battletoads_GEG.r08` (1,822 records), **two ports / per-strobe / Start delay 1 / Skip first 0**,
continuous trace streaming off, cold power-on.

## Hardware Results

The Dark Queen message-table landing, previously attributed to the N8 driving save RAM where the ACE
needs open bus, **also occurs on an original cartridge with genuine open bus**. That attribution was
too strong. It is also a power-on alignment outcome: the harness sweep of the six modeled startup
timings produces the Dark Queen portrait as well as the ending.

A controlled batch of six boots, each with the NES unplugged and its capacitors drained and the
Arduino reset beforehand, gave the intro screen every time and these outcomes:

| Outcome | Count | Where it broke |
| --- | ---: | --- |
| Speeder-bike level's health-draining enemy in the wrong place | 2 | Before the ACE; the run was already lost |
| Dark Queen message table | 2 | Slide reached `$8000`, `JMP ($0013)` taken, wrong destination |
| Stuck on the race level | 2 | Ending jump fired, slide never carried the PC to `$8000` |
| Animated ending | 0 | — |

**The scores entering the glitch are correct on every boot that reaches it** (011500 / 018500). The
run is right and only the ACE landing is wrong. Earlier attempts made without resetting the Arduino
are not clean draws; see [Operational Notes](#operational-notes).

## The Landing Is Decided By Zero Page `$75`

The glitch jumps to `$75BD` and executes open bus. From the reference disassembly, `$75 $75` is
`ADC $75,X`, which **reads zero page `$75`**; that value becomes the value left on the bus, and the
rest of the slide is fetched from open bus as that byte repeated until the program counter reaches
`$8000`, where `JMP ($0013)` enters the ending.

Comparing NesHawk runs at the glitch (movie record 2396) between two alignments that reach the ending
and two that do not:

| | `$13` | `$14` | `JMP ($0013)` | `$75` | Result |
| --- | --- | --- | --- | --- | --- |
| blank 0, phase 0, parity 0 | `06` | `80` | `$8006` | **`6F`** | ending |
| blank 2, phase 2, parity 1 | `06` | `80` | `$8006` | **`6F`** | ending |
| blank 0, phase 0, parity 1 | `06` | `80` | `$8006` | `9A` | stuck on race level |
| blank 2, phase 0, parity 0 | `06` | `80` | `$8006` | `E1` | stuck on race level |

- **`JMP ($0013)` is not the variable.** `$13/$14` hold `06 80` in every run, winning and losing.
- **`$75` is the variable.** `$6F` makes the slide `RRA $6F6F`, which walks the PC to `$8000`. `$9A`
  is `TXS` and `$E1` is `SBC (zp,X)`; neither reaches `$8000`, and the game stays on the race level.
- **`$75` changes every frame.** It is part of the RNG stream, not a stable state: the winning run's
  values around the glitch run `… 46, 1C, 6F, 53, 14, 80 …`. One losing run reaches `$6F` three
  records late. Failures are small phase errors, not gross divergence.
- **Winning is one exact state.** The two winning runs have byte-identical zero pages at the glitch,
  0 of 256 bytes different, despite different delays and different alignments. The two losing runs
  differ from each other in 76 bytes.
- **Divergence begins at the game's first controller read** (frame 1164, record 1), in `$25-$28` and
  `$75`, before the movie has delivered anything that affects play.

The outcome is therefore fixed by the console's RNG phase at power-on, upstream of anything the
replay device does. Battletoads advances its RNG in a busy loop that the frame interrupt breaks, so
the phase is set by how many iterations run before the NMI fires.

## Start Delay Is Not A Lever

A NesHawk sweep of Start delays 1 through 18 against all six modeled startup timings, scored by
comparing each run's final frame against the known-good ending image:

| Delay | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Endings / 6 | 1 | 0 | 1 | 2 | 0 | 0 | 0 | 2 | 2 | 2 | 0 | 1 | 1 | 2 | 2 | 2 | 0 | 1 |

**19 endings in 108 runs, almost exactly one in six, scattered as independent draws. No delay reaches
three of six.** Each delay shifts the RNG phase by one frame, so higher delays are fresh draws rather
than variations, and none is robust across alignments. Keep Start delay 1, the corpus power-on value.

On hardware, delay 0 does not start the game and delays 2, 3 and 4 reach the glitch and fail. Delays
5 and 6 failed early with the game's headbutt-instead-of-kick lottery, which the harness does not
model and which is not a delay effect.

## Harness Blank To Hardware Delay Mapping

The harness inserts blank records with `BT_BLANK`, which is boolean; for N blanks, prepend N `00 00`
pairs to a copy of the `.r08` instead. **Hardware Start delay = harness blank + 1.** This was
measured, not assumed. A trace captured during the intro at delay 1 shows:

```
latch 1:  result=waiting  mask=00   <- the delay-1 blank
latch 2:  result=ok       mask=10   <- record 0 (r08 raw 08, reversed = 10)
```

The game's first poll therefore receives record 0 at delay 1, which is what harness blank 0 does.
Hardware delay 0 failing to start matches harness blank -1, where the game reaches level 1 at record
530 instead of record 4. The console emits one extra latch before the game's first poll, as the
harness README claimed.

## Input Delivery Is Console-Verified

`TASDeck-input-test` (staged beside the ROMs) is an NROM test ROM plus matching `.r08` that checks
what the **NES receives**, using the same `$8D78-$8D91` controller-read instructions, strobe width,
bit order and spacing as Battletoads. Launch it to `STATE WAIT`, then start playback at two ports /
strobe / delay 1 / skip 0 without resetting the NES.

**Result: PASS / INDEX 2004 hex, three separate runs — 8,196 consecutive two-port records matched,
WANT equal to GOT.** The differing `PRE` values (`07DE`, `0204`, `0247`) are pre-arm waiting time,
not dropped records.

This is the only measurement of delivery that is not self-reported. Firmware traces read TASDeck's
own output pin and cannot see a late bit or a shifted record stream. The comparator does not
resynchronize after an error, so a dropped or repeated record fails at a known index. Three clean
passes therefore also **rule out the ±1 latch-train drift hypothesis** — the TAStm32 feature TASDeck
lacks, and the one that TASDeck's own mask-versus-r08 checks are structurally blind to because they
compare the served mask against the record index TASDeck believes it is on.

A pass does not prove every timing condition in the real game. The test polls once per frame and does
not reproduce Battletoads' NMI handler or workload, so it does not exercise the payload window's
6.70 microsecond strobe-to-first-read deadline under load.

## Ruled Out

| Hypothesis | How it was ruled out |
| --- | --- |
| Input delivery / bit timing | Input comparator PASS three times, 8,196 records, console-side |
| ±1 latch-train drift | Same test; the comparator does not resync after an error |
| Start delay | 108-run sweep, one in six at every delay, nothing above 2/6 |
| Power-on RAM, Golf-style primer | `BT_RAM=everdrive` gives byte-identical results across all six alignments |
| Post-movie output | `popFrame()` returns a zeroed mask when exhausted, matching the harness's "post-movie reads receive zero on both ports" |
| Cartridge revision | See below |
| Arming TASDeck changing the boot path | Stale controller state from a previous run; fixed by resetting the Arduino |

### Why A Golf-Style RAM Primer Cannot Work Here

Golf read *uninitialized RAM as data*, so writing the expected bytes before the movie fixed it.
Battletoads does not seed its RNG from power-on RAM; it advances the RNG in a busy loop broken by the
frame interrupt, so the phase depends on an iteration count, not on memory contents. A primer can
write every byte of RAM without changing it. Measured: clearing the zero page changes nothing.

The timing analogue of a primer is a startup-synchronization patch. That is what v3 and v4 were. v4
converged all six modeled alignments to the ending and played byte-identically to the reference at
every latch for all three movies, and **still froze on hardware on the first attempt**, because the
approach leans on NesHawk's PPU-race and dot-skip model. Those are recorded as a dead end.

### Cartridge Revision

A ROM revision mismatch is **deterministic** — every boot would fail the same way in the same place.
The observed behaviour is a per-boot lottery with several outcomes, including boots that play
correctly to the glitch with reference scores and fire the ACE on the right frame into the game's own
message table. Code at `$75BD`, `$8000`, `$66EB` and the `$0013` vector all behave as the reference
expects. A different PRG revision would not produce that. This is not a cartridge version problem.

### The Other Two Movies

Neither uses arbitrary code execution, so neither has the game-end glitch's single-frame `$75`
requirement. They have a different and probably more forgiving failure profile.

- **Warps (`battletoads_2p_warp.r08`, 4271M) is worth trying.** Its documented hardware failure —
  never beating Intruder Excluder or Robo-Manus — was pinned on the N8 driving save RAM where level 3
  reads open bus at `$7FEB-$7FFF`. An original cartridge reads `$7F` there correctly, so this movie
  has never been tested in the configuration most likely to fix it. Roughly ten minutes per attempt.
- **Warpless (`battletoads_2p.r08`, 4267M) is lower value.** Its blocker is the missed Surf City
  floor clip, and the harness found that no cartridge-RAM fill value changes Surf City, so the
  open-bus difference is not the explanation and an original cartridge is unlikely to fix it.
  Roughly eighteen minutes per attempt with the known blocker unaddressed.

## Operational Notes

- **Reset the Arduino between attempts.** The firmware holds controller state until a new run resets
  it, so a stale mask from a previous attempt sits on the data line at power-on. This was observed to
  change which boot screen appears. Because the outcome is decided by power-on RNG phase, a stray
  press at boot can bias the draw rather than merely add noise. Clean procedure is reset, arm, power
  on; the clean signature is the full intro playing every time.
- **Do not enable continuous trace streaming for this movie.** A two-port strobe run emits a trace row
  per port per latch edge, sharing one serial link with the record upload, and has been observed to
  starve the upload into a buffer underrun resembling a desync.
- **Battletoads does not read the controller during the logos and intro.** The first four latches are
  at frames 1164, 1176, 1186 and 1199. That leaves a wide window in which the 384-row trace ring is
  nearly empty, which is how the boot latch structure above was captured. Once the game polls every
  frame the ring self-flushes in about three seconds.
- **The glitch fires roughly 575 latches after the movie's records run out.** The `.r08` holds 1,822
  records; the ending jump occurs near latch 2397. TASDeck serves zeros on both ports through that
  window.
- **Firmware in this tree is v75** (`uno_r4_wifi.ino:41`), and both trace gates still read
  `tasPlayback.started() || tasPlayback.startDelayRemaining() > 0` (`:2578`, `:2731`), which stays
  true forever after playback completes. A trace taken after the movie ends is therefore flooded with
  post-completion rows and cannot hold the payload window at records 1807-1818.

## Reviving The NesHawk Harness

The harness lives at `logs/research/battletoads-2026-09-15/reference/harness/`. Its `validated-build/`
directory is a working binary and needs no emulator rebuild, but `Program.cs` hardcodes
`/private/tmp/battletoads-reference`, which is periodically cleaned. To restore:

1. Install a .NET 8 runtime:
   `dot.net/v1/dotnet-install.sh --runtime dotnet --channel 8.0 --install-dir /private/tmp/battletoads-reference/dotnet`
2. Extract `BizHawk-2.5.2/Assets/gamedb` from the source archive recorded in `build-manifest.json`
   into `/private/tmp/battletoads-reference/`, verifying its SHA256.
3. Copy `validated-build/*` to `/private/tmp/battletoads-reference/bin/Release/net8.0/` and run
   `dotnet Headless.dll "<rom>" "<r08>" <outprefix> 6000`.

Validation before trusting it as an oracle: the unmodified ROM with the open-bus model and zero
blanks reaches the ending at `record=2397 level=254`. `BT_PHASE` 0-2 and `BT_CPU_PARITY` 0-1 select
the startup timing. The `.ram` output stores 2,048 CPU RAM bytes per CSV row, so row index equals
record minus one.

## Open Questions

- **The hardware outcome mix does not match the model.** Across the six modeled alignments at delay 1
  the harness produces one ending and mostly race-level stalls, and never the message-table landing or
  the pre-glitch enemy divergence. Clean hardware boots produce both repeatedly. The physical startup
  space is evidently richer than the three PPU phases and two CPU parities the harness offers, which
  its own README concedes. Latch drift would have explained this and has now been excluded.
- Whether a warm-reset start draws power-on alignment from a different and possibly more
  deterministic distribution than cold power-on. Untested. The reset convention is `--blank 0`, and
  cold power-on and reset-release must be recorded as distinct procedures.
