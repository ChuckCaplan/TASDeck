# Battletoads

Battletoads is TASDeck's worked example of power-on-phase failures and of an ACE run decided by
console hardware rather than by the replay device. This folder holds the write-ups and the
Battletoads-specific tools.

## Status (2026-09-25)

Original cartridge, front-loading NES, two ports, per-strobe, Skip first 0:

| Movie | Result | Settings |
| --- | --- | --- |
| Warpless (`battletoads_2p.r08`) | Beaten, unmodified, 2026-09-24 | Start delay 1, watcher-GOOD boot |
| Warps (`battletoads_2p_warp.r08`) | Beaten, unmodified, 2026-09-24 | Start delay 1, watcher-GOOD boot |
| Game-end glitch (`Battletoads_GEG.r08`, 3528M) | Unmodified file lands on the Dark Queen on every GOOD boot; won with `+tail1830R` (one press after the last record), which is not a clean verification | Start delay 4 |

On this console a CPU write stays on the open bus, so the game-end glitch's open-bus slide misses
the ending. Alyosha's 2021 verification reached it because of an open-bus quirk his hardware has and
this console lacks. The next test for the unmodified file is a different NES. See
[Alyosha's Win](real-cartridge.md#alyoshas-win-an-open-bus-quirk-of-his-hardware).

On the EverDrive N8 Pro all three movies were beaten with the patched
`Battletoads (TASDeck sync v5).nes`, which is also not a clean verification.

Procedure for cartridge attempts: reset the Arduino, arm, then power the NES on from cold, and play
out only boots the watcher calls GOOD.

## Contents

| Path | What it is |
| --- | --- |
| [real-cartridge.md](real-cartridge.md) | Main write-up: original-cartridge runs, the boot-timing model, the open-bus analysis of the game-end glitch, and how to rebuild the research harnesses |
| [everdrive-open-bus.md](everdrive-open-bus.md) | The EverDrive N8 Pro's `$6000-7FFF` work-RAM problem and the patched ROMs |
| `tools/watch-boot.js` | Follows `logs/trace/boot-timing.log` and prints a GOOD / BAD / MAYBE / OFF-MODEL verdict for each boot: `node docs/design/battletoads/tools/watch-boot.js` |
| `tools/hunt-boot.js` | Power-cycles the NES through a TP-Link Kasa smart plug until the watcher accepts a boot, then lets it play out; needs `--plug HOST` or `TASDECK_PLUG_HOST` |
| `tools/patch-startup.js`, `rom-patches/` | Builds the EverDrive open-bus-preload ROM (v2) from your own USA ROM |
| [boot-timing-test/](boot-timing-test/README.md) | Test ROM that checks TASDeck's `Boot timing` numbers against reads timed by the NES |
| [input-test/](input-test/README.md) | Test ROM that checks what the NES receives, using Battletoads' controller-read loop |
| `tests/` | Tests for the tools; `npm test` runs them |

ROMs, `.r08` files and the BizHawk research harnesses under `logs/research/` are not in the
repository.
