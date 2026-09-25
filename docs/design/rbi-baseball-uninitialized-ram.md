# R.B.I. Baseball And Uninitialized Work RAM

adelikat's [R.B.I. Baseball "playaround"](https://tasvideos.org/1118M) is the second verified run
that cannot be played from the EverDrive N8 Pro's menu with the unmodified ROM. The cause is the one
described in [Golf And Uninitialized Work RAM](golf-uninitialized-ram.md): the game reads a
zero-page byte it never initializes, and the EverDrive's loader supplies the wrong value. The
hardware procedure is Golf's, played from the per-latch `.r08` at Start delay 0.

For general playback and desync diagnosis, see [Hardware TAS Playback And
Troubleshooting](../hardware-tas-workflow.md).

## The Failure

Launched from the EverDrive, the run desynchronizes at the first pitch. The movie's opening bunt
goes foul instead of fair, and every at-bat after it differs. FCEUX reproduces this: replaying the
movie with work RAM filled with `$00` departs from the default-pattern replay between movie frames
1000 and 1025, the same pitch.

## What `$0017` Is

R.B.I. Baseball's random number generator at `$EE67` combines a 16-bit linear-feedback shift
register at `$15`/`$16` with a byte at `$17` stepped as `$17 = 5 × $17 + 1`, and returns
`$17 XOR $15 XOR $16`. The game steps it about once per frame on every screen, including the title,
and input never changes it.

The startup routine clears work RAM but deliberately carries `$17` across the clear:

```txt
; $F124 - startup RAM clear
  LDA $17          ; the uninitialized byte
  PHA
  ...              ; zero $0000-$07FF, except $0100-$010F and $01C0-$01FF
  PLA
  STA $17
```

The power-on value of `$17` therefore becomes the generator's seed. `$17 & 4 = 4`, which puts it
among the zero-page bytes the FCEUX pattern sets to `$FF` and the EverDrive sets to `$00` — see [Why
The EverDrive Cannot Run It](golf-uninitialized-ram.md#why-the-everdrive-cannot-run-it). That one
byte is the entire difference. In FCEUX, zero-filled RAM with `$0017 = $FF` written at frame 1
matches the default-pattern replay at all 17 checkpoints across the movie's 16,154 frames, and the
movie still syncs with `$0017` primed under all-`$FF` and random fills.

## Why No Start Delay Helps

Golf's delay works because its seed is a frame counter, and delaying the start moves its phase.
Here the seed is the value itself. A `$00` boot and a `$FF` boot run on different orbits of the
generator from the first frame rather than one being a delayed copy of the other, and no Start delay
from 0 to 255 realigns them. `$17` alone reaches `$FF` from `$00` after 163 steps, but the shift
register must return to its starting state at the same time, which first happens about three
million steps in — roughly fourteen hours idling at the title screen — and would still leave the
game's frame counter offset by the delay.

## Stream And Settings

Generate the stream with the FM2 converter and play the per-latch `.r08`:

```sh
scripts/convert-fm2-to-tasdeck-mask.sh adelikat-playaround-rbibaseball.fm2 "RBI Baseball (U).nes"
```

R.B.I. Baseball strobes exactly twice on every polled frame, once before reading port 2 and once
before port 1, so `adelikat-playaround-rbibaseball.polls.r08` holds 31,562 records for 15,781
polled frames, with no unread latches. The file used for the verified run is byte-identical to it
(SHA-1 `5B889C08D4DAB5838BDDEAD2B2B3C408F3B41B38`).

Play it with `per strobe` sync, both ports, `Skip first` 0, and **Start delay 0** rather than the
`.r08` default of 1. On the console used for the verified run, Start delays 1, 2, and 3 were each
tried first, and the run completed at 0. That matches the
[alyosha-tas](https://github.com/alyosha-tas/NES_replay_files) corpus, which plays power-on runs at
`--blank 1` and runs that start from reset at `--blank 0`; the procedure below starts from reset.

Do not use the `.tdmask`. In `completed reads` mode the console loses port 1's B button: the runner
commands that first use it (Up+B from movie frame 1144) never register, the runner holds at first
base, and every later at-bat differs. FCEUX reproduces that failure exactly when port 1's B is read
as A. The game takes its first port 1 read 4 CPU cycles after the strobe falls and one every 17
cycles after that (about 9.5 µs apart). The same input played in `per strobe` mode reaches the
console intact.

## Verification Procedure

The steps are Golf's; see [its procedure](golf-uninitialized-ram.md#verification-procedure) for why
each one matters.

1. **Prime work RAM.** Launch Vi Grey's `nes-ram-to-fceux` from the EverDrive and hold nothing on
   the D-pad, which selects the FCEUX pattern and therefore `$0017 = $FF`.
2. **Hold Reset before touching the cartridge.**
3. **Swap in a real R.B.I. Baseball cartridge**, still holding Reset.
4. **Arm playback.** Load `adelikat-playaround-rbibaseball.polls.r08` with `per strobe` sync, both
   ports, `Skip first` 0, and Start delay 0. Press Play, wait for the upload, then press Start.
5. **Release Reset.** R.B.I. Baseball boots, and record 0 goes to its first controller read.

Either retail cartridge should work. The game shipped as a licensed gray cartridge and as Tengen's
unlicensed black cartridge; their PRG ROMs differ only in the 31-byte "LICENSED BY Nintendo of
America Inc" title text, and both sync the movie identically in FCEUX. The stream above was
generated from the gray-cartridge dump, `RBI Baseball (U).nes`, SHA-1
`A69BC8AC50ECECB005E36E94862795F69BA33545`.

## If A Boot Fails

A failure at the first pitch means the primed `$0017` did not survive the swap; repeat the
procedure from step 1.

The movie is also sensitive to boot timing, independently of RAM. In FCEUX, starting the reset
handler 6 or 14 CPU cycles late desyncs it around record 2,000–3,000, and 8 or 16 cycles late around
record 4,000–5,000. A failure in either range with everything else correct is a reason to reboot, not
to change settings.

## Legitimacy

The verified run uses a retail cartridge, the unmodified ROM, and the converter's unmodified
stream. As with Golf, the only departure from a plain cold boot is that work RAM was initialized to
the FCEUX and BizHawk default pattern, and the accurate claim is "verified on original hardware with
work RAM initialized to the FCEUX and BizHawk default pattern."

A seven-byte ROM patch that stores `$FF` to `$0017` before jumping to the original reset handler
lets the movie sync from the EverDrive's zero fill in FCEUX. It changes game code, so it is a way to
rehearse the run, not to verify it.
