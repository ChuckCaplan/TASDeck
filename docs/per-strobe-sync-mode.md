# Per-strobe sync mode specification

Status: final requirements — approved for implementation, v1. Not yet implemented.
Date: 2026-07-15

This document is self-contained implementation requirements. The normative content is the
"Implementation requirements" checklist and the "Firmware design" contracts; the other sections
carry the evidence and rationale behind them. Anything listed under "Future work" is explicitly
out of scope for this implementation.

## Summary

Add a third TAS synchronization mode, `strobe`, in which the firmware consumes exactly one input
record per accepted NES latch (strobe) edge, with no latch-window coalescing and no completed-read
gating. This is the default playback semantic of the TAStm32 replay device — the device against
which every `.r08` in the console-verified replay library was produced and verified. TASDeck's two
existing modes (`poll` and `latch`) both group strobe edges into latch windows and advance at most
one record per window, so they cannot faithfully play any run whose game latches the controller
more than once per frame and consumes each read.

## Implementation requirements (normative checklist)

Every item is testable and must hold at completion. File and line references describe the code as
of 2026-07-15; re-locate by content if lines have drifted.

Firmware — protocol (`NesDeckProtocol.*`):

- **R1** `TasSyncMode::Strobe` exists; `parseCommand` accepts `TAS_BEGIN <frames> strobe [ports]
  [window_us]`; unknown mode tokens are still rejected; `tasSyncModeName(Strobe)` returns
  `"strobe"`. `window_us` parsing and range validation are byte-for-byte unchanged (the value is
  simply unused in strobe mode).
- **R2** The startup banner protocol string (`uno_r4_wifi.ino:257`) lists `poll|latch|strobe`.

Firmware — playback (`NesTasPlayback.*`):

- **R3** `begin()` accepts `Strobe` with validation otherwise identical to today.
- **R4** In strobe mode `onLatchEdge()` implements the contract in "Strobe-mode onLatchEdge
  contract" below: every call is a playback event; no time comparison; no poll gating;
  `preAdvanced_` never participates.
- **R5** In strobe mode `windowExpiryDue()` returns false and `onWindowExpired()` never consumes a
  record nor sets `preAdvanced_` — the 1 kHz timer and loop service cannot advance playback.
- **R6** In strobe mode `willAdvanceOnEdge()` returns true iff
  `active() && (started_ || (startRequested_ && readyToStart() && startDelayRemaining_ == 0))`.
- **R7** The start delay decrements exactly once per accepted edge (bare, torn, or full read), and
  record 0 is served on the first accepted edge after it reaches zero. Total edges to complete a
  run = delay + totalFrames.
- **R8** `noteLatchObserved()` and `notePollCompleted()` have no effect on strobe-mode advancement
  (callers need not be changed; the strobe branch must not read `pollCompletedInWindow_`).
- **R9** `Complete` and `Underrun` behave exactly as in windowed modes: masks zeroed, staged masks
  zeroed, error latched (`Underrun`), `active()` false afterwards.
- **R10** `stagedNextMasks()` points at the record the next accepted edge will serve at every
  point in the run — after arming, during the delay, after each advance, and at end of stream
  (zeros).

Firmware — sketch (`uno_r4_wifi.ino`):

- **R11** `handleLatchEdge` treats every edge as window-opening in strobe mode via an explicit
  mode check (`sameHardwareWindow` computed false when `tasPlayback.syncMode() == Strobe`). Do
  **not** implement this as "window = 0": the signed backwards-step guard
  (`latchWithinCurrentWindow`) must never see a zero window, or a transient negative gap would
  coalesce edges.
- **R12** Both clock ISRs (`handlePort1Clock`, `handlePort2Clock`): after the 8th shift, when
  `syncMode() == Strobe && willAdvanceOnEdge()`, the data line pre-positions bit 0 of the staged
  next mask for that port instead of the current pressed mask's bit 0. Windowed-mode behavior is
  unchanged.
- **R13** When `TAS_START` is accepted with delay 0 and playback has not started, the staged
  frame-0 first-bit levels are written to both data pins from command context, with interrupts
  briefly masked (mirror the `serviceTasWindowExpiry` pattern).
- **R14** In strobe mode one **additional** trace row is recorded per accepted strobe at edge
  time, while `started() || startDelayRemaining() > 0`: result = `lastWindowResult()`, frame =
  `currentFrame()`, port = 1, latched mask = the served port-1 mask, clocked mask = the previous
  read's reconstruction snapshot at edge entry, diag kind = the edge kind. Existing completed-poll
  rows (both ports) are retained unchanged, so analysis filters rows by kind. Ring format,
  `TAS_TRACE` paging, and the bridge continuous stream are unchanged.
- **R15** Two new anomaly counters, `bare_strobe` (previous inter-strobe interval contained zero
  clocks on the clocked port) and `torn_strobe` (previous read ended at shift index 1–7), detected
  at edge entry from the existing clocks-since-latch / shift-index state, counted only in strobe
  mode with TAS output enabled. They append to the existing anomaly-code space and surface through
  the existing status/trace paths. Diagnostics only — they never block advancement.
- **R16** The existing `line_mismatch` instrumentation applies unchanged to strobe-mode served
  edges (`Started`/`AdvancedAtEdge` kinds).
- **R17** The firmware version identifier is bumped.

Web and bridge:

- **R18** `tas.js`: `HARDWARE_TAS_SYNC_MODES = ["poll", "latch", "strobe"]`. The r08 parse default
  remains `"poll"` at land time; it flips to `"strobe"` only in rollout phase 4, as a separate
  change after hardware validation.
- **R19** `index.html`: the `#syncMode` picker gains
  `<option value="strobe">per strobe (r08 replay)</option>`; the picker remains visible only for
  `.r08` loads.
- **R20** `app.js`: the two hardcoded mode ternaries (`app.js:1051`, `app.js:1931`) are replaced
  with validation against the shared mode list from `tas.js`.
- **R21** `bridge-server.js`: accepts and threads `"strobe"`; the "must be poll or latch" error
  text (`bridge-server.js:382`) is updated.
- **R22** `.tdmask` uploads remain poll-mode-only; no picker is shown for them (unchanged).

Tests (all green via `npm run check`):

- **R23–R26** as enumerated in the Tests section. No existing test may be weakened or deleted;
  windowed-mode behavior must be covered by the untouched existing suite.

Docs:

- **R27** Updated: AGENTS.md (protocol grammar, TAS-playback section, and the manual-QA bullet
  describing the r08 picker), `firmware/uno_r4_wifi/README.md` command table,
  `docs/hardware-tas-workflow.md` (mode-selection table from this spec, `--blank N` ↔
  `Start delay N` mapping), README.md one-line mention.

Constraints (binding, from AGENTS.md and the firmware's concurrency design):

- **C1** `NesDeckProtocol.*`, `NesTasPlayback.*`, `NesControllerState.*` stay free of Arduino
  APIs — host-testable.
- **C2** Nothing on the serial/command path may mask interrupts long enough to delay the NES pin
  ISRs. The playback ring stays single-producer/single-consumer with free-running indices; status
  snapshots read fields without `noInterrupts()`.
- **C3** Latch ISR strictly higher priority than clock ISRs (unchanged).
- **C4** Web app stays dependency-free; transport boundary and existing event shapes preserved.
- **C5** Small, direct changes in existing files; match surrounding style; no new modules.

Out of scope for this implementation (see Future work): latch-train resync, bk2→r08 dump script,
overread flag, mid-run mode transitions, clock filter, TD2P granularity header flag.

Definition of done (code phase / rollout phase 1): all R-items implemented; `npm run check` green
(web tests, firmware host tests, ESLint, Arduino compile for `arduino:renesas_uno:unor4wifi`);
zero behavioral change to poll/latch modes; diff confined to the files named above plus tests and
docs. Phases 2–4 (hardware validation, default flip) are gated manual steps, not part of the code
deliverable.

## Motivation and evidence

Golf (USA), `Golf.r08` (console-verified, alyosha's NES_replay_files, TAStm32 `--blank 1`,
front-loader, power-on):

- The `.r08` contains **1971** records; the NesHawk-exported `.tdmask` for the same movie contains
  **1953** records (one per non-lag frame).
- A sequence alignment of the two streams shows the difference is exactly **18 inserted records**,
  every one a duplicated `A`-press byte (`0x01, 0x01` in the r08 where the tdmask has a single
  `0x01`), distributed across the run — one per swing.
- Golf therefore strobes the controller **twice on each swing frame** and acts on both reads. The
  verified stream requires two records to be consumed on those frames. Under either existing
  TASDeck mode the second strobe lands inside the latch window (minimum 500 µs, default 8 ms),
  re-serves the same record, and playback is permanently one record out of position from the first
  swing onward.

More broadly: every `.r08` in the library encodes *per-latch* semantics. Playing them under a
windowed mode reinterprets them under a model they were never verified against. Games that latch
once per polled frame happen to behave identically under both models, which is why SMB1
maximum-score and Donkey Kong r08 runs already pass — but the equivalence is accidental, not
guaranteed. Strobe mode makes TASDeck's r08 playback semantics match the device the files were
made for.

## Semantics

When a TAS run is begun with sync mode `strobe`:

1. Every accepted rising edge on the shared latch line (D2) is a distinct playback event. There is
   no latch window and no notion of "same console frame".
2. Once playback has started, each accepted edge consumes exactly one record and serves it to both
   controller ports (`TasFrameMasks` carries port 1 and port 2 together, matching the two bytes per
   record in an `.r08`).
3. Completed 8-clock reads do **not** gate advancement. Bare strobes (no clocks) and torn reads
   (1–7 clocks) each still consume one record. This matches TAStm32, whose default mode advances on
   the latch edge regardless of how many bits the console clocks out.
4. `TAS_START <delay>` consumes the first `<delay>` accepted edges while serving released input
   (all buttons up), then serves record 0 on the next edge. This maps 1:1 to TAStm32 `--blank N`.
5. The run completes when the final record has been served; a strobe after the last record releases
   all input, exactly as the windowed modes do today.

Mode selection guidance (user-facing):

| Source data | Mode |
| --- | --- |
| `.tdmask` from FCEUX/BizHawk export (lag-stripped, one record per polled frame) | `poll` |
| `.r08` verified with default TAStm32 settings | `strobe` |
| `.r08` documented as needing TAStm32 `--dpcm` (Metroid, Bugs Bunny Crazy Castle) | `poll` or `latch` (the latch window *is* the `--dpcm` filter) |
| Future SubNESHawk per-latch dumps (SMB3 0.32-class payloads, real cartridge) | `strobe` |

Caution: r08s of DPCM re-read games (SMB3, Tetris — files with the ~4×-per-frame duplicate
structure) are `strobe`-mode files by construction, but they embed the emulator's *predicted*
corruption re-reads and therefore sync only on consoles whose power-on phase reproduces those
events. On this project's console + N8 Pro the DMC pattern varies per boot, so expect these
specific r08s to be boot-dependent in strobe mode; the frame-model `.tdmask` under `poll` mode
remains the repeatable pairing for those games (see Future work for the full evidence).

## Verified TAStm32 semantics (source audit, 2026-07-15)

Audited against `Ownasaurus/TAStm32` (master) to remove guesswork. Findings:

- **Consumption edge: RISING, latch and clocks.** `SetNESMode()` configures
  `P1_CLOCK|P1_LATCH|P2_CLOCK` as `GPIO_MODE_IT_RISING` (`Src/TASRun.c:492`). The falling-edge
  latch configs elsewhere in that file belong to Genesis/SMS modes. TASDeck's
  `attachInterrupt(..., RISING)` wiring matches exactly.
- **No latch debounce in default mode.** In `NesSnesLatch()` (`Src/stm32f4xx_it.c:370`), when the
  DPCM fix is off every latch ISR invocation calls `GetNextFrame()` and consumes one record. There
  is no time comparison on the latch line at all. Strobe mode's "no debounce" default is therefore
  exact parity, not an approximation.
- **`--dpcm` is a one-shot 8 ms repeat window.** With `dpcmFix` on, serving a latch sets
  `recentLatch = 1` and arms a one-shot 8 ms timer (`stm32f4xx_it.c:444-448`); latches arriving
  while `recentLatch == 1` re-serve bit 0 of the *current* frame and reset the bit pointer
  (`stm32f4xx_it.c:666-678`); the timer expiry clears the flag (`stm32f4xx_it.c:780`). This
  confirms the mode-mapping table: TASDeck's window mode is the `--dpcm` equivalent, with one
  nuance — TAStm32's window is a one-shot anchored at the served latch, TASDeck's is a sliding
  window re-anchored by each edge. Identical for same-frame re-read bursts; they differ only under
  pathological continuous strobing.
- **`--blank N` is client-side blank records.** `tastm32.py` prepends N all-zero records to the
  stream before sending (`python/tastm32.py:442-445`); the first N latches consume them. TASDeck's
  `Start delay` in strobe mode (serve released input for N accepted edges) is semantically
  equivalent.
- **Bit-0 timing precedent.** TAStm32 serves bit 0 *inside* the latch ISR: the first instruction
  writes the pre-staged next-frame GPIO word to BSRR, then bookkeeping precomputes the following
  frame (`stm32f4xx_it.c:374-380`). The whole verified library tolerates ISR-entry serving on that
  hardware (`.ramcode` EXTI handlers). TASDeck's design — pre-positioning bit 0 at the 8th clock of
  the previous read, before the strobe even arrives — is strictly more conservative, which is the
  right margin for the UNO R4's slower `attachInterrupt` dispatch.
- **Clock filter exists as an option, not a default.** `--clock 0..63` (× 0.25 µs) arms a one-shot
  timer after each served clock edge and ignores further clock edges until it expires
  (`stm32f4xx_it.c:238-249`) — an anti-glitch deviation from real-controller behavior. TASDeck
  shifts on every clock edge, which is what a real 4021 does; no filter is needed for v1.

## What this mode does not fix (non-goals)

- **Lag-divergent games.** If the console (or the EverDrive N8) latches a different *number* of
  times than the stream encodes — the SMB3 10-vs-11 boss-room lag frame class — no serving mode
  can compensate. Note: whether Golf's start-screen failure is this class or a window-model
  artifact is **unresolved** (the earlier trace analysis observed the tdmask under window
  semantics only; the r08 and tdmask are byte-identical through the start region). The phase-3
  Golf strobe run is the decisive experiment — completion would prove the window model was the
  cause; failure with a bit-perfect trace would prove hardware divergence. Either outcome is
  acceptable for this feature; Golf's acceptance criterion is serving fidelity, not completion.
- **Overread parity.** What the data line carries after the 8th clock (TAStm32 `--overread`) is a
  separate compatibility item; see Risks.
- **Windowed-mode behavior.** `poll` and `latch` modes are untouched.

## Firmware design

### Advance path

Current behavior (both existing modes): `handleLatchEdge` computes `sameHardwareWindow` from
`latchWithinCurrentWindow()` and only calls `tasPlayback.onLatchEdge()` when the edge opens a new
window (`uno_r4_wifi.ino:1323`). The normal advance is the loop/timer *pre-advance*
(`serviceTasWindowExpiry` → `onWindowExpired`) that runs mid-gap after the window closes; the
in-ISR advance is a fallback.

Strobe mode changes:

- `handleLatchEdge` treats **every** edge as window-opening (`sameHardwareWindow` forced false when
  `syncMode() == Strobe`). The existing edge path — entry fast-path pin write, `onLatchEdge`,
  latch-and-serve — is reused unchanged.
- `NesTasPlayback::onLatchEdge` gets a strobe branch: skip the `newWindow` time comparison and the
  `previousWindowPolled` gate entirely. Not-started/delay/started handling mirrors the existing
  structure (`NotStartedWait`, `DelayWait` decrementing per edge, `Started`, then `advanceFrame`
  per edge).
- `NesTasPlayback::windowExpiryDue()` returns **false** in strobe mode. The 1 kHz service timer and
  loop service never consume records — wall-clock advancement is meaningless in a latch-driven
  mode, and a timer-consumed record during a console pause would be an off-by-one. `preAdvanced_`
  is never set in strobe mode.
- Because the advance decision contains no time comparison, the `micros()` backwards-step hazard
  that caused the Zelda dungeon-1 double-advance (fixed in v44) is structurally absent from this
  mode.

### Strobe-mode onLatchEdge contract (normative)

The strobe branch is entered immediately after the `active()` check, before any window logic:

```txt
onLatchEdge(nowMicros, nextMasks) — strobe mode:
  nextMasks = currentMasks_
  if (!active()):            lastEdgeKind_ = Ended;          return Inactive
  hasLatched_ = true; lastLatchMicros_ = nowMicros           # bookkeeping only, never read
  if (!started_):
    if (!startRequested_ || !readyToStart()):
                             lastEdgeKind_ = NotStartedWait; return Waiting
    if (startDelayRemaining_ > 0):
      startDelayRemaining_ -= 1
                             lastEdgeKind_ = DelayWait;      return Waiting
    started_ = true; currentFrame_ = 0
    currentMasks_ = popFrame(); stageNextMask()
    nextMasks = currentMasks_
    lastWindowResult_ = Ok;  lastEdgeKind_ = Started;        return Ok
  result = advanceFrame(nextMasks)          # Ok | Complete | Underrun
  lastEdgeKind_ = (result == Ok) ? AdvancedAtEdge : Ended
  lastWindowResult_ = result;                                return result
```

Notes: `preAdvanced_` and `pollCompletedInWindow_` are never read or written in this branch.
`noteLatchObserved()`/`notePollCompleted()` calls from the sketch are harmless no-ops with respect
to strobe advancement (R8). The first accepted edge after the delay serves record 0 (`Started`);
each subsequent edge serves the next record; total accepted edges to complete = delay +
totalFrames (R7).

### Data-line timing

The hard constraint (unchanged from today): the console samples bit 0 a few microseconds after the
strobe edge — sooner than latch-ISR entry can reliably update the pin. The windowed modes solve
this by pre-positioning the next mask's bit 0 mid-gap. Strobe mode cannot use a timer, so it
pre-positions at the earliest post-read moment instead:

- **Steady state (full 8-clock reads).** After the edge advance serves record N,
  `advanceFrame → stageNextMask()` already points the staged masks at record N+1. The clock ISRs
  already rewrite the data line after the 8th shift to pre-position "bit 0 for the next strobe"
  (`uno_r4_wifi.ino:1407-1418` and the port-2 equivalent). In strobe mode this rewrite uses
  **`stagedNextMask` bit 0** (record N+1) instead of the current pressed mask's bit 0. Bit 0 of the
  next record is therefore on the wire from the 8th clock of the current read — typically tens of
  microseconds to milliseconds before the next strobe. `willAdvanceOnEdge()` (as redefined for
  strobe mode by R6) is the flag-only decision the clock ISR gates on.
- **Fallback (bare strobes, torn reads).** The next edge's ISR entry fast path
  (`uno_r4_wifi.ino:1264-1283`) writes `stagedNextMasks()` bit 0 immediately, exactly as it does
  today for the missed-pre-advance case. Lateness is already instrumented: the ISR records whether
  the served first bit was on the wire before entry and counts `kTasAnomalyLineMismatch` when it
  was not (`uno_r4_wifi.ino:1352-1364`). The acceptance bar for validation runs is zero
  line-mismatch anomalies on full-read streams.
- **Consecutive-strobe budget.** Support strobes arriving ≥ ~30 µs apart (SMB3-class re-read loops;
  the 0.32 payload polls ~35 µs apart). The strobe-mode edge path adds only a ring pop and restage
  to work the ISRs already do per edge at these rates in windowed runs; at 48 MHz this is well
  under budget. The latch ISR remains priority 0, clocks priority 1, per the existing scheme.

### Start, delay, and arming

- Arming before power-on must put record 0's bit 0 on the wire without a timer release. When
  `TAS_START` is processed with delay 0 (and whenever the delay reaches 0 via an edge), the staged
  frame-0 first bit is written from command/loop context — mirroring today's pre-start staging,
  minus the window bookkeeping. The existing pre-start `stageNextMask()` in `pushChunk` already
  keeps the staged masks pointing at frame 0.
- During the delay, edges serve released input via the existing `DelayWait` path;
  `willAdvanceOnEdge()` stays false until the delay is exhausted, so the entry fast path keeps
  serving zeros. `kTasMaxStartDelayPolls` (3600) is unchanged.

### End of stream, underrun, cancel

Unchanged result handling: `Complete` and `Underrun` disable TAS output and release input through
the existing `tasOutputEnabled` path in the edge handler. `TAS_CANCEL`/`TAS_END` behave as today.

### Trace and anomalies

- The 512-entry trace ring, `TAS_TRACE` paging, and the bridge's continuous stream
  (`BRIDGE_TAS_TRACE_STREAM=1`) are unchanged in format.
- In strobe mode an **additional** trace row is recorded per accepted strobe at edge time (R14 —
  content defined there), so a hardware capture can be diffed 1:1 against the `.r08` record
  sequence, including bare strobes, which are invisible to the completed-poll rows. The existing
  completed-poll rows (both ports) are retained unchanged; analysis distinguishes row types by the
  recorded edge kind. The ring turns over faster in strobe mode; the bridge continuous stream
  captures everything regardless.
- New anomaly counters `bare_strobe` and `torn_strobe` per R15. Both are diagnostics, not errors —
  they are *expected* for some games in strobe mode, and their counts are exactly what the
  r08-parity investigation needs. The existing `kTasAnomalyTornTrain` poll-mode gate is left as-is.
- `TasEdgeKind` gains no new values; served strobes report `AdvancedAtEdge`, and the existing
  `Started`/`DelayWait`/`Ended` kinds retain their meanings.

## Protocol changes

```txt
TAS_BEGIN <frames> <poll|latch|strobe> [ports] [window_us]
```

- `NesDeckProtocol`: add `TasSyncMode::Strobe`; parse token `strobe` alongside `poll`/`latch`
  (`NesDeckProtocol.cpp` token block at line ~113); `tasSyncModeName()` returns `"strobe"`.
- `window_us` is accepted and ignored in strobe mode. Parser and `begin()` validation are
  **unchanged** — the value is range-checked exactly as today, stored, and simply never read by
  the strobe advance path. This keeps old commands, token positions, and validation tests intact.
  `TAS_STATUS` reports the mode name; the window value is meaningless for strobe runs and
  documented as such.
- Startup banner protocol string (`uno_r4_wifi.ino:257`) updated per R2.

## Bridge and web changes

- `apps/web/src/tas.js`: `HARDWARE_TAS_SYNC_MODES = ["poll", "latch", "strobe"]`. R08 parse default
  stays `poll` in phase 1 and flips to `strobe` in phase 4 (see Rollout).
- `apps/web/index.html`: add `<option value="strobe">per strobe (r08 replay)</option>` to the
  `#syncMode` picker.
- `apps/web/src/app.js`: generalize the two hardcoded ternaries (`app.js:1051`, `app.js:1931`) that
  map `"latch" ? latch : poll` into validation against the shared mode list.
- `apps/web/src/transport.js`: no structural change (`TAS_BEGIN ${frameCount} ${syncMode} ...` is
  already generic); mode-set validation picks up the new list from `tas.js`.
- `scripts/bridge-server.js`: mode validation error text ("must be poll or latch",
  `bridge-server.js:382`) updated; passthrough and trace metadata are already mode-agnostic.
- Docs: AGENTS.md protocol grammar and TAS-playback section, firmware README command table,
  `docs/hardware-tas-workflow.md` (r08 guidance, mode-selection table above, `--blank N` ↔
  `Start delay N` mapping), README.md one-line mention.

## Buffer and throughput analysis

- Ring: 512 records; start gate 120 records; `TAS_CHUNK` carries up to 48 records per line at
  115200 baud → sustained refill ≈ 2.3–2.6 k records/s.
- Typical strobe-mode consumption is ≤ 2–4 records per frame (120–240/s) — margin ≥ 10×.
- Burst tolerance: a re-read burst consuming records every ~35 µs is covered by ring headroom
  (≥ ~390 records beyond the start gate) provided the sustained average stays under the serial
  ceiling. A run that *sustains* consumption above ~2.3 k records/s will `Underrun`; this is a
  documented v1 ceiling, far beyond any cataloged game, and the trace records it unambiguously.

## Tests

- **R23** — `firmware/uno_r4_wifi/tests/protocol_test.cpp`, protocol:
  parse `TAS_BEGIN n strobe`, with and without `[ports]`/`[window_us]`; name round-trip; unknown
  mode tokens still rejected; out-of-range `window_us` still rejected in strobe mode.
- **R24** — `firmware/uno_r4_wifi/tests/protocol_test.cpp`, playback (host-compiled
  `NesTasPlayback`):
  - every edge advances, including edges 35 µs apart and edges with identical timestamps — no
    coalescing, no time sensitivity;
  - `noteLatchObserved()`/`notePollCompleted()` calls between edges do not change strobe
    advancement (R8);
  - delay decrements once per edge and record 0 is served on the first post-delay edge; total
    edges to complete = delay + totalFrames (R7);
  - `willAdvanceOnEdge()` false before start and during delay, true once armed with delay 0 and
    while started (R6);
  - `stagedNextMasks()` progression across arming, delay, every advance, and end of stream —
    zeros after the final record (R10);
  - `windowExpiryDue()` always false; `onWindowExpired()` never consumes (R5);
  - completion, underrun, two-port masks served per record, reset/cancel (R9).
- **R25** — web (`tas.test.js`, `transport.test.js`, `bridge-server.test.js`): mode list contains
  `strobe`; TAS_BEGIN formatting threads `strobe`; bridge accepts and threads the mode end-to-end;
  r08 parse default remains `poll` (phase-1 behavior).
- **R26** — Playwright: the `#syncMode` picker exposes the `strobe` option for `.r08` loads and
  stays hidden for `.tdmask` loads.

## Hardware validation and rollout

Phased, v44-style — each phase gates the next:

1. **Land the code** with `strobe` selectable but nothing defaulted to it. `npm run check` (web
   tests, firmware host tests, Arduino compile) green.
2. **Windowed regression on console.** One known-good tdmask run (SMB1 warps) in poll mode must
   still complete — proves the shared edge-path changes didn't disturb windowed playback.
3. **Strobe bring-up on console.** SMB1 maximum-score `.r08` (already verified on TASDeck in poll
   mode) played in strobe mode must complete, with a captured trace showing records consumed ==
   strobes accepted and zero `line_mismatch` anomalies. Then `Golf.r08` in strobe mode, Start
   delay 1 (its documented `--blank 1`), with a continuous trace: the acceptance criterion is
   **serving fidelity** (consumption tracks strobes 1:1 through the title/menu section; masks match
   the r08 prefix bit-perfectly), not run completion — whether the start-screen failure survives
   under verified semantics is exactly what this run decides (see Non-goals). Then retest the
   Fail-dir games whose
   console-verified r08s have only ever been played under window semantics — Castlevania,
   Excitebike, Battletoads GEG (2P) — since r08 + strobe replays the exact pairing TAStm32
   verified and removes the window model as a variable; some may flip to Success. Then the homebrew
   batch from the To Do library (Spacegulls, Driar, etc.) for new verified entries.
4. **Flip the r08 default** to `strobe` and update docs. The picker still allows `poll`/`latch`
   for `--dpcm`-class files.

## Risks and open questions

- **Bare boot strobes vs dump contents.** If BizHawk r08 dumps do *not* include records for
  boot-time bare strobes but a game emits them on hardware, strobe mode over-consumes at boot where
  poll mode held (`ReadlessHold`). SMB1's poll-mode success suggests its dump and hardware agree;
  the phase-3 SMB1 strobe trace settles this empirically. If disagreement appears, the per-game
  answer is the mode picker (that is exactly the TAStm32 situation: `--dpcm` games exist because
  one semantic does not fit all games).
- **Noise immunity.** Windowed modes tolerate latch-line glitches by design; strobe mode consumes a
  record per accepted edge, so a phantom edge is an off-by-one. TAStm32 ships the same exposure
  (no latch debounce in default mode) and the library verifies against it, and current TASDeck
  wiring has produced clean full-run traces (SMB3 bit-perfect), so v1 ships without a debounce; if
  phase-3 traces show phantom edges, add a micro-debounce (~10–20 µs, far below the 30 µs strobe
  floor) as a follow-up.
- **Overread behavior shift.** In strobe mode the post-8th-clock line carries the *next* record's
  bit 0 (it carries the next mask's bit 0 in windowed modes too, but only after the window closes
  mid-gap). Games that intentionally read more than 8 bits should not use strobe mode; full
  `--overread` parity is a separate backlog item.
- **ISR latency on torn/bare paths.** The entry fast path may lose the bit-0 race on the strobe
  *after* a torn read (same exposure as today's missed-pre-advance fallback). It is instrumented
  (`line_mismatch`), and phase-3 acceptance requires zero occurrences on the validation games.

## Future work (out of scope for this spec, discovered during the TAStm32 audit)

- **Latch-train resync (`--latchtrain`).** TAStm32 optionally accepts an array of expected latch
  counts per "train" (consecutive latches; a >20 ms gap — one or more lag frames — separates
  trains, detected by a one-shot timer). At each train boundary the firmware compares actual vs
  expected latch count and self-corrects a ±1 divergence: one latch short → burn one record; one
  extra → hold one record; larger deviations are reported as errors
  (`Src/stm32f4xx_it.c:450-501`). The train array derives from the *emulator movie's* lag pattern,
  so this is a uniform, movie-derived, a-priori policy — the legitimate kind of divergence
  tolerance (unlike post-hoc hardware-trace calibration). A TASDeck equivalent is the principled
  candidate fix for the input-alignment class of EverDrive N8 lag divergence (Golf's title→menu
  block, if its divergence is ±1-per-train shaped). It cannot fix game-state divergence (SMB3's
  RNG-phase lag frame), and it needs its own spec: train derivation from FM2/BK2 lag data, upload
  protocol, and gap-timer service.
- **bk2 → r08 per-latch dump script.** Strobe mode's content source is per-latch data, and the
  published r08 library only covers runs someone already dumped. For a movie that exists only as a
  `.bk2` (or an `.fm2` imported into BizHawk) and needs per-latch playback — a Golf-class
  multi-latch game with no published r08 — add a BizHawk Lua exporter that replays the movie and
  emits one record per latch, producing a standard `.r08`. No new file format: `.r08` already is
  the ecosystem's per-latch container, TASDeck already loads it, and it is two-port by definition.
  Prerequisites and limits: verify that NesHawk's `event.oninputpoll` (or equivalent hook) fires at
  true per-latch granularity before building; the movie must sync when replayed under NesHawk
  (FCEUX-made movies that desync in NesHawk cannot be faithfully dumped by any tool); per-latch
  dumping stays a per-game choice, never the default. DPCM re-read games (SMB3, Tetris) *can* be
  dumped and played per-latch — `Super_Mario_Bros_3_Warps.r08` is proof: 145,056 records vs the
  same movie's 36,127-record tdmask, RLE value sequences identical, median run length exactly 4×
  (double-read compare × two separately-strobed port reads), with ~290 segments carrying NesHawk's
  predicted DMC-corruption re-reads — but playback then requires the console to reproduce those
  corruption events exactly (power-on phase determinism). Verified on alyosha's front-loader + real
  cart; on this project's console + N8 Pro, traces show the DMC anomaly pattern varies per boot, so
  per-latch DPCM playback is expected to be a boot lottery there and windowed playback of the
  frame-model conversion remains the robust choice. Multi-boot strobe-mode playback of the SMB3 r08
  doubles as a console phase-stability probe.
  Optional companion change: a granularity flag in the TD2P header so mask files self-describe and
  the UI can refuse invalid mode pairings (frame-model data in strobe mode and vice versa).
- **Overread flag parity.** TAStm32 `--overread` is a per-run firmware flag selecting the post-8-bit
  data-line level. TASDeck currently hardcodes the equivalent behavior; a `TAS_BEGIN` flag would
  complete the option-parity set for the r08 library (Bugs Bunny Crazy Castle).
- **Mid-run mode transitions (`--transition`).** TAStm32 can toggle the DPCM fix at specific frame
  numbers during a run (`Src/TASRun.c:54-90`). If a game ever needs windowed handling for one
  section and per-strobe for another, per-section mode switching is the established pattern.
- **Clock filter.** Optional spurious-clock-edge suppression (see audit notes). Only worth
  considering if a specific game exhibits DPCM double-clock corruption that its own re-read logic
  does not absorb.
