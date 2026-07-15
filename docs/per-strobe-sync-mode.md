# Per-strobe sync mode specification

Status: FROZEN v1 — rollout phase 1 implemented; console validation and the later default flip remain pending.
Date: 2026-07-15 (revised same day: resolved four implementation-blocking ambiguities from external
review — completion edge accounting, edge-row marking, trace-capture throughput, strobe counter
semantics — plus start-delay staging text, effective refill throughput, and mode-aware UI copy.
Second review pass, same day: edge-row gating/ordering/timestamp made normative, legacy
trace-analyzer row-awareness (R20a), bridge counter plumbing and reset semantics, honest ISR
budget with a phase-3 acceptance check, and full UI string coverage. Third pass, same day:
strobe-mode trace writes made single-writer — the latch ISR is the sole ring writer,
completed-poll rows suppressed (two nested ISR writers would corrupt the ring) — with one edge
row per active port replacing the diag-bit-6 marker and restoring two-port bit-perfect diffing.
Freeze polish: kind-aware expected results for edge rows in R20a, torn counting limited to
active ports, and the exact non-diagnostic debug-pin build command for the phase-3 ISR check)

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
  record 0 is served on the first accepted edge after it reaches zero. Edge accounting
  distinguishes two milestones: **all records served** after delay + totalFrames accepted edges,
  and **playback marked `Complete`** (masks zeroed, input released, `active()` false) on one
  further accepted edge — delay + totalFrames + 1 total. This matches `advanceFrame()`
  (`NesTasPlayback.cpp:272`), which returns `Complete` on the edge *after* the final record was
  served; a console that stops strobing after the last served record leaves the run serving the
  final mask, exactly as the windowed modes do today.
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
- **R14** In strobe mode, trace rows are recorded **per accepted strobe at edge time — one row
  per active port — and these replace the completed-poll rows**, which are suppressed in strobe
  mode (sole-writer rule below; windowed-mode tracing is untouched):
  - **Gating.** The row is recorded iff `started() || startDelayRemaining() > 0` is true when
    evaluated either immediately before **or** immediately after the `onLatchEdge()` call (the OR
    of both reads). The predicate changes during the call in both directions: evaluated
    before-only it misses the delay-0 `Started` edge (turns true during the call); evaluated
    after-only it misses the final `DelayWait` edge that decrements the delay 1→0.
  - **Ordering.** The pre-edge state the row needs — per-port clocks-since-latch, shift indices,
    the clocked-mask reconstruction/snapshot, clock counts — is captured into locals at ISR
    entry, before `handleLatchEdge` resets that state (`uno_r4_wifi.ino:1310`). The row itself is
    written after `onLatchEdge()` returns, once the served mask, result, and edge kind are known.
  - **Content — one row per active port.** The latch ISR writes a port-1 row and, when
    `portCount() == 2`, a port-2 row immediately after it (consecutive sequence numbers, same
    timestamp and latch count — that pairing is the grouping key). Each row: result = the result
    `onLatchEdge()` returned, frame = `currentFrame()`, port = the row's port, latched mask = the
    served mask for that port, clocked mask = the previous read's reconstruction for that port
    (defined below), shift-index and clocks-since-latch = that port's pre-reset locals, diag
    kind = the edge kind, **diag bit 5 (`0x20`, currently unused) set** to mark the row as a
    strobe-edge row. Per-port rows make each port's bare/torn state directly readable from the
    row's own fields, and both served bytes of a two-port `.r08` record are captured — the trace
    diffs bit-perfectly against the full record stream, not just port 1. Diag byte layout: bit 0
    = line-low-at-latch, bits 1–3 = kind, bit 4 = anomaly mark, bit 5 = strobe-edge row.
  - **Sole writer / poll-row suppression.** In strobe mode the latch ISR is the trace ring's
    **only** writer: completed-poll rows are suppressed (`recordTasTrace()` is not called from
    the clock ISRs when `syncMode() == Strobe`; windowed modes are unchanged). This is a hard
    concurrency requirement, not an optimization. The ring's writer protocol assumes writers
    that cannot preempt one another — today both writers are the priority-1 clock ISRs, which
    never nest, and the timestamp-zero publication (`uno_r4_wifi.ino:138`) protects the
    main-loop *reader* against one writer, not two nested writers. A priority-0 latch-ISR write
    preempting a clock-ISR write mid-`recordTasTrace()` would reuse the same slot and corrupt
    both the row and the head/sequence accounting; suppression keeps exactly one writer context
    per run, and wrapping trace writes in `noInterrupts()` is forbidden (C2). Nothing is lost by
    suppression: the previous read's reconstruction rides in the next edge row, so
    served-vs-read verification becomes a cross-row diff (edge-row pair N+1's clocked masks
    against pair N's served masks) instead of a same-row compare.
  - **Timestamp.** Edge rows record the edge timestamp already captured at ISR entry
    (`latchMicros`), passed into the trace writer as a parameter: `recordTasTrace()` currently
    reads `micros()` per row (`uno_r4_wifi.ino:1031`), and the edge path must not pay extra
    `micros()` reads in the priority-0 latch ISR.
  - **Filtering and record mapping.** Diag bit 5 partitions row types across all modes —
    windowed traces contain only bit-5-clear completed-poll rows, strobe traces only bit-5 edge
    rows (kind alone could not distinguish them, since completed-poll rows copy
    `controllerDiagWindowKind` from the edge that opened their read). `.r08` record diffing uses
    bit-5 rows whose kind is `Started` or `AdvancedAtEdge` — exactly one per served record per
    active port, port-1 rows forming the record's first byte stream and port-2 rows the second;
    `DelayWait` rows and the final `Ended` rows do not correspond to movie records.
  - **Clocked-mask definition (per port).** The completed-poll paths clear the clocked-mask
    accumulators after each full read (`uno_r4_wifi.ino:1453` and the port-2 equivalent), so the
    edge rows require retained snapshots — each port's completed-poll path saves its
    reconstruction to a per-port snapshot variable before clearing it (the save still runs in
    strobe mode even though the poll row itself is suppressed), and each edge row records its
    port's snapshot when the preceding interval contained a completed read, the live partial
    accumulator when the read was torn, and zero when the interval was bare.
  - Ring entry format, `TAS_TRACE` paging, and the bridge continuous stream are unchanged on the
    wire.
- **R15** Two new run-level **counters** — dedicated `uint32` fields, not anomaly codes — detected
  at accepted-edge entry from the existing clocks-since-latch / shift-index state, counted only in
  strobe mode with TAS output enabled:
  - `bare_strobe`: the preceding inter-strobe interval contained zero clock edges on **port 1**.
    Port 1 only, by definition — `.r08` uploads are two-port streams even for one-player games,
    so a port-2 rule would fire on every strobe of every 1P run and drown the signal.
  - `torn_strobe`: a port's shift index is 1–7 at edge entry; evaluated only for **active ports**
    (`port <= portCount()`, mirroring `notePollCompleted`'s guard) and incremented once per
    tripping port per edge — a one-port strobe run must never count an invisible port-2 event
    (R14 emits no port-2 row for it). An unclocked port sits at shift index 0 and never trips
    it, so two-port runs of one-player games get no port-2 false positives either.
  The first accepted edge of a run has no preceding inter-strobe interval and is never counted.
  Both counters surface as new `tas_status` fields (`bare_strobes=`, `torn_strobes=`) and reset
  with `TAS_BEGIN`/trace reset. They must **not** route through `noteTasAnomaly()`: every kind
  except ordinary re-reads freezes the trace ring (`uno_r4_wifi.ino:1002`), and these events are
  *expected* in strobe mode — they never freeze the ring, never touch the aggregate anomaly
  count/kind, and never block advancement. Reset semantics: the counters are cleared in
  `resetTasTrace()`, which runs on accepted `TAS_BEGIN` and `TAS_START`
  (`uno_r4_wifi.ino:830,851`), and must **not** be cleared by `resumeTasTrace()`
  (`TAS_TRACE_RESUME`), so whole-run accounting survives a frozen-ring dump and resume. Per-edge
  visibility: each port's bare/torn state is readable row-by-row from that port's own R14 edge
  row (`clocksSinceLatch`/`shiftIndex` fields). No new anomaly code is needed.
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
  with validation against the shared mode list from `tas.js`. UI copy becomes mode-aware: with
  strobe selected, the start-delay unit label (`index.html:142`, currently `windows`) reads
  `strobes`, the skip-first unit label (`index.html:151`, currently `frames`; it trims records
  client-side) reads `records`, and all **three** "at the next NES latch window" status strings
  (`app.js:1338`, `app.js:1375`, `app.js:1456`) read "at the next latch strobe". The trace-page
  log line "captured N rows from poll X to Y" (`app.js:1480`) becomes row-type-neutral ("from
  sequence X to Y") — strobe-mode sequences contain edge rows, not polls.
  `HARDWARE_TAS_PAUSE_MESSAGE` (`app.js:26`, "…sending more polls from the bridge") becomes
  mode-neutral ("…sending more TAS chunks from the bridge"), and the buffer/progress strings that
  count "frames" (`app.js:1452`, `app.js:1459`, `app.js:1467`, `app.js:1771`) say "records" for
  `.r08` runs, where a record is not a frame. Windowed tdmask runs keep today's wording.
- **R20a** `app.js`: the trace analyzer `findTasTraceAnomalies` (`app.js:1533`) becomes
  row-type-aware: its per-poll heuristics — clocked-mask-vs-served-mask mismatch,
  `clocksSinceLatch == 8`, per-port clock/latch deltas — apply only to rows with diag bit 5
  clear. On an edge row the clocked mask belongs to the *previous* record while the latched mask
  is the *newly served* record, so every input transition would otherwise be reported as corrupt —
  and a strobe trace consists entirely of such rows (R14 suppresses poll rows in strobe mode), so
  the skip rule keeps the legacy analyzer correct without any mode awareness. The result check
  (`result !== "ok"`, `app.js:1550`) becomes kind-aware for bit-5 rows instead of being skipped:
  expected pairings are `DelayWait` → `waiting`, `Started`/`AdvancedAtEdge` → `ok`, and a final
  `Ended` → `complete`; `underrun` is always flagged, as is any other result/kind pairing —
  including kinds that must never appear on a strobe-edge row (`SameWindow`, `PreAdvanced`,
  `ReadlessHold`, and `NotStartedWait`, which R14's gating excludes from recording). Sequence-gap
  detection still runs over the unfiltered row stream (sequence numbers are global across row
  types). A dedicated strobe-edge analysis pass (cross-row served-vs-read diffing per R14) is
  optional in v1.
- **R21** `bridge-server.js`: accepts and threads `"strobe"`; the "must be poll or latch" error
  text (`bridge-server.js:382`) is updated. The counters from R15 need explicit plumbing:
  `tasStatusPayload()` (`bridge-server.js:1136`) enumerates every forwarded field and must gain
  `bare_strobes`/`torn_strobes` (default 0) for the WebSocket status stream, and the final values
  are persisted in the trace event-log header (`formatTraceEventLogHeader`,
  `bridge-server.js:2202`) and the continuous-stream `# end:` footer — phase 3 relies on them for
  whole-run accounting, so serial-only visibility is insufficient.
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
deliverable — and they are the *only* functional verification of the sketch-level items R11–R16
(see the coverage note in Tests), so phase 1 sign-off explicitly excludes claiming those items
work on hardware.

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
5. All records have been served once delay + totalFrames edges have been accepted, but the run is
   not yet marked complete: the **next** accepted edge returns `Complete`, releases all input, and
   ends playback — delay + totalFrames + 1 accepted edges in total (R7), exactly as the windowed
   modes' `advanceFrame` behaves today. A console that stops strobing after the last served record
   leaves the run active and serving the final mask, also matching today's behavior.

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
each subsequent edge serves the next record; after delay + totalFrames accepted edges every record
has been served, and the next edge's `advanceFrame` returns `Complete` and releases input — delay
+ totalFrames + 1 accepted edges to completion (R7).

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
  the 0.32 payload polls ~35 µs apart). Beyond the work the ISRs already do per edge in windowed
  runs, the strobe-mode edge path adds: the ring pop and restage, the pre-reset state snapshots
  and bare/torn counter checks (R14/R15), and up to two trace-ring entry writes (one per active
  port, R14) — all straight-line loads and stores, with the edge timestamp passed in rather than
  re-reading `micros()` (R14) — all inside the priority-0 latch ISR that runs immediately before
  the clock ISRs. The clock ISRs write no trace rows in strobe mode (R14 sole-writer rule), which
  returns some of that budget. At 48 MHz this
  is expected to fit the ~30 µs floor, but that is a claim to verify, not assume: phase 3 includes
  an ISR-budget acceptance check at ~35 µs strobe spacing — no lost clock edges (clock counts
  consistent with records served) and latch-ISR pulse width within the inter-strobe gap, measured
  via `TASDECK_ISR_DEBUG_PIN`. The latch ISR remains priority 0, clocks priority 1, per the
  existing scheme.

### Start, delay, and arming

- Arming before power-on must put record 0's bit 0 on the wire without a timer release. When
  `TAS_START` is processed with delay 0 and playback has not started, the staged frame-0 first bit
  is written from command context (R13) — mirroring today's pre-start staging, minus the window
  bookkeeping. The existing pre-start `stageNextMask()` in `pushChunk` already keeps the staged
  masks pointing at frame 0.
- When the delay reaches 0 **via an edge**, no command- or loop-context path runs — window expiry
  is disabled in strobe mode (R5), so there is nothing to write from `loop()`. Record 0's bit 0
  reaches the wire through the normal strobe-mode paths instead: the post-8th-clock rewrite of the
  read that follows the final `DelayWait` edge (R12 — `willAdvanceOnEdge()` turns true the moment
  the delay hits zero), or, when that interval is bare or torn, the next edge's ISR entry fast
  path, with lateness instrumented as `line_mismatch` (R16).
- During the delay, edges serve released input via the existing `DelayWait` path;
  `willAdvanceOnEdge()` stays false until the delay is exhausted, so the entry fast path keeps
  serving zeros. `kTasMaxStartDelayPolls` (3600) is unchanged.

### End of stream, underrun, cancel

Unchanged result handling: `Complete` and `Underrun` disable TAS output and release input through
the existing `tasOutputEnabled` path in the edge handler. `TAS_CANCEL`/`TAS_END` behave as today.

### Trace and anomalies

- The 512-entry trace ring, `TAS_TRACE` paging, and the bridge's continuous stream
  (`BRIDGE_TAS_TRACE_STREAM=1`) are unchanged in format. Diag bit 5 (R14) partitions row types:
  windowed traces contain only completed-poll rows (bit 5 clear), strobe traces only strobe-edge
  rows (bit 5 set) — kind alone cannot distinguish them.
- In strobe mode the completed-poll rows are **replaced** by per-port strobe-edge rows recorded
  at edge time (R14 — the latch ISR must be the ring's sole writer; see R14's concurrency
  clause), so a hardware capture can be diffed 1:1 against the `.r08` record sequence on both
  ports, including bare strobes, which never produced completed-poll rows at all. Windowed-mode
  tracing is unchanged.
- **Trace capture is best-effort, not lossless.** Edge rows arrive at one per active port per
  strobe — 60–480 rows/s across the strobe rates in the throughput section. The continuous
  stream drains at most 12 rows per serial exchange at a measured 50–65 ms per exchange
  (≈ 185–240 rows/s ceiling), sharing the serial command queue with ack-gated chunk uploads and
  status polls, so sustained strobe-mode row rates can outrun it: the 512-row ring (≈ 2–4 s at
  typical game rates) may turn over between drains and the stream may have gaps. Rows carry monotonic sequence numbers, so gaps are detectable and
  every captured run of rows is contiguous; phase-3 validation criteria are therefore defined over
  **contiguous captured segments**, and the frozen-ring dump (anomaly freeze + `TAS_TRACE` paging)
  remains the lossless-evidence path around a fault. No rollout step may assume the continuous
  stream captures every row.
- New run-level counters `bare_strobe` and `torn_strobe` per R15. Both are diagnostics, not errors —
  they are *expected* for some games in strobe mode, and their counts are exactly what the
  r08-parity investigation needs. They bypass `noteTasAnomaly()` and the freeze machinery entirely
  (R15). The existing `kTasAnomalyTornTrain` poll-mode gate is left as-is.
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
  map `"latch" ? latch : poll` into validation against the shared mode list; make the delay/skip
  unit labels, all three armed-status strings, and the trace-page log line mode-aware per R20;
  make `findTasTraceAnomalies` skip strobe-edge rows (diag bit 5) for its per-poll heuristics per
  R20a.
- `apps/web/src/transport.js`: no structural change (`TAS_BEGIN ${frameCount} ${syncMode} ...` is
  already generic); mode-set validation picks up the new list from `tas.js`.
- `scripts/bridge-server.js`: mode validation error text ("must be poll or latch",
  `bridge-server.js:382`) updated. Command passthrough is already mode-agnostic, but the R15
  counters are not free: `tasStatusPayload()` enumerates its forwarded fields and must add
  `bare_strobes`/`torn_strobes`, and the trace event-log header and continuous-stream footer
  must persist their final values (R21).
- Docs: AGENTS.md protocol grammar and TAS-playback section, firmware README command table,
  `docs/hardware-tas-workflow.md` (r08 guidance, mode-selection table above, `--blank N` ↔
  `Start delay N` mapping), README.md one-line mention.

## Buffer and throughput analysis

- Ring: 512 records; start gate 120 records; `TAS_CHUNK` carries up to 48 records per line at
  115200 baud → **raw wire** ceiling ≈ 2.3–2.6 k records/s. The **effective** refill rate is
  lower: the bridge sends chunks synchronously and awaits each acknowledgement
  (`sendNextTasChunk`, `bridge-server.js:578`), and a full exchange measures 50–65 ms, so
  sustained refill ≈ 740–960 records/s — before status polls, and less while the optional
  continuous trace stream shares the serial command queue.
- Typical strobe-mode consumption is ≤ 2–4 records per frame (120–240/s) — margin ≈ 3–8× against
  the effective rate, not the raw-wire 10×. Adequate, but validation runs with continuous tracing
  enabled should expect the thinner margin.
- Burst tolerance: a re-read burst consuming records every ~35 µs is covered by ring headroom
  (≥ ~390 records beyond the start gate) provided the sustained average stays under the effective
  refill rate. A run that *sustains* consumption above ≈ 740 records/s risks `Underrun`; this is a
  documented v1 ceiling, still well beyond any cataloged game, and the trace records it
  unambiguously.

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
  - delay decrements once per edge and record 0 is served on the first post-delay edge; all
    records served after delay + totalFrames edges; the edge after that returns `Complete`, zeros
    the masks, and deactivates playback — delay + totalFrames + 1 edges in total (R7);
  - `willAdvanceOnEdge()` false before start and during delay, true once armed with delay 0 and
    while started (R6);
  - `stagedNextMasks()` progression across arming, delay, every advance, and end of stream —
    zeros after the final record (R10);
  - `windowExpiryDue()` always false; `onWindowExpired()` never consumes (R5);
  - completion, underrun, two-port masks served per record, reset/cancel (R9).
- **R25** — web (`tas.test.js`, `transport.test.js`, `bridge-server.test.js`): mode list contains
  `strobe`; TAS_BEGIN formatting threads `strobe`; bridge accepts and threads the mode end-to-end;
  r08 parse default remains `poll` (phase-1 behavior); bridge status payloads forward
  `bare_strobes`/`torn_strobes` and the trace header/footer persist them (R21);
  `findTasTraceAnomalies` reports no false anomalies on a strobe-mode fixture of per-port edge
  rows (diag bit 5 set) spanning an input transition and including `DelayWait`/`waiting` rows and
  a final `Ended`/`complete` row, still flags a genuine sequence gap and an `underrun` row in
  that fixture, and keeps today's behavior on a windowed completed-poll fixture (R20a).
- **R26** — Playwright: the `#syncMode` picker exposes the `strobe` option for `.r08` loads and
  stays hidden for `.tdmask` loads; with strobe selected, the delay/skip unit labels read
  `strobes`/`records` and the armed-status wording says "latch strobe" (R20), reverting when a
  windowed mode is selected again.

Coverage note: the sketch-level requirements **R11–R16** (ISR window bypass, post-8th-clock
staging, command-context pin staging, strobe-edge trace rows, bare/torn counters, line-mismatch
carryover) have no host-test harness — C1 keeps the testable modules Arduino-free, and the sketch
is exercised only by the compile gate. R23–R26 therefore do not cover them; their functional
verification is the phase 2–3 hardware runs, whose acceptance evidence (bit-5 edge rows,
counter values, zero `line_mismatch`, windowed regression) is enumerated in the rollout section.
Where a strobe-mode decision can live in `NesTasPlayback` rather than the sketch, prefer that
placement so R24 covers it on the host.

## Hardware validation and rollout

Phased, v44-style — each phase gates the next:

1. **Land the code** with `strobe` selectable but nothing defaulted to it. `npm run check` (web
   tests, firmware host tests, Arduino compile) green.
2. **Windowed regression on console.** One known-good tdmask run (SMB1 warps) in poll mode must
   still complete — proves the shared edge-path changes didn't disturb windowed playback.
3. **Strobe bring-up on console.** Trace-based criteria in this phase are evaluated over
   **contiguous captured segments** (the continuous stream may gap at strobe-mode row rates; see
   Trace and anomalies), with `tas_status` counters (`current_frame`, latch count,
   `bare_strobes`/`torn_strobes`) providing the whole-run accounting. SMB1 maximum-score `.r08`
   (already verified on TASDeck in poll mode) played in strobe mode must complete, with every
   captured segment showing records consumed == strobes accepted and zero `line_mismatch`
   anomalies. This phase also runs the ISR-budget check from "Data-line timing": drive a re-read
   burst source at ~35 µs strobe spacing (the SMB3 warps r08's 4-latch/frame bursts qualify;
   completion is not required, only serving under burst) and verify no lost clock edges and a
   latch-ISR pulse width within the inter-strobe gap via `TASDECK_ISR_DEBUG_PIN`. Build for this
   check with
   `TASDECK_ISR_DEBUG_PIN=9 ARDUINO_PORT=/dev/cu.usbmodemXXXX npm run upload:firmware` —
   **not** `npm run upload:firmware:diagnostic`, which also sets `TASDECK_DIAGNOSTIC_FORCE_A=1`
   and thereby enables the forced diagnostic mask that bypasses TAS playback entirely
   (`kDiagnosticForcedMask` gates the whole edge path). `TASDECK_DIAGNOSTIC_FORCE_A` must remain
   unset for every playback measurement. Then `Golf.r08` in strobe mode, Start delay 1 (its documented `--blank 1`), with a
   continuous trace: the acceptance criterion is **serving fidelity** (consumption tracks strobes
   1:1 through the title/menu section; masks match the r08 prefix bit-perfectly across the
   captured segments), not run completion — whether the start-screen failure survives under
   verified semantics is exactly what this run decides (see Non-goals). Then retest the
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
