const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_RECENT_RUN_SOURCE_BYTES,
  RECENT_RUNS_INDEX_VERSION,
  RecentRunsStore,
  normalizeRecentRunsIndex,
  recentRunEntryId,
  recentRunOutcomeForRunState,
  recentRunStreamFileName,
} = require("../../../scripts/recent-runs-store.js");
const { recentRunSourceKey } = require("../src/recents.js");
const {
  parseTasFileBytes,
  tasFramesToMasks,
  tasMasksPortCount,
  tasRunChecksum,
} = require("../src/tas.js");

function fakeClock(initial = "2026-07-29T18:00:00.000Z") {
  let milliseconds = new Date(initial).getTime();
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => {
      milliseconds += amount;
    },
  };
}

async function makeStore(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-recents-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = options.directory || path.join(root, "recent-runs");
  const store = new RecentRunsStore({ ...options, directory });
  await store.load();
  return { store, root, directory };
}

function makeR08Bytes(seed = 0) {
  return Buffer.from([0x80 ^ seed, 0x00, 0x40 ^ seed, 0x00]);
}

function makeRun(id, bytes = makeR08Bytes(), overrides = {}) {
  const fileName = overrides.fileName || `run-${id}.r08`;
  const parsed = parseTasFileBytes(fileName, bytes);
  const masks = tasFramesToMasks(parsed.frames);
  const portCount = tasMasksPortCount(masks);
  return {
    id,
    fileName,
    fileFormat: "r08",
    sourceKey: recentRunSourceKey(bytes),
    sourceByteLength: bytes.length,
    sourceFrameCount: 0,
    originalChecksum: tasRunChecksum(masks, portCount),
    originalFrameCount: masks.length,
    frameCount: masks.length,
    portCount,
    syncMode: "strobe",
    startDelayPolls: 1,
    skipPolls: 0,
    started: false,
    ...overrides,
  };
}

async function archiveRun(store, clock, run, bytes, outcome = "completed") {
  const need = await store.needsSource(run);
  if (need.needed) {
    await store.storeSource({ run, fileName: run.fileName, bytes });
  }
  const entryId = store.beginRun(run, { firmwareId: "v63" });
  await store.flush();
  clock.advance(1_000);
  await store.finalizeRun(entryId, {
    outcome,
    recordsPlayed: run.frameCount,
    firmwareId: "v63",
  });
  return entryId;
}

async function streamFiles(directory) {
  try {
    return await fsp.readdir(path.join(directory, "streams"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("exports deterministic pure store helpers", () => {
  assert.equal(recentRunOutcomeForRunState("complete"), "completed");
  assert.equal(recentRunOutcomeForRunState("stopped"), "stopped");
  assert.equal(recentRunOutcomeForRunState("error"), "error");
  assert.equal(recentRunOutcomeForRunState("disconnected"), "interrupted");
  assert.equal(recentRunOutcomeForRunState("newer-state"), "unknown");
  assert.match(recentRunEntryId({ id: 7 }, new Date("2026-07-29T18:42:11.503Z")), /-7$/);
  assert.equal(
    recentRunStreamFileName(`sha256:${"a".repeat(64)}`, "R08"),
    `${"a".repeat(64)}.r08`,
  );
  assert.equal(recentRunStreamFileName("not-a-digest", "r08"), "");
  assert.deepEqual(normalizeRecentRunsIndex({ version: 1, entries: [] }), {
    version: RECENT_RUNS_INDEX_VERSION,
    entries: [],
  });
  assert.throws(() => normalizeRecentRunsIndex({ version: 2, entries: [] }), /invalid/);
});

test("beginRun and finalizeRun persist one completed entry with duration and progress", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const run = makeRun(1);
  const id = store.beginRun(run, { firmwareId: "v63" });
  await store.flush();
  clock.advance(1_250);
  await store.finalizeRun(id, { outcome: "completed", recordsPlayed: 2 });

  const entries = store.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, "completed");
  assert.equal(entries[0].recordsPlayed, 2);
  assert.equal(entries[0].durationMs, 1_250);
  const persisted = JSON.parse(await fsp.readFile(path.join(directory, "index.json"), "utf8"));
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0].outcome, "completed");
});

test("finalizeRun maps stopped, error, and interrupted outcomes", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  for (const [index, outcome] of ["stopped", "error", "interrupted"].entries()) {
    const id = store.beginRun(makeRun(index + 1));
    clock.advance(10);
    await store.finalizeRun(id, { outcome, recordsPlayed: index });
  }
  assert.deepEqual(
    store.entries().map((entry) => entry.outcome),
    ["interrupted", "error", "stopped"],
  );
});

test("newest firmware counters persist and interrupted runs retain them", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const id = store.beginRun(makeRun(1));
  store.noteProgress(id, 1, {
    bare_strobes: 12,
    torn_strobes: 3,
    anomaly_count: 135_934,
    anomaly_kind: 4,
    anomaly_seq: 812,
    fw: "v64",
  });
  clock.advance(500);
  await store.finalizeRun(id, { outcome: "interrupted", recordsPlayed: 1 });

  const [entry] = store.entries();
  assert.equal(entry.outcome, "interrupted");
  assert.equal(entry.bareStrobes, 12);
  assert.equal(entry.tornStrobes, 3);
  assert.equal(entry.anomalyCount, 135_934);
  assert.equal(entry.anomalyKind, 4);
  assert.equal(entry.anomalySeq, 812);
  assert.equal(entry.firmwareId, "v64");
});

test("same source produces separate run entries and one deduplicated blob", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const first = makeRun(1, bytes);
  assert.deepEqual(await store.needsSource(first), { needed: true });
  await store.storeSource({ run: first, fileName: first.fileName, bytes });
  await archiveRun(store, clock, first, bytes);

  const second = makeRun(2, bytes);
  const secondNeed = await store.needsSource(second);
  assert.equal(secondNeed.needed, false);
  assert.match(secondNeed.contentKey, /^sha256:/);
  await archiveRun(store, clock, second, bytes);

  assert.equal(store.entries().length, 2);
  assert.equal((await streamFiles(directory)).length, 1);
  assert.equal(store.entries()[0].contentKey, store.entries()[1].contentKey);
});

test("a reused sourceKey with a different mask fingerprint requests bytes", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const first = makeRun(1, bytes);
  await archiveRun(store, clock, first, bytes);

  const collision = makeRun(2, bytes, {
    sourceKey: first.sourceKey,
    originalChecksum: first.originalChecksum ^ 0xff,
  });
  assert.deepEqual(await store.needsSource(collision), { needed: true });
});

test("storeSource rejects mismatched masks, checksum, and verified port count", async (t) => {
  const { store, directory } = await makeStore(t);
  const bytes = makeR08Bytes();
  const runs = [
    makeRun(1, bytes, { originalFrameCount: 3 }),
    makeRun(2, bytes, { originalChecksum: 255 }),
    makeRun(3, bytes, { portCount: 1 }),
  ];

  for (const run of runs) {
    const id = store.beginRun(run);
    await assert.rejects(
      store.storeSource({ run, fileName: run.fileName, bytes }),
      /source masks do not match/,
    );
    assert.equal(store.entries().find((entry) => entry.id === id).sourceAvailable, false);
  }
  assert.deepEqual(await streamFiles(directory), []);
});

test("storeSource rejects a raw payload above the 4 MiB cap", async (t) => {
  const { store, directory } = await makeStore(t);
  const bytes = Buffer.alloc(MAX_RECENT_RUN_SOURCE_BYTES + 1);
  const run = {
    id: 1,
    fileName: "large.r08",
    fileFormat: "r08",
    sourceKey: recentRunSourceKey(bytes),
    sourceByteLength: bytes.length,
  };
  await assert.rejects(
    store.storeSource({ run, fileName: run.fileName, bytes }),
    /too large/,
  );
  assert.deepEqual(await streamFiles(directory), []);
});

test("loadSource returns byte-identical bytes and the restore triple", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const run = makeRun(1, bytes, {
    syncMode: "latch",
    startDelayPolls: 9,
    skipPolls: 1,
    frameCount: 1,
  });
  const id = await archiveRun(store, clock, run, bytes);
  const loaded = await store.loadSource(id);

  assert.equal(Buffer.compare(loaded.bytes, bytes), 0);
  assert.deepEqual(loaded.restore, { syncMode: "latch", delayPolls: 9, skipPolls: 1 });
  assert.equal(loaded.portCount, 2);
  assert.equal(loaded.totalRecords, 2);
});

test("deleteRun garbage-collects a shared blob only after its last reference", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const firstId = await archiveRun(store, clock, makeRun(1, bytes), bytes);
  const secondId = await archiveRun(store, clock, makeRun(2, bytes), bytes);

  assert.equal((await streamFiles(directory)).length, 1);
  await store.deleteRun(firstId);
  assert.equal((await streamFiles(directory)).length, 1);
  await store.deleteRun(secondId);
  assert.equal((await streamFiles(directory)).length, 0);
});

test("deleteRun refuses a playing entry and clearRuns keeps it", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const finishedId = store.beginRun(makeRun(1));
  clock.advance(1);
  await store.finalizeRun(finishedId, { outcome: "stopped", recordsPlayed: 0 });
  const activeId = store.beginRun(makeRun(2));
  await store.flush();

  await assert.rejects(store.deleteRun(activeId, { activeId }), /still playing/);
  const cleared = await store.clearRuns({ activeId });
  assert.deepEqual(cleared, { removed: 1, keptActive: true });
  assert.deepEqual(store.entries().map((entry) => entry.id), [activeId]);
});

test("retention evicts the oldest finalized entry and never a playing entry", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now, maxEntries: 2 });
  const oldest = store.beginRun(makeRun(1));
  clock.advance(1);
  await store.finalizeRun(oldest, { outcome: "stopped", recordsPlayed: 0 });
  clock.advance(1);
  const playing = store.beginRun(makeRun(2));
  await store.flush();
  clock.advance(1);
  const newest = store.beginRun(makeRun(3));
  clock.advance(1);
  await store.finalizeRun(newest, { outcome: "completed", recordsPlayed: 2 });

  assert.deepEqual(
    new Set(store.entries().map((entry) => entry.id)),
    new Set([playing, newest]),
  );
  assert.equal(store.entries().find((entry) => entry.id === playing).outcome, "playing");
});

test("trace attachment is keyed by bridge run id, newest-first, and works after finalize", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const id = store.beginRun(makeRun(7));
  clock.advance(1);
  await store.finalizeRun(id, { outcome: "completed", recordsPlayed: 2 });
  await store.attachTraceForRun(7, { path: "logs/trace/one.trace", kind: "manual" });
  clock.advance(1);
  await store.attachTraceForRun(7, { path: "logs/trace/two.csv", kind: "auto" });
  await store.attachTraceForRun(7, { path: "logs/trace/two.csv", kind: "auto" });
  await store.attachTraceForRun(999, { path: "logs/trace/missing.trace", kind: "manual" });

  assert.deepEqual(
    store.entries()[0].traceFiles.map((trace) => trace.path),
    ["logs/trace/two.csv", "logs/trace/one.trace"],
  );
});

test("zero, one, and forty trace files still produce exactly one entry per run", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const zero = store.beginRun(makeRun(1));
  const one = store.beginRun(makeRun(2));
  const forty = store.beginRun(makeRun(3));
  await store.attachTraceForRun(2, { path: "logs/trace/only.trace", kind: "manual" });
  for (let index = 0; index < 40; index += 1) {
    await store.attachTraceForRun(3, {
      path: `logs/trace/burst-${index}.trace`,
      kind: "auto",
    });
  }

  assert.equal(store.entries().length, 3);
  assert.equal(store.entries().find((entry) => entry.id === zero).traceFiles.length, 0);
  assert.equal(store.entries().find((entry) => entry.id === one).traceFiles.length, 1);
  assert.equal(store.entries().find((entry) => entry.id === forty).traceFiles.length, 40);
});

test("trace runaway guard truncates at the injected limit", async (t) => {
  const { store } = await makeStore(t, { tracePathLimit: 3 });
  store.beginRun(makeRun(1));
  for (let index = 0; index < 5; index += 1) {
    await store.attachTraceForRun(1, {
      path: `logs/trace/${index}.trace`,
      kind: "auto",
    });
  }
  const [entry] = store.entries();
  assert.equal(entry.traceFiles.length, 3);
  assert.equal(entry.traceFilesTruncated, true);
});

test("delete, clear, and retention eviction never delete referenced trace files", async (t) => {
  const clock = fakeClock();
  const { store, root } = await makeStore(t, { now: clock.now, maxEntries: 1 });
  const traceDirectory = path.join(root, "logs", "trace");
  await fsp.mkdir(traceDirectory, { recursive: true });

  const deleteTrace = path.join(traceDirectory, "delete.trace");
  await fsp.writeFile(deleteTrace, "delete");
  const deleteId = store.beginRun(makeRun(1));
  await store.attachTraceForRun(1, { path: deleteTrace, kind: "manual" });
  clock.advance(1);
  await store.finalizeRun(deleteId, { outcome: "stopped", recordsPlayed: 0 });
  await store.deleteRun(deleteId);
  assert.equal((await fsp.stat(deleteTrace)).isFile(), true);

  const clearTrace = path.join(traceDirectory, "clear.trace");
  await fsp.writeFile(clearTrace, "clear");
  const clearId = store.beginRun(makeRun(2));
  await store.attachTraceForRun(2, { path: clearTrace, kind: "manual" });
  clock.advance(1);
  await store.finalizeRun(clearId, { outcome: "stopped", recordsPlayed: 0 });
  await store.clearRuns();
  assert.equal((await fsp.stat(clearTrace)).isFile(), true);

  const evictionTrace = path.join(traceDirectory, "eviction.trace");
  await fsp.writeFile(evictionTrace, "eviction");
  const evictionId = store.beginRun(makeRun(3));
  await store.attachTraceForRun(3, { path: evictionTrace, kind: "manual" });
  clock.advance(1);
  await store.finalizeRun(evictionId, { outcome: "stopped", recordsPlayed: 0 });
  const replacementId = store.beginRun(makeRun(4));
  clock.advance(1);
  await store.finalizeRun(replacementId, { outcome: "completed", recordsPlayed: 2 });
  assert.equal((await fsp.stat(evictionTrace)).isFile(), true);
});

test("finalizeRun is idempotent and a missing id is a no-op", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const id = store.beginRun(makeRun(1));
  clock.advance(100);
  const first = await store.finalizeRun(id, { outcome: "stopped", recordsPlayed: 1 });
  clock.advance(5_000);
  const second = await store.finalizeRun(id, { outcome: "error", recordsPlayed: 2 });
  const missing = await store.finalizeRun("evicted-id", {
    outcome: "error",
    recordsPlayed: 9,
  });

  assert.equal(second.outcome, "stopped");
  assert.equal(second.endedAt, first.endedAt);
  assert.equal(second.recordsPlayed, 1);
  assert.equal(missing, null);
});

test("deliberate dereference deletes immediately while a young discovered orphan gets grace", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, {
    now: clock.now,
    orphanGraceMs: 3_600_000,
  });
  const bytes = makeR08Bytes();
  const id = await archiveRun(store, clock, makeRun(1, bytes), bytes);
  const [blobName] = await streamFiles(directory);
  const orphanPath = path.join(directory, "streams", "orphan.r08");
  await fsp.writeFile(orphanPath, "orphan");
  const tenMinutesAgo = new Date(clock.now().getTime() - 600_000);
  await fsp.utimes(orphanPath, tenMinutesAgo, tenMinutesAgo);

  await store.deleteRun(id);
  assert.equal((await streamFiles(directory)).includes(blobName), false);
  assert.equal((await fsp.stat(orphanPath)).isFile(), true);
  clock.advance(3_600_001);
  await store.gcOrphans();
  await assert.rejects(fsp.stat(orphanPath), { code: "ENOENT" });
});

test("startup and post-store GC remove expired orphans and count their physical bytes", async (t) => {
  const clock = fakeClock();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-recents-cap-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "recent-runs");
  const streamsDirectory = path.join(directory, "streams");
  await fsp.mkdir(streamsDirectory, { recursive: true });
  for (const name of ["old-one.r08", "old-two.r08"]) {
    const filePath = path.join(streamsDirectory, name);
    await fsp.writeFile(filePath, Buffer.alloc(8));
    const old = new Date(clock.now().getTime() - 7_200_000);
    await fsp.utimes(filePath, old, old);
  }

  const store = new RecentRunsStore({
    directory,
    now: clock.now,
    maxStreamBytes: 8,
    orphanGraceMs: 3_600_000,
  });
  await store.load();
  assert.equal((await streamFiles(directory)).length, 0);

  const postStoreOrphan = path.join(streamsDirectory, "post-store-orphan.r08");
  await fsp.writeFile(postStoreOrphan, Buffer.alloc(8));
  const old = new Date(clock.now().getTime() - 7_200_000);
  await fsp.utimes(postStoreOrphan, old, old);
  const bytes = makeR08Bytes();
  const run = makeRun(1, bytes);
  await store.needsSource(run);
  await store.storeSource({ run, fileName: run.fileName, bytes });
  assert.equal((await streamFiles(directory)).includes("post-store-orphan.r08"), false);
  const totalBytes = (
    await Promise.all(
      (await streamFiles(directory)).map((name) =>
        fsp.stat(path.join(streamsDirectory, name)),
      ),
    )
  ).reduce((total, stat) => total + stat.size, 0);
  assert.ok(totalBytes <= 8);
});

test("a missing reused blob asks the browser for bytes again", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  await archiveRun(store, clock, makeRun(1, bytes), bytes);
  const [blobName] = await streamFiles(directory);
  await fsp.unlink(path.join(directory, "streams", blobName));

  assert.deepEqual(await store.needsSource(makeRun(2, bytes)), { needed: true });
});

test("pending uploads dedupe by fingerprint without retaining run masks", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now, maxPendingSources: 3 });
  const bytes = makeR08Bytes();
  const firstRun = makeRun(1, bytes);

  assert.deepEqual(await store.needsSource(firstRun), { needed: true });
  await store.storeSource({ run: firstRun, fileName: firstRun.fileName, bytes });

  // Re-uploading the same file — what changing sync mode or skip does — must not
  // ask for the bytes a second time even though no run has started yet.
  const secondNeed = await store.needsSource(makeRun(2, bytes));
  assert.equal(secondNeed.needed, false);
  assert.equal(secondNeed.contentKey, firstRun.recentContentKey);

  // The tracked fingerprints stay bounded and hold no reference to the runs, so
  // a session of opening files without playing them cannot pin their masks.
  for (let id = 3; id <= 10; id += 1) {
    await store.needsSource(makeRun(id, makeR08Bytes(id)));
  }
  assert.equal(store.pendingSources.size, 3);
  assert.equal(
    [...store.pendingSources.values()].some((snapshot) => "masks" in snapshot),
    false,
  );
  assert.equal(store.currentPendingRun.id, 10);

  store.beginRun(store.currentPendingRun, { firmwareId: "v63" });
  assert.equal(store.currentPendingRun, null);
  assert.equal(store.pendingSources.size, 2);
  await store.flush();
});

test("load persists entries registered while the index was still being read", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  await archiveRun(store, clock, makeRun(1, bytes), bytes);
  await store.flush();

  // A second store over the same directory begins a run before its load
  // resolves, which is the window where a queued write could otherwise drop the
  // history it had not merged yet.
  const reopened = new RecentRunsStore({ directory, now: clock.now });
  const loading = reopened.load();
  const entryId = reopened.beginRun(makeRun(2, makeR08Bytes(2)), { firmwareId: "v63" });
  await loading;
  await reopened.flush();
  assert.equal(reopened.entries().length, 2);

  const persisted = JSON.parse(await fsp.readFile(path.join(directory, "index.json"), "utf8"));
  assert.equal(persisted.entries.length, 2);
  assert.equal(
    persisted.entries.some((entry) => entry.id === entryId),
    true,
  );
});

test("loadSource disables a row for a missing blob but not for a transient failure", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const entryId = await archiveRun(store, clock, makeRun(1, bytes), bytes);
  const [blobName] = await streamFiles(directory);
  const blobPath = path.join(directory, "streams", blobName);

  // A directory where the blob belongs reads as EISDIR: unreadable now, but not
  // proof the archive is gone, so the row must stay loadable.
  await fsp.unlink(blobPath);
  await fsp.mkdir(blobPath);
  await assert.rejects(() => store.loadSource(entryId), /EISDIR/);
  assert.equal(store.entries()[0].sourceAvailable, true);

  await fsp.rmdir(blobPath);
  await assert.rejects(() => store.loadSource(entryId), /ENOENT/);
  assert.equal(store.entries()[0].sourceAvailable, false);
});

test("clearRuns reports a kept run held only by the caller's active id", async (t) => {
  const clock = fakeClock();
  const { store } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const keptId = await archiveRun(store, clock, makeRun(1, bytes), bytes, "completed");
  await archiveRun(store, clock, makeRun(2, makeR08Bytes(2)), makeR08Bytes(2), "stopped");

  const result = await store.clearRuns({ activeId: keptId });
  assert.deepEqual(result, { removed: 1, keptActive: true });
  assert.deepEqual(
    store.entries().map((entry) => entry.id),
    [keptId],
  );
});

test("startup repair interrupts playing entries at lastObservedAt, not restart time", async (t) => {
  const clock = fakeClock("2026-07-30T08:00:00.000Z");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-recents-repair-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "recent-runs");
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "playing-1",
          fileName: "movie.r08",
          fileFormat: "r08",
          startedAt: "2026-07-29T18:00:00.000Z",
          lastObservedAt: "2026-07-29T18:05:00.000Z",
          outcome: "playing",
          bridgeRunId: 1,
        },
      ],
    }),
  );

  const store = new RecentRunsStore({ directory, now: clock.now });
  await store.load();
  const [entry] = store.entries();
  assert.equal(entry.outcome, "interrupted");
  assert.equal(entry.endedAt, "2026-07-29T18:05:00.000Z");
  assert.equal(entry.durationMs, 300_000);
});

test("corrupt index is quarantined and load starts empty without throwing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-recents-corrupt-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "recent-runs");
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, "index.json"), "{ definitely not json");
  const store = new RecentRunsStore({ directory });

  await store.load();
  assert.deepEqual(store.entries(), []);
  assert.equal(
    (await fsp.readdir(directory)).some((name) => /^index\.corrupt-.*\.json$/.test(name)),
    true,
  );
});

test("atomic writes leave no index.json.tmp behind", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const id = store.beginRun(makeRun(1));
  await store.flush();
  clock.advance(1);
  await store.finalizeRun(id, { outcome: "completed", recordsPlayed: 2 });
  assert.equal(
    (await fsp.readdir(directory)).includes("index.json.tmp"),
    false,
  );
});

test("progress persistence is throttled and terminal progress always flushes", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, {
    now: clock.now,
    progressFlushMs: 30_000,
  });
  const id = store.beginRun(makeRun(1));
  await store.flush();
  const writesAfterBegin = store.writeCount;
  for (let index = 0; index < 10; index += 1) {
    store.noteProgress(id, index, { anomaly_count: index });
  }
  await store.flush();
  assert.ok(store.writeCount - writesAfterBegin <= 1);

  clock.advance(30_000);
  store.noteProgress(id, 10, { anomaly_count: 10 });
  await store.flush();
  assert.ok(store.writeCount - writesAfterBegin <= 2);
  clock.advance(1);
  await store.finalizeRun(id, { outcome: "stopped", recordsPlayed: 11 });
  const persisted = JSON.parse(await fsp.readFile(path.join(directory, "index.json"), "utf8"));
  assert.equal(persisted.entries[0].recordsPlayed, 11);
});

test("orphan grace keeps young blobs and removes old ones with an injected clock", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, {
    now: clock.now,
    orphanGraceMs: 3_600_000,
  });
  const youngPath = path.join(directory, "streams", "young.r08");
  const oldPath = path.join(directory, "streams", "old.r08");
  await fsp.writeFile(youngPath, "young");
  await fsp.writeFile(oldPath, "old");
  const old = new Date(clock.now().getTime() - 3_600_001);
  await fsp.utimes(oldPath, old, old);

  await store.gcOrphans();
  assert.equal((await fsp.stat(youngPath)).isFile(), true);
  await assert.rejects(fsp.stat(oldPath), { code: "ENOENT" });
});

test("source bytes received during playback are deferred until the terminal transition", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const run = makeRun(1, bytes, { started: true });
  const id = store.beginRun(run);
  const result = await store.storeSource({ run, fileName: run.fileName, bytes });
  assert.deepEqual(result, { deferred: true });
  assert.deepEqual(await streamFiles(directory), []);

  clock.advance(1);
  await store.finalizeRun(id, { outcome: "completed", recordsPlayed: 2 });
  for (let attempt = 0; attempt < 20 && (await streamFiles(directory)).length === 0; attempt += 1) {
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 5);
    });
  }
  assert.equal((await streamFiles(directory)).length, 1);
});

test("loadSource detects tampering, refuses bytes, and marks the entry unavailable", async (t) => {
  const clock = fakeClock();
  const { store, directory } = await makeStore(t, { now: clock.now });
  const bytes = makeR08Bytes();
  const id = await archiveRun(store, clock, makeRun(1, bytes), bytes);
  const [blobName] = await streamFiles(directory);
  await fsp.writeFile(path.join(directory, "streams", blobName), Buffer.alloc(bytes.length, 0xff));

  await assert.rejects(store.loadSource(id), /integrity/);
  assert.equal(store.entries()[0].sourceAvailable, false);
});

test("content keys name blobs by the sha256 of the original bytes", async (t) => {
  const { store, directory } = await makeStore(t);
  const bytes = makeR08Bytes();
  const run = makeRun(1, bytes);
  await store.storeSource({ run, fileName: run.fileName, bytes });
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(await streamFiles(directory), [`${digest}.r08`]);
});
