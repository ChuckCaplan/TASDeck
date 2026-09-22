# Battletoads On The EverDrive N8 Pro

Status: **one reported animated game-end-glitch ending on 2026-09-15**, using v2 variant D
(NES 2.0, 8 KiB battery-backed work RAM) from cold power-on with EverDrive auto-load. Other attempts,
including v3/v4 and both long R08 movies, have failed. Battletoads playback on this setup remains
unresolved. The v2 result establishes that this patched ROM can reach the ending; it does not prove
that the RAM declaration caused the success or that the patch reliably fixes the hardware failure.
See [Checking The EverDrive's RAM](#checking-the-everdrives-ram) and
[What v2 Does Not Address](#what-v2-does-not-address).

> **Update, 2026-09-22 — see [Battletoads On An Original Cartridge](battletoads-real-cartridge.md).**
> The game-end glitch has since been run on an original cartridge, which drives real open bus at
> `$6000-7FFF` and makes this document's patched ROMs unnecessary. Two findings there bear on this
> one. First, **the Dark Queen message-table landing is not diagnostic of the N8's work RAM**: an
> original cartridge with genuine open bus reproduces it, so it is also a power-on alignment outcome.
> Second, the landing is decided by zero page `$75` at the exact frame the glitch fires — the byte
> `ADC $75,X` leaves on the bus to fill the slide — and not by the `JMP ($0013)` vector, which holds
> `$8006` in winning and losing runs alike. Input delivery has also been verified from the console
> side and excluded as a cause.

The three supplied R08 movies have published TASVideos console verifications:
`battletoads_2p.r08` (warpless, [4267M](https://tasvideos.org/4267M)),
`battletoads_2p_warp.r08` (warps, [4271M](https://tasvideos.org/4271M)), and `Battletoads_GEG.r08`
(game end glitch, [3528M](https://tasvideos.org/3528M)). All three play to the ending in BizHawk's
NesHawk core from the unmodified ROM. The verification video's descriptions link these exact R08
files but do not identify original cartridge versus flashcart or give retry counts. The
[replay-corpus instructions](https://github.com/alyosha-tas/NES_replay_files/blob/b1696129c45218de514ab98579449eb2020fc97b/README.md#L3-L18)
specify TAStm32, a front-loading NES, power-on, and normally `--blank 1`. The user's TAStm32 comparison
is with those published verifications, not a test of TAStm32 on this same console and EverDrive.
Only the patched game-end-glitch movie has finished on this setup so far.

In [March 2021](https://tasvideos.org/Forum/Posts/504290), before publishing these verifications,
Alyosha warned that the recent Battletoads runs worked only occasionally from power-on. His
[June 2021 startup-state update](https://tasvideos.org/Forum/Posts/506829) retained Battletoads sync
with minor initial lag adjustments. These reports support investigating startup timing; they do
not establish the cause of the current failures or a success rate for these three files.

For general playback and desync diagnosis, see [Hardware TAS Playback And
Troubleshooting](../hardware-tas-workflow.md).

## Hardware Results So Far

With the unmodified ROM, the warpless movie failed in level 1 at one of two recurring spots on most
boots. Boots that survived level 1 matched the reference encode through level 4 and then missed the
Surf City floor clip. The game-end glitch fired on the correct frame but showed the Dark Queen's
message table instead of the ending.

On 2026-09-15 the startup-synchronization patch described in [The Withdrawn v1
Patch](#the-withdrawn-v1-patch) was tested on the same console:

| Movie | Result with v1 |
| --- | --- |
| Warpless | Level 1 still desynchronized repeatedly. In the speeder-bike level (level 3) an extra small enemy that drains health appeared on more than half of the boots. Surf City's clip still did not happen. |
| Warps | Reached the climbing level and desynchronized at the Robo-Manus boss. |
| Game end glitch | Glitched without reaching the ending or the Dark Queen. |

The v2 ROM was then tested with `Battletoads_GEG.r08`. With the game's original iNES 1.0 header, one
boot desynchronized before the glitch when an extra enemy appeared, and the next reached the glitch
with the reference scores (011500 / 018500), after which the player sprite flashed, disappeared, and
the screen stayed corrupted — the same outcome as v1.

Attempts with two NES 2.0 headers and byte-identical code had different outcomes:

| Header | Result |
| --- | --- |
| NES 2.0, 8 KiB volatile work RAM | Reached "AND SO, THE DARK QUEEN IS DEFEATED ONCE AGAIN...", but the screen froze — no drifting stars, no ship |
| **NES 2.0, 8 KiB battery-backed work RAM, battery flag set (v2 D)** | **One real animated ending**, reported from cold power-on with EverDrive auto-load. Later attempts failed. |

The frozen screen is a distinct failure signature: ending text appeared without the expected
animation. Its precise CPU state was not measured. The attempts do not isolate the effect of the
battery declaration from startup variation, and the RAM probe below passes with all four headers.
The builder retains the header used for the successful attempt as an experimental baseline.

## N8 Pro Mapper Source And `$6000-7FFF`

Battletoads uses the AxROM board, which has no work RAM. On an original cartridge nothing drives the
data bus for reads from `$6000-7FFF`, so the CPU reads open bus: the last value on the bus, which
after an absolute or indirect address is normally that address's high byte.

The official N8 Pro reference source at commit `317f8caf8d2b917a260e94ec14d5edbbbfced8ba`
(2026-05-10) requests save RAM throughout that range. From
[`fpga/000/map_007.sv`](https://github.com/krikzz/edn8-pro-pub/blob/317f8caf8d2b917a260e94ec14d5edbbbfced8ba/fpga/000/map_007.sv#L33-L53):

```verilog
assign srm.ce = {cpu.addr[15:13], 13'd0} == 16'h6000;
assign mao.map_cpu_oe = int_cpu_oe | (srm.ce & srm.oe) | (prg.ce & prg.oe);
```

The mapper also requests writes, but the
[top-level gates](https://github.com/krikzz/edn8-pro-pub/blob/317f8caf8d2b917a260e94ec14d5edbbbfced8ba/fpga/base_sv/everdrive.sv#L94-L126)
can deselect SRAM with `prg_ram_off`; the configured address mask can mirror a smaller region.
When SRAM is enabled, reads and writes use that memory. When it is disabled, the mapper still
selects the memory-data path instead of the address-high-byte fallback, but that does not prove
that retained SRAM data is returned. Thus this source does not establish unconditional readable
and writable 8 KiB RAM regardless of header or configuration.

The repository describes its FPGA sources as
[examples and reference projects](https://github.com/krikzz/edn8-pro-pub#contents). Equivalence to the
installed mapper binary and the menu's header-to-configuration mapping have not been verified.
The local emulator experiment adds RAM to the original-cartridge model to test one possible
difference; it is not a complete model of the user's EverDrive.

## Where Battletoads Reads Open Bus

Logging `$6000-7FFF` reads in the successful local emulator runs of all three movies finds the
following accesses:

| Code | When | Addresses | Open-bus value | Movies |
| --- | --- | --- | --- | --- |
| Bank 5 `$84C9`/`$84E3` `LDA ($1B),Y` | Level 3 (speeder bikes), 356 reads | `$7FEB-$7FFF` | `$7F` | All three |
| Game-end glitch setup | 4 frames before the jump | `$66EB-$66EF` | `$66` | GEG |
| Game-end glitch slide | The ending jump to `$75BD` | `$75BD-$7FFF` | `$75 $75`, then `$6F` | GEG |

The level 3 reads are the level-block loader walking past the end of its table. The game-end glitch
jumps to `$75BD` and executes open bus: `$75 $75` is `ADC $75,X`, which leaves `$6F` on the bus, and
`$6F $6F $6F` (`RRA $6F6F`) repeats until the program counter reaches `$8000`, where
`JMP ($0013)` enters the ending ([TASVideos game resources](https://tasvideos.org/GameResources/NES/Battletoads#GameEnd)).
No other levels, including Surf City, read this range in those reference runs. Failed hardware runs
have not been instrumented to establish their actual accesses.

### Effect In Emulation

Adding 8 KiB of cartridge RAM to the emulated board produces outcomes resembling some hardware
failures. This does not uniquely identify their cause:

- **Game end glitch:** RAM filled with `$00` stays in level 3; `$FF` goes to a cutscene; `$EA`,
  `$75`, and `$60` also miss the ending. No single fill value imitates the slide.
- **Warpless level 3:** with `$00`, the RNG bytes `$25-$28` diverge about three seconds into level 3,
  enemy tables diverge about three seconds later, and the level never finishes. Across 71 uniform
  fill values, 27 stall level 3 and the other 44 play through Surf City with the same surfboard
  speeds as the reference. RAM contents are therefore a candidate explanation for the extra enemy,
  not a measured cause on the console.
- **Warps:** across the same 71 fill values, 19 reach the ending, 12 stall level 3, and 40 play
  Arctic Caverns and Karnath's Lair correctly and then never finish Intruder Excluder, the climbing
  level with the Robo-Manus boss. That is where the hardware run fails.

None of the tested uniform fills that passes level 3 changes Surf City. This experiment has not
explained the hardware Surf City failure.

## What v2 Changes

At reset, before the game clears its work RAM, v2 writes the open-bus bytes into `$6000-7FFF`:
every address holds its own page byte, except `$75BF-$7FEA`, which holds `$6F`. When the N8 Pro
provides enabled, sufficiently large SRAM, these writes prepare the values used by the reference
run. On an original
cartridge the writes go nowhere. The routine runs again whenever the game restarts through its reset
path.

The patch changes startup code; the TASDeck firmware and R08 files are unchanged by it. v2 differs from the original
ROM in 95 bytes, four of them in the header; file offsets include the 16-byte header:

| Bank | CPU address | File offset | Bytes | Purpose |
| ---: | --- | --- | ---: | --- |
| — | iNES header | `$00006`, `$00007`, `$0000A`, `$0000B` | 4 | NES 2.0 header: battery flag, 8 KiB battery-backed work RAM, 8 KiB CHR RAM |
| 0 | `$82C4` | `$002D4` | 4 | `LDA #$00; LDX #$17` becomes `JSR $8085; NOP` |
| 0 | `$8085` | `$00095` | 16 | Trampoline in an unused palette routine: calls bank 6 entry `$2A`, then restores `A=0`, `X=$17` |
| 6 | `$802A` | `$3003A` | 3 | Unused jump-table entry now jumps to `$FF3D` |
| 6 | `$FF3D` | `$37F4D` | 12 | Calls bank 7 `$80BC`, then restores the bank-0 return bank in `$2D` |
| 7 | `$80BC` | `$380CC` | 59 | Preload and delay, in padding after the table byte read at `$80BB` |

Both calls use the game's own bank-call helper at `$FFCB`, which is identical in every bank. Source:
[battletoads-open-bus-preload.s](../../scripts/rom-patches/battletoads-open-bus-preload.s).

### Timing

Battletoads advances its random number generator in a busy loop that the frame interrupt breaks, so
added startup time can change the whole run. The detour runs with NMI and rendering disabled, where
the NTSC PPU produces exactly 89,342 dots per frame and three frames are exactly 89,342 CPU cycles.
The preload is padded with a counted delay to exactly 178,684 cycles (six frames) more than the two
instructions it displaces.

In the tested NesHawk model, the original reset code resumes at the same PPU dot, CPU cycle parity,
and odd/even frame as the unmodified ROM, six frames later. The unmodified ROM reaches
`$82C8` at CPU cycle 57,183 (scanline 242, dot 28) and v2 at 235,867 (scanline 242, dot 28). The
same holds under every startup perturbation the harness offers: PPU step offsets 1 and 2 and CPU
parity 1. Editing any instruction in the preload changes the cycle count and must be re-measured.

## Build And Test

Build from the repository root with your own copy of the ROM:

```sh
node scripts/patch-battletoads-startup.js \
  "/path/to/Battletoads (USA).nes" \
  "/path/to/Battletoads (USA) - TASDeck open bus v2.nes"
```

The script requires source SHA1 `5c3a497a82be60704dedf45248b6ad9b32c855ab`, refuses to overwrite an
existing output, and prints a JSON manifest of every replacement. Output SHA256:
`ad7e445e19c71b6f4ffa2b126bf9884a9ca074c366f2efe5a3be6c5c9f2932a8`.

To check the builder against your ROM:

```sh
BATTLETOADS_TEST_ROM="/path/to/Battletoads (USA).nes" \
  node --test apps/web/tests/patch-battletoads-startup.test.js
```

The reported successful attempt used **cold power-on with EverDrive auto-load**, not launching the
game and then releasing NES Reset. Keep those procedures distinct in run records; they are not
established as equivalent. The investigation's replay settings are **two ports, per-strobe mode,
Start delay 1, Skip first 0**, with continuous trace capture off. Arm before the game's polls begin
and keep menu-navigation polls out of the replay.

For `Battletoads_GEG.r08`, success requires the ending text beginning "AND SO, THE DARK QUEEN IS
DEFEATED" **with drifting stars and a ship crossing the screen**. A frozen ending screen does not
pass. Record the exact ROM variant, cold-power/reset procedure and first divergence for each attempt.
The long movies have not completed on hardware; removing the extra level-3 enemy on every boot is
an unverified target, not a promised result of v2.

The next diagnostic is the [NES-side input delivery test](../../scripts/battletoads-input-test/README.md).
It uses Battletoads' exact controller-read loop and compares the NES's received bytes with 8,196
expected two-port records. It stops on the first mismatch and displays the record and both ports'
expected/received bytes. Existing Arduino traces sample the output at different times and cannot
supply that proof. The diagnostic has emulator validation with deliberate input faults; no physical
NES comparator result is available yet. This test is a receiver diagnostic, not a game fix or console
verification of a movie.

### Trace Evidence And Capture Corrections

The September 15 GEG capture at 17:37 reports all 1,822 records consumed without a buffer error,
but its retained rows are after movie completion. Other captures mostly preserve startup records
0–119. The 20:04 warp capture contains correct ordinary reads through record 1321 followed by a
142.3-second gap and short reads unlike the game's normal routine. Those later anomalies cannot be
assigned to the original desync without console context. None of these logs proves what the NES
sampled at the first divergence, and they do not identify which patched ROM was running.

The bridge capture code now retains the requested initial start delay and firmware identity across
compact chunk acknowledgements. Missing bare/torn diagnostics are left blank instead of printed as
zero; old diagnostic counters are not retained as if they were current. These changes improve the
evidence and do not alter controller playback. Restart the bridge to use the updated capture code;
no firmware upload is needed for these changes. Record ROM hash/variant and boot procedure alongside
the next game capture.

## Checking The EverDrive's RAM

The preload assumes writable RAM at `$6000-7FFF` with enough distinct addresses to retain its
pattern. The reference FPGA derives its address mask from `prg_mask[7:4]` and can disable SRAM
with `prg_ram_off`
([configuration source](https://github.com/krikzz/edn8-pro-pub/blob/317f8caf8d2b917a260e94ec14d5edbbbfced8ba/fpga/base_sv/sys_cfg.sv#L14-L54)).
The installed menu's handling of the original iNES header and the experimental NES 2.0 headers is
not established. With 128 bytes or 2 KiB mirrored, v2's game-end glitch fails in the emulator;
with 4 KiB it still reaches the ending. These are model results, not measurements of the cartridge.

A diagnostic build replaces the preload with a probe that writes `$A5` to `$6000`, `$3C` to `$7000`,
and `$C3` to `$7FFF`, writes `$00` to `$6001` to change the bus, reads back, and fills the screen
with a palette color: green for 8 KiB, yellow when `$6000` was overwritten through a mirror of 4 KiB
or less, and red when `$7FFF` did not keep its value. In NesHawk it shows red with open bus, green
with 8 KiB, and yellow with 4 KiB and 128-byte mirrors. It was built with four headers: unchanged;
battery flag; NES 2.0 with 8 KiB work RAM (`$07` in byte 10); and NES 2.0 with 8 KiB battery RAM.

**On the console all four showed green.** That confirms the tested writes/readbacks and excludes
the simple mirrors exercised by the probe; it does not check all 8,192 addresses or retention
through a later reset or loader action. Only v2 D has produced a reported animated ending. A
header effect, RAM handling and startup variation remain separate hypotheses; these few attempts
do not identify which matters. The diagnostic builds are staged next to the ROM and are not
produced by the repository script.

## Validation

NesHawk (BizHawk 2.5.2, headless, both ports `ControllerNES`) replaying the unmodified R08 files.
"Open bus" is the original-cartridge model. "N8 model" is an experimental model that adds 8 KiB of
cartridge RAM filled with random bytes and assumes a cleared zero page. It does not reproduce a
verified trace of the installed loader. Each
v2 run is compared with the unmodified ROM's reference run, shifted by six frames:

| Movie | Cartridge model | Result |
| --- | --- | --- |
| Game end glitch | Open bus | All 2,048 RAM bytes identical at all 4,015 latches; inputs and ending image identical |
| Game end glitch | N8 model | Identical up to the glitch at record 2,397, then reaches the same ending text one frame earlier; zero-filled and random initial RAM give identical runs |
| Warps | Open bus | All RAM identical at all 36,777 latches; inputs and ending image identical |
| Warps | N8 model | Same, apart from the zero page's initial `$FD-$FF` |
| Warpless | Open bus | All RAM identical at all 68,264 latches; inputs and ending image identical |
| Warpless | N8 model | Same, apart from the zero page's initial `$FD-$FF` |

The one difference in the N8 model is expected: the slide's `RRA $6F6F` writes land in the modeled
RAM, and `$7FEB-$7FFF` hold `$7F` for level 3 rather than the slide's `$6F`.

These results validate v2 under those model assumptions. They do not validate the physical
console's timing, the installed mapper/configuration, or the controller bytes sampled by the NES.

## Remaining Failures And The v3/v4 Experiments

The user reports one animated ending with v2 D and failures on other attempts. This is not a
controlled success-rate measurement. Across six startup timings in the harness, v2 gives one
ending, one Dark Queen portrait, and other stalled outcomes. Similar symptoms make startup timing
a candidate, but do not prove that CPU/PPU alignment causes the current hardware failures or
exclude replay-device timing.

Two experimental ROMs tried to remove it, both built locally rather than by the repository script
(`logs/research/battletoads-2026-09-15/v3/` and `v4/`):

- **v3** adds v1's synchronizer back on top of v2's preload, entered through the game's own two
  VBlank waits so it starts at the phase it was designed for, with v2's fixed delay removed. In the
  harness it converges all six timings to scanline 242 / dot 28 / odd frame but not to one CPU
  parity; the glitch succeeds on two of six timings instead of one.
- **v4** adds two dot skips ahead of that. Enabling rendering across two frames spans exactly one
  odd frame, whose pre-render line is one dot short. This changes the modeled frame phase; it does
  not establish control over the physical CPU/PPU master-clock dividers. **In the harness**, all six
  timings reach the glitch's ending, and all six play byte-identically to the cartridge reference at
  every latch for all three movies (2,397, 36,777 and 68,264 rows).

**Both v3 and v4 have failed on hardware**; a v4 attempt reached the glitch and froze. Model
convergence therefore has not produced a reliable hardware fix. The NES-side input comparator is
the next investigation step, rather than further unmeasured startup variants. Preserve v2 D as the
variant associated with one reported success, not as a proven solution.

## What v2 Does Not Address

- **Level 1 desyncs.** The reference emulator run has no level-1 reads from `$6000-7FFF`. The
  recurring hardware failures remain unexplained.
- **Surf City.** The reference has no reads from that range in Surf City, and no tested level-3
  uniform fill that survives level 3 changes the surfboard physics. The hardware runs that reached Surf City matched the reference encode's
  scores, health, and timing and then bounced off the river floor where the reference clips through.

A comparison on an original cartridge could help isolate flashcart effects. No such comparison,
or TAStm32 comparison on this same setup, has been performed in this investigation.

## The Withdrawn v1 Patch

`battletoads-startup-sync-v1` (SHA256
`052cb0cc77b723503a8cc392fe69575244b647bcb56e235b956b8780c988320c`) inserted an adaptation of
[Shay Green's NTSC NMI synchronization](https://github.com/christopherpow/nes-test-roms/blob/master/nmi_sync/nmi_sync.s)
into the same reset hook, intending to make startup timing identical on every boot. It reached the
ending of all three movies in NesHawk, but that validation disabled cartridge RAM, so it did not
model the N8 Pro. It failed on hardware as described above and was withdrawn for two reasons:

- In the tested NesHawk model, the sampled startup perturbations of the unmodified ROM stall in
  level 1. That model result does not establish the internal startup state of hardware runs that
  reached Surf City, nor prove which hardware differences v1 could address.
- The routine does not control CPU cycle parity. Entering it a few frames later lands on the same
  scanline and dot with the opposite parity on some starts, and those runs diverge from the first
  controller read.

v2 keeps v1's reset hook, trampoline, and jump-table entry, and replaces the synchronizer with the
fixed-length preload. The v1 assembly and harness are preserved locally in
`logs/research/battletoads-2026-09-15/`.

## Primary References

- [EverDrive N8 Pro FPGA reference sources, pinned snapshot](https://github.com/krikzz/edn8-pro-pub/tree/317f8caf8d2b917a260e94ec14d5edbbbfced8ba/fpga)
- Verification descriptions: [warpless](https://www.youtube.com/watch?v=qn-upaQctSg), [warps](https://www.youtube.com/watch?v=QlbwNH_lyO4), [game end glitch](https://www.youtube.com/watch?v=X6sR4F6kBnI)
- [Alyosha's power-on/retry caveat](https://tasvideos.org/Forum/Posts/504290) and [NesHawk startup update](https://tasvideos.org/Forum/Posts/506829)
- [Battletoads disassembly](https://github.com/feos-tas/DisAssemble/tree/f1a43b69577246850d136473700a333b3cdfe93f/Battletoads)
- [Battletoads game resources, game end glitch](https://tasvideos.org/GameResources/NES/Battletoads#GameEnd)
- [Warpless author's Surf City explanation](https://tasvideos.org/6758S#Level5SurfCity)
- [NTSC PPU frame timing](https://www.nesdev.org/wiki/PPU_frame_timing)
- Local evidence: `logs/research/battletoads-2026-09-15/n8-cartridge-ram/`
