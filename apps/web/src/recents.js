(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.TasDeckRecents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const RECENT_RUN_OUTCOMES = [
    "playing",
    "completed",
    "stopped",
    "error",
    "interrupted",
    "unknown",
  ];
  const RECENT_RUN_SORT_KEYS = [
    "date",
    "name",
    "played",
    "length",
    "completed",
    "mode",
    "delay",
    "skip",
  ];
  const RECENT_RUN_SORT_DIRECTIONS = ["desc", "asc"];
  const RECENT_RUN_TRACE_VISIBLE = 5;
  const NES_FRAMES_PER_SECOND = 60.0988;
  const MAX_START_DELAY_POLLS = 3600;
  const SYNC_MODES = ["poll", "strobe", "latch"];
  const MODE_RANK = {
    poll: 0,
    strobe: 1,
    latch: 2,
  };

  function recentRunSourceKey(bytes) {
    const view = normalizeBytes(bytes);
    let hash = 0x811c9dc5;
    for (const byte of view) {
      hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${view.byteLength}`;
  }

  function normalizeRecentRunEntry(raw = {}) {
    const outcome = stringValue(raw.outcome);
    const traceFiles = Array.isArray(raw.traceFiles)
      ? raw.traceFiles
          .map((trace) => normalizeRecentRunTrace(trace))
          .filter((trace) => trace.path)
      : [];

    return {
      id: stringValue(raw.id),
      fileName: stringValue(raw.fileName),
      fileFormat: normalizeFileFormat(raw.fileFormat),
      sourceKey: stringValue(raw.sourceKey),
      contentKey: stringValue(raw.contentKey),
      sourceAvailable: raw.sourceAvailable === true,
      sourceBytes: nonNegativeInteger(raw.sourceBytes),
      maskChecksum: nonNegativeInteger(raw.maskChecksum),
      syncMode: normalizeSyncMode(raw.syncMode),
      delayPolls: nonNegativeInteger(raw.delayPolls),
      skipPolls: nonNegativeInteger(raw.skipPolls),
      portCount: nonNegativeInteger(raw.portCount),
      totalRecords: nonNegativeInteger(raw.totalRecords),
      effectiveRecords: nonNegativeInteger(raw.effectiveRecords),
      sourceFrameCount: nonNegativeInteger(raw.sourceFrameCount),
      recordsPlayed: nonNegativeInteger(raw.recordsPlayed),
      startedAt: stringValue(raw.startedAt),
      lastObservedAt: stringValue(raw.lastObservedAt),
      endedAt: stringValue(raw.endedAt),
      durationMs: nonNegativeNumber(raw.durationMs),
      outcome: RECENT_RUN_OUTCOMES.includes(outcome) ? outcome : "unknown",
      firmwareId: stringValue(raw.firmwareId),
      bridgeRunId: nonNegativeInteger(raw.bridgeRunId),
      error: stringValue(raw.error),
      bareStrobes: nonNegativeInteger(raw.bareStrobes),
      tornStrobes: nonNegativeInteger(raw.tornStrobes),
      anomalyCount: nonNegativeInteger(raw.anomalyCount),
      anomalyKind: nonNegativeInteger(raw.anomalyKind),
      anomalySeq: nonNegativeInteger(raw.anomalySeq),
      traceFiles,
      traceFilesTruncated: raw.traceFilesTruncated === true,
    };
  }

  function normalizeRecentRunEntries(rawList) {
    return Array.isArray(rawList) ? rawList.map((entry) => normalizeRecentRunEntry(entry)) : [];
  }

  function isCompletedRecentRun(entry) {
    return entry?.outcome === "completed";
  }

  function filterRecentRuns(entries, { completedOnly = false } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    return completedOnly ? list.filter((entry) => isCompletedRecentRun(entry)) : [...list];
  }

  function sortRecentRuns(entries, { key = "date", direction = "desc", now = new Date() } = {}) {
    const sortKey = RECENT_RUN_SORT_KEYS.includes(key) ? key : "date";
    const sortDirection = RECENT_RUN_SORT_DIRECTIONS.includes(direction) ? direction : "desc";
    const directionFactor = sortDirection === "asc" ? 1 : -1;
    const nowMs = dateMilliseconds(now);

    return (Array.isArray(entries) ? [...entries] : []).sort((left, right) => {
      const primary = compareRecentRuns(left, right, sortKey, nowMs);
      if (primary !== 0) {
        return primary * directionFactor;
      }

      const dateTie = dateMilliseconds(right?.startedAt) - dateMilliseconds(left?.startedAt);
      if (dateTie !== 0) {
        return dateTie;
      }
      return stringValue(left?.id).localeCompare(stringValue(right?.id));
    });
  }

  function recentRunEstimatedLength(entry) {
    const sourceFrameCount = nonNegativeNumber(entry?.sourceFrameCount);
    if (sourceFrameCount > 0) {
      return {
        ms: (sourceFrameCount / NES_FRAMES_PER_SECOND) * 1000,
        exact: true,
      };
    }

    const effectiveRecords = nonNegativeNumber(entry?.effectiveRecords);
    return {
      ms: effectiveRecords > 0 ? (effectiveRecords / NES_FRAMES_PER_SECOND) * 1000 : 0,
      exact: false,
    };
  }

  function recentRunElapsedMs(entry, now = new Date()) {
    if (entry?.outcome === "playing") {
      const startedAt = dateMilliseconds(entry.startedAt);
      const nowMs = dateMilliseconds(now);
      return Math.max(0, nowMs - startedAt);
    }
    return nonNegativeNumber(entry?.durationMs);
  }

  function formatRecentRunDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(nonNegativeNumber(milliseconds) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const paddedSeconds = String(seconds).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
    }
    return `${minutes}:${paddedSeconds}`;
  }

  function formatRecentRunProgress(played, total) {
    const normalizedPlayed = nonNegativeInteger(played);
    const normalizedTotal = nonNegativeInteger(total);
    const percentage =
      normalizedTotal > 0 ? Math.round((normalizedPlayed / normalizedTotal) * 100) : 0;
    return `${normalizedPlayed.toLocaleString()} / ${normalizedTotal.toLocaleString()} records (${percentage}%)`;
  }

  function formatRecentRunRelativeTime(startedAt, now = new Date()) {
    const startedMs = dateMilliseconds(startedAt);
    const nowMs = dateMilliseconds(now);
    if (!Number.isFinite(startedMs)) {
      return "unknown";
    }

    const elapsedMs = Math.max(0, nowMs - startedMs);
    const elapsedMinutes = Math.floor(elapsedMs / 60_000);
    if (elapsedMinutes < 1) {
      return "just now";
    }
    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m ago`;
    }

    const elapsedHours = Math.floor(elapsedMs / 3_600_000);
    if (elapsedHours < 24) {
      return `${elapsedHours}h ago`;
    }
    if (elapsedHours < 48) {
      return "yesterday";
    }

    return new Date(startedMs).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  function recentRunModeLabel(syncMode) {
    if (syncMode === "strobe") {
      return "per strobe (r08 replay)";
    }
    if (syncMode === "latch") {
      return "per latch window (dpcm r08)";
    }
    return "completed reads";
  }

  function recentRunConfigChips(entry) {
    const mode = normalizeSyncMode(entry?.syncMode);
    const modeChip =
      mode === "strobe" ? "per strobe" : mode === "latch" ? "per latch window" : "completed reads";
    const format = normalizeFileFormat(entry?.fileFormat).toUpperCase() || "TAS";
    const portCount = nonNegativeInteger(entry?.portCount);
    const chips = [
      format,
      modeChip,
      `delay ${nonNegativeInteger(entry?.delayPolls)}`,
      `skip ${nonNegativeInteger(entry?.skipPolls)}`,
      `${portCount} port${portCount === 1 ? "" : "s"}`,
    ];
    const firmwareId = stringValue(entry?.firmwareId);
    if (firmwareId) {
      chips.push(`fw ${firmwareId}`);
    }
    return chips;
  }

  function recentRunAnomalyChips(entry) {
    const chips = [];
    const bareStrobes = nonNegativeInteger(entry?.bareStrobes);
    const tornStrobes = nonNegativeInteger(entry?.tornStrobes);
    const anomalyCount = nonNegativeInteger(entry?.anomalyCount);
    if (bareStrobes > 0) {
      chips.push(`${bareStrobes.toLocaleString()} bare strobes`);
    }
    if (tornStrobes > 0) {
      chips.push(`${tornStrobes.toLocaleString()} torn strobes`);
    }
    if (anomalyCount > 0) {
      const kind = nonNegativeInteger(entry?.anomalyKind);
      chips.push(`${anomalyCount.toLocaleString()} anomalies (kind ${kind})`);
    }
    return chips;
  }

  function recentRunTraceSummary(entry, { expanded = false } = {}) {
    const traceFiles = Array.isArray(entry?.traceFiles) ? entry.traceFiles : [];
    const normalized = traceFiles
      .map((trace) => normalizeRecentRunTrace(trace))
      .filter((trace) => trace.path)
      .map((trace) => ({
        ...trace,
        baseName: trace.path.split(/[\\/]/).pop() || trace.path,
      }));
    const visible = expanded ? normalized : normalized.slice(0, RECENT_RUN_TRACE_VISIBLE);

    return {
      visible,
      hiddenCount: expanded ? 0 : Math.max(0, normalized.length - visible.length),
      truncated: entry?.traceFilesTruncated === true,
    };
  }

  function annotateDuplicateRecentRunNames(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const identitiesByName = new Map();
    for (const entry of list) {
      const name = stringValue(entry?.fileName).toLocaleLowerCase();
      if (!identitiesByName.has(name)) {
        identitiesByName.set(name, new Set());
      }
      identitiesByName.get(name).add(recentRunContentIdentity(entry));
    }

    return list.map((entry) => {
      const copy = { ...entry };
      const name = stringValue(entry?.fileName).toLocaleLowerCase();
      if ((identitiesByName.get(name)?.size || 0) > 1) {
        copy.nameTag = recentRunNameTag(entry);
      } else {
        delete copy.nameTag;
      }
      return copy;
    });
  }

  function restoreOptionsForRecentRun(entry) {
    const fileFormat = normalizeFileFormat(entry?.fileFormat);
    const requestedMode = stringValue(entry?.syncMode);
    const syncMode =
      fileFormat === "r08" && SYNC_MODES.includes(requestedMode) ? requestedMode : "poll";
    const delayPolls = clampInteger(entry?.delayPolls, 0, MAX_START_DELAY_POLLS);
    const totalRecords = nonNegativeInteger(entry?.totalRecords);
    const skipPolls = clampInteger(entry?.skipPolls, 0, Math.max(0, totalRecords - 1));
    return { syncMode, delayPolls, skipPolls };
  }

  function compareRecentRuns(left, right, key, nowMs) {
    if (key === "name") {
      return stringValue(left?.fileName).localeCompare(stringValue(right?.fileName), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    if (key === "played") {
      return recentRunElapsedMs(left, nowMs) - recentRunElapsedMs(right, nowMs);
    }
    if (key === "length") {
      return recentRunEstimatedLength(left).ms - recentRunEstimatedLength(right).ms;
    }
    if (key === "completed") {
      return Number(isCompletedRecentRun(left)) - Number(isCompletedRecentRun(right));
    }
    if (key === "mode") {
      return MODE_RANK[normalizeSyncMode(left?.syncMode)] - MODE_RANK[normalizeSyncMode(right?.syncMode)];
    }
    if (key === "delay") {
      return nonNegativeInteger(left?.delayPolls) - nonNegativeInteger(right?.delayPolls);
    }
    if (key === "skip") {
      return nonNegativeInteger(left?.skipPolls) - nonNegativeInteger(right?.skipPolls);
    }
    return dateMilliseconds(left?.startedAt) - dateMilliseconds(right?.startedAt);
  }

  function recentRunContentIdentity(entry) {
    const contentKey = stringValue(entry?.contentKey);
    return contentKey || `missing:${stringValue(entry?.id)}`;
  }

  function recentRunNameTag(entry) {
    const contentKey = stringValue(entry?.contentKey);
    if (contentKey) {
      const digest = contentKey.startsWith("sha256:") ? contentKey.slice(7) : contentKey;
      return digest.slice(0, 7) || "unknown";
    }
    const id = stringValue(entry?.id);
    return id.split("-").pop()?.slice(-7) || "unknown";
  }

  function normalizeRecentRunTrace(trace) {
    return {
      path: stringValue(trace?.path),
      kind: stringValue(trace?.kind),
      at: stringValue(trace?.at),
    };
  }

  function normalizeBytes(bytes) {
    if (bytes instanceof Uint8Array) {
      return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
      return new Uint8Array(bytes);
    }
    if (ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return Uint8Array.from(bytes || []);
  }

  function normalizeFileFormat(value) {
    const format = stringValue(value).toLocaleLowerCase();
    return format === "r08" || format === "tdmask" ? format : "";
  }

  function normalizeSyncMode(value) {
    return SYNC_MODES.includes(value) ? value : "poll";
  }

  function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function clampInteger(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return minimum;
    }
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function dateMilliseconds(value) {
    const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  return {
    RECENT_RUN_OUTCOMES,
    RECENT_RUN_SORT_KEYS,
    RECENT_RUN_SORT_DIRECTIONS,
    RECENT_RUN_TRACE_VISIBLE,
    recentRunSourceKey,
    normalizeRecentRunEntry,
    normalizeRecentRunEntries,
    isCompletedRecentRun,
    filterRecentRuns,
    sortRecentRuns,
    recentRunEstimatedLength,
    recentRunElapsedMs,
    formatRecentRunDuration,
    formatRecentRunProgress,
    formatRecentRunRelativeTime,
    recentRunModeLabel,
    recentRunConfigChips,
    recentRunAnomalyChips,
    recentRunTraceSummary,
    annotateDuplicateRecentRunNames,
    restoreOptionsForRecentRun,
  };
});
