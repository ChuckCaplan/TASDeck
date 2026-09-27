# Super Mario Bros. 2 Game-End Glitch

[7280M](https://tasvideos.org/7280M) (dillthepill08, BizHawk 2.11.1 SubNESHawk, PRG0) finishes the
game in 11.6 seconds by executing controller input as code. Alyosha verified it on a cartridge, and
its per-strobe dump is `Super_Mario_Bros_2_GEG.r08` in the
[alyosha-tas](https://github.com/alyosha-tas/NES_replay_files) corpus. That dump is exactly the latched
rows of the movie: `npm run bk2 -- convert` on the movie writes the same file byte for byte. On
TASDeck it reached the payload but ended on the pause screen. Replaying it headless in BizHawk (see
[Headless BizHawk Harness](../../design/bizhawk-harness.md)) found three causes, each fixed in
firmware v77.

## Status

The game-end glitch was beaten on the console with firmware v77 and `Start delay 1` from the
EverDrive menu: on 2026-09-26 with the guarded file and both settings below, and on 2026-09-27 with
the published file unchanged and `BRIDGE_TAS_OVERREAD=pressed` alone, on the first launch.

| File | Settings | BizHawk result | Hardware |
| --- | --- | --- | --- |
| `Super_Mario_Bros_2_GEG.r08` (corpus, 1730 records) | v76 defaults | Pause screen | Pause screen, every run |
| same | `BRIDGE_TAS_OVERREAD=pressed` | Ending on 16 of 40 simulated EverDrive launches | Won (EverDrive, Start delay 1, first launch) |
| [`Super_Mario_Bros_2_GEG.guarded.r08`](Super_Mario_Bros_2_GEG.guarded.r08) (1052 records) | `BRIDGE_TAS_OVERREAD=pressed BRIDGE_TAS_GUARD_UNTIL=677` | Ending on 40 of 40 launches and 100 of 100 DMC phases | Won (EverDrive, Start delay 1) |

SHA-256: corpus file `8f7e271d5c6ec587fd0838790b095799adf020d7d16ac8442a8103a27324dcd6`, guarded file
`c86f3496273b098ac860cafa7f40411ed94816a54bb5e56a91c9a9c350eceb7b`. July's traces are consistent with
this: with the old `released` over-read the payload exits all fell on the right records and the game
still paused, and whether the level-1 pickup worked varied from run to run.

## Reads Past The Eighth Clock

SMB2 reads the controllers until two consecutive port-1 reads agree. The payload jumps back into
that loop in the middle, without a new strobe, after records 1653, 1725 and 1727, and clocks three
more bits on port 1 and four on port 2. Those bits rotate into `$F5`/`$F6`, which the payload later
executes (the author's chain is `$00` → `$36` → `$F6` → `$E956`, the ending setup). A real controller
shifts in pressed bits, and BizHawk models that:

| Over-read level | BizHawk result |
| --- | --- |
| Pressed (a real controller) | Ending |
| Released (TAStm32 without `--overread`) | Pause screen |
| TASDeck's default (the next record's A) | Pause screen |

Start the bridge with `BRIDGE_TAS_OVERREAD=pressed`. See
[Reads Past The Eighth Clock](../../hardware-tas-workflow.md#reads-past-the-eighth-clock).

## DMC Phase

SMB2 plays DPCM samples, and a DMC fetch that lands on a controller read makes the game read again.
Where those collisions fall depends on the DMC timer's phase when the game starts. A cartridge
power-on starts it from a fixed state. An EverDrive menu launch starts it wherever it happens to be.
Across 100 starting phases, 53 reach the ending with the plain dump; the losers take an extra read
near frame 530 that spends one record too many and shifts every record after it. Across 40
simulated EverDrive launches (warm start at a random point in the frame, EverDrive RAM image), 16
win.

The guard removes this. Records 0-1354 are ordinary play, two reads per frame. Records 1355-1729 are
the payload, where every read carries a different bit.
[`tools/guard-r08.js`](tools/guard-r08.js) collapses the first part to one record per frame, keeping
the read the game settles on, and copies the payload unchanged:

```sh
node docs/games/smb2/tools/guard-r08.js Super_Mario_Bros_2_GEG.r08 1355 Super_Mario_Bros_2_GEG.guarded.r08
BRIDGE_TAS_OVERREAD=pressed BRIDGE_TAS_GUARD_UNTIL=677 npm start
```

With `TAS_GUARD_UNTIL 677`, a strobe run re-serves the current record for every strobe inside a
latch window below record 677 and advances when the window closes, then plays one record per strobe
from 677 on. The guarded file reaches the ending from 100 of 100 DMC phases and 40 of 40 simulated
launches. Both variables apply to every strobe run the bridge arms, so restart it without them
before playing another movie.

The guarded file drops only reads the game discards. Every frame keeps the value the game settles
on, and the payload is the published records. Of the 678 dropped records, the only one that differs
from its frame's kept read is record 1196 (B+Left): the movie changes to B+Right for the next two
reads, the game discards the B+Left read, and so on the console that frame reads twice instead of
three times. The published file won unchanged too, so the guard only removes the launch lottery.

## Buffer

The payload's 375 records are read in about 80 ms. The bridge keeps the firmware's record ring
about 75% full and checks it every 500 ms, so a 512-record ring ran dry before the end. v77's ring
holds 1024 records.

## Settings

Super Mario Bros. 2 (USA) PRG0, `strobe`, two ports, `Start delay 1` from the EverDrive menu. In the
emulator a delay of 0 or 1 blank before record 0 works and 2 does not; from the menu, whose launch
spends one latch, that means 1 or 2.
