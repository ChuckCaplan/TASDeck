# Golf And Uninitialized Work RAM

Golf (USA) is the one verified run that cannot be played from the EverDrive N8 Pro's menu at any
setting. The game reads uninitialized zero-page RAM, and the EverDrive's loader supplies exactly the
one value that breaks the run. This document records the mechanism, the hardware procedure that
works around it, and how to recognize the same class of failure in other movies.

For general playback and desync diagnosis, see [Hardware TAS Playback And
Troubleshooting](../hardware-tas-workflow.md).

## The Failure

At Start delay 256 on an EverDrive N8 Pro, Golf completes hole 1 correctly and shows the right wind
at hole 2's tee, then the second stroke on hole 2 stops roughly a ball's width short of the cup and
the run desynchronizes from there. Every downstream hole is wrong because each hole's wind seed
depends on the frame count, and the missed putt changes it.

The ball flight after record 308 is the measurable signature:

| Power-on `$4C` | Hole 2, stroke 2 flight | Frames | Outcome |
| --- | --- | ---: | --- |
| `$01`–`$FF` (255 values) | 10,449.9 ms | 628 | Holes out |
| `$00` (1 value) | 9,251.5 ms | 556 | Stops short |

## What `$4C` Is

`$4C` is a sub-pixel wind-drift accumulator. Golf increments it once per ball-flight tick and
compares it against a threshold read from the table at `$D63F`. When the accumulator crosses the
threshold, the ball's lateral position `$45` advances one unit and `$4C` resets to zero. With the
wind strength in play on hole 2 the threshold is `$02`:

```txt
; $D258 - wind drift, called once per flight tick
  LDY $48          ; wind strength index
  BMI $D26B        ; no wind, skip entirely
  INC $4C          ; the uninitialized byte
  LDA $4C
  CMP $D63F,Y      ; thresholds: 0A 09 08 07 06 05 04 03 02
  BCC $D26B
  INC $45          ; ball drifts one unit
  LDA #$00
  STA $4C
```

Golf never writes `$4C` before this read. If the power-on value is `$01` or higher, the first `INC`
already reaches the threshold and the ball drifts on tick one. If it is `$00`, that first drift is
delayed by exactly one tick, and every later tick stays one step behind. All 255 non-zero values
produce an identical trajectory, which is why a sweep of all 256 values finds exactly one failure.

## Why The EverDrive Cannot Run It

BizHawk's NesHawk core fills work RAM from `InitialWRamStatePattern`. When a movie leaves that
setting null or empty — 67 of the 74 movies in the public replay corpus do — the core falls back to
the FCEUX power-on pattern:

```txt
if ((i & 4) != 0) ram[i] = 0xFF; else ram[i] = 0x00;   // 00 00 00 00 FF FF FF FF, repeating
```

The EverDrive's menu ROM fills `$0100`-`$07FF` with that same pattern, and then a loader stub copied
to `$0640` fills the **entire zero page** with `$00` before jumping through the reset vector. The
behavior is identical in firmware V2.00, V2.08, V2.15 and the 2025 build, and the menu ROM contains
exactly one launch path, so "Boot Last Game" does not bypass it either.

That leaves a single, precise deviation:

> Zero-page addresses with bit 2 set should be `$FF`. The EverDrive supplies `$00`.

That is 128 of the 256 zero-page bytes: `$04`-`$07`, `$0C`-`$0F`, `$14`-`$17`, through `$FC`-`$FF`.
The rule predicts Golf's failure without any emulation, because `$4C & 4 = 4`.

No TASDeck setting can compensate. The device drives two controller data pins; NES `+5V` and reset
are not connected, and `TAS_START` releases every button. Start delay only moves the seed phase, and
because the seed is a single byte that phase has a period of 256 — sweeping all 256 phases with
`$4C = $00` produces zero completions.

## The Three Constrained Bytes

Golf reads seven zero-page bytes before writing them. Three of them decide whether a run can sync:

| Byte | Role | Requirement |
| --- | --- | --- |
| `$8B` | NMI counter copied to `$8C` as each hole's wind seed | Any value; sets the required Start delay |
| `$4C` | Wind-drift accumulator | Must not be `$00`; no Start delay can compensate |
| `$4B` | Second drift constraint | Must be `$00` or `$FF`; 254 of 256 values fail at hole 2 |

The remaining four (`$3E`, `$40`, `$8D`, `$8E`) have no measurable effect on this movie. Every
published NES power-on RAM pattern satisfies both hard constraints, so the EverDrive is the only
documented configuration that cannot run the movie at all.

## Verification Procedure

The run was verified on a real Golf cartridge with an unmodified `Golf.r08`, by priming work RAM
before the game boots.

1. **Prime work RAM.** Launch [Vi Grey's `nes-ram-to-fceux`](https://vigrey.com/) from the EverDrive
   (`git clone git://git.vigrey.com/nes-ram-to-fceux`; a prebuilt NROM ROM ships in `bin/`). Hold
   nothing on the D-pad, which selects the FCEUX pattern and therefore `$4C = $FF` and `$4B = $00`.
   The ROM writes RAM within about ten frames, then parks the CPU in a `JMP $01FD` loop that
   executes entirely out of RAM and makes no cartridge accesses.
2. **Hold Reset before touching the cartridge.** This step matters on any console with a working
   CIC lockout chip. Once the cartridge leaves the slot the lockout pulses reset, and each pulse
   sends the CPU to `$FFFC`, which with no cartridge present reads open bus and executes whatever
   the bus returns — corrupting the zero page that was just primed. Holding Reset halts the CPU so
   it cannot run at all while the slot is empty.
3. **Swap in the real Golf cartridge**, still holding Reset.
4. **Arm playback.** Load `Golf.r08` with `per strobe` sync, `Skip first` 0, and Start delay 255.
   That delay is specific to this console; the section below explains how to derive it for another.
   Press Play, wait for the upload, then press Start. Nothing happens yet because the console is
   halted and produces no latches — which is what makes the timing deterministic rather than
   hand-timed.
5. **Release Reset.** Golf boots, takes its first controller poll on frame 2, and TASDeck counts the
   start delay from there.

## Choosing The Start Delay

The correct delay is console-specific. It compensates for the power-on value of `$8B`, and a
hardware Reset boot costs a different number of NMIs than an EverDrive menu launch, so a value that
works on one setup will not carry to another. The tee screen displays enough to derive it. Golf
renders a hole's seed as:

```txt
MPH       = (seed >> 3) & 15
direction = seed & 7      ; 0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW

new delay = current delay + ($7B - observed seed)   ; mod 256
```

Hole 2's tee must read **15MPH southeast**, which is seed `$7B`. Read the wind at whatever delay you
started with, convert it to a seed, and apply the correction. On the console used for the verified
run, Start delay 1 produced 15MPH southwest — seed `$7D`, two steps high — so the run was repeated
at delay 255 and completed all eighteen holes.

Two properties of the encoding are worth knowing before spending boots on it:

- **Bit 7 is not displayed.** Seeds `$7B` and `$FB` both render as 15MPH southeast, so every wind
  reading has a second candidate 128 delay steps away. If the wind looks correct and the putt still
  misses, add 128.
- **A 0 MPH reading hides the direction**, collapsing sixteen seeds into one observation. It is
  still useful as a coarse check: hole 1 is windless at the correct delay.

The full reference state at hole 2's tee is `OUT 2 / 395Y / PAR 4 / WIND 15MPH SE / SHOT I-0 /
SCORE -2, 2 / CLUB 3W`.

## Legitimacy

The published run uses a retail Golf cartridge — no patched game code — and an unmodified
`Golf.r08` that is byte-identical to the file in the public replay corpus. The movie targets
Golf (USA), SHA-1 `B7128F71125070D5E4009C474D259811D029E8B6`. The only departure from a plain cold
boot is that work RAM was initialized to a documented pattern rather than left to natural power-on
residue, which is established practice for uninitialized-RAM games and is disclosed in the run's
table entry.

The accurate claim is "verified on original hardware with work RAM initialized to the FCEUX and
BizHawk default pattern." It is not a claim that Golf synchronizes from an arbitrary cold boot; that
would additionally require `$4C` and `$4B` to land in range on that particular power-on.

## Recognizing The Same Failure Elsewhere

Any movie whose game reads an uninitialized zero-page byte at an address with bit 2 set is exposed
to the same deviation. Exposure alone is not enough — Monopoly reads four such bytes and completes
on the EverDrive regardless, because none of them changes its behavior. The byte has to feed
something the run depends on.

The public replay corpus names these runs as requiring RAM cleared to the FCEUX and BizHawk pattern:
Adventures of Tom Sawyer, Marble Madness, Mickey Mousecapade, Monopoly (both runs), Rad Racer,
Silver Surfer, and Wizards and Warriors (both runs). Replaying each of them under the EverDrive's
RAM image and under the BizHawk default confirms that Marble Madness, Wizards and Warriors, and Rad
Racer genuinely behave differently between the two.

One class of failure this does **not** explain is the per-boot lottery. The EverDrive fills RAM
identically on every launch, so work RAM is a constant across boots; anything that varies from one
boot to the next on that hardware comes from CPU, PPU, or APU alignment, or from DMC timing, not
from power-on RAM.
