# Battletoads input delivery test

This is a standalone NES test ROM with a matching R08. It checks what the **NES receives** from
TASDeck. It does not patch Battletoads, fix its random number generator, or verify a game movie.
The test needs the normal TASDeck firmware, not the forced-A diagnostic firmware.

## Run on the NES

1. Copy `Battletoads input test.nes` to the EverDrive and launch it. Leave TASDeck stopped while
   navigating the menu. The television should show **STATE WAIT**.
2. Load `battletoads_input_test.r08` in TASDeck. Use **two ports**, **per-strobe mode**,
   **Start delay 1**, **Skip first 0**. Keep continuous trace streaming off.
3. Start playback while the test ROM is already showing WAIT. **Do not reset the NES.** This test
   has a synchronization marker, so it does not need the game's precise boot/arm procedure.
4. After about **2 minutes 18 seconds**, expect **STATE PASS**, **INDEX 2004**. All numbers on the
   screen are hexadecimal. PASS means 8,196 consecutive two-port records matched.
5. On **FAIL**, leave the screen intact and note **INDEX, WANT, GOT, PRE**. WANT/GOT list P1 then
   P2, in raw R08 bit order (`80` = A, `01` = Right). INDEX is the first bad record within the
   checked sequence; add hexadecimal `40` (64 decimal) for its zero-based R08 file record.
   Press TASDeck **Trace** before cancelling playback to preserve supporting bridge evidence.
6. If it stays at **WAIT** after playback finishes, the marker was not received; that is **not a
   pass**. Record the screen and settings. If it stays at RUN, record its index and elapsed time.

`PRE` is the number of polls before the first marker was recognized, including the waiting time
before arming. It is not a count of dropped movie records. The expected replay contains 64 initial
blank records followed by the marker and test sequence. Recognition of the first marker pair locks
alignment; every later pair, including the rest of the marker, is checked. There is no resync after
an error. A corrupt first marker can leave the test waiting, so WAIT is inconclusive.

## What a result means

- **FAIL:** the receiver did not see the expected stream. The position and byte difference let us
  investigate first-bit timing, later bits, port wiring, record alignment or buffer interruption.
  A failure alone does not identify which of those caused it.
- **PASS:** the input path worked for these masks and timing conditions. It does not prove that
  Battletoads' complete startup, interrupts, RNG, cartridge behavior or long runs will match.

The ROM uses the same controller-read instructions at `$8D78-$8D91` as Battletoads, reading both
ports with the same strobe width, bit order, spacing and branch placement. It polls once per frame,
performs sprite DMA before each poll, and varies the poll's position in the frame. A minimal NMI handler only increments a frame counter; it does not reproduce Battletoads' NMI
handler. It does not use DPCM audio, cartridge RAM or Battletoads game code. Its rendering uses CHR ROM on NROM;
this is deliberately independent of the mapper-7 work-RAM question.

The sequence covers changing A bits, walking bits, complements, alternating `55/AA` and a
deterministic two-port pseudorandom stream, across enough records to require bridge refills.

## Build

Python 3 and the existing cc65 tools (`ca65`, `ld65`) are required. No commercial ROM is needed.
From the repository root:

```sh
python3 docs/design/battletoads/input-test/build.py /tmp/battletoads-input-test
```

Output: the ROM, replay, and SHA256 manifest. Rebuilding replaces those diagnostic output files;
use a dedicated directory. The builder asserts the serial-read instruction bytes and expected-data
placement. A clean emulator pass and deliberately corrupted-port/record tests validate the comparator;
physical NES testing is still needed to measure TASDeck's electrical delivery.

Validation: two complete clean emulator runs and seven deliberate fault cases gave the expected
results; a missing-marker case stayed WAIT. The exact failure index and displayed bytes were
checked, and the ROM/replay hashes reproduced on a second build.

The September 2026 development harness, since deleted, recorded final NES RAM and asserted the
pass/fail state, exact failure index, and displayed expected/received bytes using a local NesHawk
2.5.2 headless build. That harness supplied ideal digital controller values; it could not simulate
Arduino interrupt latency or the electrical signals at the console port.
