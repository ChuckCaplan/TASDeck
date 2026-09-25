# Battletoads On An Original Cartridge

Status as of 2026-09-25 (all times EDT):

- **The unmodified game-end-glitch movie cannot win on this console with this cartridge
  (2026-09-25).** Its Dark Queen landing is deterministic, not a power-on lottery. Every console
  stores `$6F` in `$75`, and on this console's bus the `$6F` slide drifts one byte and misses the
  ending. More GOOD boots will not help. See
  [Why The Unmodified Movie Loses Every Time](#why-the-unmodified-movie-loses-every-time).
- **Alyosha's 2021 win is explained by an open-bus quirk of his hardware (2026-09-25 evening).** His
  current emulator forces bit 7 of unmapped `$6000-7FFF` reads to follow address line A2, a rule he
  calls "hardware dependent" and says is needed for the game-end glitch. With that rule the
  unmodified movie reaches the ending from every modeled state, by a different slide that does not
  depend on `$75`. This console lands on the Dark Queen where the rule predicts the ending, so it
  lacks the quirk. The next test is a different NES. See
  [Alyosha's Win: An Open-Bus Quirk Of His Hardware](#alyoshas-win-an-open-bus-quirk-of-his-hardware).
- **All three movies have been beaten on this console with the EverDrive N8 Pro and the patched
  `Battletoads (TASDeck sync v5).nes`:** the game-end glitch on its first on-target boot, warpless
  (`battletoads_2p.r08`) on its first on-target boot, and warps (`battletoads_2p_warp.r08`) on its
  second. A patched ROM is not a clean console verification.
- **The original cartridge has not produced a win** in about 45 game-end-glitch attempts (delays 1
  and 4) and every warps attempt. GOOD boots went 0 for 8.
- **Why the game-end glitch can't win on a cartridge, and the fix (2026-09-24):** the published
  movie's final open-bus slide only reaches the ending in an emulator that ignores CPU writes when
  tracking open bus. With real bus behavior the model's winning states land on the Dark Queen, the
  same screen as every GOOD cartridge boot. One extra press after the movie's last record fixes
  it in the model under both bus behaviors. See
  [The Dark Queen Landing Is An Open-Bus Emulation Error](#the-dark-queen-landing-is-an-open-bus-emulation-error).
- **★★★ ALL THREE MOVIES BEATEN ON THE ORIGINAL CARTRIDGE, 2026-09-24.** Warpless
  (`battletoads_2p.r08`, unmodified, Start delay 1): boot 19:50 EDT, watcher GOOD (13/10/13, 386,998
  cycles, +307, clock +232 ppm), through the end of level 1, Surf City and Robo-Manus to the ending; a
  clean console run. That day's warpless GOOD boots before it (19:45 on 13/10/13, 19:48 on 12/10/13)
  desynced near the end of level 1, a per-boot variation that power-on video-memory contents and the
  real bus do not explain in the model.
- **★★ WARPS BEATEN ON THE ORIGINAL CARTRIDGE WITH THE UNMODIFIED `.r08`, 2026-09-24 (boot 19:32
  EDT):** `battletoads_2p_warp.r08`, Start delay 1, watcher GOOD (12/10/13, 356,862 cycles, +305, clock
  +146 ppm; start state 10T). Past Robo-Manus to the ending: a clean console run, with no patched ROM
  and no modified input.
- **★ GAME-END GLITCH WON ON THE ORIGINAL CARTRIDGE, 2026-09-24 18:08 EDT:** `Battletoads_GEG+tail1830R.r08`, Start
  delay 4, on a GOOD boot (13/10/13, 387,154 cycles, +295, clock +47 ppm), after the unmodified
  movie had produced the Dark Queen on 6 of 7 GOOD boots. A one-cycle timing difference inside the
  glitch window would have made the tail fail in most modeled variants, so this favors the bus
  explanation. Alyosha's 2021 verification video (`youtu.be/X6sR4F6kBnI`, presumably an original
  cartridge, since he verifies from power-on) shows the real ending from the unmodified file; his
  hardware's open-bus quirk accounts for that (see the status line above).
- Input delivery is verified from the console side and is not the cause.
- **The cartridge is a genuine Nintendo board** (photographed 2026-09-24), so `$6000-7FFF` reads open
  bus.

Most failures of a Battletoads run are decided by the console's power-on CPU/PPU timing, not by the
replay device. The game-end glitch adds a second, deterministic failure on real cartridges, covered
first below.

Companion document: [Battletoads On The EverDrive N8 Pro](battletoads-everdrive-open-bus.md), which
covers the flashcart `$6000-7FFF` work-RAM problem and the v2/v3/v4 patched ROMs. **That problem does
not exist on an original cartridge**, which drives open bus in that range as the reference run
expects. Patched ROMs run only on the EverDrive.

Settings for everything below unless noted: front-loading NES, two ports, per-strobe, Skip first 0,
continuous trace streaming off, cold power-on, `.r08` files byte-identical to
[alyosha-tas/NES_replay_files](https://github.com/alyosha-tas/NES_replay_files).

## The Dark Queen Landing Is An Open-Bus Emulation Error

### Mechanism

The glitch reaches bank 0's script dispatcher (`$DB09-$DB26`) with script opcode `$FE`, read from
bank 3 ROM data because the glitch leaves object 0's type byte (`$04FC`) at an invalid `$83`. A
phantom object with index `$FF` writes it there every frame. Opcodes `$E0-$F6` index a 23-entry
handler table at `$DB3A`. `$FE` reads past its end and jumps to `$75BD`, in open bus. There,
`$75 $75` is `ADC $75,X` with X = 0, which reads `NMI_Areg_saver`: the NMI handler (`$FF98`)
stores whatever A held when the frame interrupt hit the RNG busy loop (`$871F`). The slide then
executes open bus up to `$8000`, where every bank starts with `JMP ($0013)`; `$13/$14` = `$8006`, and
bank 0's `$8006` jumps to `$8326`, the game-flow routine that shows the ending.

In the winning states `$75` = `$6F`, so the slide is `RRA $6F6F` repeated, a 3-byte instruction that
lands exactly on `$8000`. **NesHawk (01c3b14) updates its open-bus value (`DB`) only in
`ReadMemory`.** On a real NES a CPU write cycle drives the data bus, so after each `RRA` writes its
rotated value (`$37` or `$B7`), the next opcode fetched from open bus is that byte and the slide goes
elsewhere. On the EverDrive preload ROMs (v2 D, v5) `$6000-7FFF` is RAM filled with `$6F`, which
behaves like NesHawk. That is why they won and the cartridge does not.

### Evidence (harness in `logs/research/battletoads-2026-09-24-real-bus/`)

- A research build adds `BT_WRITE_DB` (`NES.WriteMemory` sets `DB`). From the default winning state,
  per-latch RAM, RNG and timing stay identical through the jump (latch 2397). After it, NesHawk shows
  the ending text; with `BT_WRITE_DB=1` the same run shows **the Dark Queen portrait cycling the
  message table ("ROBO-MANUS")**, the screen seen on the cartridge.
- Every modeled ending state at delays 1 and 4 converges on one game state at the glitch (RAM hashes
  at latches 735 and 2390). Covered: the watcher's GOOD classes (23 states at delay 4, 17 at delay 1)
  and the ending half of its MAYBE classes. With `BT_WRITE_DB=1`, all of them land on the Dark Queen.
- **A controller press after the movie's last record moves the busy-loop phase at the final frame
  interrupt without moving the jump**, so the jump reads a different `$75`. From that one state:

| Extra input | `$75` at the jump | NesHawk bus | Real bus | Cartridge, GOOD boots |
| --- | --- | --- | --- | --- |
| none (published) | `$6F` | ending | **Dark Queen** | Dark Queen (6 of 7 at delay 4, 2 of 2 at delay 1) |
| P1 Right at record 1830 | `$8E` | ending | **ending** | ending (1 of 1, 2026-09-24) |
| P1 Select at record 1860 | `$07` | ending | **ending** | not run |
| P1 Left at 1950 | `$9B` | stuck | ending | ending (1 of 1, 2026-09-25) |
| P1 Right at 2000 | `$93` | Dark Queen | ending | **Dark Queen** (1 of 1, 2026-09-25) |

  "Real bus" here means `BT_WRITE_DB=1`: a CPU write leaves its value on the data bus for the next
  open-bus read. The last two rows were staged as hardware tests because NesHawk and the real bus
  disagree on them. See [The two tests](#the-two-tests).

  The first two tails won every ending class at both delays under both bus behaviors, and the
  final files were re-verified in the harness (8/8). Search: 63 of 150 single-press tails before it
  was stopped; 4 won under the real bus.
- Warps under `BT_WRITE_DB=1` still reaches its ending at latch 34,996, so the bus error is specific
  to the glitch's slide.
- Separately, shifting only the NMI by one CPU cycle from latch 1500 or 1800 gives a Dark Queen
  landing at latch 2409 or 2450; from latch 17, 500 or 1000 the run dies before the glitch. The
  one-in-five GOOD boots that die to the speeder-bike enemy fit a timing variant like this. It
  cannot be seen in the first 16 latches, and no tail helps it.

### Files and use

**Use `~/Desktop/Everdrive/TAS/Fail/Battletoads/Battletoads_GEG+tail1830R.r08`.** It also survives
a one-CPU-cycle NMI shift from the end of the movie at both delays (`$75`→`$AC`, still the ending),
while `+tail1860Sel` lands on the Dark Queen under that shift; both fail at two cycles. The backup
and a README are in `TASDeck-real-bus-tail/`. Records 0-1821 are the published movie. Play at Start
delay 4 with the watcher, which reads `+tail` names with the original tables, and play out GOOD and
MAYBE boots; on this cartridge 7 of 27 delay-4 boots so far were one or the other. This extends the input file after its last record, so it is not a clean
verification of 3528M.

The two test files from the table sit in the same folder: `Battletoads_GEG+test1950L.r08` and
`Battletoads_GEG+test2000R.r08`. Play them at Start delay 4, on GOOD boots only. Each is the
published movie plus one press after its last record.

### Emulator timing knobs

The same research build adds `BT_NMI_DOTS`, `BT_VBL_DOT` and `BT_NMI_SUP` (NMI assertion dot,
`$2002` VBL race dot, NMI suppression window). One-dot shifts reproduce several cartridge
fingerprints that stock NesHawk never produces: 12/11/14 at 357,359 +306, 13/10/13 at 386,606, and
13/10/14 at 387,143 +306. They support the idea that this console lands on sub-dot CPU/PPU alignments
NesHawk does not model. No knob setting makes a GOOD fingerprint land on the Dark Queen; the bus
behavior does.

## Why The Unmodified Movie Loses Every Time

Analysis from 2026-09-25, from the 2021 harness's default winning state at delay 4 (`BT_OFFSET=-12`,
phase 0, parity 0, 3 blanks). Commands and raw outputs are listed in
[Reproducing The Analysis](#reproducing-the-analysis).

### `$75` is `$6F` on every console

The byte the glitch executes first is `$75`, the A register saved by the NMI handler (`$FF98`). A
trace of the final frame's busy loop (`BT_LOOPTRACE=3942-3944`) shows where that NMI lands:

```txt
L871F:  jsr L8728        ; RNG mixing over $25-$28, X = 3..0
        jsr L8743
        jmp L871F        ; <- NMI taken after this JMP (frame 3943 -> 3944)
L8743:  lda $25 / eor $28 / adc $27 / sta $26
        lda $27 / rol a / sbc $28 / sta $27
        eor $26          ; A = $6F from here ...
        sta $25
        rts
        ; ... through JMP L871F, JSR L8728 and LDX #$03, until LDA $25,X loads a new A
```

A holds `$6F` for 20 CPU cycles across six instruction boundaries. The model's NMI is taken 12
cycles after the window opens and 8 before it closes. Consoles differ in CPU/PPU alignment by about
one cycle, so no console can move the NMI out of this window without changing the whole game state.
Every modeled state on the winning trajectory stores `$6F`, at every Start delay tried (1-12). Across
the 27 alignment-knob combinations run on 2026-09-24 (`results/kw.out`), 114 jumps read `$6F` and 15
read `$76`, and `$76` also loses on a real bus (see the sweep below). No Start delay, power-on state
or boot produces a winning `$75` from the unmodified input.

### The slide, step by step

The jump lands at `$75BD` with X = 0 and Y = `$0F`. `$75 $75` is `ADC $75,X`, which reads `$6F` and
leaves it on the bus. The next opcode is fetched from open bus at `$75BF`.

| Step | NesHawk bus (last value read) | Real bus (last value read or written) |
| --- | --- | --- |
| `$75BF` | `RRA $6F6F`: reads `$6F`, writes `$37` | Same |
| Next fetch | `$6F` again (the write is ignored) | `$37`, the written value |
| Then | `RRA $6F6F` repeats 875 times | `RLA $37,X`: RAM `$37` = `$F9`, writes `$F3` |
| Then | Lands exactly on `$8000` (`$8000 - $75BF` = 3 × 875) | `ISC ($F3),Y`: pointer `$0100` + `$0F` → stack RAM `$010F`, `$7C` → `$7D` |
| Then | Last `RRA` at `$7FFD`; next opcode at `$8000` | `ADC $7D7D,X` repeats from `$75C6`; the last one starts at `$7FFE` and uses `$8000` (`$6C`) as an operand |
| Result | `JMP ($0013)` → `$8006` → `$8326`, the ending | Next opcode at `$8001`, missing `JMP ($0013)` → Dark Queen message table |

Every input to the real-bus path is ordinary RAM, with no I/O register or timing-dependent read. On
a console whose bus keeps written values, the unmodified movie therefore reaches the same Dark Queen
on every boot. That matches the cartridge: every GOOD boot of the unmodified file landed on the Dark
Queen (6 of 7 at delay 4; the seventh died earlier to the speeder-bike enemy), and 0 of about 45
attempts overall reached the ending.

### Which `$75` values win on a real bus

A forced sweep sets `$75` to each value just before the jump (`BT_POKE75`, 256 runs with
`BT_WRITE_DB=1`): **126 reach the ending, 68 the Dark Queen, 62 stall** on the race level. `$6F` is a
Dark Queen. Winning values:

```txt
03 05 06 07 0A 0F 11 13 15 16 17 18 19 1A 1B 1D 1F 20 24 25 26 28 2A 2C 35 38 3A 3C 44 47 48 4A
4D 4E 54 55 58 59 5A 5C 5D 5E 61 65 66 68 6A 6D 73 74 78 79 7A 7C 7D 7E 83 84 85 86 87 88 8A 8E
8F 91 93 94 95 96 97 98 99 9A 9B 9F A1 A3 A4 A5 A6 A8 AA AC AD AE B1 B5 B6 B8 B9 BA BC BD BE BF
C1 C4 C5 C7 C8 CA CC CD CF D4 D5 D8 D9 DA DC DD DE DF E1 E4 E5 E8 EA EC F1 F5 F8 F9 FA FF
```

About half of all values would win on this bus. The console just never produces any of them without
a change to the input. That is why one press after the movie fixes it: the press changes how long
the frame's game logic runs, which moves the final NMI to a different point in the busy loop. The
three tails tested on hardware (`$8E`, `$9B`, `$93`) all work the same way on a real bus. With X = 0
they store 0 to a ROM address (`STX $8E8E`, `TAS $9B9B,Y`, `SHA ($93),Y`), and 0 is `BRK`. `RTI`
returns with `$75` on the bus, so `ADC $75,X` restarts on every iteration. X = 0 also makes the
unstable `&(H+1)` term of `TAS` and `SHA` irrelevant, and `SHA`'s pointer (`$F0DF` + `$0F`) does not
cross a page.

### The two tests

`+test1950L` (`$9B`) and `+test2000R` (`$93`) predict opposite results under the two bus models, so
each was played once on a GOOD delay-4 boot:

| File | NesHawk bus predicts | Real bus predicts | Cartridge |
| --- | --- | --- | --- |
| unmodified | ending | Dark Queen | Dark Queen |
| `+tail1830R` | ending | ending | ending |
| `+test1950L` | race-level stall | ending | **ending** |
| `+test2000R` | Dark Queen | ending | **Dark Queen** |

The real bus matches three of the four files and NesHawk's bus matches two. Neither matches all
four. The model was checked for a state that would explain both test results:

- All 23 modeled power-on states behind the delay-4 GOOD fingerprint follow one trajectory (RAM hash
  `50B170BACE` at latch 2390), so the model makes one prediction per file.
- Across the 29 sub-dot knob and state combinations (`BT_NMI_DOTS`, `BT_VBL_DOT`, `BT_NMI_SUP`) that
  produce a GOOD fingerprint, `+test1950L` and `+test2000R` behave the same on a real bus: 20
  endings, 9 early level-3 losses, and no Dark Queen.

So no modeled state gives `+test1950L` the ending and `+test2000R` the Dark Queen together. The
`+test2000R` result is one boot. The Dark Queen is the most common failure on a real bus: 68 of the
130 losing `$75` values, and 41 of the 63 single-press tails searched (`results/tails.out`). GOOD cartridge
boots have also gone off-model before, for example the speeder-bike loss. So one Dark Queen is weak
evidence, while an ending is hard to reach by accident.
This analysis still favors the real bus, but the discrepancy is unexplained.

Write retention itself is documented hardware behavior. AccuracyCoin, a test ROM designed for an NTSC
RP2A03G console, checks that "Moving the program counter to open bus should read instructions from
the floating data bus values. Write cycles should update the data bus" (Open Bus test 4) and that
"Writing should always update the data bus" (test 8).

### Alyosha's Win: An Open-Bus Quirk Of His Hardware

Found 2026-09-25 evening. Alyosha's current C++ NES core in
[GBAHawk](https://github.com/alyosha-tas/GBAHawk/blob/ebfcc4541e3d8924a7e8a84ebd2c76da69a97589/libHawk/NESHawk/Mappers.h#L104-L117)
(present since its first commit, 2026-03-03) models open bus on a cartridge with no work RAM like
this:

- a CPU write sets the bus value (`MemoryMap.cpp`, `DB_Ext = value`), as on this console;
- a read of unmapped `$6000-7FFF` returns that value with **bit 7 forced to address bit A2**: cleared
  when A2 = 0, set when A2 = 1. The comment reads "not entirely accurate and hardware dependent /
  works for Battletoads and Castlevania III". The same rule sits in its MMC3, MMC5 and MMC6 code.

In a TASVideos forum post of 2025-12-26 he wrote that "open bus is somewhat noisy, in fact emulating
this noise is needed to verify Castlevania 3 and Battletoads game end glitch", and he describes that
emulation as tuned to his own console and cartridge.

**The rule reproduces his win.** Ported as knob `BT_OB7=1` into the 2021 tracer, with
`BT_WRITE_DB=1`:

- Every modeled power-on state that reaches the glitch reaches the **ending** (8 of 8 runs, delays 2
  and 4). Without the rule the same states store `$6F` and land on the Dark Queen. The saved
  classifier output (`results/2026-09-25/ob7_rule_sweep.out`) labels the delay-2 pair `Q` only
  because its jump comes 11 frames earlier and polling resumes before the 4,400-frame limit. Its end
  latch equals its jump latch and it then goes silent for hundreds of frames, as every ending does; a
  Dark Queen landing polls every frame.
- The slide no longer uses `$75`. The first fetch at `$75BD` reads `$F5`, and execution runs a
  `BRK`/`RTI` chain from `$75BD` to `$7802` (the IRQ/BRK vector target `$FE74` is a lone `RTI`), then
  a one-byte `SEI`/`SED` sled from `$7803` that lands exactly on `$8000`, `JMP ($0013)`, and the ending.
- The rule also changes the game's `$66EB-66EF` open-bus reads just before the glitch, which adds one
  lag frame there, so the jump comes a frame later.
- All four files played on this cartridge also reach the ending under the rule.

**This console does not show the quirk.** The rule predicts the ending for the unmodified file and
for `+test2000R`, and the neutral files are the same input through the glitch; the cartridge gave the
Dark Queen for all of them. Plain write retention matches five of the six cartridge results and the
rule matches only the two tail endings. The exact behavior of this bus is still not fully modeled
(`+test2000R` is unexplained), but the model that fits it best gives no way for the unmodified input
to win.

Alyosha's hardware, from his posts and video descriptions: a standard front-loading NES with an
RP2A03G CPU and an RP2C02G-0 PPU, a TAStm32 started from power-on with the default `--blank 1`, and
almost certainly an original cartridge. He never states the cartridge; the video opens on the capture
card's no-signal screen and goes straight into the Tradewest logo with no flashcart menu, and he had
no development board until 2021-07-19, after the 2021-07-02 video. His other facts check out:

- The `.r08` in his repository has a single commit (2021-07-02 17:23 UTC) and is byte-identical to
  the file played here.
- "Resync from original" means only five inserted blank frames, four at level-load lag frames and
  one at the end. All 996 non-blank input frames match 3528M.
- TAStm32 serves "no buttons" when its buffer runs out (`Src/stm32f4xx_it.c` in Ownasaurus/TAStm32,
  the `else // no data left in the buffer` branch), the same zeros TASDeck serves after the movie.

Other console attempts at the game-end glitch (True's and dwangoAC's runs of the older 2403M, True's
2016 test of the NesHawk version) desynced or ended differently. Alyosha's 2021 video is the only
known success.

The rule was fitted to two different cartridges (Battletoads on AOROM, Castlevania III on MMC5),
which suggests the quirk is on the console side, but that is an inference. The
[NESdev wiki](https://www.nesdev.org/wiki/Open_bus_behavior) also says some cartridges have "a weak
non-deterministic effect" on open-bus values.

### What would make the unmodified movie win

Hardware with Alyosha's quirk, not more attempts. On such a console any boot that plays correctly to
the glitch should reach the ending, whatever `$75` holds. In order of value:

1. **Try a second NES.** A front-loader with an RP2A03G CPU and an RP2C02G-0 PPU matches Alyosha's.
   Play GOOD delay-4 boots of the unmodified file; the result repeats exactly on a given console, so a
   handful of boots answers it. Record the CPU and PPU markings of this console too.
2. **A different Battletoads cartridge is unlikely to help.** NesCartDB lists one US board for the
   game: NES-AOROM-03 with a 74HC161 and the same PRG ROM (CRC32 `279710DC`) as this cartridge.
3. **The EverDrive N8 Pro cannot test the quirk.** Its FPGA drives every CPU read of `$4020-$FFFF`,
   and returns the address high byte when no mapper claims the read (`fpga/base_sv/everdrive.sv`,
   `cpu_dir` and the `//open bus` default in krikzz/edn8-pro-pub). Only `$4000-$401F` shows the
   console's own open bus on it.
4. **A bus adapter** in the cartridge slot that drives Alyosha's pattern, or `$6F`, on reads of
   `$6000-7FFF` would reproduce a winning slide with the original cartridge. Like the patched ROMs and
   the tail files, it would not be a clean verification.

## Hardware Run Log

### 2026-09-22, original cartridge, game-end glitch at delay 1

About twenty boots. A controlled batch of six, each with the NES unplugged, its capacitors drained
and the Arduino reset beforehand, gave the intro screen every time:

| Outcome | Count | Where it broke |
| --- | ---: | --- |
| Speeder-bike level's health-draining enemy in the wrong place | 2 | Before the ACE; the run was already lost |
| Dark Queen message table | 2 | Slide reached `$8000`, `JMP ($0013)` taken, wrong destination |
| Stuck on the race level | 2 | Ending jump fired, slide never carried the PC to `$8000` |
| Animated ending | 0 | — |

The scores entering the glitch are correct on every boot that reaches it (011500 / 018500). Earlier
attempts made without resetting the Arduino are not clean draws; see
[Operational Notes](#operational-notes).

### 2026-09-22, original cartridge, warps at delay 1

Five traced boots. Every warps attempt on the cartridge died at Robo-Manus at the end of the climbing
level, about three minutes in. Their title fingerprints, matched later against the 2021 reference:

| Boot | Title gaps (frames) | First title gap (cycles) | Start state |
| --- | --- | --- | --- |
| 18:46, 18:47 | 12 / 11 / 13 | 357,2xx | 21F, 10T or 11T |
| 18:48 | 12 / 11 / 14 | 357,2xx | 21T or 10F |
| 19:05 | 12 / 10 / 13 | 357,1xx | 11F |
| 19:06 | 13 / 11 / 13 | 386,999 | none of the modeled states |

### 2026-09-23, EverDrive with `Battletoads (TASDeck sync v5).nes`, delay 1

| Boot | Movie | Title gaps (frames), gap 7 − gap 6 | On target | Outcome |
| --- | --- | --- | --- | --- |
| 19:32 | Game-end glitch | 12.99 / 11.04 / 13.94, +306 | yes | **Real animated ending, first attempt** |
| 19:34 | Warps | 12.99 / 10.04 / 12.95, +307 | yes | Died at Robo-Manus |
| 19:37 | Warpless | 11.99 / 10.04 / 12.95, +308 | no | Stuck at the start of level 1 |
| 19:38 | Warpless | 11.99 / 10.04 / 12.95, +309 | no | Stuck at the start of level 1 |
| 19:40 | Warpless | 11.99 / 10.04 / 12.95, +305 | no | Not played out |
| 19:41 | Warpless | 12.99 / 10.04 / 12.95, +305 | yes | **Beat the game**, past Surf City and Robo-Manus |
| 20:03 | Warps | 12.99 / 10.04 / 12.95, +309 | yes | **Beat the game**, past Robo-Manus |

On-target boots won 3 of 4. The synchronizer hit the target on 4 of 7 boots.

### 2026-09-23 evening, original cartridge, game-end glitch with the boot watcher

`scripts/watch-battletoads-boot.js` verdicts from `logs/trace/boot-timing.log`. Gaps 2-4 are the
title at delay 1; at delay 4 the title is gaps 5-7 and the difference is gap 10 − gap 9. Boots not
listed with an outcome were powered off after the verdict or not reported.

| Time | Delay | Title (frames) | First title gap | Difference | Verdict | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 21:58:30 | 1 | 13 / 11 / 14 | 386,881 | +292 | BAD | |
| 21:59:18 | 4 | 12 / 11 / 14 | 357,231 | +305 | UNKNOWN | |
| 21:59:58 | 4 | 13 / 10 / 13 | 387,066 | +298 | MAYBE | |
| 22:01:22 | 4 | 13 / 10 / 14 | 387,032 | +307 | UNKNOWN | |
| 22:02:50 | 4 | 12 / 11 / 13 | 356,690 | +305 | UNKNOWN | |
| 22:03:29 | 4 | 12 / 11 / 14 | 356,726 | +307 | BAD | |
| 22:04:07 | 4 | 12 / 11 / 13 | 357,306 | +297 | BAD | |
| 22:04:47 | 4 | 13 / 10 / 13 | 388,324 | +305 | UNKNOWN | |
| 22:05:26 | 4 | 13 / 10 / 13 | 386,546 | +309 | UNKNOWN | |
| 22:06:07 | 4 | 12 / 11 / 14 | 356,763 | +307 | BAD | |
| 22:06:48 | 4 | 13 / 11 / 14 | 386,539 | +307 | UNKNOWN | |
| 22:07:27 | 4 | 13 / 10 / 13 | 387,069 | +296 | **GOOD** | Dark Queen message table |
| 22:08:53 | 4 | 13 / 10 / 13 | 387,066 | +297 | **GOOD** | Dark Queen message table |
| 22:10:19 | 4 | 13 / 10 / 13 | 387,033 | +294 | **GOOD** | Speeder-bike enemy in the wrong place |
| 22:11:17 | 4 | 12 / 11 / 14 | 357,281 | +305 | UNKNOWN | Glitched and stayed on the race level |

- **All three GOOD boots lost**, although each matches the model's winning 21T trajectory at delay 4
  to within about 25 cycles on the title screen and ±2 cycles over the first gameplay frames.
- **7 of 14 delay-4 boots were UNKNOWN.** Rescaled per boot on its own gameplay frames (see
  [Boot Timing](#boot-timing)), one of them (22:02:50) is a modeled losing class the fixed clock
  correction had pushed out of tolerance. The other **6 of 14 are off-model**: title-poll
  combinations none of the 228 modeled states produces, 530-1,260 cycles or a whole frame from any
  model value. All of this is on the title screen, before the game reads `$6000-7FFF`.
- Every delay-4 boot also shows its third blank-poll gap (gap 4) about 20-34 cycles longer than the
  model. **That is TASDeck, not the cartridge**: gap 4 ends on the first playback latch, which the
  firmware stamps later than start-delay latches (see [Boot Timing](#boot-timing)).

Five more delay-4 cartridge boots on 2026-09-24 (15:58-16:02, firmware v76): 4 OFF-MODEL, 1 BAD. That
makes 10 of 19 delay-4 cartridge boots off-model and 3 of 19 GOOD. Two GOOD boots right after them
(16:04, 16:07) were reported as Dark Queen landings too: GOOD cartridge boots have now produced the
Dark Queen 4 times and the speeder-bike loss once, and no ending.

The same session continued at delay 1 (16:09-16:15, two GOOD boots, both Dark Queen) and with warps at
delay 1 (16:16-16:28, 17 boots, one GOOD, which lost to the level-3 life-drain enemy). **GOOD cartridge
power-on boots: 0 of 8 won**, against 3 of 4 on-target v5 boots on the EverDrive. Tightening the
watcher's tolerances cannot separate them. Calibrated against the winning trajectory, the eight GOOD
cartridge boots sit within 22 cycles on every title gap and 5 cycles on every gameplay gap. The
EverDrive winners sit within 37 and 3, so the losers are as close as the winners, some closer. What
decides the ending, the cycle on which the frame interrupt lands in the RNG busy loop, changes RAM
rather than poll timing. In the model, winning and losing twins keep identical latch timing until
latch ~517 or ~819, and the traced 2026-09-22 cartridge boot matched the model's timing until latch
~2,115.

**Conclusion:** on this console with the original cartridge the model does not describe the power-on
states well enough to choose boots. The watcher's verdicts are validated only on the EverDrive with
v5 (and, by construction, v2 D).

### 2026-09-25, original cartridge, the two tail tests at delay 4

A morning session, starting about 10:32 with boots about 38 seconds apart, played only GOOD boots.
Two launches were warm boots (short power-off) and are not counted.

| File | Cold boots | GOOD boot | Outcome |
| --- | --- | --- | --- |
| `+test1950L` | 20 (13 BAD 12/11/14, 2 BAD 12/11/13, 4 OFF-MODEL) | 10:45:41, 13/10/13, 387,161, +296, clock +267 ppm | **Ending** |
| `+test2000R` | 5 (1 BAD 12/11/14, 1 BAD 12/11/13, 2 OFF-MODEL) | 10:52:34, 13/10/13, 387,126, +296, clock +254 ppm | **Dark Queen** |

The mix of power-on states shifted from the two earlier sessions:

- **GOOD fell to 2 of 25 cold boots**, against 6 of 29 on 2026-09-23 and 2026-09-24.
- **12/11/14 titles, which lose to the speeder-bike enemy, rose to 16 of 25**, against about 8 of 29.
- **13/10/13 titles fell to 5 of 25**, against about 11 of 29. Three of the five were the off-model
  386,590-cycle twin, which has appeared in every session.

Timing measurements were normal: startup gap about 1,162.6 frames, intro polls 4/8/1, and BAD boots
within about 20 cycles of the model row. So this is the console's power-on distribution, not
TASDeck. The earlier sessions were in the evening, and this one probably started with a cold
console. Whether temperature shifts the distribution is untested.

## What Decides The Outcome

### The landing byte is the A register at the frame interrupt

The game-end glitch jumps to `$75BD` and executes open bus. `$75 $75` is `ADC $75,X`, which reads
zero page `$75`; that value is left on the bus, and the rest of the slide is fetched from open bus as
that byte repeated until the program counter reaches `$8000`, where `JMP ($0013)` enters the ending.
`$6F` makes the slide `RRA $6F6F`, which walks the PC to `$8000`; other values do not. That holds
only on NesHawk's bus, which ignores writes. On a bus that keeps written values `$6F` loses and about
half of all other values win; see
[Why The Unmodified Movie Loses Every Time](#why-the-unmodified-movie-loses-every-time).

`$75` is `NMI_Areg_saver`: the NMI handler stores the A register there. Between frames the game
spins in `random_cycle` (`$871F`), churning its RNG bytes `$25-$28` until the NMI arrives, so both
the RNG state and `$75` depend on exactly which CPU cycle each NMI lands on. That is set by the
console's power-on CPU/PPU timing. Clearing or priming RAM cannot change it.

| NesHawk run at the glitch (record 2396) | `$13` | `$14` | `$75` | Result |
| --- | --- | --- | --- | --- |
| blank 0, phase 0, parity 0 | `06` | `80` | **`6F`** | ending |
| blank 2, phase 2, parity 1 | `06` | `80` | **`6F`** | ending |
| blank 0, phase 0, parity 1 | `06` | `80` | `9A` | stuck on race level |
| blank 2, phase 0, parity 0 | `06` | `80` | `E1` | stuck on race level |

### Twelve start states

Every modeled power-on state reaches the end of the game's two startup VBlank waits (bank 0 `$82C8`,
scanline 242 in NesHawk's numbering) in one of 12 **start states**: the dot the CPU cycle starts on
mod 3, CPU cycle parity against the PPU, and the PPU's odd-frame flag, named like `01F`. Shifting
the CPU by whole cycles does not change the start state. For a given Start delay the start state
fixes the outcome of each movie; see [Start States And Delays](#start-states-and-delays). NesHawk's
default state is `01F`, which wins all three movies at delay 1.

### Why the first harness could not reproduce the hardware

The first harness is BizHawk 2.5.2. Its power-on state is `start_up_offset = 2` with the PPU's
odd-frame flag (`idleSynch`) clear. Alyosha retuned NesHawk's power-on state to his console in June
2021, and he dumped these files on those development builds:

| File | Dumped (repo commit date) | NesHawk power-on state that day |
| --- | --- | --- |
| `battletoads_2p_warp.r08` | 2021-06-22 16:55 UTC | [`28ff96d`](https://github.com/TASEmulators/BizHawk/commit/28ff96deb52c64bbda8e7d57acd36fcae324f6b4), 32 minutes earlier: offset -4, vblank and sprite-overflow flags set at power-on |
| `battletoads_2p.r08` | 2021-06-22 21:10 UTC | same |
| `Battletoads_GEG.r08` | 2021-07-02 17:23 UTC | [`76c76a8`](https://github.com/TASEmulators/BizHawk/commit/76c76a8775): offset 4, `idleSynch` set (every release since 2.6.3) |

His [announcement](https://tasvideos.org/Forum/Posts/506829): "the state I chose (out of 3 more or
less equally reasonable options) is that the runs of Battletoads still sync, with very minor
adjustment for initial lag frames". The 2.5.2 harness varied only CPU/PPU phase and CPU parity
around its own offset and never produced the Dark Queen landing or the speeder-bike loss at delay 1.

### The 2021 reference

`logs/research/battletoads-2026-09-23-startup-state/harness/` builds BizHawk
[`01c3b14`](https://github.com/TASEmulators/BizHawk/commit/01c3b1449593ad1637584783677e9be5939cd6f9)
(2021-07-02) headless, with the same latch hook and open-bus cartridge model as before. Environment
variables set the power-on state after construction: `BT_OFFSET` (`start_up_offset`), `BT_VBL`,
`BT_OVF`, `BT_IDLE`, `BT_PHASE`, `BT_CPU_PARITY`, plus `BT_BLANKS` (hardware Start delay minus 1),
`BT_INSERT` (`record:count` blank records before a movie record), `BT_KEEPWRAM` (EverDrive work-RAM
model) and `BT_BOOTONLY` (stop at `$82C8` and print the start state). At its default state it
reaches the game-end-glitch ending at latch 2397 and plays warps to its ending at latch 34,996.

A sweep of offset -12 to 14, vblank flag, odd-frame flag and CPU parity (216 states), plus CPU/PPU
phase probes, gives exactly eleven distinct latch-timing trajectories for the game-end glitch at
delay 1, and it reproduces every cartridge outcome of 2026-09-22 from timing alone:

| Title gaps (frames) | First title gap (cycles) | Gap 7 − gap 6 | Outcome at delay 1 | States |
| --- | --- | --- | --- | ---: |
| 12 / 10 / 13 | 356,886 | +306 | **Ending** | 17 |
| 12 / 10 / 13 | 357,205 | +306 | Race stall | 19 |
| 12 / 11 / 13 | 357,205 | +306 | **Ending** (twin separates at latch 517) | 22 |
| 12 / 11 / 13 | 357,205 | +306 | Race stall | 17 |
| 12 / 11 / 13 | 356,886 | +306 | Race stall | 7 |
| 12 / 11 / 14 | 357,205 | +306 | Speeder-bike loss (004500 / 011500) | 23 |
| 12 / 11 / 14 | 356,886 | +306 | Race stall | 11 |
| 13 / 11 / 14 | 386,985 | +306 | **Ending** (twin separates at latch 819) | 18 |
| 13 / 11 / 14 | 386,985 | +306 | Race stall | 16 |
| 13 / 11 / 14 | 386,983 | +296 | Dark Queen taunt | 38 |
| 13 / 11 / 14 | 386,983 | +296 | Race stall | 40 |

57 of 228 states (25%) reach the ending. The warps model reproduces the Robo-Manus death, and the
winning states play on to the ending. Hardware latch timestamps, calibrated on the fourth title gap
(285,769 cycles in every class), agree with the model to about two CPU cycles per frame on the
EverDrive; four of the five warps boots of 2026-09-22 match a model class exactly through their
first 120 latches.

## Boot Timing

The bridge logs a `Boot timing` line once a run passes its 16th latch, appends it to
`logs/trace/boot-timing.log`, and writes it into saved `.trace` headers: the gaps between the first
latches in NTSC frames and CPU cycles. At Start delay 1, gap 1 runs from the power-on latch to the
first title poll (about 1,163 frames), gaps 2-4 are the title gaps, gap 5 is about 9.6 frames, and
gaps 6 onward are single gameplay frames. Each extra blank moves those one gap later. A first gap
of a few frames instead of about 1,163 means RAM survived the power-off (see
[Operational Notes](#operational-notes)).

The numbers are Arduino `micros()` timestamps, not console cycles, and two measurement effects matter
at the scale the watcher uses:

- **Clock scale drifts per boot.** The bridge applies a fixed 1.001228 correction. Fitted on each
  boot's own gameplay frames, the remaining error ranged from +110 to +370 ppm across the 2026-09-23
  boots, minutes apart: up to about 150 cycles on a 13-frame title gap, more than the watcher's
  120-cycle tolerance. Differences between adjacent single-frame gaps (gap 7 − gap 6) cancel it;
  single long gaps do not. The watcher now calibrates each boot (below).
- **Before firmware v76 the first playback latch was stamped late.** Start-delay latches take the
  latch ISR's general path, which read `micros()` at entry. After the last delay latch the 1 kHz
  service starts playback and pre-advances record 0, so the first playback latch and every later one
  take the strobe fast path, which read `micros()` in its preemptible tail, about 13 µs (20-34
  cycles) after the strobe. The gap spanning that switch read long by that amount: gap 4 at delay 4,
  and at delay 1 the 1,163-frame gap, where it is invisible. **v76 refers both paths back to the
  ISR's entry cycle** (`tasdeck::microsAtCycle`), so every latch is stamped at the same point.
  Confirmed on hardware 2026-09-24: five delay-4 cartridge boots on v76 read gap 4 within −7 to −1
  cycles of the model, against +17 to +31 on all fourteen v75 boots.

Neither effect changes what the console receives: per-strobe playback consumes one record per latch
edge and never consults the clock.

### Checking The Measurement With The Test ROM

`scripts/boot-timing-test/build.py` builds `TASDeck boot timing test.nes`, which performs 20 reads at
the game-end-glitch default state's latch gaps, exact to the cycle, and shows them on screen. The
ROM's gaps are straight-line CPU code with rendering, interrupts and DMA off, and all 19 match the
2021 reference to the cycle, so they are a ruler the NES itself controls.

Load `boot_timing_test.r08` at **Start delay 6** and run the watcher: it recognizes the file and
prints PASS or FAIL. Rather than trusting the schedule blindly, it fits
`measured = k × (expected + offset)` over the gaps, so the data give TASDeck's clock scale `k` and
any fixed per-gap offset. It holds the gap from the last delay latch to the first playback latch
(gap 6 at delay 6, a single frame) out of the fit and reports it separately. The check catches:

- a clock scale error of any size (reported, not failed);
- a fixed offset of more than about 5 cycles on every gap, from the ROM's cycle counting or
  TASDeck's stamping;
- a single gap that disagrees, including the delay-to-playback gap. v75 firmware should FAIL on gap 6
  by +20-34 cycles; v76 should PASS.

It cannot see an offset common to every latch, which cancels in every gap and so cannot affect any
comparison; effects below TASDeck's 1 µs (about 1.8-cycle) resolution; or anything about how
Battletoads itself runs on this console, which the ROM does not reproduce. As of 2026-09-24 it has
not been run on hardware.

### Automatic Terminal Watcher

Run this in a separate terminal before starting attempts:

```sh
node scripts/watch-battletoads-boot.js
```

It follows new entries in `logs/trace/boot-timing.log`, detecting the movie filename and Start
delay, and can start before the log exists. A `+suffix` before `.r08` (such as
`Battletoads_GEG+tail1830R.r08`) is read with the original movie's tables. It only reads the log and does not control playback.

- **GOOD:** matches a winning model fingerprint; promising, not a guaranteed win.
- **BAD:** matches a modeled losing start state.
- **MAYBE:** winning and losing states share the fingerprint, or measurement tolerances overlap,
  **and the title reads 13/10/13**. That title's losing twin dies to the speeder-bike enemy before
  the glitch, so the attempt shows itself early.
- **SKIP:** any other ambiguous fingerprint.
- **OFF-MODEL:** calibrated cleanly, but no modeled power-on state produces this title timing, so
  the model has no prediction.
- **UNKNOWN:** no supported table, incomplete data, gaps after the title that do not fit the model
  (no calibration possible), or a short startup gap (a warm boot, or a Reset launch that needs
  Start delay 0).
- **PASS / FAIL:** a `boot_timing_test.r08` capture; see
  [Checking The Measurement](#checking-the-measurement-with-the-test-rom).

Each boot is first calibrated on its own clock: the ~9.6-frame gap after the title plus the next
four gameplay gaps span 405,344 cycles (±2) in every modeled trajectory, or exactly one frame more
in one warps class, so the watcher scales the line to that span and prints the correction as
`clock +NNN ppm`. A span more than 0.1% off is rejected.

Tables cover the game-end glitch at delays 1 and 4 and warps and warpless at delay 1, from the
2026-09-23 sweeps. A launch without the power-on boot latch (gap 1 only a few frames, with the cold
intro's polls 4, 8 and 1 frames apart) gives the game the boot power-on delay + 1 gives it, so
Start delay 0 is read with the delay-1 table and Start delay 3 with the delay-4 table; other delays
get advice instead of a verdict. Matching uses heuristic tolerances of 120 cycles for the calibrated
first title gap and 4 cycles for the gameplay difference. **The verdicts are validated on the EverDrive with v5, where
GOOD boots won 3 of 4, and failed on this console's original cartridge, where GOOD boots lost 3 of
3.** They do not apply to the unpatched ROM on the EverDrive, whose work RAM breaks level 3 and the
game-end glitch. `--once` classifies existing entries and exits; `--log PATH` watches another file.

A v5 game-end-glitch boot at delay 1 shows SKIP even when it is on target, because the target shares
its 13/11/14 fingerprint with a losing state; at delay 4 an on-target v5 boot shows GOOD.

## Start States And Delays

Model outcomes by Start delay, from one representative power-on state per start state:

| Movie | Winning start states by delay |
| --- | --- |
| Game-end glitch | d1: 01F, 10T, 21F · d2: 00F, 01F · d3: 00F · d4: 01F, 11T, 20F, 21T · d8: 00T, 01F, 11T · d9: 00T, 01F, 20T · d10: 10F, 10T, 11T |
| Warps | d1-4: 01F · d1 and d6: 10T · d5 and d8: 11T · d8: 01F · d9: 00F, 20T |
| Warpless | d1-4 and d8: 01F · d1 and d6: 10T · d5 and d8: 11T · d9: 00F |

**21F and 21T never win warps at any delay from 1 to 40.** The cartridge's traced warps boots
landed on 21F, 21T, 10T/11T and 11F, which is why every cartridge warps attempt died at Robo-Manus.

Over all 228 modeled states the game-end glitch wins 57 (25%) at delay 1 and 75 (33%) at delay 4,
where the delay-4 winners are:

| Gaps 5-7 (frames) | Gap 5 (cycles) | Gap 10 − gap 9 | Endings / states |
| --- | --- | --- | --- |
| 13 / 10 / 13 | 387,143 | +296 | 23 / 23 |
| 12 / 10 / 13 | 356,822 | +306 | 18 / 18 |
| 12 / 11 / 13 | 356,827 | +306 | 34 / 45 |

`sweep8.out` stopped at latch 2400, the glitch itself, so on its own it could not tell the ending from
the Dark Queen landing, which differ only afterwards. Rerun past the glitch on 2026-09-24
(`sweep8-long.out`, `harness/rerun_long.py`, 4,520 frames): all 75 are real endings, with the ending
image and the ending's ~120 silent latches after the jump; no label changed, and **no modeled state
lands on the Dark Queen at delay 4**. The cartridge's GOOD boots landing there is a real gap in the
model, not a scoring error.

Delay 4 was recommended for the cartridge because the cartridge's most common delay-1 loss (the
speeder-bike enemy) is start state 21T, which wins at delay 4 in the model. The evening cartridge
test above shows that inference does not hold on this console.

Classes are defined at one Start delay; at another delay the same power-on states regroup.

## Sync v5: Forcing The Winning State On The EverDrive

`Battletoads (TASDeck sync v5).nes` forces start state `01F`, which wins the game-end glitch at
delays 1 and 4, warps and warpless:

1. v2 D's hook, open-bus preload and NES 2.0 battery header, unchanged.
2. v4's PPU synchronizer, which lands every modeled state on the same dot and frame but leaves CPU
   parity split.
3. An OAM DMA (513 or 514 cycles by parity) and a `$2002` read placed across the next VBlank start:
   in NesHawk one parity reads two dots before the flag sets, the other one dot after.
4. For the parity that reads the flag, two frames of background rendering across exactly one odd
   pre-render line, dropping one dot to move onto the other alignment.
5. A final delay to the target frame and dot, then the original startup continues at `$82C8`.

Sources: `logs/research/battletoads-2026-09-23-startup-state/v5/`, built by `v5build.py` with
`PT=176 PN=1 PB=0 FX=46 FT=76 NX=92 NT=144` (SHA256 `ff011488…8113d95`). The code lives in the
free space v2-v4 used (bank 6 `$FED0-$FF4A`, bank 7 `$80BC-$80FF` and `$FF40-$FF75`) and adds about
half a second of black screen at power-on.

In the 2021 reference with the EverDrive work-RAM model, all 228 modeled power-on states land on the
target, and the movies finish from every start state tried: game-end glitch 40/40 at delay 1 and
12/12 at delay 4, warps 3/3 (and past Robo-Manus at delays 1-4), warpless 2/2 including Surf City.
Every on-target boot logs the same gaps: 12.99 / 11.04 / 13.95 for the game-end glitch and
12.99 / 10.04 / 12.95 for warps and warpless, both with a difference near +306.

On hardware (see the [run log](#2026-09-23-everdrive-with-battletoads-tasdeck-sync-v5nes-delay-1)):

- **The synchronizer lands on target about half the time.** The misses match the model's
  12 / 10 / 13 class with a 357,2xx first gap exactly, which is the target with the CPU one PPU dot
  off, and the model reproduces their level-1 stall. Single-fault simulations (probe misfire, a frame
  early or late) produce other fingerprints, so the miss is in the synchronizer's own `$2002`
  convergence, most likely the sub-dot CPU/PPU clock alignment the console picks at power-on.
- **On-target boots won 3 of 4.** The one loss, warps at 19:34, matched the model's winning
  trajectory to ±4 cycles over its first 120 latches and still died at Robo-Manus, so on-target
  timing narrows the lottery without removing it.
- Off-target boots show in the `Boot timing` line within 20 seconds; reject them and power-cycle.

An NMI-timed final alignment would follow the game's own timing reference instead of `$2002` races,
but the game's NMI handler (`$FE75`) resets the stack and dispatches through `(jump_ptr_nmi)` in
bank 0, which has almost no free space, and the reference emulator has a single clock alignment, so
it could only be validated on hardware.

## The Original Cartridge From Here

For the game-end glitch, the open-bus finding at the top of this document supersedes the options
below: GOOD cartridge boots are the model's winning state, and the `+tail` movies address their Dark
Queen landing. The options below still apply to warps, warpless and the level-3 failures.

### Is `$6000-7FFF` really open bus on this cartridge?

The cartridge's failures from winning timing are the same ones the EverDrive produced before the
open-bus preload: the Dark Queen landing, the misplaced speeder-bike enemy, and warps dying at
Robo-Manus. The game reads `$6000-7FFF` in level 3 (the loader's `$7FEB-$7FFF` overread) and the
game-end glitch executes from there, so it depends on this range returning open bus. A genuine
AOROM board leaves it undriven. A reproduction board, a board with RAM or a decoder that answers
there, or anything else that changes what the console reads there would break those runs, and could
vary from boot to boot.

The 2021 reference with the range filled (`BT_WRAMFILL`), from the two winning start states used
for the game-end glitch:

| `$6000-7FFF` returns | Result |
| --- | --- |
| Open bus | Real ending |
| `$00` | Lost in level 3 before the glitch (scores 003500 / 005500) |
| `$FF` | Game over after the glitch |
| Random bytes, or each page's high byte | Glitch fires, stuck on the race level |

So wrong bytes there would turn winning timing into the cartridge's failure modes.

**Answered 2026-09-24: yes.** Photographs of both sides of the board show a genuine Nintendo
NES-AOROM board: a Nintendo-marked CIC, a 32-pin PRG ROM, the 28-pin CHR RAM at U2, the mapper
logic, no battery, no extra RAM, no flash or logic device, and no rework on the solder side. Nothing
on such a board drives `$6000-7FFF`. The Dark Queen, race-stall and speeder-bike losses are also
exactly the model's timing-class failures, and the off-model title timing happens before the game
reads that range, so neither points at the cartridge.

### How The Game Is Started

With the cartridge ruled out, what remains between the EverDrive runs, which followed the model, and
the cartridge runs, which did not, is how the game starts:

- **EverDrive:** the N8 menu jumps into the game on a console that has been running since power-on.
- **Cartridge power-on:** the game starts from the console's power-on reset, with the CPU and PPU in
  their power-on states.

On a front-loader the Reset button also resets the PPU, so a Reset-button launch is closer to
power-on than the EverDrive's jump, but it is the only other way to start the unmodified cartridge.
It is untested for Battletoads. The Golf and R.B.I. Baseball hold-Reset swap does it without the
warm-boot trap: boot a ROM from the EverDrive that leaves `$FD` ≠ `$28` (the Golf RAM primer
leaves `$FF`), hold Reset, swap in the cartridge, arm, release. R.B.I. Baseball needed Start delay 0
that way; the equivalent of power-on delay 4 would then be Start delay 3. The watcher reports which
delay the launch needs, then classifies it. Use the game-end glitch at delay 4, which has the most
GOOD fingerprints in the model and a power-on baseline to compare against. Twenty seconds per
launch shows whether Reset launches stay on-model where power-on launches did not; only then is
playing their GOOD boots informative.

### Other options

A cartridge cannot be patched, so the console must land on a winning start state by itself, and on
this console the model cannot say which power-on boots do. Besides the Reset launch above:

1. **A different NES.** Power-on behavior varies by console and chip revision, and it is the one
   variable not yet changed. Alyosha's console matches NesHawk; this one does not with the cartridge.
   For the unmodified game-end glitch the question is the bus rather than power-on timing; see
   [What would make the unmodified movie win](#what-would-make-the-unmodified-movie-win).
2. **A diagnostic cartridge run.** Trace every few seconds from the title to the failure of one
   cartridge boot and compare it with the model to find the first divergence. The off-model title
   fingerprints show the divergence starts on the title screen, before any `$6000-7FFF` read.
3. **Plain retries.** Alyosha warned these runs "would only work occasionally" from power-on; about
   35 game-end-glitch attempts on this console have produced no ending, so the odds look low. For the
   unmodified game-end glitch, retries cannot work on this console: its loss is deterministic (see
   [Why The Unmodified Movie Loses Every Time](#why-the-unmodified-movie-loses-every-time)). Retries
   still apply to warps and warpless, which have won here.

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
lacks, and the one that TASDeck's own mask-versus-r08 checks are structurally blind to.

A pass does not prove every timing condition in the real game. The test polls once per frame and does
not reproduce Battletoads' NMI handler or workload, so it does not exercise the payload window's
6.70 microsecond strobe-to-first-read deadline under load. The v5 wins, which include that payload,
cover the rest.

## Harness Blank To Hardware Delay Mapping

**Hardware Start delay = harness blank + 1.** A trace captured during the intro at delay 1 shows:

```
latch 1:  result=waiting  mask=00   <- the delay-1 blank
latch 2:  result=ok       mask=10   <- record 0 (r08 raw 08, reversed = 10)
```

The game's first poll therefore receives record 0 at delay 1, which is what harness blank 0 does.
Hardware delay 0 does not start the game, matching harness blank -1. The console emits one extra
latch before the game's first poll.

## Ruled Out

| Hypothesis | How it was ruled out |
| --- | --- |
| Input delivery / bit timing | Input comparator PASS three times, 8,196 records, console-side; v5 wins |
| ±1 latch-train drift | Same test; the comparator does not resync after an error |
| Power-on RAM, Golf-style primer | The RNG phase is set by NMI timing in a busy loop, not by RAM contents; clearing the zero page changes nothing |
| Post-movie output | `popFrame()` returns a zeroed mask when exhausted, matching the harness's "post-movie reads receive zero on both ports"; TAStm32 also serves "no buttons" on buffer underflow, and the `.r08`'s last three records are zero |
| RAM primer steering the real-bus slide | `$37`, `$F3`, `$F4` and `$010F` are cleared by the reset code (frame 2, `$82E6`/`$82E9`) and rewritten by the game before the jump (`BT_WATCH`) |
| AOROM bus conflicts | Conflicts need a CPU write to `$8000-$FFFF`; the unmodified slide writes only `$6F6F`, zero page and the stack page before reaching `$8000`, and the tails' stores of 0 latch 0 either way |
| Cartridge revision | A revision mismatch would fail deterministically; the cartridge fails in several ways and reaches the glitch with reference scores |
| Arming TASDeck changing the boot path | Stale controller state from a previous run; fixed by resetting the Arduino |
| Start delay as a universal fix | Each delay regroups start states; none wins them all (2.5.2 sweep and 2021 sweeps) |

## Superseded Work

- **2.5.2 delay sweep.** Delays 1-18 against six startup timings gave 19 endings in 108 runs, one in
  six at every delay. It modeled the pre-June-2021 power-on state.
- **v3/v4 synchronizer ROMs.** v4 converged all six 2.5.2 timings and froze at the glitch on its
  only hardware attempt. It was aimed at a state chosen in the wrong model; v5 uses the same
  synchronizer aimed at the 2021 model's `01F` and won on hardware.
- **Warpless blocked at Surf City.** That was the power-on state, not the movie: from `01F` the
  model passes Surf City, and the 19:41 v5 boot beat the game.

## Operational Notes

- **Reset the Arduino between attempts.** The firmware holds controller state until a new run resets
  it, so a stale mask from a previous attempt sits on the data line at power-on. Clean procedure is
  reset, arm, power on; the clean signature is the full intro playing every time.
- **A short power-off keeps the game's warm-boot flag.** The reset code clears RAM except
  `$FD-$FF`, and it treats `$FD = $28` (written when the title screen starts) as a restart. Then
  the intro reads the controllers every frame and skips to the title on any press, so a held stale
  mask skips the intro and TASDeck's blanks are spent on intro polls. The `Boot timing` line shows it
  as a first gap of a few frames instead of about 1,163; power off longer and retry.
- **Do not enable continuous trace streaming for this movie.** A two-port strobe run emits a trace row
  per port per latch edge, sharing one serial link with the record upload, and has been observed to
  starve the upload into a buffer underrun resembling a desync.
- **Battletoads does not read the controller during the logos and intro.** The first four latches are
  at frames 1164, 1176, 1186 and 1199. Once the game polls every frame the trace ring self-flushes in
  about three seconds.
- **The glitch fires roughly 575 latches after the movie's records run out.** The `.r08` holds 1,822
  records; the ending jump occurs near latch 2397. TASDeck serves zeros on both ports through that
  window.
- **Firmware in this tree is v76** (`uno_r4_wifi.ino:41`; v76 only moved latch timestamps), and both
  trace gates still read
  `tasPlayback.started() || tasPlayback.startDelayRemaining() > 0`, which stays
  true forever after playback completes. A trace taken after the movie ends is flooded with
  post-completion rows and cannot hold the payload window at records 1807-1818.

## Reproducing The Analysis

### The 2021 harness

Use the 2021 harness in `logs/research/battletoads-2026-09-23-startup-state/harness/` for anything
involving power-on state. Its `Program.cs`, project file and `bizhawk-01c3b14-headless.patch`
rebuild against the BizHawk `01c3b14` source archive with a .NET 8 SDK. As rebuilt on 2026-09-24:
a blob-filtered sparse clone of `TASEmulators/BizHawk` at `01c3b14` needs only `src/BizHawk.Common`,
`src/BizHawk.BizInvoke`, `src/BizHawk.Emulation.Common`, the NES core, `CPUs/MOS 6502X`, `Sound`,
`CoreNames.cs`, `Resources` and `Assets/gamedb` (about 50 MB). Apply the patch's three edits by hand
or with CRLF handling, because the sources are CRLF with BOM and `patch` rejects every hunk. Copy
`libblip_buf.dylib` from the 2.5.2 `validated-build/`, and set `BT_ROOT` to the checkout, since
`Program.cs` defaults to a deleted scratch path. The default state should give `endLatch=2397` and
`final=BE24D5985F763F04` at 4,500 frames, about 15 seconds per run. `bootsweep.py` records the
start state of every modeled power-on for a ROM, `sweep.py` runs job lists in parallel,
`keymap.py`/`cartdelay.py` build the start-state and delay tables, and `classify_boot.py` applies
them to a pasted `Boot timing` line. The sweep outputs (`sweep*.out`, `boot_*.json`,
`geg_classes.json`) sit in the parent directory.

### The real-bus tracer

The open-bus work uses a separate tracer in `logs/research/battletoads-2026-09-24-real-bus/harness/`:
`Program.cs`, `Tracer.csproj`, and `bizhawk-01c3b14-research-knobs.patch`. The patch adds
`BT_WRITE_DB`, `BT_NMI_DOTS`, `BT_VBL_DOT` and `BT_NMI_SUP` to NesHawk. To build it:

1. Put the project in a directory next to the patched BizHawk checkout, which must be named `BH`
   (the project file includes `../BH/src/...`).
2. Run `dotnet build -c Release -o <out>`.
3. Copy `libblip_buf.dylib` into `<out>`.

Run it as `dotnet <out>/Tracer.dll "<rom>" "<r08>" <outprefix> <frame limit>`. Set `BT_ROOT` to the
checkout. The delay-4 GOOD state is `BT_OFFSET=-12 BT_VBL=0 BT_IDLE=0 BT_PHASE=0 BT_CPU_PARITY=0
BT_BLANKS=3`, and the jump comes at frame 3944, so a limit of 4400 is enough. Options:

| Variable | Effect |
| --- | --- |
| `BT_WRITE_DB=1` | Real bus: CPU writes set the open-bus value |
| `BT_TRACEJUMP=1`, `BT_TRACE_FROM=<latch>` | At `$75BD`, dump the last 200 instructions, zero page and stack; `BT_JUMPLINE=1` prints only `JUMP ... V75=..` |
| `BT_OBREADS=1`, `BT_WATCH_FROM=2399` | Log every CPU read in `$6000-7FFF` (the slide) with the byte at PC |
| `BT_POKE75=<hex>` | Set `$75` when the glitch first reaches `$75BD` (added 2026-09-25) |
| `BT_LOOPTRACE=<f0>-<f1>` | Log busy-loop (`$871F-$874F`) instructions with A and the CPU cycle in frames f0-f1 (added 2026-09-25) |
| `BT_OB7=1` | Alyosha's GBAHawk rule: bit 7 of unmapped `$6000-7FFF` reads = A2 (`2` inverts it). Only in `harness/2026-09-25/alyosha-ob7/` (patch and `Program.cs`; its shell scripts point at a deleted scratch build) |

To classify outcomes, run `harness/tailcls.py <results> <frame limit> -v`. It prints `E?` for the
ending, `Q` for the Dark Queen and `s` for the race-level stall, and its limit must equal the
tracer's. The 2026-09-25 scripts are in `harness/2026-09-25/`:

- `poke75_sweep.py <out> 1 all` runs all 256 `$75` values on the real bus.
- `jobs_run.py knob_good_test_jobs.json <out>` runs both test files over the 29 knob and state
  combinations that give a GOOD fingerprint.
- Both scripts hard-code the 2026-09-24 scratch build directory for `dotnet` and `BT_ROOT`. After a
  rebuild, point `TRACER_DLL` at the new `Tracer.dll`, and `RUNS` at an output folder, or edit `B`.

Outputs are in `results/2026-09-25/`:

- `poke75_retention.out`: the 256-value sweep.
- `knob_good_1950L_2000R_retention.out`: the knob check.
- `slide_*_{retention,neshawk}.txt`: the slide traces.
- `final_nmi_busy_loop.txt`: the busy-loop trace.

The 23-state check groups `battletoads-2026-09-23-startup-state/sweep8-long.out` by title
13/10/13, first gap about 387,143, difference about +296, and `rh2390`.

### The 2.5.2 harness

The 2.5.2 harness in `logs/research/battletoads-2026-09-15/reference/harness/` models the
pre-June-2021 state. Its `validated-build/` binary needs `/private/tmp/battletoads-reference` with a
.NET 8 runtime and the BizHawk 2.5.2 `Assets/gamedb`; run
`dotnet Headless.dll "<rom>" "<r08>" <outprefix> 6000`.

## Open Questions

- Why this console's cartridge boots produce title fingerprints no modeled state produces (6 of 14
  delay-4 boots), and why boots that do match the winning trajectory still lose. The 20-34 cycle
  third-blank-gap excess once listed here is a TASDeck timestamp artifact.
- Whether a different console, or a Reset launch instead of a power-on, lands the cartridge on
  modeled (and winning) start states.
- Whether an NMI-timed alignment would raise v5's on-target rate above about one in two.
- Whether a second NES shows Alyosha's open-bus quirk, and whether the quirk comes from the console
  or the cartridge. His cartridge and mods are not stated; his CPU and PPU are RP2A03G and
  RP2C02G-0.
- Why `+test2000R` landed on the Dark Queen when every modeled GOOD state and knob variant gives the
  ending on a real bus, with or without Alyosha's rule, while `+test1950L` reached the ending as
  predicted. It is one boot.
- Whether this console's power-on distribution depends on temperature. On 2026-09-25 GOOD fell to
  2 of 25 and 12/11/14 titles rose to 16 of 25 in a morning session.
