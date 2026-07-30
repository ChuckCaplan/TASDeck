const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RECENT_RUN_OUTCOMES,
  RECENT_RUN_SORT_DIRECTIONS,
  RECENT_RUN_SORT_KEYS,
  annotateDuplicateRecentRunNames,
  filterRecentRuns,
  formatRecentRunDuration,
  formatRecentRunProgress,
  formatRecentRunRelativeTime,
  normalizeRecentRunEntry,
  recentRunAnomalyChips,
  recentRunConfigChips,
  recentRunElapsedMs,
  recentRunEstimatedLength,
  recentRunModeLabel,
  recentRunSourceKey,
  recentRunTraceSummary,
  restoreOptionsForRecentRun,
  sortRecentRuns,
} = require("../src/recents.js");

const NOW = new Date("2026-07-29T20:00:00.000Z");

function entry(id, overrides = {}) {
  return normalizeRecentRunEntry({
    id,
    fileName: `${id}.r08`,
    fileFormat: "r08",
    sourceAvailable: true,
    sourceBytes: 10,
    contentKey: `sha256:${id.padEnd(64, "0")}`,
    syncMode: "poll",
    delayPolls: 0,
    skipPolls: 0,
    portCount: 2,
    totalRecords: 600,
    effectiveRecords: 600,
    recordsPlayed: 300,
    startedAt: "2026-07-29T18:00:00.000Z",
    endedAt: "2026-07-29T18:00:05.000Z",
    durationMs: 5_000,
    outcome: "stopped",
    ...overrides,
  });
}

test("exports the decided outcome, sort-key, and direction sets", () => {
  assert.deepEqual(RECENT_RUN_OUTCOMES, [
    "playing",
    "completed",
    "stopped",
    "error",
    "interrupted",
    "unknown",
  ]);
  assert.deepEqual(RECENT_RUN_SORT_KEYS, [
    "date",
    "name",
    "played",
    "length",
    "completed",
    "mode",
    "delay",
    "skip",
  ]);
  assert.deepEqual(RECENT_RUN_SORT_DIRECTIONS, ["desc", "asc"]);
});

test("recentRunSourceKey is stable, length-sensitive, and content-sensitive", () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 255]);
  const identical = Uint8Array.from(bytes);
  const changed = Uint8Array.from([0, 1, 2, 2, 255]);
  const longer = Uint8Array.from([0, 1, 2, 3, 255, 0]);

  assert.equal(recentRunSourceKey(bytes), recentRunSourceKey(identical.buffer));
  assert.match(recentRunSourceKey(bytes), /^fnv1a32:[0-9a-f]{8}:5$/);
  assert.notEqual(recentRunSourceKey(bytes), recentRunSourceKey(changed));
  assert.notEqual(recentRunSourceKey(bytes), recentRunSourceKey(longer));
});

test("normalizeRecentRunEntry coerces numeric strings and supplies safe defaults", () => {
  const normalized = normalizeRecentRunEntry({
    id: 7,
    sourceAvailable: true,
    sourceBytes: "446214",
    delayPolls: "1",
    skipPolls: "2",
    totalRecords: "10",
    effectiveRecords: "8",
    recordsPlayed: "4",
    durationMs: "123.5",
    bareStrobes: "12",
    traceFiles: [{ path: 17, kind: "manual", at: null }, null],
    outcome: "future-outcome",
  });

  assert.equal(normalized.id, "7");
  assert.equal(normalized.sourceAvailable, true);
  assert.equal(normalized.sourceBytes, 446214);
  assert.equal(normalized.delayPolls, 1);
  assert.equal(normalized.skipPolls, 2);
  assert.equal(normalized.totalRecords, 10);
  assert.equal(normalized.effectiveRecords, 8);
  assert.equal(normalized.recordsPlayed, 4);
  assert.equal(normalized.durationMs, 123.5);
  assert.equal(normalized.bareStrobes, 12);
  assert.equal(normalized.outcome, "unknown");
  assert.deepEqual(normalized.traceFiles, [{ path: "17", kind: "manual", at: "" }]);
  assert.equal(normalized.error, "");
  assert.equal(normalized.traceFilesTruncated, false);
});

test("completed-only filtering keeps completed and explicitly drops every other outcome", () => {
  const outcomes = ["completed", "stopped", "error", "interrupted", "playing", "unknown"];
  const entries = outcomes.map((outcome) => entry(outcome, { outcome }));

  assert.deepEqual(
    filterRecentRuns(entries, { completedOnly: true }).map((run) => run.outcome),
    ["completed"],
  );
  assert.deepEqual(
    filterRecentRuns(entries, { completedOnly: false }).map((run) => run.outcome),
    outcomes,
  );
});

test("sortRecentRuns sorts all eight keys in both directions", () => {
  const pairs = [
    {
      key: "date",
      low: { startedAt: "2026-07-27T00:00:00.000Z" },
      high: { startedAt: "2026-07-29T00:00:00.000Z" },
    },
    {
      key: "name",
      low: { fileName: "Level 2.r08" },
      high: { fileName: "Level 10.r08" },
    },
    { key: "played", low: { durationMs: 1_000 }, high: { durationMs: 9_000 } },
    {
      key: "length",
      low: { sourceFrameCount: 60, effectiveRecords: 9_000 },
      high: { sourceFrameCount: 0, effectiveRecords: 600 },
    },
    { key: "completed", low: { outcome: "stopped" }, high: { outcome: "completed" } },
    { key: "mode", low: { syncMode: "poll" }, high: { syncMode: "latch" } },
    { key: "delay", low: { delayPolls: 1 }, high: { delayPolls: 10 } },
    { key: "skip", low: { skipPolls: 2 }, high: { skipPolls: 20 } },
  ];

  for (const pair of pairs) {
    const low = entry(`${pair.key}-low`, pair.low);
    const high = entry(`${pair.key}-high`, pair.high);
    assert.deepEqual(
      sortRecentRuns([high, low], { key: pair.key, direction: "asc", now: NOW }).map(
        (run) => run.id,
      ),
      [low.id, high.id],
      `${pair.key} ascending`,
    );
    assert.deepEqual(
      sortRecentRuns([low, high], { key: pair.key, direction: "desc", now: NOW }).map(
        (run) => run.id,
      ),
      [high.id, low.id],
      `${pair.key} descending`,
    );
  }
});

test("sortRecentRuns times a playing entry from injected now and ranks poll, strobe, latch", () => {
  const playing = entry("playing", {
    outcome: "playing",
    startedAt: "2026-07-29T19:58:00.000Z",
    durationMs: 0,
  });
  const finished = entry("finished", { durationMs: 60_000 });
  assert.equal(recentRunElapsedMs(playing, NOW), 120_000);
  assert.deepEqual(
    sortRecentRuns([finished, playing], { key: "played", direction: "desc", now: NOW }).map(
      (run) => run.id,
    ),
    ["playing", "finished"],
  );

  const modes = ["latch", "poll", "strobe"].map((syncMode) => entry(syncMode, { syncMode }));
  assert.deepEqual(
    sortRecentRuns(modes, { key: "mode", direction: "asc", now: NOW }).map(
      (run) => run.syncMode,
    ),
    ["poll", "strobe", "latch"],
  );
});

test("sortRecentRuns breaks equal primary keys by newest date then id without mutating input", () => {
  const older = entry("z", { delayPolls: 4, startedAt: "2026-07-28T00:00:00.000Z" });
  const newestB = entry("b", { delayPolls: 4, startedAt: "2026-07-29T00:00:00.000Z" });
  const newestA = entry("a", { delayPolls: 4, startedAt: "2026-07-29T00:00:00.000Z" });
  const input = [older, newestB, newestA];

  assert.deepEqual(
    sortRecentRuns(input, { key: "delay", direction: "asc", now: NOW }).map((run) => run.id),
    ["a", "b", "z"],
  );
  assert.deepEqual(input.map((run) => run.id), ["z", "b", "a"]);
});

test("recentRunEstimatedLength distinguishes exact source frames from estimates", () => {
  const exact = recentRunEstimatedLength(entry("exact", { sourceFrameCount: 600, effectiveRecords: 1 }));
  const estimated = recentRunEstimatedLength(
    entry("estimated", { sourceFrameCount: 0, effectiveRecords: 600 }),
  );
  const empty = recentRunEstimatedLength(
    entry("empty", { sourceFrameCount: 0, effectiveRecords: 0 }),
  );

  assert.equal(exact.exact, true);
  assert.equal(estimated.exact, false);
  assert.equal(exact.ms, estimated.ms);
  assert.deepEqual(empty, { ms: 0, exact: false });
  assert.equal(Number.isNaN(empty.ms), false);
});

test("formatRecentRunDuration follows the run-timer digit rules", () => {
  assert.equal(formatRecentRunDuration(0), "0:00");
  assert.equal(formatRecentRunDuration(59_000), "0:59");
  assert.equal(formatRecentRunDuration(60_000), "1:00");
  assert.equal(formatRecentRunDuration(1_133_109), "18:53");
  assert.equal(formatRecentRunDuration(3_845_000), "1:04:05");
});

test("formatRecentRunProgress reports full, partial, and zero-total progress safely", () => {
  assert.equal(
    formatRecentRunProgress(223_107, 223_107),
    "223,107 / 223,107 records (100%)",
  );
  assert.equal(formatRecentRunProgress(50, 200), "50 / 200 records (25%)");
  assert.equal(formatRecentRunProgress(0, 0), "0 / 0 records (0%)");
  assert.doesNotMatch(formatRecentRunProgress(0, 0), /NaN/);
});

test("formatRecentRunRelativeTime observes each bucket boundary", () => {
  assert.equal(formatRecentRunRelativeTime("2026-07-29T19:59:01.000Z", NOW), "just now");
  assert.equal(formatRecentRunRelativeTime("2026-07-29T19:59:00.000Z", NOW), "1m ago");
  assert.equal(formatRecentRunRelativeTime("2026-07-29T19:55:00.000Z", NOW), "5m ago");
  assert.equal(formatRecentRunRelativeTime("2026-07-29T19:00:00.000Z", NOW), "1h ago");
  assert.equal(formatRecentRunRelativeTime("2026-07-29T18:00:00.000Z", NOW), "2h ago");
  assert.equal(formatRecentRunRelativeTime("2026-07-28T20:00:00.000Z", NOW), "yesterday");
  assert.equal(formatRecentRunRelativeTime("2026-07-27T20:00:00.000Z", NOW), "Jul 27");
});

test("recentRunModeLabel matches the three sync picker labels exactly", () => {
  assert.equal(recentRunModeLabel("poll"), "completed reads");
  assert.equal(recentRunModeLabel("strobe"), "per strobe (r08 replay)");
  assert.equal(recentRunModeLabel("latch"), "per latch window (dpcm r08)");
});

test("recentRunConfigChips includes format, playback configuration, ports, and firmware", () => {
  assert.deepEqual(
    recentRunConfigChips(
      entry("chips", {
        fileFormat: "r08",
        syncMode: "strobe",
        delayPolls: 1,
        skipPolls: 2,
        portCount: 2,
        firmwareId: "v63",
      }),
    ),
    ["R08", "per strobe", "delay 1", "skip 2", "2 ports", "fw v63"],
  );
});

test("recentRunAnomalyChips omits clean counters and gives each counter one muted text chip", () => {
  assert.deepEqual(recentRunAnomalyChips(entry("clean")), []);
  const chips = recentRunAnomalyChips(
    entry("diagnostic", {
      bareStrobes: 12,
      tornStrobes: 3,
      anomalyCount: 135_934,
      anomalyKind: 4,
    }),
  );
  assert.deepEqual(chips, [
    "12 bare strobes",
    "3 torn strobes",
    "135,934 anomalies (kind 4)",
  ]);
  assert.equal(chips.some((chip) => typeof chip !== "string"), false);
});

test("annotateDuplicateRecentRunNames tags only same-name, distinct-content entries", () => {
  const unique = entry("unique", { fileName: "unique.r08" });
  const replayOne = entry("replay-one", {
    fileName: "same.r08",
    contentKey: "sha256:aaaaaaaa11111111",
  });
  const replayTwo = entry("replay-two", {
    fileName: "SAME.R08",
    contentKey: "sha256:aaaaaaaa11111111",
  });
  const collisionOne = entry("collision-one", {
    fileName: "collision.r08",
    contentKey: "sha256:bbbbbbb11111111",
  });
  const collisionTwo = entry("collision-two", {
    fileName: "COLLISION.R08",
    contentKey: "sha256:ccccccc22222222",
  });
  const missingKey = entry("run-missing7", {
    fileName: "collision.r08",
    contentKey: "",
  });
  const input = [unique, replayOne, replayTwo, collisionOne, collisionTwo, missingKey];
  const annotated = annotateDuplicateRecentRunNames(input);

  assert.equal(annotated[0].nameTag, undefined);
  assert.equal(annotated[1].nameTag, undefined);
  assert.equal(annotated[2].nameTag, undefined);
  assert.equal(annotated[3].nameTag, "bbbbbbb");
  assert.equal(annotated[4].nameTag, "ccccccc");
  assert.equal(typeof annotated[5].nameTag, "string");
  assert.notEqual(annotated[5].nameTag, "");
  assert.equal(input.some((run) => Object.hasOwn(run, "nameTag")), false);
  assert.notEqual(annotated[3], input[3]);
});

test("recentRunTraceSummary extracts base names, collapses five, and expands in place", () => {
  const traces = Array.from({ length: 7 }, (_unused, index) => ({
    path: `logs/trace/run-${index}.stream.csv`,
    kind: index === 0 ? "stream" : "auto",
    at: `2026-07-29T18:00:0${index}.000Z`,
  }));
  const run = entry("traces", { traceFiles: traces, traceFilesTruncated: true });
  const collapsed = recentRunTraceSummary(run, { expanded: false });
  const expanded = recentRunTraceSummary(run, { expanded: true });

  assert.equal(collapsed.visible.length, 5);
  assert.equal(collapsed.visible[0].baseName, "run-0.stream.csv");
  assert.equal(collapsed.hiddenCount, 2);
  assert.equal(collapsed.truncated, true);
  assert.equal(expanded.visible.length, 7);
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(recentRunTraceSummary(entry("none")).visible.length, 0);
  assert.equal(
    recentRunTraceSummary(entry("five", { traceFiles: traces.slice(0, 5) })).hiddenCount,
    0,
  );
});

test("restoreOptionsForRecentRun honors r08 modes, clamps values, and never restores ports", () => {
  for (const syncMode of ["poll", "strobe", "latch"]) {
    assert.equal(
      restoreOptionsForRecentRun(
        entry(syncMode, { fileFormat: "r08", syncMode, delayPolls: 1, skipPolls: 2 }),
      ).syncMode,
      syncMode,
    );
  }

  assert.deepEqual(
    restoreOptionsForRecentRun(
      entry("tdmask", {
        fileFormat: "tdmask",
        syncMode: "strobe",
        delayPolls: 4_000,
        skipPolls: 100,
        totalRecords: 10,
        portCount: 1,
      }),
    ),
    { syncMode: "poll", delayPolls: 3600, skipPolls: 9 },
  );
  assert.deepEqual(
    restoreOptionsForRecentRun({
      fileFormat: "r08",
      syncMode: "invalid",
      delayPolls: Number.NaN,
      skipPolls: -1,
      totalRecords: 0,
    }),
    { syncMode: "poll", delayPolls: 0, skipPolls: 0 },
  );
  assert.deepEqual(
    restoreOptionsForRecentRun({ fileFormat: "r08", syncMode: "latch" }),
    { syncMode: "latch", delayPolls: 0, skipPolls: 0 },
  );
  assert.equal(Object.hasOwn(restoreOptionsForRecentRun(entry("ports")), "portCount"), false);
});
