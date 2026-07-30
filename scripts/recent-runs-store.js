const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const {
  parseTasFileBytes,
  tasFramesToMasks,
  tasMasksPortCount,
  tasRunChecksum,
} = require("../apps/web/src/tas.js");
const {
  normalizeRecentRunEntries,
  normalizeRecentRunEntry,
  recentRunSourceKey,
  restoreOptionsForRecentRun,
} = require("../apps/web/src/recents.js");

const RECENT_RUNS_INDEX_VERSION = 1;
const RECENT_RUNS_DIR_NAME = "recent-runs";
const RECENT_RUNS_MAX_ENTRIES = 100;
const RECENT_RUNS_MAX_STREAM_BYTES = 256 * 1024 * 1024;
const RECENT_RUNS_ORPHAN_GRACE_MS = 3_600_000;
const RECENT_RUNS_PROGRESS_FLUSH_MS = 30_000;
const RECENT_RUN_TRACE_PATH_LIMIT = 200;
const MAX_RECENT_RUN_SOURCE_BYTES = 4 * 1024 * 1024;

class RecentRunsStore {
  constructor({
    directory,
    now = () => new Date(),
    maxEntries = RECENT_RUNS_MAX_ENTRIES,
    maxStreamBytes = RECENT_RUNS_MAX_STREAM_BYTES,
    orphanGraceMs = RECENT_RUNS_ORPHAN_GRACE_MS,
    progressFlushMs = RECENT_RUNS_PROGRESS_FLUSH_MS,
    tracePathLimit = RECENT_RUN_TRACE_PATH_LIMIT,
  }) {
    if (!directory) {
      throw new Error("A recent-runs directory is required.");
    }

    this.directory = directory;
    this.streamsDirectory = path.join(directory, "streams");
    this.indexPath = path.join(directory, "index.json");
    this.indexTempPath = `${this.indexPath}.tmp`;
    this.now = now;
    this.maxEntries = positiveInteger(maxEntries, RECENT_RUNS_MAX_ENTRIES);
    this.maxStreamBytes = nonNegativeInteger(maxStreamBytes, RECENT_RUNS_MAX_STREAM_BYTES);
    this.orphanGraceMs = nonNegativeInteger(orphanGraceMs, RECENT_RUNS_ORPHAN_GRACE_MS);
    this.progressFlushMs = nonNegativeInteger(progressFlushMs, RECENT_RUNS_PROGRESS_FLUSH_MS);
    this.tracePathLimit = positiveInteger(tracePathLimit, RECENT_RUN_TRACE_PATH_LIMIT);
    this.index = { version: RECENT_RUNS_INDEX_VERSION, entries: [] };
    this.writeQueue = Promise.resolve();
    this.pendingRuns = new Map();
    this.deferredSources = new Map();
    this.lastProgressFlushAt = new Map();
    this.writeCount = 0;
  }

  async load() {
    await fsp.mkdir(this.streamsDirectory, { recursive: true });
    const entriesRegisteredWhileLoading = this.index.entries;
    let loadedIndex = { version: RECENT_RUNS_INDEX_VERSION, entries: [] };
    let repaired = false;

    try {
      const contents = await fsp.readFile(this.indexPath, "utf8");
      loadedIndex = normalizeRecentRunsIndex(JSON.parse(contents));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this._quarantineCorruptIndex();
      }
    }

    const existingIds = new Set(loadedIndex.entries.map((entry) => entry.id));
    loadedIndex.entries.unshift(
      ...entriesRegisteredWhileLoading.filter((entry) => !existingIds.has(entry.id)),
    );
    this.index = loadedIndex;

    for (const entry of this.index.entries) {
      if (entry.outcome !== "playing") {
        continue;
      }
      const endedAt = validDate(entry.lastObservedAt) || validDate(entry.startedAt) || this._now();
      entry.outcome = "interrupted";
      entry.endedAt = endedAt.toISOString();
      entry.lastObservedAt = endedAt.toISOString();
      entry.durationMs = Math.max(0, endedAt.getTime() - dateMilliseconds(entry.startedAt));
      repaired = true;
    }

    const evicted = await this._enforceEntryLimit();
    repaired = repaired || evicted.length > 0;
    await this._removeDereferencedContentKeys(evicted);
    await this.gcOrphans();
    if (repaired) {
      await this._persist();
    }
    return this.entries();
  }

  entries() {
    return normalizeRecentRunEntries(this.index.entries);
  }

  async needsSource(run) {
    this._trackPendingRun(run);
    const sourceKey = stringValue(run?.sourceKey);
    if (!sourceKey) {
      this._setRunSource(run, { contentKey: "", sourceAvailable: false, sourceBytes: 0 });
      return { needed: false };
    }

    const fingerprint = runFingerprint(run);
    const candidates = [
      ...this.index.entries,
      ...[...this.pendingRuns.values()].filter((candidate) => candidate !== run),
    ];
    for (const candidate of candidates) {
      if (
        stringValue(candidate.sourceKey) !== sourceKey ||
        candidateMaskChecksum(candidate) !== fingerprint.maskChecksum ||
        candidateTotalRecords(candidate) !== fingerprint.totalRecords ||
        candidatePortCount(candidate) !== fingerprint.portCount
      ) {
        continue;
      }

      const contentKey = stringValue(candidate.contentKey || candidate.recentContentKey);
      const sourceBytes = nonNegativeInteger(
        candidate.sourceBytes ?? candidate.sourceByteLength,
        0,
      );
      if (!contentKey || !(await this._streamMatchesSize(contentKey, runFileFormat(run), sourceBytes))) {
        continue;
      }

      this._setRunSource(run, { contentKey, sourceAvailable: true, sourceBytes });
      return { needed: false, contentKey };
    }

    this._setRunSource(run, {
      contentKey: "",
      sourceAvailable: false,
      sourceBytes: nonNegativeInteger(run?.sourceByteLength, 0),
    });
    return { needed: true };
  }

  async storeSource({ run, fileName, bytes }) {
    const sourceBytes = normalizeBuffer(bytes);
    if (sourceBytes.length > MAX_RECENT_RUN_SOURCE_BYTES) {
      this._markRunSourceUnavailable(run);
      await this._persist();
      throw new Error("The recent-run source is too large.");
    }
    if (run?.started === true) {
      this.deferredSources.set(bridgeRunId(run), {
        run,
        fileName,
        bytes: Buffer.from(sourceBytes),
      });
      return { deferred: true };
    }
    return this._storeSourceNow({ run, fileName, bytes: sourceBytes });
  }

  async _storeSourceNow({ run, fileName, bytes }) {
    const sourceBytes = normalizeBuffer(bytes);
    try {
      this._validateSourcePayload(run, fileName, sourceBytes);
    } catch (error) {
      this._markRunSourceUnavailable(run);
      await this._persist();
      throw error;
    }

    const fileFormat = runFileFormat(run);
    const contentKey = `sha256:${crypto.createHash("sha256").update(sourceBytes).digest("hex")}`;
    const streamFileName = recentRunStreamFileName(contentKey, fileFormat);
    const streamPath = path.join(this.streamsDirectory, streamFileName);
    await fsp.mkdir(this.streamsDirectory, { recursive: true });
    try {
      await fsp.writeFile(streamPath, sourceBytes, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        this._markRunSourceUnavailable(run);
        await this._persist();
        throw error;
      }
      const existing = await fsp.readFile(streamPath);
      const existingKey = `sha256:${crypto.createHash("sha256").update(existing).digest("hex")}`;
      if (existing.length !== sourceBytes.length || existingKey !== contentKey) {
        this._markRunSourceUnavailable(run);
        await this._persist();
        throw new Error("The archived recent-run stream does not match its content key.");
      }
    }

    this._setRunSource(run, {
      contentKey,
      sourceAvailable: true,
      sourceBytes: sourceBytes.length,
    });
    this._updateEntrySourceForRun(run);
    await this._persist();
    await this.gcOrphans();
    return { contentKey, sourceBytes: sourceBytes.length };
  }

  markSourceUnavailable(sourceKey) {
    const normalizedKey = stringValue(sourceKey);
    for (const run of this.pendingRuns.values()) {
      if (stringValue(run.sourceKey) === normalizedKey) {
        this._markRunSourceUnavailable(run);
      }
    }
    this._schedulePersist();
  }

  beginRun(run, { firmwareId = "" } = {}) {
    const startedAt = this._now();
    const id = recentRunEntryId(run, startedAt);
    const existing = this.index.entries.find((entry) => entry.id === id);
    if (existing) {
      return existing.id;
    }

    const totalRecords = candidateTotalRecords(run);
    const skipPolls = nonNegativeInteger(run?.skipPolls, 0);
    const entry = normalizeRecentRunEntry({
      id,
      fileName: path.basename(stringValue(run?.fileName) || "uploaded.tas"),
      fileFormat: runFileFormat(run),
      sourceKey: stringValue(run?.sourceKey),
      contentKey: stringValue(run?.recentContentKey || run?.contentKey),
      sourceAvailable: run?.recentSourceAvailable === true || run?.sourceAvailable === true,
      sourceBytes: nonNegativeInteger(run?.recentSourceBytes ?? run?.sourceByteLength, 0),
      maskChecksum: candidateMaskChecksum(run),
      syncMode: stringValue(run?.syncMode) || "poll",
      delayPolls: nonNegativeInteger(run?.startDelayPolls, 0),
      skipPolls,
      portCount: candidatePortCount(run),
      totalRecords,
      effectiveRecords: nonNegativeInteger(run?.frameCount, Math.max(0, totalRecords - skipPolls)),
      sourceFrameCount: nonNegativeInteger(run?.sourceFrameCount, 0),
      recordsPlayed: 0,
      startedAt: startedAt.toISOString(),
      lastObservedAt: startedAt.toISOString(),
      endedAt: "",
      durationMs: 0,
      outcome: "playing",
      firmwareId,
      bridgeRunId: bridgeRunId(run),
      error: "",
      traceFiles: [],
      traceFilesTruncated: false,
    });
    this.index.entries.unshift(entry);
    run.recentRunEntryId = id;
    this.pendingRuns.delete(bridgeRunId(run));
    this.lastProgressFlushAt.set(id, startedAt.getTime());
    this._schedulePersist();
    return id;
  }

  noteProgress(id, recordsPlayed, counters = {}) {
    const entry = this.index.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.outcome !== "playing") {
      return;
    }

    entry.recordsPlayed = Math.max(
      entry.recordsPlayed,
      nonNegativeInteger(recordsPlayed, entry.recordsPlayed),
    );
    entry.lastObservedAt = this._now().toISOString();
    applyCounters(entry, counters);
    if (stringValue(counters.fw)) {
      entry.firmwareId = stringValue(counters.fw);
    }

    const nowMs = dateMilliseconds(entry.lastObservedAt);
    const lastFlushAt = this.lastProgressFlushAt.get(id) || 0;
    if (nowMs - lastFlushAt >= this.progressFlushMs) {
      this.lastProgressFlushAt.set(id, nowMs);
      this._schedulePersist();
    }
  }

  async finalizeRun(
    id,
    { outcome, recordsPlayed, error = "", firmwareId = "" } = {},
  ) {
    const entry = this.index.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.outcome !== "playing") {
      return entry ? normalizeRecentRunEntry(entry) : null;
    }

    const endedAt = this._now();
    entry.outcome = recentRunOutcomeForRunState(outcome);
    if (entry.outcome === "unknown" || entry.outcome === "playing") {
      entry.outcome = "error";
    }
    entry.recordsPlayed = Math.max(
      entry.recordsPlayed,
      nonNegativeInteger(recordsPlayed, entry.recordsPlayed),
    );
    entry.lastObservedAt = endedAt.toISOString();
    entry.endedAt = endedAt.toISOString();
    entry.durationMs = Math.max(0, endedAt.getTime() - dateMilliseconds(entry.startedAt));
    entry.error = stringValue(error);
    if (stringValue(firmwareId)) {
      entry.firmwareId = stringValue(firmwareId);
    }
    this.lastProgressFlushAt.delete(id);

    const evicted = await this._enforceEntryLimit();
    await this._persist();
    await this._removeDereferencedContentKeys(evicted);
    await this.gcOrphans();
    const deferredSource = this.deferredSources.get(entry.bridgeRunId);
    if (deferredSource) {
      this.deferredSources.delete(entry.bridgeRunId);
      this._storeSourceNow(deferredSource).catch(() => {});
    }
    return normalizeRecentRunEntry(entry);
  }

  async attachTraceForRun(bridgeRunIdValue, { path: tracePath, kind }) {
    const normalizedBridgeRunId = nonNegativeInteger(bridgeRunIdValue, 0);
    const entry = this.index.entries.find(
      (candidate) => candidate.bridgeRunId === normalizedBridgeRunId,
    );
    if (!entry) {
      return null;
    }

    const normalizedPath = stringValue(tracePath);
    if (!normalizedPath || entry.traceFiles.some((trace) => trace.path === normalizedPath)) {
      return normalizeRecentRunEntry(entry);
    }
    if (entry.traceFiles.length >= this.tracePathLimit) {
      entry.traceFilesTruncated = true;
      await this._persist();
      return normalizeRecentRunEntry(entry);
    }

    entry.traceFiles.unshift({
      path: normalizedPath,
      kind: stringValue(kind),
      at: this._now().toISOString(),
    });
    await this._persist();
    return normalizeRecentRunEntry(entry);
  }

  async gcOrphans() {
    await fsp.mkdir(this.streamsDirectory, { recursive: true });
    const referencedFiles = this._referencedStreamFiles();
    const protectedFiles = this._pendingStreamFiles();
    const streamFiles = await this._streamFiles();
    const nowMs = this._now().getTime();

    for (const stream of streamFiles) {
      if (referencedFiles.has(stream.name) || protectedFiles.has(stream.name)) {
        continue;
      }
      if (nowMs - stream.mtimeMs >= this.orphanGraceMs) {
        await unlinkIfPresent(stream.path);
      }
    }
  }

  async loadSource(id) {
    const entry = this.index.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error("That recent run no longer exists.");
    }
    if (!entry.sourceAvailable || !entry.contentKey) {
      throw new Error("That run's stream was not archived.");
    }

    const streamPath = this._streamPath(entry.contentKey, entry.fileFormat);
    try {
      const bytes = await fsp.readFile(streamPath);
      const contentKey = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.length !== entry.sourceBytes || contentKey !== entry.contentKey) {
        throw new Error("The archived stream failed its integrity check.");
      }
      return {
        fileName: entry.fileName,
        bytes,
        restore: restoreOptionsForRecentRun(entry),
        portCount: entry.portCount,
        totalRecords: entry.totalRecords,
      };
    } catch (error) {
      entry.sourceAvailable = false;
      await this._persist();
      throw error;
    }
  }

  async deleteRun(id, { activeId = "" } = {}) {
    const index = this.index.entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return { removed: 0, keptActive: false };
    }
    const entry = this.index.entries[index];
    if (entry.outcome === "playing" || entry.id === activeId) {
      throw new Error("That run is still playing.");
    }

    this.index.entries.splice(index, 1);
    await this._persist();
    await this._removeDereferencedContentKeys([entry.contentKey], { activeId });
    await this.gcOrphans();
    return { removed: 1, keptActive: false };
  }

  async clearRuns({ activeId = "" } = {}) {
    const removedEntries = [];
    const keptEntries = [];
    for (const entry of this.index.entries) {
      if (entry.outcome === "playing" || entry.id === activeId) {
        keptEntries.push(entry);
      } else {
        removedEntries.push(entry);
      }
    }
    this.index.entries = keptEntries;
    await this._persist();
    await this._removeDereferencedContentKeys(
      removedEntries.map((entry) => entry.contentKey),
      { activeId },
    );
    await this.gcOrphans();
    return {
      removed: removedEntries.length,
      keptActive: keptEntries.some((entry) => entry.outcome === "playing"),
    };
  }

  flush() {
    return this.writeQueue;
  }

  _validateSourcePayload(run, fileName, bytes) {
    if (bytes.length > MAX_RECENT_RUN_SOURCE_BYTES) {
      throw new Error("The recent-run source is too large.");
    }
    const advertisedLength = nonNegativeInteger(run?.sourceByteLength, bytes.length);
    if (advertisedLength !== bytes.length) {
      throw new Error("The recent-run source length does not match the upload.");
    }
    const sourceKey = recentRunSourceKey(bytes);
    if (stringValue(run?.sourceKey) && sourceKey !== run.sourceKey) {
      throw new Error("The recent-run source fingerprint does not match the upload.");
    }

    const expectedFormat = runFileFormat(run);
    if (fileFormatForName(fileName) !== expectedFormat) {
      throw new Error("The recent-run source format does not match the upload.");
    }
    const parseResult = parseTasFileBytes(fileName, bytes);
    const masks = tasFramesToMasks(parseResult.frames);
    const parsedPortCount = tasMasksPortCount(masks);
    if (
      masks.length !== candidateTotalRecords(run) ||
      parsedPortCount !== candidatePortCount(run) ||
      tasRunChecksum(masks, parsedPortCount) !== candidateMaskChecksum(run)
    ) {
      throw new Error("The recent-run source masks do not match the upload.");
    }
  }

  _trackPendingRun(run) {
    if (run && typeof run === "object") {
      this.pendingRuns.set(bridgeRunId(run), run);
    }
  }

  _setRunSource(run, { contentKey, sourceAvailable, sourceBytes }) {
    if (!run || typeof run !== "object") {
      return;
    }
    run.recentContentKey = contentKey;
    run.recentSourceAvailable = sourceAvailable;
    run.recentSourceBytes = sourceBytes;
  }

  _markRunSourceUnavailable(run) {
    this._setRunSource(run, {
      contentKey: "",
      sourceAvailable: false,
      sourceBytes: nonNegativeInteger(run?.sourceByteLength, 0),
    });
    this._updateEntrySourceForRun(run);
  }

  _updateEntrySourceForRun(run) {
    const entry = this.index.entries.find(
      (candidate) => candidate.bridgeRunId === bridgeRunId(run),
    );
    if (!entry) {
      return;
    }
    entry.contentKey = stringValue(run?.recentContentKey);
    entry.sourceAvailable = run?.recentSourceAvailable === true;
    entry.sourceBytes = nonNegativeInteger(run?.recentSourceBytes, 0);
  }

  _schedulePersist() {
    this._persist().catch(() => {});
  }

  _persist() {
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => this._writeIndex());
    return this.writeQueue;
  }

  async _writeIndex() {
    await fsp.mkdir(this.directory, { recursive: true });
    const contents = `${JSON.stringify(
      {
        version: RECENT_RUNS_INDEX_VERSION,
        entries: this.index.entries,
      },
      null,
      2,
    )}\n`;
    try {
      await fsp.writeFile(this.indexTempPath, contents, "utf8");
      await fsp.rename(this.indexTempPath, this.indexPath);
      this.writeCount += 1;
    } finally {
      await unlinkIfPresent(this.indexTempPath);
    }
  }

  async _quarantineCorruptIndex() {
    const corruptPath = path.join(
      this.directory,
      `index.corrupt-${fileTimestamp(this._now())}.json`,
    );
    try {
      await fsp.rename(this.indexPath, corruptPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async _enforceEntryLimit() {
    const removedContentKeys = [];
    while (this.index.entries.length > this.maxEntries) {
      const index = findOldestEvictableEntryIndex(this.index.entries);
      if (index === -1) {
        break;
      }
      const [removed] = this.index.entries.splice(index, 1);
      removedContentKeys.push(removed.contentKey);
    }

    await this.gcOrphans();
    let totalBytes = await this._streamByteTotal();
    while (totalBytes > this.maxStreamBytes) {
      const index = findOldestEvictableEntryIndex(this.index.entries);
      if (index === -1) {
        break;
      }
      const [removed] = this.index.entries.splice(index, 1);
      removedContentKeys.push(removed.contentKey);
      await this._removeDereferencedContentKeys([removed.contentKey]);
      totalBytes = await this._streamByteTotal();
    }
    return removedContentKeys;
  }

  async _removeDereferencedContentKeys(contentKeys, { activeId = "" } = {}) {
    const referencedKeys = new Set(this.index.entries.map((entry) => entry.contentKey).filter(Boolean));
    const activeEntry = this.index.entries.find((entry) => entry.id === activeId);
    const protectedKeys = new Set(
      [
        activeEntry?.contentKey,
        ...[...this.pendingRuns.values()].map(
          (run) => run.recentContentKey || run.contentKey,
        ),
      ].filter(Boolean),
    );

    for (const contentKey of new Set(contentKeys.filter(Boolean))) {
      if (referencedKeys.has(contentKey) || protectedKeys.has(contentKey)) {
        continue;
      }
      for (const fileFormat of ["r08", "tdmask"]) {
        await unlinkIfPresent(this._streamPath(contentKey, fileFormat));
      }
    }
  }

  _referencedStreamFiles() {
    return new Set(
      this.index.entries
        .map((entry) => recentRunStreamFileName(entry.contentKey, entry.fileFormat))
        .filter(Boolean),
    );
  }

  _pendingStreamFiles() {
    return new Set(
      [...this.pendingRuns.values()]
        .map((run) =>
          recentRunStreamFileName(
            run.recentContentKey || run.contentKey,
            runFileFormat(run),
          ),
        )
        .filter(Boolean),
    );
  }

  async _streamMatchesSize(contentKey, fileFormat, expectedBytes) {
    if (!contentKey || !fileFormat || expectedBytes <= 0) {
      return false;
    }
    try {
      const stat = await fsp.stat(this._streamPath(contentKey, fileFormat));
      return stat.isFile() && stat.size === expectedBytes;
    } catch {
      return false;
    }
  }

  _streamPath(contentKey, fileFormat) {
    const fileName = recentRunStreamFileName(contentKey, fileFormat);
    if (!fileName) {
      throw new Error("The recent-run content key is invalid.");
    }
    return path.join(this.streamsDirectory, fileName);
  }

  async _streamFiles() {
    let directoryEntries;
    try {
      directoryEntries = await fsp.readdir(this.streamsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files = [];
    for (const entry of directoryEntries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(this.streamsDirectory, entry.name);
      const stat = await fsp.stat(filePath);
      files.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
    return files;
  }

  async _streamByteTotal() {
    const streams = await this._streamFiles();
    return streams.reduce((total, stream) => total + stream.size, 0);
  }

  _now() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
}

function recentRunOutcomeForRunState(state) {
  if (state === "complete" || state === "completed") {
    return "completed";
  }
  if (state === "stopped" || state === "cancelled" || state === "canceled") {
    return "stopped";
  }
  if (state === "error") {
    return "error";
  }
  if (state === "interrupted" || state === "disconnected") {
    return "interrupted";
  }
  if (state === "playing") {
    return "playing";
  }
  return "unknown";
}

function normalizeRecentRunsIndex(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.version !== RECENT_RUNS_INDEX_VERSION ||
    !Array.isArray(raw.entries)
  ) {
    throw new Error("The recent-runs index is invalid.");
  }
  return {
    version: RECENT_RUNS_INDEX_VERSION,
    entries: normalizeRecentRunEntries(raw.entries),
  };
}

function recentRunStreamFileName(contentKey, fileFormat) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(stringValue(contentKey));
  const format = stringValue(fileFormat).toLocaleLowerCase();
  if (!match || (format !== "r08" && format !== "tdmask")) {
    return "";
  }
  return `${match[1].toLocaleLowerCase()}.${format}`;
}

function recentRunEntryId(run, startedAt = new Date()) {
  return `${fileTimestamp(startedAt)}-${bridgeRunId(run)}`;
}

function fileTimestamp(now = new Date()) {
  const date = [
    padTimestampPart(now.getFullYear(), 4),
    padTimestampPart(now.getMonth() + 1),
    padTimestampPart(now.getDate()),
  ].join("-");
  const time = [
    padTimestampPart(now.getHours()),
    padTimestampPart(now.getMinutes()),
    padTimestampPart(now.getSeconds()),
    padTimestampPart(now.getMilliseconds(), 3),
  ].join("-");
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes < 0 ? "-" : "+";
  const offsetAbsolute = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(offsetAbsolute / 60);
  const offsetRemainderMinutes = offsetAbsolute % 60;
  const offset = `${offsetSign}${padTimestampPart(offsetHours)}${padTimestampPart(offsetRemainderMinutes)}`;
  return `${date}T${time}${offset}`;
}

function padTimestampPart(value, length = 2) {
  return String(value).padStart(length, "0");
}

function runFingerprint(run) {
  return {
    maskChecksum: candidateMaskChecksum(run),
    totalRecords: candidateTotalRecords(run),
    portCount: candidatePortCount(run),
  };
}

function candidateMaskChecksum(run) {
  return nonNegativeInteger(run?.maskChecksum ?? run?.originalChecksum, 0);
}

function candidateTotalRecords(run) {
  return nonNegativeInteger(run?.totalRecords ?? run?.originalFrameCount, 0);
}

function candidatePortCount(run) {
  return nonNegativeInteger(run?.portCount, 0);
}

function bridgeRunId(run) {
  return nonNegativeInteger(run?.bridgeRunId ?? run?.id, 0);
}

function runFileFormat(run) {
  const explicit = stringValue(run?.fileFormat).toLocaleLowerCase();
  return explicit === "r08" || explicit === "tdmask"
    ? explicit
    : fileFormatForName(run?.fileName);
}

function fileFormatForName(fileName) {
  const extension = path.extname(stringValue(fileName)).toLocaleLowerCase();
  if (extension === ".r08") {
    return "r08";
  }
  if (extension === ".tdmask") {
    return "tdmask";
  }
  return "";
}

function applyCounters(entry, counters) {
  entry.bareStrobes = nonNegativeInteger(counters.bare_strobes ?? counters.bareStrobes, entry.bareStrobes);
  entry.tornStrobes = nonNegativeInteger(counters.torn_strobes ?? counters.tornStrobes, entry.tornStrobes);
  entry.anomalyCount = nonNegativeInteger(counters.anomaly_count ?? counters.anomalyCount, entry.anomalyCount);
  entry.anomalyKind = nonNegativeInteger(counters.anomaly_kind ?? counters.anomalyKind, entry.anomalyKind);
  entry.anomalySeq = nonNegativeInteger(counters.anomaly_seq ?? counters.anomalySeq, entry.anomalySeq);
}

function findOldestEvictableEntryIndex(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].outcome !== "playing") {
      return index;
    }
  }
  return -1;
}

function normalizeBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return Buffer.from(bytes || []);
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function dateMilliseconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function unlinkIfPresent(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

module.exports = {
  MAX_RECENT_RUN_SOURCE_BYTES,
  RECENT_RUNS_DIR_NAME,
  RECENT_RUNS_INDEX_VERSION,
  RECENT_RUNS_MAX_ENTRIES,
  RECENT_RUNS_MAX_STREAM_BYTES,
  RECENT_RUNS_ORPHAN_GRACE_MS,
  RECENT_RUNS_PROGRESS_FLUSH_MS,
  RECENT_RUN_TRACE_PATH_LIMIT,
  RecentRunsStore,
  normalizeRecentRunsIndex,
  recentRunEntryId,
  recentRunOutcomeForRunState,
  recentRunStreamFileName,
};
