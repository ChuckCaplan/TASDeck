# Boot Timing Test ROM

`build.py` makes an NROM test ROM that checks TASDeck's `Boot timing` log line against timing the
NES itself controls. After reset it waits about a second, then performs 20 two-port controller reads
with Battletoads' read routine, with rendering and interrupts off, separated by cycle-counted delays.
The screen then lists the gaps TASDeck should report.

```sh
python3 docs/design/battletoads/boot-timing-test/build.py <output-dir>
```

The output directory gets `TASDeck boot timing test.nes`, a 64-record blank
`boot_timing_test.r08`, and `manifest.json` with the schedule and hashes.

The default schedule is the first 19 latch gaps of Battletoads' game-end-glitch movie on NesHawk's
default power-on state, the state Alyosha dumped it with, so a correct capture reads like a winning
Battletoads boot: 12.99 / 11.04 / 13.95 title gaps and a gap 7 − gap 6 of +306 cycles.

## Use

1. Run `node docs/design/battletoads/tools/watch-boot.js` in a terminal.
2. Load `boot_timing_test.r08` with two ports, per-strobe, **Start delay 6**, Skip first 0, and arm.
3. Power on the test ROM the same way you launch a movie.
4. About 20 seconds later the watcher prints PASS or FAIL for the capture.

Gap 1 runs from the console's power-on latch to the ROM's first read and is not comparable. The
logged cycles use a fixed correction for the UNO R4's clock, which drifts by a few hundred ppm from
boot to boot, so the watcher does not compare them to the screen directly. It fits
`measured = k × (expected + offset)` over gaps 2-15, which measures the clock scale `k` and any fixed
per-gap offset instead of assuming them, then checks each gap. Start delay 6 puts the gap from the
last delay latch to the first playback latch on a single-frame gap (gap 6), which the watcher reports
separately: firmware before v76 stamps that latch about 13 µs late and FAILs it by +20-34 cycles.
Start delay 1 hides that gap inside gap 1.

What a PASS cannot rule out: an offset common to every latch (it cancels in every gap, so nothing
that compares gaps can be affected by it), effects below the 1 µs (about 1.8-cycle) resolution of
`micros()`, and anything specific to how a real game runs on the console.

The schedule is exact in the 2021 NesHawk reference: all 19 gaps match to the cycle.
