# Recently Played TAS Runs — Implementation Design

Status: proposed, not implemented. This document is the implementation brief for the "Recent" picker
that sits next to `Open` in the TAS File panel.

## 1. What The Feature Does

1. A `Recent` button next to the `Open` file picker opens a modal list of TAS runs that have actually
   played on hardware.
2. Each row shows the TAS file name, when it ran, how long it played, how far it got, whether it
   finished, and the exact playback configuration it used (sync mode, start delay, skip first, port
   count, firmware id). Rows also carry that run's diagnostics: the bare/torn strobe and anomaly
   counters the firmware reported, and the trace files it produced with a copy-path button.
3. Choosing a row loads that TAS exactly as `Open` would have loaded it, and restores the same sync
   mode, start delay, and skip-first values the chosen run used.
4. `Re-run` does the same thing and continues straight through upload and arm, stopping armed so
   `Start` can be pressed at the console sync point — one button for the boot-lottery workflow where
   the same movie is retried many times.
5. A `Completed runs only` checkbox filters the list to runs that played every record — excluding runs
   that were stopped, errored, interrupted, or are still playing.
6. The list can be sorted by TAS name, date, time played, estimated length, completed state, sync
   mode, start delay, and skip first — ascending or descending.
7. Individual runs can be deleted, and `Clear all` empties the list.

Out of scope: editing an entry, renaming runs, marking a run as "won the game", replaying a run
without the browser, syncing recents between machines, and any change to firmware. See
[§16 Optional Follow-Ups](#16-optional-follow-ups).

## 2. The Constraint That Decides The Architecture

A browser cannot reopen a file it loaded through `<input type="file">`. The `File` object is gone on
reload, and the File System Access API that could persist a handle is unavailable in iOS Safari —
which is a first-class client here, because the README documents driving TASDeck from a phone on the
LAN. So "load the same TAS again" is only possible if **something other than the browser keeps the
bytes**.

The bridge is that something, and it is the right owner for three more reasons:

- It already receives the complete mask stream on `tas_upload` and already writes files under `logs/`.
- It already owns run lifecycle, run ids, firmware status polling, and completion detection, so it is
  the only component that can measure duration and outcome correctly.
- Playback deliberately survives the browser sleeping or closing mid-run
  ([`app.js:1860`](../../apps/web/src/app.js#L1860)). A browser-side store would lose exactly the runs
  that matter most — the long ones.

Consequence: recents are per-installation, shared by every browser that connects to that bridge. A
run started on the laptop appears in the phone's list. That is the desired behavior, not a
side effect.

## 3. Data Model

### 3.1 Storage layout

```
logs/recent-runs/index.json              # {"version":1,"entries":[…]} newest first
logs/recent-runs/streams/<sha256>.r08      # archived original file bytes, deduped by content
logs/recent-runs/streams/<sha256>.tdmask
```

`logs/` is already gitignored, so no `.gitignore` change is needed. The directory is
`options.recentRunsDir || path.join(this.logDir, "recent-runs")` so tests can point it at a temp dir
exactly like the existing trace tests do
([`bridge-server.test.js:487`](../../apps/web/tests/bridge-server.test.js#L487)).

### 3.2 Entry schema

```json
{
  "id": "2026-07-29T18-42-11-503-0700-7",
  "fileName": "smb3-100-warpless.r08",
  "fileFormat": "r08",
  "sourceKey": "fnv1a32:9f3ab21c:446214",
  "contentKey": "sha256:6a1c9f…",
  "sourceAvailable": true,
  "sourceBytes": 446214,
  "maskChecksum": 137,
  "syncMode": "strobe",
  "delayPolls": 1,
  "skipPolls": 0,
  "portCount": 2,
  "totalRecords": 223107,
  "effectiveRecords": 223107,
  "sourceFrameCount": 0,
  "recordsPlayed": 223107,
  "startedAt": "2026-07-29T18:42:11.503Z",
  "lastObservedAt": "2026-07-29T19:01:04.612Z",
  "endedAt": "2026-07-29T19:01:04.612Z",
  "durationMs": 1133109,
  "outcome": "completed",
  "firmwareId": "v63",
  "bridgeRunId": 7,
  "error": "",
  "bareStrobes": 0,
  "tornStrobes": 0,
  "anomalyCount": 135934,
  "anomalyKind": 4,
  "anomalySeq": 812,
  "traceFiles": [
    { "path": "logs/trace/2026-07-29T18-42-12-004-0700_smb3-100-warpless.stream.csv", "kind": "stream", "at": "2026-07-29T19:01:06.220Z" },
    { "path": "logs/trace/2026-07-29T18-55-03-118-0700_smb3-100-warpless.trace", "kind": "auto", "at": "2026-07-29T18:55:03.118Z" }
  ],
  "traceFilesTruncated": false
}
```

**Invariant: one started run produces exactly one entry.** Not one per trace file, not one per chunk,
not one per status poll. A run that wrote forty trace files and a run that wrote none both appear
exactly once; `traceFiles` is a list *inside* the single entry. The entry is created once in
`beginRun` at `TAS_START` and only ever updated after that, and its `id` is derived from
`bridgeRunId`, so a duplicate is not representable.

Field notes:

- `id` — `${fileTimestamp(startedAt)}-${bridgeRunId}`. Reuse the exported `fileTimestamp` helper
  ([`bridge-server.js:2487`](../../scripts/bridge-server.js#L2487)) so ids sort lexically by time.
- `fileFormat` — `"r08"` or `"tdmask"`, derived from the file-name extension bridge-side. It gates
  whether a restored `syncMode` is honored (§9.4).
- `sourceKey` — cheap content fingerprint of the archived file bytes, `fnv1a32:<hex8>:<byteLength>`,
  computed by the identical shared helper on both sides. Used only to decide whether the bridge
  already has the bytes, never as proof of identity.
- `contentKey` — `sha256:` of the archived bytes, computed bridge-side. This names the blob file and is
  the identity used for dedupe and garbage collection.
- `maskChecksum` — `tasRunChecksum` over the pre-skip masks, i.e. the run's `originalChecksum`. This
  is the guard that makes `sourceKey` reuse safe (§4.2).
- `totalRecords` / `effectiveRecords` — records as loaded, and records after `skipPolls` (what the
  firmware was armed with). Both are needed: progress percentage uses `effectiveRecords`, and the
  restore path re-applies `skipPolls` to the full file.
- `sourceFrameCount` — the TD2P v2 source-movie frame count when the browser knows it, else `0`. Only
  used for the exact-vs-estimated run length (§8, `recentRunEstimatedLength`).
- `recordsPlayed` — highest firmware `current` seen for the run.
- `lastObservedAt` — timestamp of the newest status applied to this run, persisted on every progress
  flush. It exists so crash recovery can date the end of a run: without it, a bridge that dies at 19:00
  and restarts the next morning would repair the entry with `endedAt` = startup time and report a
  fourteen-hour `durationMs` — on a field that is also a sort key. Startup repair uses
  `lastObservedAt` as `endedAt`, making a crash-recovered duration accurate to within one flush
  interval.
- `durationMs` — `endedAt - startedAt`, bridge wall clock. This is deliberately *not* the UI run
  timer, which anchors elapsed time to the console's first observed poll
  ([`app.js:1110`](../../apps/web/src/app.js#L1110)); the two can differ by up to about a second. Do not
  try to reconcile them, and do not send the browser's timer to the bridge.
- `outcome` — see §3.3.
- `firmwareId` — firmware `fw` string from the last status. This user's diagnostic workflow is
  organized around which firmware revision a run used, so surface it as a chip in the row.
- `bareStrobes`, `tornStrobes`, `anomalyCount`, `anomalyKind`, `anomalySeq` — the firmware's own
  counters, taken from the newest status seen for the run, so an interrupted run keeps its partial
  values. **These are informational, not a verdict.** A large anomaly count is routinely benign: the
  Punch-Out win reported 135,934 anomalies, all kind 4, purely as an artifact of a game that polls
  four times per frame. Render them in the muted chip style and never let them influence the outcome
  badge or the completed filter — **diagnostic counters never influence outcome** (§3.3).
- `traceFiles` — every trace artifact this run produced, newest first, each tagged `manual` (the
  firmware CSV dump from the `Trace` button), `log` (the event-log `.trace` that the same button also
  writes), `auto` (a frozen-ring anomaly dump), or `stream` (the continuous `.stream.csv`).
  Paths come from the existing `displayPathForLog` helper
  ([`bridge-server.js:2586`](../../scripts/bridge-server.js#L2586)). The entry **references** these
  files; it does not own them (§5). No per-run limit: anomaly dumps do arrive in bursts (one
  documented failure produced a tight burst across two thousand records), but a path costs about 150
  bytes of JSON, so even a 40-dump run adds ~6 KB and a full list of pathological runs stays under a
  megabyte. Dropping paths to save that would throw away exactly the dumps clustered around a desync,
  which are the ones worth finding. Long lists are a *display* problem, solved in the row (§9.1), not
  by discarding data.
- `traceFilesTruncated` — runaway guard only. Appending stops at
  `RECENT_RUN_TRACE_PATH_LIMIT = 200` paths and sets this flag, so a firmware bug that dumps in a loop
  cannot grow `index.json` without bound. Reaching it is not an expected state; the row shows a plain
  "trace list truncated" note if it ever happens.

### 3.3 Outcome taxonomy

| Outcome | Set when | Counts as completed |
| --- | --- | --- |
| `playing` | entry created at `TAS_START` | no |
| `completed` | firmware status reports `complete=1` | **yes** |
| `stopped` | `TAS_CANCEL` from Stop, or from loading another file/recent | no |
| `error` | run error other than `ok`, or a stream failure | no |
| `interrupted` | serial disconnect, bridge shutdown, or a `playing` entry found at startup | no |
| `unknown` | never written; reserved so a newer bridge's outcome can't break an older UI | no |

The `Completed runs only` filter shows `completed` and nothing else. That is the whole contract: a run
that was stopped early, errored, lost the serial link, or is still going does not appear.

**Precedence when a status carries both `complete=1` and a non-`ok` error: error wins.** That is what
`applyTasFirmwareStatus` already does ([`bridge-server.js:991-996`](../../scripts/bridge-server.js#L991-L996)),
and the entry must agree with the run state rather than invent its own ranking. Separately, a *trace*
failure is never an outcome: `streamTasTraceRows` and the frozen-ring dump already confine their errors
to a bridge log line, and a failed capture or a failed trace attach must not turn successful playback
into `error`.

**Terminal transitions are idempotent and keyed to the entry, never to "the current entry."** Every
path that abandons a run finalizes that run's own `id`, captured when the entry was created. The
distinction is not academic: `cancelTasRun` captures its `run`, then awaits a serial round-trip
([`bridge-server.js:724`](../../scripts/bridge-server.js#L724)), and because inbound WebSocket messages
are dispatched without serialization
([`bridge-server.js:1889`](../../scripts/bridge-server.js#L1889)), a `tas_upload` can replace
`this.activeTasRun` while that await is outstanding. A hook that resolved "the active entry" at that
moment would finalize the *new* run's entry and leave the old one `playing` forever. §7.2 lists every
call site.

### 3.4 File Identity: There Is No Full Path, Ever

**A `.tdmask` or `.r08` outside the project is the normal case, and its directory is not recoverable.**
`File.name` from `<input type="file">` is the base name only — `smb3-100-warpless.r08`, never
`/Users/…/Everdrive/TAS/To Do/smb3-100-warpless.r08`. Browsers deliberately withhold the path, there is
no flag to opt in, and drag-and-drop gives no more. The bridge therefore cannot store one, and
`sanitizeTasFileName` ([`bridge-server.js:2595`](../../scripts/bridge-server.js#L2595)) already reflects
that reality: it takes the string as given and truncates it. Do not invent a `filePath` field, do not
ask the user to type one, and do not infer a directory from an old run.

Three consequences, all of which the design leans into rather than works around:

1. **Restoring never depends on the path.** The bytes live in `logs/recent-runs/streams/`, so a recent
   run loads correctly after the original file has been moved, renamed, deleted, or left on an SD card
   in a drawer. This is a strength of archiving the bytes instead of remembering a location, and it is
   why the earlier "just store the path" shape was never on the table.
2. **The row shows a base name, so two same-named files look alike.** Identity is content, not name:
   different bytes are always different entries with different blobs. To keep the list honest,
   `annotateDuplicateRecentRunNames` (§8) tags an entry only when one file name maps to two or more
   *distinct* contents, appending the first seven characters of its `contentKey` — `smb3.r08 · 6a1c9f2`
   — so `To Do/` and `Fail/` copies of the same movie name are distinguishable at a glance. Repeated
   runs of the identical file share a `contentKey` and get no tag, because they are genuinely the same
   stream and a badge on every row would be noise.
3. **Recents is a run log, not a library index.** It answers "what did I play and how", not "where do
   my TAS files live". Browsing a real library with real paths needs the bridge to enumerate
   directories, which is a different feature (§16).

## 4. Archiving The Source Bytes

### 4.1 When the transfer happens

The bridge asks for bytes during `tas_upload` — before arming, before any console streaming. Never
between `TAS_START` and a terminal state. Base64 decoding and a half-megabyte disk write are cheap,
but this project has already been bitten by background work starving the chunk path
(`docs/hardware-tas-workflow.md#continuous-trace-capture`), so keep the archive work strictly in the
pre-arm window. If a source payload somehow arrives while `activeTasRun.started` is true, queue the
write until the run reaches a terminal state.

### 4.2 The exchange

1. Browser adds three optional fields to the existing `tas_upload` message: `sourceKey`,
   `sourceByteLength`, `sourceFrameCount`. These are additive; a client that omits them still uploads
   and plays normally, and its entry records `sourceAvailable: false`.
2. Bridge decides whether it needs the bytes:
   - No entry has this `sourceKey` → **needs bytes**.
   - An entry has this `sourceKey` **and** the same `maskChecksum`, `totalRecords`, and `portCount` as
     the pending run → reuse that entry's `contentKey`, no transfer.
   - `sourceKey` matches but the mask fingerprint does not → treat as a different file and **need
     bytes**. (This is the guard that makes a 32-bit fingerprint safe: two distinct files must
     collide on FNV-1a *and* byte length *and* the mask checksum *and* the record count to be
     confused, and the blob is stored under its own sha256 either way.)
   Reuse also requires the blob to still be **on disk at the recorded size** — `fsp.stat` before
   suppressing the transfer. Trusting the index alone would silently produce an entry pointing at a
   file someone deleted by hand, and the failure would only surface later at load time.
3. When bytes are needed the bridge replies `recent_run_source_request { sourceRequestId, sourceKey,
   bridgeRunId }` to the uploading client only.
4. Browser replies `recent_run_source { sourceRequestId, sourceKey, fileName, bytesBase64 }` with the
   bytes it still holds in `state.tas.fileBytes`. If the user has since loaded a different file, it
   replies `recent_run_source_unavailable { sourceRequestId, sourceKey }` instead. The
   `sourceRequestId` correlates the reply to its request so a late answer for a superseded upload is
   discarded rather than applied to whatever happens to be pending; content verification would catch
   the mismatch anyway, but discarding it by id is cheaper and clearer.
5. Bridge validates before storing: `sourceRequestId` is still outstanding, size ≤
   `MAX_RECENT_RUN_SOURCE_BYTES` (4 MiB raw, which stays well under the 8 MiB `MAX_WS_PAYLOAD_BYTES`
   after base64 inflation) and equal to the advertised `sourceByteLength`, the recomputed `sourceKey`
   matches, the extension matches the run's `fileFormat`, `parseTasFileBytes(fileName, bytes)`
   succeeds, and the resulting pre-skip masks match the pending run's `originalFrameCount`,
   `portCount`, and `originalChecksum`. Any mismatch → do not store, log a bridge line, mark
   `sourceAvailable: false`. A stored blob is therefore always a faithful copy of what was played.
6. **Archiving never gates playback.** If `Re-run` arms while the source response is still in flight,
   arming proceeds; a late payload is written when it arrives (deferred past a started run per §4.1),
   and a lost one leaves `sourceAvailable: false` on one row. Making `tas_arm` await the archive would
   put a disk write in front of `TAS_BEGIN` to protect a cosmetic flag — the wrong trade on a device
   where arming timing matters. See §11.

Base64 on the browser side must be chunked; spreading a 446 KB `Uint8Array` into
`String.fromCharCode` overflows the call stack.

```js
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
  }
  return window.btoa(binary);
}
```

### 4.3 Rejected alternative

The bridge could rebuild the file from the masks it already holds (re-add the TD2P header, or
bit-reverse back to `.r08`) and skip the transfer entirely. Rejected: it is a second, parallel
implementation of the format that can silently drift from `parseTasFileBytes`, and it cannot recover
the TD2P v2 source frame count. Archiving the user's actual bytes and re-parsing them through the one
existing parser means a restored run is byte-identical to the original open by construction.

## 5. Retention, Garbage Collection, Integrity

- `RECENT_RUNS_MAX_ENTRIES = 100`, `RECENT_RUNS_MAX_STREAM_BYTES = 256 * 1024 * 1024`. On each
  finalize, evict oldest entries until both caps hold. Never evict an entry whose outcome is
  `playing`. **The byte cap is measured over the physical contents of `streams/`, including orphans** —
  measuring only referenced blobs would let unreferenced files push the directory past the cap while
  the store believed it was under.
- Blob removal has two tiers, because one rule cannot serve both cases:
  - **Deliberately dereferenced** — the last entry referencing a blob was just deleted, cleared, or
    evicted. Remove it immediately, unless it belongs to the pending upload or the active run. No grace
    period: the user asked for it to go.
  - **Discovered orphan** — a file in `streams/` that the index never referenced, which is the normal
    result of loading a file and never playing it, since loading auto-uploads
    ([`app.js:1582`](../../apps/web/src/app.js#L1582)) and the archive is written before any run starts.
    Remove only once it is older than `RECENT_RUNS_ORPHAN_GRACE_MS = 3_600_000`, so a blob waiting for
    its `Play` is never pulled out from under it.
- GC runs on **startup**, after `storeSource`, and on delete, clear, and finalize — never on a timer.
  Startup and post-store are the ones that matter for the leak: browsing a folder and opening a dozen
  files without playing them writes a dozen blobs and creates zero entries, so a GC that only fires on
  finalize would never run at all and `streams/` would grow without bound.
- Index writes go to `index.json.tmp` then `fsp.rename`, serialized through a single promise chain
  (same idiom as `this.writeQueue`) so a status update can never interleave with a delete.
- Progress updates (`recordsPlayed`, `lastObservedAt`, and the diagnostic counters) flush at most once
  every `RECENT_RUNS_PROGRESS_FLUSH_MS = 30_000`; terminal transitions always flush immediately. Thirty
  seconds rather than two keeps rewrites off the streaming path with 15× fewer writes, and the cost is
  bounded: the only thing a crash loses is up to thirty seconds of `recordsPlayed` and end-time
  precision on a run that startup repair is already marking `interrupted`.
- A malformed or unknown-version `index.json` is renamed to `index.corrupt-<timestamp>.json` and the
  store starts empty. It must never throw into the bridge.
- **Trace files are referenced, never owned.** Deleting an entry, clearing the list, and retention
  eviction all leave the files under `logs/trace/` untouched. Those are diagnostic artifacts with
  their own lifecycle, and a recents cleanup must not destroy the evidence from a failed run. The
  reverse case — a trace file deleted by hand — is expected: the row still lists the path, and the
  copy button still works.
- **Hard rule:** every recents operation is wrapped so that a failure logs a bridge line and is
  otherwise swallowed. Recents is a convenience feature; it must never be able to fail a `tas_upload`,
  an arm, a start, or a status poll. Tests assert this explicitly (§12.3).

## 6. Bridge Protocol

All new message types. Existing `tas_*` shapes are unchanged apart from the three additive
`tas_upload` fields in §4.2.

Client → bridge:

| Type | Payload | Notes |
| --- | --- | --- |
| `recent_runs_list` | `{ requestId }` | Serial connection **not** required |
| `recent_run_load` | `{ requestId, id }` | |
| `recent_run_delete` | `{ requestId, id }` | |
| `recent_runs_clear` | `{ requestId }` | |
| `recent_run_source` | `{ sourceKey, fileName, bytesBase64 }` | Reply to a source request |
| `recent_run_source_unavailable` | `{ sourceKey }` | Browser no longer holds the bytes |

Bridge → client:

| Type | Payload |
| --- | --- |
| `recent_runs` | `{ requestId?, entries: [...], removed?, keptActive? }` |
| `recent_run_source_request` | `{ sourceKey }` |
| `recent_run_source_loaded` | `{ requestId, id, fileName, bytesBase64, restore: { syncMode, delayPolls, skipPolls }, portCount, totalRecords }` |
| `recent_runs_error` | `{ requestId, message }` |

Rules:

- `recent_runs_list` answers the requester with the full current list, so the UI renders bridge truth
  rather than optimistically mutating rows. `recent_run_delete` and `recent_runs_clear` **broadcast**
  that list to every client instead of replying only to the requester: recents are explicitly shared
  (§15), so a dialog open on the phone must not keep showing rows the laptop just deleted. The
  `requestId` still rides along for the requester's own correlation.
- `recent_runs` is broadcast to every client on entry **create** and **finalize** only. Never on a
  progress update: at one status poll per second a 100-entry broadcast would be constant chatter for
  no benefit, and a `playing` row's elapsed time is computed client-side from `startedAt`. Also **not**
  on a trace attach — anomaly dumps burst, and a burst of list broadcasts is exactly the kind of
  incidental load this bridge does not need. Attached traces appear the next time the dialog opens.
- Delete or clear targeting the active `playing` entry is refused: `recent_run_delete` answers
  `recent_runs_error` ("That run is still playing."), and `recent_runs_clear` skips it and reports
  `keptActive: true` with the `removed` count.
- Add the new types to the dispatcher in `handleClientMessage`
  ([`bridge-server.js:1895`](../../scripts/bridge-server.js#L1895)). Do **not** route them through
  `handleClientTasMessage`, whose non-upload branches require a live serial link
  ([`bridge-server.js:350`](../../scripts/bridge-server.js#L350)); browsing and loading recents must work
  before the Arduino is connected.

## 7. Bridge Implementation

### 7.1 New module: `scripts/recent-runs-store.js`

A standalone CommonJS module with no serial or WebSocket knowledge — disk plus JSON only, so it unit
tests without constructing a `SerialBridge`. It requires `../apps/web/src/tas.js` and
`../apps/web/src/recents.js` exactly as `bridge-server.js` already requires shared web modules.

```js
class RecentRunsStore {
  constructor({ directory, now = () => new Date(), maxEntries, maxStreamBytes }) {}

  async load() {}                                   // read + repair index, mark stale playing → interrupted
  entries() {}                                      // normalized, newest first
  needsSource(run) {}                               // → { needed: bool, contentKey?: string }
  async storeSource({ run, fileName, bytes }) {}    // verify then write streams/<sha256>.<ext>
  markSourceUnavailable(sourceKey) {}
  beginRun(run, { firmwareId }) {}                  // SYNCHRONOUS: registers in memory, returns id,
                                                    // schedules the flush without awaiting it
  noteProgress(id, recordsPlayed, counters) {}      // throttled flush; counters = firmware diagnostics
  async finalizeRun(id, { outcome, recordsPlayed, error, firmwareId }) {}  // idempotent per id
  async attachTraceForRun(bridgeRunId, { path, kind }) {}   // works on finalized entries too
  async gcOrphans() {}                              // startup + post-store; two-tier rule from §5
  async loadSource(id) {}                           // → { fileName, bytes, restore, portCount, totalRecords }
  async deleteRun(id, { activeId }) {}
  async clearRuns({ activeId }) {}
}
```

Also export the pure pieces for direct testing: `recentRunOutcomeForRunState`,
`normalizeRecentRunsIndex`, `recentRunStreamFileName`, `recentRunEntryId`.

### 7.2 Hooks into `SerialBridge`

| Call site | Change |
| --- | --- |
| `constructor` ([`bridge-server.js:93`](../../scripts/bridge-server.js#L93)) | build `this.recentRuns` from `options.recentRunsDir \|\| path.join(this.logDir, RECENT_RUNS_DIR_NAME)`; kick off `load()` and remember the promise |
| `createTasRun` ([`bridge-server.js:421`](../../scripts/bridge-server.js#L421)) | carry `sourceKey`, `sourceByteLength`, `sourceFrameCount`, and a derived `fileFormat` onto the run object; keep the existing validation order so a bad upload still fails the same way |
| `handleTasUpload` ([`bridge-server.js:401`](../../scripts/bridge-server.js#L401)) | **before** replacing `this.activeTasRun`, finalize the outgoing run's entry if it is still unfinished — see the displacement rule below. Then, after the normal status broadcast, `needsSource(run)` → send `recent_run_source_request` to that client |
| `startTasRun` ([`bridge-server.js:550`](../../scripts/bridge-server.js#L550)) | store the normalized `startDelayPolls` on the run (it is currently local-only), then `beginRun` right after `markTasRunStarted`. `beginRun` registers the entry **synchronously in memory** and returns the id; its disk flush is fire-and-forget, so nothing on the start path awaits I/O before `continueTasStream` is scheduled |
| `continueTasStream`'s rejection handler ([`bridge-server.js:574`](../../scripts/bridge-server.js#L574)) | finalize `error`. This path sets `run.state = "error"` **without** calling `applyTasFirmwareStatus`, so a status-only hook would leave the entry `playing` forever |
| `armTasRun` / `resumeTasRun` rejection handlers ([`bridge-server.js:691`](../../scripts/bridge-server.js#L691)) | same: finalize `error` on the run they captured |
| `applyTasFirmwareStatus` ([`bridge-server.js:985`](../../scripts/bridge-server.js#L985)) | `noteProgress(current, counters)` where `counters` carries `bare_strobes`, `torn_strobes`, `anomaly_count`, `anomaly_kind`, `anomaly_seq`, and `fw` straight off the status; on `complete` → finalize `completed`; on error → finalize `error`. The counters ride along on the same throttled flush, so an interrupted run keeps its last-known values |
| `cancelTasRun` ([`bridge-server.js:717`](../../scripts/bridge-server.js#L717)) | finalize `stopped` if the entry is still `playing` |
| `handleSerialDisconnect` ([`bridge-server.js:253`](../../scripts/bridge-server.js#L253)) and `disconnect` | finalize `interrupted` if a run was playing |
| `main`'s `shutdown` handler | best-effort finalize `interrupted` inside the existing 1 s shutdown budget |
| `writeTasTraceDumpFile` ([`bridge-server.js:1025`](../../scripts/bridge-server.js#L1025)) | after the write, `attachTraceForRun(run.id, { path, kind })` — this one function backs both the manual `Trace` button and the frozen-ring auto dump, so `kind` comes from a new argument (`"manual"` / `"auto"`) supplied by the two callers |
| `streamTasTraceRows` ([`bridge-server.js:1098`](../../scripts/bridge-server.js#L1098)) | attach with `kind: "stream"` after the closing `# end:` append, i.e. once per run rather than per batch |
| `handleEventLogSave` ([`bridge-server.js:943`](../../scripts/bridge-server.js#L943)) | when `reason === "tas-trace"` and a run is active, attach with `kind: "log"`. **Pressing `Trace` writes two files**, not one: the firmware CSV dump through `writeTasTraceDumpFile` ([`bridge-server.js:779`](../../scripts/bridge-server.js#L779)) and a second event-log `.trace` through this handler, because the browser follows `requestTasTrace` with `saveEventLog` ([`app.js:2399`](../../apps/web/src/app.js#L2399)). Hooking only the first would make "every trace artifact" false and would omit the file with the readable header |
| `module.exports` | add `RecentRunsStore` re-export for tests |

**The displacement rule.** `handleTasUpload` replaces `activeTasRun` unconditionally today, and the
old run's stream loop notices only because it re-tests `this.activeTasRun === run` and exits. Nothing
finalizes it. That is invisible with one browser, because loading a file stops the run first, but it is
routine across devices: a phone that never participated in the laptop's run computes
`hadHardwareRun` from *its own* state — status `loaded`, `streamedFrames` 0, `bridgeRunId` 0
([`app.js:2229`](../../apps/web/src/app.js#L2229)) — so it sends **no** `tas_cancel` at all, and its
upload displaces an armed or playing run silently. The laptop then ignores the new run's statuses
because `client_run_id` no longer matches
([`app.js:1877`](../../apps/web/src/app.js#L1877)) and keeps showing a run that no longer exists.

Make the bridge authoritative: when `handleTasUpload` displaces a run that was `arming`, `armed`,
`streaming`, `playing`, or `paused`, it first marks that run stopped, issues `TAS_CANCEL` when serial is
connected, and finalizes its entry as `stopped`. The client is not trusted to have cancelled, because
across devices it cannot know it needed to. This is the one bridge behavior change the feature requires,
and it fixes stale-entry bookkeeping and a genuinely messy console handoff at the same time.

Trace attachment deliberately keys on `bridgeRunId` rather than the active entry, because the
continuous trace stream drains and closes its file *after* the run reaches a terminal state
([`bridge-server.js:1181-1200`](../../scripts/bridge-server.js#L1181-L1200)) and a frozen-ring dump can
land late too. An attach that arrives for an already-finalized entry is normal, not an error; an
attach for an id that no longer exists (evicted or deleted) is dropped silently.

Note the delay-value plumbing: `startTasRun` normalizes `delayPolls` into a local
([`bridge-server.js:556`](../../scripts/bridge-server.js#L556)) and never stores it. The recents entry
needs it, so assign it to the run (`run.startDelayPolls`) and keep using that local for the firmware
command.

## 8. New Web Module: `apps/web/src/recents.js`

Pure, DOM-free, UMD-wrapped exactly like `tas.js` (`module.exports` plus
`globalThis.TasDeckRecents`) so both the browser and the Node store use one implementation, and so
`node --test` can exercise it directly. Load it from `index.html` before `app.js`.

API:

```js
RECENT_RUN_OUTCOMES          // ["playing","completed","stopped","error","interrupted","unknown"]
RECENT_RUN_SORT_KEYS         // ["date","name","played","length","completed","mode","delay","skip"]
RECENT_RUN_SORT_DIRECTIONS   // ["desc","asc"]

recentRunSourceKey(bytes)                       // "fnv1a32:<hex8>:<byteLength>"
normalizeRecentRunEntry(raw)                    // coerced view model; unknown outcome → "unknown"
normalizeRecentRunEntries(rawList)
isCompletedRecentRun(entry)                     // outcome === "completed"
filterRecentRuns(entries, { completedOnly })
sortRecentRuns(entries, { key, direction, now })
recentRunEstimatedLength(entry)                 // { ms, exact }
recentRunElapsedMs(entry, now)                  // durationMs, or now - startedAt while playing
formatRecentRunDuration(ms)                     // "0:00" | "18:53" | "1:04:05"
formatRecentRunProgress(played, total)          // "223,107 / 223,107 records (100%)"
formatRecentRunRelativeTime(startedAt, now)     // "just now" | "5m ago" | "2h ago" | "yesterday" | "Jul 27"
recentRunModeLabel(syncMode)                    // "completed reads" | "per strobe" | "per latch window"
recentRunConfigChips(entry)                     // ["R08", "per strobe", "delay 1", "skip 0", "2 ports", "fw v63"]
recentRunAnomalyChips(entry)                    // ["135,934 anomalies (kind 4)"] — omits zeros
recentRunTraceSummary(entry, { expanded })      // { visible: [{ path, baseName, kind }], hiddenCount, truncated }
annotateDuplicateRecentRunNames(entries)        // adds nameTag to entries whose fileName collides
restoreOptionsForRecentRun(entry)               // { syncMode, delayPolls, skipPolls }
```

Details that matter:

- `recentRunEstimatedLength` returns `{ ms: sourceFrameCount / NES_FRAMES_PER_SECOND * 1000, exact: true }`
  when `sourceFrameCount > 0`, else `{ ms: effectiveRecords / NES_FRAMES_PER_SECOND * 1000, exact: false }`.
  Render inexact values with a leading `~`, matching the run timer's existing convention.
- `recentRunModeLabel` must return the same wording as the sync-mode `<select>` options in
  [`index.html:146-150`](../../apps/web/index.html#L146-L150) so the list and the picker never disagree.
- `formatRecentRunDuration` uses the same digit rules as `formatRunTime`
  ([`app.js:1236`](../../apps/web/src/app.js#L1236)). Preferred: have `formatRunTime` delegate to this
  helper so there is one formatter; the existing run-timer tests must keep passing either way.
- Sorting: `date` on `startedAt`; `name` with
  `left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })` so `Level 2` sorts
  before `Level 10` (use the string method, not `Intl.Collator` — see the globals note in §10);
  `played` on `recentRunElapsedMs`; `length` on `recentRunEstimatedLength().ms`;
  `completed` puts completed runs first (in `desc`); `mode` uses the fixed rank
  `poll < strobe < latch` to match the picker's option order rather than alphabetical; `delay` and
  `skip` are numeric. Every key breaks ties by `startedAt` descending then `id`, so sorting is stable
  and deterministic.
- Default sort is `date` / `desc`.
- `recentRunTraceSummary`: base names split from repo-relative paths without `node:path`; an empty or
  missing `traceFiles` gives `{ visible: [], hiddenCount: 0 }`. Collapsed it returns the first
  `RECENT_RUN_TRACE_VISIBLE = 5` with the rest counted in `hiddenCount`; expanded it returns all of
  them with `hiddenCount: 0`. This is purely presentational — the entry always keeps every path.
- `recentRunAnomalyChips` emits a chip only for a non-zero counter, so a clean run shows nothing:
  `12 bare strobes`, `3 torn strobes`, `135,934 anomalies (kind 4)` with thousands separators. It never
  returns a severity, because these counters do not imply failure (§3.2).
- `annotateDuplicateRecentRunNames` tags **only** when one case-insensitive `fileName` maps to two or
  more *distinct* `contentKey` values. Replaying the same file is the dominant workflow here — eight
  boots of one movie is normal — and those entries share a `contentKey`, so tagging them would put a
  meaningless badge on nearly every row. The tag is the first seven characters of `contentKey` after
  the `sha256:` prefix; entries with no `contentKey` fall back to their `id` suffix. The input array is
  never mutated in place.

## 9. Web UI

### 9.1 Markup

In `.file-actions` ([`index.html:115`](../../apps/web/index.html#L115)), `Recent` goes to the left of the
`Open` picker so `Open` stays the rightmost primary action:

```html
<div class="file-actions">
  <button class="small-button" type="button" id="recentRunsButton">Recent</button>
  <label class="file-picker">
    Open
    <input id="tasFile" type="file" accept=".tdmask,.r08" />
  </label>
</div>
```

The dialog is a native `<dialog>` placed at the end of `<main>`:

```html
<dialog id="recentRunsDialog" class="recent-runs-dialog" aria-labelledby="recentRunsTitle">
  <form method="dialog" class="recent-runs-head">
    <div>
      <p class="eyebrow">TAS File</p>
      <h2 id="recentRunsTitle">Recently Played</h2>
    </div>
    <span class="log-capacity" id="recentRunsCount">0 runs</span>
    <button class="small-button" type="submit" id="recentRunsClose" aria-label="Close recent runs">×</button>
  </form>

  <div class="recent-runs-toolbar">
    <label class="show-both-control" for="recentRunsCompletedOnly">
      <input type="checkbox" id="recentRunsCompletedOnly" />
      <span>Completed runs only</span>
    </label>
    <label class="recent-runs-sort" for="recentRunsSort">
      <span class="visually-hidden">Sort runs by</span>
      <select id="recentRunsSort">
        <option value="date">Date</option>
        <option value="name">TAS name</option>
        <option value="played">Time played</option>
        <option value="length">Estimated length</option>
        <option value="completed">Completed</option>
        <option value="mode">Sync mode</option>
        <option value="delay">Start delay</option>
        <option value="skip">Skip first</option>
      </select>
    </label>
    <button class="small-button" type="button" id="recentRunsSortDirection" aria-label="Sort descending">↓</button>
    <button class="small-button" type="button" id="recentRunsClear">Clear all</button>
  </div>

  <p class="recent-runs-empty" id="recentRunsMessage">Loading recent runs…</p>
  <ol class="recent-runs-list" id="recentRunsList"></ol>
</dialog>
```

One sort control serves both layouts. Clickable desktop column headers were considered and rejected:
the mobile layout is stacked cards with no header row, and two controls editing one sort state is
avoidable complexity. Rows are rendered with `document.createElement` and `textContent` — never
`innerHTML` — matching how `writeLog` builds log entries
([`app.js:644`](../../apps/web/src/app.js#L644)). File names come from disk and must not be parsed as
markup.

Each row carries `data-recent-run-id` and contains:

- **Line 1** — file name (bold, `overflow-wrap: anywhere`; names like
  `lordtom,maru,tompav2-smb3-warps.tdmask` are long), the `nameTag` when the name collides with
  another visible entry (§3.4), and an outcome badge.
- **Line 2** — relative time with the absolute local time in `title`, `Played 18:53`,
  `~18:53 long`, and `223,107 / 223,107 records (100%)`.
- **Line 3** — the config chips from `recentRunConfigChips`.
- **Line 4, the diagnostics line, only when there is something to show** — the anomaly chips from
  `recentRunAnomalyChips`, then `Traces:` with one entry per file showing the base name with its
  `manual`/`auto`/`stream`/`log` kind, the full repo-relative path in `title`, and a `Copy path` button. Five
  traces are shown; a `Show all N traces` toggle expands the rest in place (per-row state, not
  persisted), because a dump-burst run can legitimately have dozens and an unbounded list would push
  every other row off screen. A clean run with no traces renders no line at all.
- **Actions** — `Load`, `Re-run` (primary), and `Delete`, the last with
  `aria-label="Delete <fileName> run"`.

Trace paths are text plus a copy button, not links. The static server only serves files under
`apps/web` ([`bridge-server.js:1723`](../../scripts/bridge-server.js#L1723)), so `logs/trace/…` is not
reachable over HTTP, and adding a download endpoint for an arbitrary log path is a path-traversal
surface out of all proportion to the convenience. A copyable repo-relative path is what actually gets
used, because the next step is always opening it in an editor or feeding it to a script on the same
machine. Copy reuses the existing `copyTextToClipboard` helper
([`app.js:707`](../../apps/web/src/app.js#L707)), which already has an `execCommand` fallback for
non-secure-context LAN access from the phone.

Badge colors reuse the existing tokens: `--good` for completed, `--warn` for error, `--muted` for
stopped and interrupted, `--accent` outline for playing.

### 9.2 States

| Condition | Message |
| --- | --- |
| Request in flight | `Loading recent runs…` |
| No entries at all | `No runs played yet. Open a .tdmask or .r08 file and press Play.` |
| Filter hides everything | `No completed runs yet. Uncheck "Completed runs only" to see every run.` |
| Middleware unreachable | `Could not reach the TASDeck middleware. Start it on this computer and try again.` |
| Entry with `sourceAvailable: false` | Row renders, `Load` and `Re-run` disabled, note: `Stream not archived — open the file with Open.` |
| Arduino not connected | `Re-run` disabled with `title="Connect the Arduino USB bridge to re-run."`; `Load` stays enabled |

### 9.3 Behavior

- `Recent` click → `networkTransport.ensureSocket()` (opens the WebSocket without touching serial,
  so recents work before `Connect`), then `recent_runs_list`, then `showModal()`. Socket failure
  shows the middleware-unreachable message inside the dialog rather than logging and doing nothing.
- `<dialog>` gives Escape-to-close and focus containment for free. On `close`, return focus to
  `#recentRunsButton`. Feature-detect `typeof dialog.showModal === "function"` and fall back to
  toggling `.hidden` with `role="dialog" aria-modal="true"` for browsers without `<dialog>`.
- Filter, sort key, and sort direction persist in `localStorage`
  (`tasdeck.recentRuns.completedOnly`, `.sortKey`, `.sortDirection`), each read and written inside
  `try/catch` because Safari private mode throws. Defaults: unchecked, `date`, `desc`.
- Filtering and sorting are pure client-side re-renders of the last received list. No refetch.
- An incoming `recent_runs` broadcast re-renders an open dialog, so a run finishing while the dialog
  is open flips its badge from Playing to Completed.
- `Clear all` requires confirmation. Use a two-step button — first click swaps the label to
  `Confirm clear` and starts a 5 s revert timer — not `window.confirm`, which ESLint's `no-alert` rule
  forbids.
- `Load` closes the dialog first, then runs the restore path. If a run is active,
  `loadTasFromParseResult` already stops and fences it as its first statement
  ([`app.js:1519`](../../apps/web/src/app.js#L1519)), so no extra stop logic is needed — but the UI test
  in §12.4 asserts the `tas_cancel` actually goes out.
- `Re-run` is `Load` followed immediately by the existing `playHardwareTas()`
  ([`app.js:1640`](../../apps/web/src/app.js#L1640)). No new playback code: that function walks
  uploading → arming → armed on its own, and `ensureHardwareTasUploaded` deduplicates against the
  auto-upload the load already kicked off, because both share `state.tas.hardwareUploadPromise` and the
  `hardwareFileKey` guard ([`app.js:1744`](../../apps/web/src/app.js#L1744)). Call it synchronously
  after the load returns so both see the same run id.
- **`Re-run` stops at armed and never sends `TAS_START`.** Releasing record 0 has to happen at the
  console sync point, which only a human watching the TV can judge; the armed state exists precisely
  for that wait. So the button gets you to "press `Start` now" in one click — power-cycle the console,
  hit `Re-run`, then `Start` — and the transport `Play` button reads `Start` when it lands, exactly as
  it does after a manual arm.
- `Re-run` requires serial, since arming talks to the Arduino. With the bridge offline it is disabled
  rather than hidden, so the reason is discoverable. Note that "connected" is a property of the
  *bridge*, not the client: once the laptop has pressed `Connect`, the phone sees `serialConnected: 1`
  in the broadcast status and its `Re-run` is live without the phone doing anything.
- **Cross-device is fully supported, and the bridge has exactly one active run.** Any client can load
  and re-run any entry, so a `Re-run` from the phone cancels whatever the laptop had armed or playing
  — and the bridge finalizes and cancels it on displacement (§7.2). That is the correct behavior for a
  shared console, but it is easy to do by accident from a second device, so guard it the same way as
  `Clear all`: the first `Re-run` click relabels to `Confirm re-run` and only the second proceeds.
  **Key that guard off the bridge's `bridge_state`, not local `state.tas.status`** — a phone that never
  participated in the laptop's run has a local status of `loaded` and would skip the confirmation
  entirely, which is exactly the case the guard exists for. `Load` keeps its existing no-confirm
  behavior, since it already matches what `Open` does today.

### 9.4 Restore semantics

`loadTasFromParseResult(fileName, parseResult)` gains an optional third argument,
`restore = null`:

```js
const restore = restoreOptionsForRecentRun(entry);   // validated, clamped
loadTasFromParseResult(fileName, parseTasFileBytes(fileName, bytes), restore);
```

Inside the function, where it currently derives defaults
([`app.js:1541-1546`](../../apps/web/src/app.js#L1541-L1546)):

- **Sync mode** — apply `restore.syncMode` only when `parseResult.format === "r08"`. For `.tdmask`
  the mode stays whatever the parser said (`poll`); `handleSyncModeChange` already enforces that
  invariant for the picker ([`app.js:2479`](../../apps/web/src/app.js#L2479)) and the restore path must
  not be a way around it.
- **Start delay** — set `state.tas.syncDelayPolls` to the clamped value **and** set
  `state.tas.syncDelayTouched = true` before calling `applyDefaultSyncDelay()`, so the mode default
  (0 for windowed, 1 for strobe) cannot overwrite a restored delay. Getting this wrong is the classic
  failure documented for the SMB3 0.32 ACE run: a prefilled `1` shifts every record and the payload
  silently never fires.
- **Skip first** — clamp to `[0, masks.length - 1]`, assign, and set `elements.syncSkipPolls.value`.
- **Port count** — never restored and never inferred. It comes from parsing the archived bytes,
  exactly as it would from `Open`. Port count is verified configuration, and a stream whose port 2
  bytes are all zero is still a two-port stream.
- Everything after that — validation, status message, event-log line, and the auto-upload when
  connected — runs unchanged.
- The browser keeps the restored bytes in `state.tas.fileBytes` so it can answer a
  `recent_run_source_request` for a file it loaded from recents (relevant only if that blob later
  goes missing).

Log the recall through the existing event log: `Loaded recent run <fileName> · per strobe · delay 1 ·
skip 0`.

## 10. Files Touched

| File | Change |
| --- | --- |
| `apps/web/src/recents.js` | **new** — pure helpers (§8) |
| `apps/web/index.html` | Recent button, dialog markup, `<script src="src/recents.js" defer>` before `app.js` |
| `apps/web/styles.css` | dialog, toolbar, row grid, badges, chips, `::backdrop`, mobile card layout |
| `apps/web/src/app.js` | `state.tas.fileBytes`; `state.recentRuns` UI state; transport methods; dialog render/bind; `restore` argument in `loadTasFromParseResult`; source-request handler in `handleMessage` |
| `scripts/recent-runs-store.js` | **new** — the store (§7.1) |
| `scripts/bridge-server.js` | store wiring (§7.2), new message dispatch, additive `tas_upload` fields |
| `apps/web/tests/recents.test.js` | **new** (§12.1) |
| `apps/web/tests/recent-runs-store.test.js` | **new** (§12.2) |
| `apps/web/tests/bridge-server.test.js` | additions (§12.3) |
| `apps/web/tests/ui/recent-runs.spec.js` | **new** (§12.4) |
| `AGENTS.md` | File Map entries, a Recent-Runs paragraph under TAS Playback, Manual QA items |
| `README.md` | one paragraph in the TAS section |
| `docs/hardware-tas-workflow.md` | short note that a played run's stream and settings are recoverable from `Recent` |

`npm run lint` already covers `apps/web/src`, `apps/web/tests`, and `scripts/*.js`, and
`scripts/test.sh` runs `node --test apps/web/tests/*.test.js`, so both new modules and both new test
files are picked up with no tooling changes.

**Globals caveat.** The ESLint config declares a deliberately short global list for
`apps/web/src/**` — `clearInterval`, `document`, `globalThis`, `module`, `window` — and `no-undef` is
an error. There is no `setTimeout`, `localStorage`, or `Intl` in that list, and no existing web source
references them bare. So write `window.setTimeout`, `window.localStorage`, `window.btoa`,
`window.atob`, and prefer string/number methods (`localeCompare`, `toLocaleString`) over `Intl.*`.
`recents.js` also runs under Node inside the store, so keep it free of any browser global.

## 11. Error Handling Rules

1. No recents failure may fail a playback operation, and no recents work may *delay* one. Wrap every
   store call; on failure broadcast a bridge log line and continue. Concretely: `beginRun` registers
   synchronously and flushes in the background, nothing on the arm or start path awaits archive I/O,
   and a trace attach that fails never changes a run's outcome. A proposal to have `tas_arm` wait for
   the source archive to land was considered and rejected on these grounds — the only thing at stake is
   one row's `sourceAvailable` flag.
2. A missing or unreadable blob makes the entry `sourceAvailable: false` rather than deleting it — the
   duration and outcome are still worth keeping.
3. A `recent_run_load` for an unknown id answers `recent_runs_error`, and the dialog shows the message
   inline instead of closing.
4. Never serve a blob whose size or sha256 no longer matches the entry. Re-check both on load; on
   mismatch answer `recent_runs_error` and mark the entry unavailable. A replay device must not hand
   back a stream different from the one it recorded.

## 12. Test Plan

Four layers. Pure helpers first, per the repo's testing guidance.

### 12.1 `apps/web/tests/recents.test.js` (node --test, pure)

- `recentRunSourceKey` is stable, length-sensitive, and identical for identical bytes; differs for a
  one-bit change.
- `normalizeRecentRunEntry` coerces string numbers, defaults missing fields, and maps an unrecognized
  outcome to `unknown`.
- `filterRecentRuns({ completedOnly: true })` keeps only `completed` and drops `stopped`, `error`,
  `interrupted`, `playing`, and `unknown`. **This is the filter's contract — assert all five
  exclusions explicitly.**
- `filterRecentRuns({ completedOnly: false })` returns everything, order preserved.
- `sortRecentRuns` for each of the eight keys, both directions: date; numeric-aware name (`Level 2`
  before `Level 10`); time played (including a `playing` entry timed from injected `now`); estimated
  length (exact TD2P v2 entry vs record-count estimate); completed-first; mode rank
  `poll < strobe < latch`; delay; skip. Plus stable tie-breaking on equal keys.
- `recentRunEstimatedLength`: exact when `sourceFrameCount > 0`, estimated from `effectiveRecords`
  otherwise, and `{ ms: 0 }` with no `NaN` when both are 0.
- `formatRecentRunDuration`: `0`, `59_000`, `60_000`, `1_133_109` → `18:53`, `3_845_000` → `1:04:05`.
- `formatRecentRunProgress`: full, partial percentage, zero total (no `NaN%`), thousands separators.
- `formatRecentRunRelativeTime` bucket boundaries with injected `now`.
- `recentRunModeLabel` returns the three exact `<select>` strings.
- `recentRunAnomalyChips`: a clean run returns `[]`; each non-zero counter contributes exactly one
  chip; a six-figure count renders with thousands separators and its kind; the helper exposes no
  severity field for a caller to color by.
- `annotateDuplicateRecentRunNames`: a unique name gets no `nameTag`; **two entries with the same name
  and the same `contentKey` — the replay-the-same-file case — also get no tag**; two entries with the
  same name and different content both get distinct tags; the comparison is case-insensitive; an entry
  with no `contentKey` still gets a renderable tag; the input array is not mutated in place.
- `recentRunTraceSummary`: base names extracted from repo-relative paths; empty and missing
  `traceFiles`; collapsed returns five with the remainder in `hiddenCount`; expanded returns all with
  `hiddenCount: 0`; a list at or below the visible limit reports `hiddenCount: 0` in both states.
- `restoreOptionsForRecentRun`: strobe/poll/latch pass through for `r08`; an `r08` mode is ignored
  for a `tdmask` entry (falls back to `poll`); an invalid mode falls back to `poll`; delay clamps to
  `0..3600`; negative, `NaN`, and missing delay → `0`; skip clamps to `totalRecords - 1`.

### 12.2 `apps/web/tests/recent-runs-store.test.js` (node --test, temp dir per test)

- `beginRun` then `finalizeRun("completed")` writes one entry with `outcome: "completed"`,
  `durationMs > 0`, and the final `recordsPlayed`.
- Outcome mapping for `stopped`, `error`, and `interrupted`.
- Firmware counters from the newest status land on the entry, and an `interrupted` run keeps the last
  values it saw rather than zeros.
- Dedupe: two runs of the same file produce two entries and exactly one file under `streams/`;
  `needsSource` is true the first time and false the second.
- `sourceKey` collision guard: a second run with the same `sourceKey` but a different
  `maskChecksum` is treated as a new file and asks for bytes.
- `storeSource` rejects bytes whose parsed masks disagree with the run (wrong record count, wrong
  checksum, wrong port count): nothing is written and the entry reports `sourceAvailable: false`.
- `storeSource` rejects a payload over `MAX_RECENT_RUN_SOURCE_BYTES`.
- `loadSource` returns bytes byte-identical to what was stored, plus the recorded restore triple.
- `deleteRun` GCs the blob only when unreferenced: two entries sharing a blob → deleting one keeps the
  file, deleting both removes it.
- `deleteRun` refuses the active `playing` entry; `clearRuns` keeps it, removes the rest, and reports
  `removed` and `keptActive`.
- Retention: exceeding `maxEntries` evicts the oldest and GCs its blob; a `playing` entry is never
  evicted.
- `attachTraceForRun` records a path on the matching entry, works after the entry is finalized, keeps
  newest-first order, deduplicates a repeated path, and silently drops an attach for an unknown
  `bridgeRunId`.
- **One entry per run:** a run with zero trace files, one, and forty all yield exactly one entry, and
  forty attaches keep all forty paths on that one entry.
- The runaway guard stops appending at `RECENT_RUN_TRACE_PATH_LIMIT` and sets `traceFilesTruncated`
  (drive it with a small injected limit rather than 200 real attaches).
- Deleting an entry, clearing the list, and retention eviction all leave the referenced trace files on
  disk (create real files in the temp dir and assert they still exist).
- `finalizeRun` is idempotent: calling it twice for one id keeps the first outcome and does not move
  `endedAt`. Calling it for an id that was evicted is a no-op, not a throw.
- Two-tier blob removal: deleting the last entry referencing a blob removes the file **immediately**
  even though it is minutes old, while a discovered orphan (write a stray file into `streams/`) survives
  until it is older than the grace window. These are the two halves of what used to be one contradictory
  rule, so test them together.
- `gcOrphans` runs on startup and after `storeSource`, and the byte cap counts orphan files: seed
  `streams/` past `maxStreamBytes` with unreferenced blobs and assert the directory is brought back
  under after a GC.
- A reused `sourceKey` whose blob has been deleted from disk asks for the bytes again instead of
  suppressing the transfer.
- Startup repair: an index containing a `playing` entry loads it as `interrupted` **and dates `endedAt`
  from `lastObservedAt`, not from startup time** — assert the recovered `durationMs` is within a flush
  interval of the real playtime, not the hours of downtime between the crash and the restart.
- A corrupt `index.json` is renamed to `index.corrupt-*.json`, `load()` does not throw, and the store
  starts empty.
- No `index.json.tmp` remains after any write.
- Throttling: ten rapid `noteProgress` calls cause at most two disk writes (inject a fake clock), and
  `finalizeRun` persists the final value regardless.
- Orphan grace: an unreferenced blob younger than the grace window survives GC; an older one does not
  (inject the clock).

### 12.3 `apps/web/tests/bridge-server.test.js` additions

Use the existing fake-client and temp-`logDir` patterns
([`bridge-server.test.js:487`](../../apps/web/tests/bridge-server.test.js#L487)).

- `recent_runs_list` answers with an entry list on a bridge with **no serial connection**, proving
  recents are serial-independent.
- `tas_upload` carrying an unknown `sourceKey` sends `recent_run_source_request` to that client and
  still sends its normal `tas_status` with `bridge_state: "uploaded"`.
- A following `recent_run_source` writes a blob under `<logDir>/recent-runs/streams/`.
- `recent_run_source_unavailable` marks the entry unavailable without throwing.
- A start-then-complete sequence creates a `playing` entry and finalizes it to `completed`, and
  `recent_runs` is broadcast on both transitions but **not** on intermediate status polls.
- A status carrying `bare_strobes`, `torn_strobes`, and a large `anomaly_count` records those values on
  the entry without changing its outcome — a completed run with 135,934 kind-4 anomalies is still
  `completed`, which is the regression guard for treating anomaly counts as failure.
- A cancel mid-run finalizes `stopped`; a serial disconnect mid-run finalizes `interrupted`.
- **A mask-stream rejection finalizes `error`** rather than leaving the entry `playing` — reject the
  chunk write and assert the entry reaches `error`. This is the path a status-only hook misses.
- **Displacement:** a `tas_upload` arriving while a run is armed or playing finalizes the outgoing
  entry as `stopped`, issues `TAS_CANCEL`, and creates no second `playing` entry. Drive it from a
  *second* client that has sent no `tas_cancel`, which is the cross-device case the browser cannot
  handle on its own.
- A status carrying both `complete=1` and a non-`ok` error finalizes as `error`, matching
  `applyTasFirmwareStatus`.
- Pressing `Trace` attaches **both** artifacts to the entry — the firmware dump as `manual` and the
  event-log file as `log`.
- `recent_run_load` returns base64 bytes byte-identical to the archived blob together with the stored
  `restore` triple.
- `recent_run_delete` and `recent_runs_clear` answer with the updated list; delete of the active run
  answers `recent_runs_error`.
- **Cross-device:** a second connected client sees the entry created by the first in its
  `recent_runs_list` reply, and its `recent_run_load` returns the same archived bytes. Drive this with
  two fake clients on one `SerialBridge` — it is the regression guard for the phone-re-runs-a-laptop-run
  property, which no single-client test would catch.
- A manual `Trace` dump during a run attaches its saved path to that run's entry with kind `manual`,
  and a frozen-ring auto dump attaches with kind `auto` — both asserted by reading the entry back out
  of the store, and neither changes the existing trace-dump reply payloads (the existing trace tests
  must pass unmodified).
- A trace attach that lands after the run finalized still records on the entry.
- **Isolation:** with a store stubbed to reject on every method, `tas_upload`, arm, start, status, and
  a trace dump all still produce their normal payloads. This is the §11.1 hard rule.

### 12.4 `apps/web/tests/ui/recent-runs.spec.js` (Playwright)

Extend the in-page fake bridge from `hardware-tas.spec.js` with `recent_runs_list`,
`recent_run_load`, `recent_run_delete`, and `recent_runs_clear` handlers, seeded with a fixture of
five entries covering all outcomes, both formats, and different modes, delays, skips, and lengths.

- `Recent` opens the dialog; the list renders one row per entry with duration, records and
  percentage, outcome badge, and the mode/delay/skip chips.
- `Completed runs only` hides the stopped, error, interrupted, and playing rows, updates the count,
  and survives closing and reopening the dialog (localStorage).
- Each sort option reorders the rows as expected, and the direction button flips them and updates its
  `aria-label`.
- **Load restores configuration:** choosing the `strobe`/`delay 1`/`skip 2` entry closes the dialog
  and leaves `#fileName`, `#playbackStatusText`, `#syncMode` (`strobe`), `#syncDelayPolls` (`1`), and
  `#syncSkipPolls` (`2`) all matching the entry, and the `tas_upload` message the fake bridge received
  carries the same `syncMode` and `skipPolls`. Add the mirror case for a `tdmask` entry: mode stays
  `poll` and the sync-mode field stays hidden.
- Loading a recent while a run is armed or playing sends `tas_cancel` before the new `tas_upload`.
- `Re-run` sends `tas_upload` then `tas_arm` and exactly one `tas_upload` (not two, proving the
  auto-upload dedupe holds), leaves the transport button reading `Start`, and sends **no** `tas_start`.
  It restores the same mode, delay, and skip as `Load`.
- `Re-run` is disabled with its explanatory `title` while the Arduino is offline, and `Load` is not.
- An entry with non-zero counters renders the anomaly chips; a clean entry renders none; a
  six-figure count does not change the outcome badge.
- Two entries sharing a file name with *different* content both render their short content tag; two
  entries that are the same file replayed render none, and a unique name renders none.
- `Re-run` while the bridge reports an active run asks for confirmation first, including on a client
  whose own status is merely `loaded` (the cross-device guard).
- A `recent_run_delete` from one client updates a dialog open in a second client, via the broadcast.
- Delete removes the row once the bridge answers; `Clear all` needs the confirm click, then shows the
  empty state.
- Both empty states render their exact copy.
- An entry with `sourceAvailable: false` renders with `Load` disabled and the explanatory note.
- An entry with trace files renders the trace line with base names and kinds, an entry with more than
  five collapses behind `Show all N traces` and expands in place on click, and `Copy path` puts the
  full repo-relative path on the clipboard
  (assert via `navigator.clipboard.readText()` with clipboard permissions granted, as the spec harness
  allows). An entry with no traces renders no trace line at all.
- Escape closes the dialog and focus returns to `#recentRunsButton`.
- Responsive: at 390×844 the dialog scrolls internally, the toolbar controls do not overflow, and no
  row is wider than the dialog (bounding-box assertions, as in the existing specs); in phone landscape
  (`844×390`) the dialog is still fully usable.

## 13. Acceptance Criteria

1. Playing a TAS, then reloading the browser, then `Recent` → `Load` reproduces the same file with the
   same mode, delay, and skip, and the resulting `tas_upload` is byte-identical to the original.
2. Runs that were stopped, errored, or interrupted are visibly distinguished and are hidden by
   `Completed runs only`.
3. Duration and records-played are correct for a run whose browser tab was closed mid-run.
4. Booting the same movie eight times produces eight entries and one archived stream file.
5. Deleting an entry removes it permanently; `Clear all` empties the list; a still-playing run cannot
   be deleted out from under itself.
6. All eight sort keys work in both directions.
7. A run that produced a `.trace` or `.stream.csv` lists those paths in its row, and deleting the entry
   leaves the files on disk.
8. `Re-run` on a connected bridge lands in the armed state with the restored settings, ready for
   `Start`, without a second upload and without releasing record 0 on its own.
9. Firmware counters appear on rows that have them, and a completed run with a six-figure benign
   anomaly count still reads as completed and still passes the `Completed runs only` filter.
10. A run whose source file has since been moved or deleted still loads from the archive, and two
    entries with the same base name are distinguishable in the list.
11. `npm run lint`, `npm test`, and `npm run check` pass.
12. Recents work with the Arduino disconnected, and every recents failure mode leaves playback intact.

## 14. Manual QA Additions

Append to the AGENTS.md checklist:

- `Recent` opens the dialog before `Connect` and lists runs from a previous session.
- Loading a recent run restores mode, delay, and skip, and the run plays on hardware.
- `Completed runs only` shows exactly the runs that reached the end.
- Sorting by name, date, time played, estimated length, completed, mode, delay, and skip all behave.
- Delete and `Clear all` persist across a bridge restart, and neither removes anything from
  `logs/trace/`.
- A run captured with `Trace` (and one run with `BRIDGE_TAS_TRACE_STREAM=1`) lists its trace paths in
  the row, and `Copy path` pastes correctly on the desktop and from the phone.
- `Re-run` on a real console: power-cycle, click `Re-run`, the panel reaches armed with the restored
  mode/delay/skip, and `Start` begins the run at the sync point.
- Load a movie from outside the repo (the Everdrive library), play it, then move the file on disk and
  load the run from `Recent` — it still plays.
- The dialog is usable at desktop, tablet, narrow mobile, and phone-landscape widths.

## 15. Settled Decisions

These were asked and answered; do not reopen them during implementation.

- **`completed` is automatic and means the firmware consumed every record.** It does not claim the game
  was beaten, and there is no manual "won" flag, star, or note field. The `Completed runs only`
  checkbox filters on exactly this signal.
- **Trace files are in scope**, referenced not owned (§3.2, §5, §9.1).
- **Anomaly counters and `Re-run` are in scope** (§3.2, §9.1, §9.3). Neither was in the first draft;
  both were promoted from follow-ups.
- **Only the file's base name is knowable**, so no entry stores a directory and restoring never
  depends on one (§3.4).
- **Retention is 100 entries / 256 MB**, oldest evicted first, never the active run.
- **A run that was uploaded and armed but never started gets no entry.** Only runs that reached
  `TAS_START` count as played.
- **Recents are per-bridge, and every client can act on every entry.** A run started on the laptop
  appears in the phone's list, and the phone can `Load` and `Re-run` it — the archived stream comes
  from the bridge, the serial link belongs to the bridge, and nothing in the flow needs the laptop's
  browser or the original file. This is intended: the phone is a remote for the console. See §9.3 for
  the single-active-run interaction it creates.
- **Runs that failed to load are not recorded.** A rejected file never becomes an entry.

## 16. Optional Follow-Ups

Not in scope. The two items that used to sit here — anomaly chips and `Re-run` — are now part of the
design. What remains is one genuinely larger feature that §3.4 points at.

- **Origin validation on the WebSocket upgrade.** `isBridgeUpgrade` checks only the pathname and the
  upgrade header ([`bridge-server.js:1742`](../../scripts/bridge-server.js#L1742)), so any page the user
  visits can already open `ws://localhost:8000/bridge` and press buttons, upload a movie, or cancel a
  run. Recents does not create that hole, but it does raise the stakes: `recent_run_load` reads archived
  bytes back out, and `recent_runs_clear` is destructive. Comparing `Origin` against `Host` would close
  it for both, and it must be written to still allow the LAN origin the phone uses. Worth doing as its
  own small change rather than as a condition of this feature.
- **A bridge-side library browser.** The only way TASDeck can ever know real file paths is for the
  Node side to enumerate configured directories (the Everdrive library, `To Do/`, `Fail/`) and serve
  that list to the browser, which would then load a movie by path instead of through the OS file
  picker. That turns recents from a run log into a library with locations, folder filters, and
  "runs of this file" grouping. It is a separate feature with its own design questions — which roots
  are allowed, how traversal is bounded, whether the phone may browse the laptop's disk — and it
  should not be smuggled into this one.
