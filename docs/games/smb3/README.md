# Super Mario Bros. 3 Game-End Glitch In 0.32 Seconds

[7245S](https://tasvideos.org/7245S) (100th_Coin, BizHawk 2.6.3 SubNESHawk, PRG0, console-verified by
Bigbass) reaches the credits 19 frames after power-on. It feeds a different A button to player 2 on
every read, so SMB3's read-until-two-reads-agree loop keeps spinning. Per the author's notes, the
spin lets an IRQ return to the wrong place, execution falls into RAM, and controller values the game
stored there steer it to the credits routine at `$B85A`. It needs `strobe` mode: every one of its
598 latches carries its own record.

The July 2026 `.r08` never worked. It was built by copying the bk2 row for row, and that is not a
per-latch dump.

## Status

| File | BizHawk result | Hardware |
| --- | --- | --- |
| `smb3-032-100thCoin_subneshawk-perlatch.r08` (617 records, July) | Hangs after 360 latches | Failed |
| [`smb3-032-100thCoin-latched-598.r08`](smb3-032-100thCoin-latched-598.r08) (598 records) | Credits at frame 19, latch 598 | Won on 2026-09-26: EverDrive menu launch, Start delay 1, firmware v77 |

The corrected file's SHA-256 is `10b399d690105a0508679f54d895ab3bda9be6ddf0ab6d756ee505e780bf1e33`.

## SubNESHawk Rows Are Not Latches

A SubNESHawk Input Log row ends at whichever comes first: the controller strobe's falling write or
the end of a video frame (`SubNESHawk.IEmulator.cs`, `DoFrame`). BizHawk latches the pads on the
falling write using the row current at that moment, so a row that ends at a frame boundary is never
latched by anything. The header's `VBlankCount` counts exactly those rows.

This movie has 617 rows: 598 latches and 19 frame rows (rows 0-10, 114, 237, 360, 365, 476, 481, 486
and 612, all blank). The first latch uses row 11. Played as records, the frame rows put a blank on
the first 11 latches and then shift the payload by one more latch at every later frame edge. The
alternating A bits then line up as matching pairs, the read loop exits early, and the game goes
elsewhere. The bare strobes and kind-2 anomalies seen on hardware in July were that wrong path, not
a serving fault: the corrected run makes no bare strobes at all (582 port-2 reads and 15 port-1
reads, every one eight clocks).

Converting any SubNESHawk movie needs an emulator pass that records which rows were latched; see
[Headless BizHawk Harness](../../design/bizhawk-harness.md).

## Emulator Results

Replayed one record per latch on BizHawk 2.6.3's NES core:

- All 324 modeled power-on states win (start-up offset -12 to 14, `idleSynch`, CPU/PPU phase, DMC
  timer parity).
- Random RAM, all-`$FF` RAM, the EverDrive's loader RAM image, a front-loader Reset, and an
  EverDrive-style launch (jump to the reset vector at any point in the frame, PPU left running) all
  win. SMB3 clears the RAM it uses.
- One extra or one missing latch before record 0 fails. Start delay is the only setting that matters.
- Latches are at least 120 µs apart, well inside TASDeck's strobe budget.

## PRG0 And PRG1

The movie was made on PRG0: TASVideos lists "(U) (PRG0) [!]", and the bk2's SHA-1 is the PRG0 file
even though its game name says PRG1. PRG1 moves the fixed bank's code by 7 bytes, but the glitch runs
through RAM and the switchable banks only. The corrected file reaches the credits on PRG1 in all 324
power-on states too, so a PRG1 cartridge is a valid target.

## Buffer

The console spends all 598 records in about 8 frames (130 ms). The bridge keeps the firmware's
record ring about 75% full and checks it every 500 ms, so firmware before v77, whose ring holds 512
records, runs dry around record 430 whatever the file. v77's ring holds 1024: the bridge sends all
598 records within about half a second of `Start`, so press `Start`, wait a second, then power on or
launch.

## Settings

`strobe`, two ports, `Skip first` 0, firmware v77 or newer. Start delay 1 from the EverDrive menu
or from a cartridge power-on, then 0, then 2; 0 from a held-Reset cartridge swap. A win shows the
Mario and Peach ending within a second.
