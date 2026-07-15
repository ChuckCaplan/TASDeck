#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  HARDWARE_TAS_MAX_START_DELAY_POLLS,
  HARDWARE_TAS_SYNC_MODE,
  HARDWARE_TAS_SYNC_MODES,
  NES_BUTTONS,
  TAS_CHUNK_FRAME_LIMIT,
  formatTasChunk,
  tasMaskHasInput,
  tasMasksFromWire,
  tasMasksPortCount,
  tasRunChecksum,
} = require("../apps/web/src/tas.js");
const {
  eventToBridgeCommand,
  formatTasChunkCommand,
  tasBeginToBridgeCommand,
  tasCancelToBridgeCommand,
  tasChunkToBridgeCommand,
  tasEndToBridgeCommand,
  tasStartToBridgeCommand,
  tasStatusToBridgeCommand,
  tasTraceToBridgeCommand,
} = require("../apps/web/src/transport.js");

const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(ROOT_DIR, "apps", "web");
const EVENT_LOG_DIR = path.join(ROOT_DIR, "logs");
const TRACE_LOG_DIR_NAME = "trace";
const DEFAULT_PORT = 8000;
const SERIAL_BAUD = 115200;
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 4 * 1024 * 1024;
const BRIDGE_TAS_BUFFER_STATUS_POLL_MS = 500;
const BRIDGE_TAS_DONE_STATUS_POLL_MS = 1000;
const BRIDGE_TAS_WAITER_TIMEOUT_MS = 10000;
const BRIDGE_TAS_TRACE_DEFAULT_COUNT = 512;
const BRIDGE_TAS_TRACE_MAX_COUNT = 512;
const BRIDGE_TAS_TRACE_PAGE_LIMIT = 12;
// Optional continuous trace streaming follows the firmware's 512-row ring
// for the whole run. Keep it off during normal playback: paging trace rows
// produces near-constant USB CDC traffic, and the Arduino core can briefly
// mask NES pin interrupts while servicing that traffic. Frozen-ring auto
// dumps and the manual Trace action remain enabled. Opt in only for focused
// diagnostics with BRIDGE_TAS_TRACE_STREAM=1.
const BRIDGE_TAS_TRACE_STREAM_ENABLED = tasTraceStreamEnabled();
const BRIDGE_TAS_TRACE_STREAM_BATCH_ROWS = 96;
const BRIDGE_TAS_TRACE_STREAM_IDLE_MS = 400;
const BRIDGE_TAS_TRACE_STREAM_BACKOFF_MS = 250;
const BRIDGE_TAS_TRACE_STREAM_MAX_FAILURES = 5;
const BRIDGE_TAS_TRACE_STREAM_DRAIN_BATCH_LIMIT = 40;
const TAS_TRACE_CSV_HEADER = [
  "sequence",
  "timestampMicros",
  "tasFrame",
  "latchCount",
  "clockCount",
  "clocksSinceLatch",
  "polledMask",
  "nextMask",
  "latchedMask",
  "shiftIndex",
  "result",
  "clockedMask",
  "diag",
  "port",
].join(",");
const SERIAL_CONNECT_READY_TIMEOUT_MS = 12000;
const SERIAL_STATUS_ATTEMPT_TIMEOUT_MS = 750;
const SERIAL_HANDLE_CLOSE_TIMEOUT_MS = 1500;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

class SerialBridge {
  constructor(options = {}) {
    this.requestedPort = options.serialPort || "";
    this.logDir = options.logDir || EVENT_LOG_DIR;
    this.clients = new Set();
    this.buttonHolders = new Map(controllerButtonKeys().map((key) => [key, new Set()]));
    this.handle = null;
    this.portPath = "";
    this.readBuffer = "";
    this.writeQueue = Promise.resolve();
    // Serializes all TAS_TRACE page collections (manual dumps, frozen-ring
    // auto-dumps, continuous streaming) so their identically-shaped responses
    // can never cross-match another collector's waiter.
    this.traceLock = Promise.resolve();
    this.disconnecting = false;
    this.serialReady = false;
    this.serialWaiters = [];
    this.activeTasRun = null;
    this.tasRunSequence = 0;
    this.tasWaiters = [];
    this.connectPromise = null;
  }

  isConnected() {
    return Boolean(this.handle) && this.serialReady;
  }

  statusPayload() {
    return {
      type: "status",
      middlewareConnected: true,
      serialConnected: this.isConnected(),
      serialPath: this.portPath,
      baudRate: SERIAL_BAUD,
    };
  }

  addClient(client) {
    this.clients.add(client);
    this.sendJson(client, this.statusPayload());
  }

  removeClient(client) {
    this.clients.delete(client);
    this.releaseClientButtons(client, "client disconnected").catch((error) => {
      this.broadcastBridge(`Release on client disconnect failed: ${error.message}`);
    });
  }

  closeClients() {
    [...this.clients].forEach((client) => {
      client.heldButtons.clear();
      try {
        client.socket.end(encodeWebSocketFrame("", 0x8));
      } catch {}
      client.socket.destroy();
    });
    this.clients.clear();
    this.buttonHolders.forEach((holders) => holders.clear());
  }

  async connect() {
    if (this.isConnected()) {
      this.broadcastStatus();
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connectSerial().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  async connectSerial() {
    let handle;
    try {
      const portPath = await findSerialPort(this.requestedPort);
      await configureSerialPort(portPath);

      const flags = fs.constants.O_RDWR | (fs.constants.O_NOCTTY || 0);
      handle = await this.openSerialHandle(portPath, flags);
      await this.requestFirmwareStatus(SERIAL_CONNECT_READY_TIMEOUT_MS);
      this.serialReady = true;
      await this.requestFirmwareStatus(SERIAL_CONNECT_READY_TIMEOUT_MS);

      this.broadcastBridge(`Connected to ${portPath} at ${SERIAL_BAUD} baud`);
      this.broadcastStatus();
    } catch (error) {
      if (this.handle === handle) {
        this.rejectSerialWaiters(error);
        this.rejectTasWaiters(error);
      }
      await this.closeSerialHandle(handle, {
        timeoutMs: SERIAL_HANDLE_CLOSE_TIMEOUT_MS,
      });
      throw error;
    }
  }

  async openSerialHandle(portPath, flags) {
    const handle = await fsp.open(portPath, flags);
    await configureSerialPort(portPath);
    this.handle = handle;
    this.portPath = portPath;
    this.readBuffer = "";
    this.serialReady = false;
    this.disconnecting = false;
    this.startReadLoop(handle);
    return handle;
  }

  async closeSerialHandle(handle, options = {}) {
    if (!handle) {
      return;
    }

    if (this.handle === handle) {
      this.handle = null;
      this.portPath = "";
      this.readBuffer = "";
      this.serialReady = false;
    }

    const timeoutMs = options.timeoutMs || 0;
    try {
      if (timeoutMs > 0) {
        await withTimeout(handle.close(), timeoutMs, "Timed out closing serial handle");
      } else {
        await handle.close();
      }
    } catch {}
  }

  async disconnect(options = {}) {
    const handle = this.handle;
    if (!handle) {
      this.clearHeldButtons();
      this.broadcastStatus();
      return;
    }

    this.disconnecting = true;
    if (options.release !== false) {
      await this.releaseAllButtons(options.reason || "disconnect");
    }
    await this.waitForDrain();

    this.handle = null;
    this.portPath = "";
    this.readBuffer = "";
    this.serialReady = false;
    this.rejectSerialWaiters(new Error("Arduino USB serial disconnected"));
    this.rejectTasWaiters(new Error("Arduino USB serial disconnected"));
    await this.closeSerialHandle(handle, {
      timeoutMs: SERIAL_HANDLE_CLOSE_TIMEOUT_MS,
    });
    this.disconnecting = false;

    this.broadcastBridge(options.reason || "Disconnected from Arduino USB serial");
    this.broadcastStatus();
  }

  async handleClientEvent(client, event) {
    if (!this.isConnected()) {
      this.sendJson(client, {
        type: "error",
        message: "Arduino USB serial is not connected",
      });
      this.broadcastStatus();
      return;
    }

    const command = this.commandForEvent(client, event);
    if (!command) {
      return;
    }

    await this.writeCommand(command);
  }

  async handleClientTasMessage(client, message) {
    if (message?.type === "tas_upload") {
      this.handleTasUpload(client, message);
      return;
    }

    if (message?.type === "tas_status") {
      await this.handleTasStatus(client);
      return;
    }

    if (!this.isConnected()) {
      this.sendJson(client, {
        type: "tas_error",
        message: "Arduino USB serial is not connected",
      });
      this.broadcastStatus();
      return;
    }

    if (message?.type === "tas_arm") {
      await this.armTasRun();
      return;
    }

    if (message?.type === "tas_start") {
      await this.startTasRun(message);
      return;
    }

    if (message?.type === "tas_pause") {
      this.pauseTasRun();
      return;
    }

    if (message?.type === "tas_resume") {
      this.resumeTasRun();
      return;
    }

    if (message?.type === "tas_cancel") {
      await this.cancelTasRun();
      return;
    }

    if (message?.type === "tas_trace") {
      await this.handleTasTrace(client, message);
      return;
    }

    const command = this.commandForTasMessage(message);
    if (!command) {
      this.sendJson(client, {
        type: "tas_error",
        message: "Invalid TAS bridge message",
      });
      return;
    }

    await this.writeCommand(command);
  }

  handleTasUpload(client, message) {
    let run;
    try {
      run = this.createTasRun(message);
    } catch (error) {
      this.sendJson(client, {
        type: "tas_error",
        command: "tas_upload",
        message: error.message,
      });
      return;
    }

    this.activeTasRun = run;
    this.broadcast(this.tasStatusPayload("tas_upload", run, {
      bridge_state: "uploaded",
      message: `Bridge stored ${run.fileName}`,
    }));
  }

  createTasRun(message) {
    const uploadedMasks = normalizeUploadedMasks(message?.masks, message?.portCount);
    const portCount = tasMasksPortCount(uploadedMasks);
    if (uploadedMasks.length === 0) {
      throw new Error("TAS upload has no playable frames.");
    }

    if (!uploadedMasks.some(tasMaskHasInput)) {
      throw new Error("TAS upload contains no recognized NES controller input.");
    }

    const frameCount = Number(message?.frameCount);
    if (!Number.isSafeInteger(frameCount) || frameCount !== uploadedMasks.length) {
      throw new Error("TAS upload frame count does not match frame data.");
    }

    const checksum = Number(message?.checksum);
    if (!Number.isInteger(checksum) || checksum !== tasRunChecksum(uploadedMasks, portCount)) {
      throw new Error("TAS upload checksum does not match frame data.");
    }

    const syncMode = message?.syncMode || HARDWARE_TAS_SYNC_MODE;
    if (!HARDWARE_TAS_SYNC_MODES.includes(syncMode)) {
      throw new Error("TAS upload sync mode must be poll, latch, or strobe.");
    }

    const skipPolls = normalizeTasRunSkipPolls(
      message?.skipPolls ??
        message?.skip_polls ??
        message?.startSkipPolls,
      uploadedMasks.length,
    );
    const masks = uploadedMasks.slice(skipPolls);
    if (masks.length === 0) {
      throw new Error("TAS skip removes all playable frames.");
    }
    if (!masks.some(tasMaskHasInput)) {
      throw new Error("TAS skip leaves no recognized NES controller input.");
    }

    return {
      id: ++this.tasRunSequence,
      clientRunId: Number.isSafeInteger(Number(message?.clientRunId)) ? Number(message.clientRunId) : 0,
      fileName: sanitizeTasFileName(message?.fileName),
      skipPolls,
      portCount,
      originalFrameCount: uploadedMasks.length,
      originalInputFrameCount: uploadedMasks.filter(tasMaskHasInput).length,
      originalChecksum: checksum,
      masks,
      frameCount: masks.length,
      inputFrameCount: masks.filter(tasMaskHasInput).length,
      syncMode,
      nextFrameIndex: 0,
      uploadEnded: false,
      paused: false,
      stopped: false,
      started: false,
      streamTask: null,
      state: "uploaded",
      firmwareStatus: null,
      error: "ok",
      traceDumpTask: null,
      lastFrozenTraceKey: "",
      traceStreamTask: null,
    };
  }

  async armTasRun() {
    const run = this.requireActiveTasRun();
    run.state = "arming";
    run.paused = false;
    run.stopped = false;
    run.started = false;
    run.nextFrameIndex = 0;
    run.uploadEnded = false;
    run.error = "ok";

    const beginCommand = tasBeginToBridgeCommand({
      type: "tas_begin",
      frameCount: run.frameCount,
      syncMode: run.syncMode,
      portCount: run.portCount,
    });
    if (!beginCommand) {
      throw new Error("TAS run has an invalid frame count, sync mode, or port count.");
    }

    let status = await this.sendFirmwareTasCommand(
      beginCommand,
      (message) => message.command === "tas_begin",
    );
    this.applyTasFirmwareStatus(run, status, "tas_begin");

    while (this.activeTasRun === run && !run.stopped && !run.paused && run.nextFrameIndex < run.frameCount && !tasStatusReady(status)) {
      status = await this.waitForTasBufferSpace(run, status);
      if (this.activeTasRun !== run || run.stopped || run.paused) {
        break;
      }

      status = await this.sendNextTasChunk(run);
    }

    if (this.activeTasRun !== run || run.stopped) {
      return;
    }

    if (!run.paused && run.nextFrameIndex >= run.frameCount && !run.uploadEnded) {
      status = await this.finishTasUpload(run);
    }

    if (!run.paused && !tasStatusReady(status)) {
      status = await this.sendFirmwareTasCommand("TAS_STATUS", (message) => message.command === "tas_status");
      this.applyTasFirmwareStatus(run, status, "tas_status");
    }

    if (run.paused) {
      this.broadcast(this.tasStatusPayload("tas_arm", run, { bridge_state: "paused" }));
      return;
    }

    if (!tasStatusReady(status)) {
      throw new Error("Arduino did not report ready after TAS prebuffer upload");
    }

    this.setTasRunState(run, "armed");
    this.broadcast(this.tasStatusPayload("tas_arm", run, { bridge_state: "armed" }));
  }

  async startTasRun(message = {}) {
    const run = this.requireActiveTasRun();
    if (run.state !== "armed") {
      throw new Error("TAS run must be armed before start.");
    }

    const startDelayPolls = normalizeTasRunStartDelayPolls(
      message?.delayPolls ??
        message?.startDelayPolls ??
        message?.start_delay_polls,
    );
    const command = tasStartToBridgeCommand({
      type: "tas_start",
      delayPolls: startDelayPolls,
    });
    if (!command) {
      throw new Error("Invalid TAS start delay.");
    }

    const status = await this.sendFirmwareTasCommand(command, (message) => message.command === "tas_start");
    this.markTasRunStarted(run);
    this.applyTasFirmwareStatus(run, status, "tas_start");
    this.startTasTraceStream(run);

    run.streamTask = this.continueTasStream(run).catch((error) => {
      if (this.activeTasRun !== run) {
        return;
      }

      run.state = "error";
      run.error = error.message;
      this.broadcast({
        type: "tas_error",
        command: "tas_stream",
        message: error.message,
      });
    });
  }

  async continueTasStream(run) {
    let status = run.firmwareStatus;

    while (this.activeTasRun === run && !run.stopped && run.nextFrameIndex < run.frameCount) {
      await this.waitWhileTasPaused(run);
      if (this.activeTasRun !== run || run.stopped) {
        return;
      }

      status = await this.waitForTasBufferSpace(run, status);
      if (this.activeTasRun !== run || run.stopped || run.paused) {
        continue;
      }

      status = await this.sendNextTasChunk(run);
    }

    if (this.activeTasRun !== run || run.stopped) {
      return;
    }

    if (!run.uploadEnded) {
      await this.finishTasUpload(run);
    }

    this.setTasRunState(run, "streaming");
    this.broadcast(this.tasStatusPayload("tas_end", run, { bridge_state: "streaming" }));
    await this.pollTasUntilDone(run);
  }

  async waitForTasBufferSpace(run, status) {
    let nextStatus = status;
    while (this.activeTasRun === run && !run.stopped && !run.paused && tasBufferIsHigh(nextStatus)) {
      await sleep(BRIDGE_TAS_BUFFER_STATUS_POLL_MS);
      if (this.activeTasRun !== run || run.stopped || run.paused) {
        return nextStatus;
      }

      nextStatus = await this.sendFirmwareTasCommand("TAS_STATUS", (message) => message.command === "tas_status");
      this.applyTasFirmwareStatus(run, nextStatus, "tas_status");
    }

    return nextStatus;
  }

  async waitWhileTasPaused(run) {
    while (this.activeTasRun === run && run.paused && !run.stopped) {
      await sleep(100);
    }
  }

  async sendNextTasChunk(run) {
    const available = tasBufferAvailable(run.firmwareStatus);
    const count = Math.min(TAS_CHUNK_FRAME_LIMIT, run.frameCount - run.nextFrameIndex, available);
    const masks = run.masks.slice(run.nextFrameIndex, run.nextFrameIndex + count);
    // Thread the run's port count from TAS_BEGIN so a chunk slice can never
    // re-infer a different count than the run was armed with.
    const chunk = formatTasChunk(run.nextFrameIndex, masks, run.portCount);
    const status = await this.sendFirmwareTasCommand(
      formatTasChunkCommand(chunk),
      (message) => message.command === "tas_chunk" && Number(message.received || 0) >= chunk.startIndex + chunk.count,
    );
    run.nextFrameIndex += count;
    this.applyTasFirmwareStatus(run, status, "tas_chunk");
    return status;
  }

  async finishTasUpload(run) {
    const status = await this.sendFirmwareTasCommand("TAS_END", (message) => message.command === "tas_end");
    run.uploadEnded = true;
    this.applyTasFirmwareStatus(run, status, "tas_end");
    return status;
  }

  async pollTasUntilDone(run) {
    while (this.activeTasRun === run && !run.stopped) {
      await sleep(BRIDGE_TAS_DONE_STATUS_POLL_MS);
      if (this.activeTasRun !== run || run.stopped) {
        return;
      }

      const status = await this.sendFirmwareTasCommand("TAS_STATUS", (message) => message.command === "tas_status");
      this.applyTasFirmwareStatus(run, status, "tas_status");
      if (Number(status.complete) === 1 || status.error !== "ok") {
        return;
      }
    }
  }

  pauseTasRun() {
    const run = this.requireActiveTasRun();
    run.paused = true;
    run.state = "paused";
    this.broadcast(this.tasStatusPayload("tas_pause", run, { bridge_state: "paused" }));
  }

  resumeTasRun() {
    const run = this.requireActiveTasRun();
    run.paused = false;
    run.state = run.started ? "streaming" : "arming";
    this.broadcast(this.tasStatusPayload("tas_resume", run, { bridge_state: run.state }));
    if (!run.started) {
      this.armTasRun().catch((error) => {
        if (this.activeTasRun !== run) {
          return;
        }

        run.state = "error";
        run.error = error.message;
        this.broadcast({
          type: "tas_error",
          command: "tas_arm",
          message: error.message,
        });
      });
    }
  }

  setTasRunState(run, state) {
    run.state = state;
  }

  markTasRunStarted(run) {
    run.started = true;
    run.paused = false;
    run.state = "streaming";
  }

  async cancelTasRun() {
    const run = this.requireActiveTasRun();
    run.paused = false;
    run.stopped = true;
    run.state = "stopped";

    if (this.isConnected()) {
      const status = await this.sendFirmwareTasCommand("TAS_CANCEL", (message) => message.command === "tas_cancel");
      this.applyTasFirmwareStatus(run, status, "tas_cancel");
      return;
    }

    this.broadcast(this.tasStatusPayload("tas_cancel", run, { bridge_state: "stopped" }));
  }

  async handleTasStatus(client) {
    const run = this.activeTasRun;
    if (!run) {
      this.sendJson(client, {
        type: "tas_status",
        command: "tas_status",
        bridge_owned: 1,
        bridge_state: "idle",
        active: 0,
        ready: 0,
        started: 0,
        complete: 0,
        current: 0,
        total: 0,
        received: 0,
        buffered: 0,
        capacity: 0,
        mask: 0,
        sync: HARDWARE_TAS_SYNC_MODE,
        latch: 0,
        clock: 0,
        error: "ok",
      });
      return;
    }

    if (this.isConnected() && run.started && !run.stopped) {
      const status = await this.sendFirmwareTasCommand("TAS_STATUS", (message) => message.command === "tas_status");
      this.applyTasFirmwareStatus(run, status, "tas_status");
      return;
    }

    this.sendJson(client, this.tasStatusPayload("tas_status", run));
  }

  async handleTasTrace(client, message = {}) {
    const requestedCount = normalizeTasTraceDumpCount(message.count ?? message.traceCount);
    const dump = await this.collectTasTraceRows(requestedCount);
    const firmwareStatus = this.activeTasRun?.firmwareStatus || {};
    const traceFrozen = Number(firmwareStatus.trace_frozen || 0) === 1;
    const anomalyCount = Number(firmwareStatus.anomaly_count || 0);
    // The client renders these rows into the event log without timestampMicros,
    // so persist the full CSV server-side too — the timing data is what makes
    // a capture comparable against the emulator's lag structure.
    let savedPath = "";
    if (this.activeTasRun && dump.rows.length > 0) {
      try {
        const filePath = await this.writeTasTraceDumpFile(this.activeTasRun, dump, ["manual_trace_dump: 1"]);
        savedPath = displayPathForLog(filePath);
      } catch (error) {
        this.broadcastBridge(`Manual TAS trace save failed: ${error.message}`);
      }
    }
    let traceMessage = `Dumped ${dump.rows.length} TAS trace row${dump.rows.length === 1 ? "" : "s"}`;
    if (savedPath) {
      traceMessage += `; saved ${savedPath}`;
    }
    if (traceFrozen) {
      traceMessage += `; ring FROZEN at anomaly kind ${firmwareStatus.anomaly_kind ?? "?"} near poll ${firmwareStatus.anomaly_seq ?? "?"}`;
    } else if (anomalyCount > 0) {
      traceMessage += `; ${anomalyCount} anomal${anomalyCount === 1 ? "y" : "ies"} noted (first kind ${firmwareStatus.anomaly_kind ?? "?"} near poll ${firmwareStatus.anomaly_seq ?? "?"})`;
    }

    this.sendJson(client, {
      type: "tas_trace",
      command: "tas_trace",
      bridge_owned: 1,
      total: dump.total,
      capacity: dump.capacity,
      first: dump.first,
      next: dump.next,
      start: dump.requestedStart,
      count: dump.rows.length,
      clipped: dump.clippedRows,
      duplicates: dump.duplicateRows,
      trace_frozen: traceFrozen ? 1 : 0,
      anomaly_count: anomalyCount,
      saved_path: savedPath,
      rows: dump.rows,
      message: traceMessage,
    });
  }

  runExclusiveTrace(task) {
    const result = this.traceLock.then(task, task);
    this.traceLock = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  collectTasTraceRows(requestedCount) {
    return this.runExclusiveTrace(() => this.collectTasTraceRowsLocked(requestedCount));
  }

  collectTasTraceRowsFrom(cursor, maxRows) {
    return this.runExclusiveTrace(() => this.collectTasTraceRowsFromLocked(cursor, maxRows));
  }

  // Streaming variant: page forward from an absolute sequence cursor instead
  // of "last N rows". A null cursor starts at the oldest row still in the
  // ring. Returns the advanced cursor so the caller can resume where this
  // batch ended.
  async collectTasTraceRowsFromLocked(startCursor, maxRows) {
    const probe = await this.sendFirmwareTasCommand("TAS_TRACE 1", (response) => response.command === "tas_trace");
    const first = Number(probe.first || 0);
    const next = Number(probe.next || 0);
    const rows = [];
    const seenSequences = new Set();
    let clippedRows = 0;
    let duplicateRows = 0;
    let cursor = startCursor === null || startCursor === undefined ? first : startCursor;
    if (cursor < first) {
      clippedRows += first - cursor;
      cursor = first;
    }
    if (cursor > next) {
      // The ring restarted (TAS_BEGIN/TAS_START reset the sequence counter).
      cursor = first;
    }

    while (cursor < next && rows.length < maxRows) {
      const pageCount = Math.min(BRIDGE_TAS_TRACE_PAGE_LIMIT, maxRows - rows.length, next - cursor);
      const status = await this.sendFirmwareTasCommand(
        `TAS_TRACE ${pageCount} ${cursor}`,
        (response) => response.command === "tas_trace",
      );
      const pageStart = Number(status.page_start ?? cursor);
      if (Number.isSafeInteger(pageStart) && pageStart > cursor) {
        clippedRows += pageStart - cursor;
      }

      for (const row of parseTasTraceRows(status.rows)) {
        if (seenSequences.has(row.sequence)) {
          duplicateRows += 1;
          continue;
        }
        seenSequences.add(row.sequence);
        rows.push(row);
      }

      const pageNext = Number(status.page_next || 0);
      if (!Number.isSafeInteger(pageNext) || pageNext <= cursor) {
        break;
      }
      cursor = pageNext;
    }

    return {
      first,
      next,
      cursor,
      clippedRows,
      duplicateRows,
      rows,
    };
  }

  async collectTasTraceRowsLocked(requestedCount) {
    const probe = await this.sendFirmwareTasCommand("TAS_TRACE 1", (response) => response.command === "tas_trace");
    const first = Number(probe.first || 0);
    const next = Number(probe.next || 0);
    const total = Number(probe.total || 0);
    const capacity = Number(probe.capacity || 0);
    const requestedStart = Math.max(first, next - requestedCount);
    const rows = [];
    const seenSequences = new Set();
    let clippedRows = 0;
    let duplicateRows = 0;
    let cursor = requestedStart;

    while (cursor < next && rows.length < requestedCount) {
      const pageCount = Math.min(BRIDGE_TAS_TRACE_PAGE_LIMIT, requestedCount - rows.length, next - cursor);
      const status = await this.sendFirmwareTasCommand(
        `TAS_TRACE ${pageCount} ${cursor}`,
        (response) => response.command === "tas_trace",
      );
      const pageStart = Number(status.page_start ?? cursor);
      if (Number.isSafeInteger(pageStart) && pageStart > cursor) {
        clippedRows += pageStart - cursor;
      }

      for (const row of parseTasTraceRows(status.rows)) {
        if (seenSequences.has(row.sequence)) {
          duplicateRows += 1;
          continue;
        }
        seenSequences.add(row.sequence);
        rows.push(row);
      }

      const pageNext = Number(status.page_next || 0);
      if (!Number.isSafeInteger(pageNext) || pageNext <= cursor) {
        break;
      }
      cursor = pageNext;
    }

    return {
      total,
      capacity,
      first,
      next,
      requestedStart,
      clippedRows,
      duplicateRows,
      rows,
    };
  }

  async handleEventLogSave(client, message = {}) {
    try {
      const text = normalizeEventLogText(message.text);
      const reason = sanitizeEventLogReason(message.reason);
      const timestamp = new Date();
      const metadata = normalizeEventLogMetadata(message.metadata);
      const traceLog = reason === "tas-trace";
      const outputDir = traceLog ? path.join(this.logDir, TRACE_LOG_DIR_NAME) : this.logDir;
      const fileName = traceLog
        ? traceLogFileName(metadata.tasFileName || metadata.tdmaskFileName || this.activeTasRun?.fileName, timestamp)
        : eventLogFileName(reason, timestamp);
      const filePath = path.join(outputDir, fileName);
      const outputText = traceLog
        ? `${formatTraceEventLogHeader(metadata, this.activeTasRun, timestamp)}\n\n${text.trimEnd()}\n`
        : `${text.trimEnd()}\n`;
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.writeFile(filePath, outputText, "utf8");

      this.sendJson(client, {
        type: "event_log_saved",
        requestId: message.requestId || "",
        path: displayPathForLog(filePath),
        fileName,
        bytes: Buffer.byteLength(outputText, "utf8"),
      });
    } catch (error) {
      this.sendJson(client, {
        type: "event_log_error",
        requestId: message.requestId || "",
        message: error.message,
      });
    }
  }

  requireActiveTasRun() {
    if (!this.activeTasRun) {
      throw new Error("No TAS run has been uploaded to the bridge.");
    }

    return this.activeTasRun;
  }

  applyTasFirmwareStatus(run, status, command) {
    run.firmwareStatus = status;
    run.error = status.error || "ok";
    if (Number(status.received || 0) > run.nextFrameIndex) {
      run.nextFrameIndex = Math.min(Number(status.received), run.frameCount);
    }
    if (run.error && run.error !== "ok") {
      run.state = "error";
    } else if (Number(status.complete) === 1) {
      run.paused = false;
      run.state = "complete";
    }
    this.maybeDumpFrozenTasTrace(run, status);
    this.broadcast(this.tasStatusPayload(command, run, status));
  }

  maybeDumpFrozenTasTrace(run, status) {
    if (!this.isConnected() || !run || run.stopped || Number(status?.trace_frozen || 0) !== 1) {
      return;
    }

    const frozenKey = `${status.anomaly_seq ?? ""}:${status.anomaly_kind ?? ""}`;
    if (run.traceDumpTask || run.lastFrozenTraceKey === frozenKey) {
      return;
    }

    run.lastFrozenTraceKey = frozenKey;
    const task = this.dumpFrozenTasTrace(run, status)
      .catch((error) => {
        run.lastFrozenTraceKey = "";
        this.broadcastBridge(`Auto TAS trace dump failed: ${error.message}`);
      })
      .finally(() => {
        if (run.traceDumpTask === task) {
          run.traceDumpTask = null;
        }
      });
    run.traceDumpTask = task;
  }

  async writeTasTraceDumpFile(run, dump, extraHeaderLines, timestamp = new Date()) {
    const outputDir = path.join(this.logDir, TRACE_LOG_DIR_NAME);
    const fileName = traceLogFileName(run.fileName, timestamp);
    const filePath = path.join(outputDir, fileName);
    const metadata = {
      timestamp: timestamp.toISOString(),
      tasFileName: run.fileName,
      bridgeRunId: run.id,
      skipPolls: run.skipPolls || 0,
      originalPolls: run.originalFrameCount || run.frameCount,
      effectivePolls: run.frameCount,
      portCount: run.portCount || 1,
      syncMode: run.syncMode || HARDWARE_TAS_SYNC_MODE,
      traceStart: dump.requestedStart,
      traceNext: dump.next,
      traceCount: dump.rows.length,
      traceCapacity: dump.capacity,
      traceClipped: dump.clippedRows,
      traceDuplicates: dump.duplicateRows,
    };
    const rowsText = formatTasTraceRowsForFile(dump.rows);
    const outputText = [
      formatTraceEventLogHeader(metadata, run, timestamp),
      ...extraHeaderLines,
      "",
      rowsText,
      "",
    ].join("\n");

    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(filePath, outputText, "utf8");
    return filePath;
  }

  async dumpFrozenTasTrace(run, firmwareStatus) {
    const dump = await this.collectTasTraceRows(BRIDGE_TAS_TRACE_MAX_COUNT);
    const filePath = await this.writeTasTraceDumpFile(run, dump, [
      "auto_trace_dump: 1",
      `trigger_anomaly_count: ${firmwareStatus.anomaly_count ?? ""}`,
      `trigger_anomaly_seq: ${firmwareStatus.anomaly_seq ?? ""}`,
      `trigger_anomaly_kind: ${firmwareStatus.anomaly_kind ?? ""}`,
    ]);
    this.broadcastBridge(`Auto-saved frozen TAS trace to ${displayPathForLog(filePath)}`);

    const resumeStatus = await this.sendFirmwareTasCommand(
      "TAS_TRACE_RESUME",
      (message) => message.command === "tas_trace_resume",
    );
    this.applyTasFirmwareStatus(run, resumeStatus, "tas_trace_resume");
  }

  startTasTraceStream(run) {
    if (!BRIDGE_TAS_TRACE_STREAM_ENABLED || run.traceStreamTask) {
      return;
    }

    run.traceStreamTask = this.streamTasTraceRows(run)
      .catch((error) => {
        this.broadcastBridge(`TAS trace stream stopped: ${error.message}`);
      })
      .finally(() => {
        run.traceStreamTask = null;
      });
  }

  // Follows the firmware trace ring for the whole run and appends every row
  // to a single CSV. Chunk uploads keep priority: while the mask buffer is
  // still filling, collection only runs when the buffer is high (the chunk
  // loop is idle-waiting in exactly that state). Rows that fall out of the
  // ring before we reach them become "# gap" comment lines. After the run
  // stops or completes, a bounded drain empties the ring: it survives
  // completion and TAS_CANCEL (only TAS_BEGIN/TAS_START reset it), so the
  // last seconds before a desync stop are still recoverable.
  async streamTasTraceRows(run) {
    const startedAt = new Date();
    const outputDir = path.join(this.logDir, TRACE_LOG_DIR_NAME);
    const filePath = path.join(outputDir, streamTraceFileName(run.fileName, startedAt));
    let fileReady = false;
    let cursor = null;
    let totalRows = 0;
    let totalGaps = 0;
    let failures = 0;
    let draining = false;
    let drainBatches = 0;

    const running = () =>
      this.activeTasRun === run && !run.stopped && run.state !== "complete" && run.state !== "error";

    for (;;) {
      if (!draining && !running()) {
        draining = true;
      }
      if (draining && (!this.isConnected() || this.activeTasRun !== run || drainBatches >= BRIDGE_TAS_TRACE_STREAM_DRAIN_BATCH_LIMIT)) {
        break;
      }

      if (!draining) {
        if (!this.isConnected() || run.paused) {
          await sleep(500);
          continue;
        }

        const status = run.firmwareStatus || {};
        if (Number(status.trace_frozen || 0) === 1) {
          // The frozen-ring auto-dump owns this state; rows resume after
          // TAS_TRACE_RESUME and the sequence jump shows up as a gap line.
          await sleep(BRIDGE_TAS_TRACE_STREAM_IDLE_MS);
          continue;
        }
        if (!run.uploadEnded && !tasBufferIsHigh(status)) {
          await sleep(BRIDGE_TAS_TRACE_STREAM_BACKOFF_MS);
          continue;
        }
      }

      let dump;
      try {
        dump = await this.collectTasTraceRowsFrom(cursor, BRIDGE_TAS_TRACE_STREAM_BATCH_ROWS);
      } catch (error) {
        failures += 1;
        if (failures >= BRIDGE_TAS_TRACE_STREAM_MAX_FAILURES) {
          throw error;
        }
        await sleep(1000);
        continue;
      }
      failures = 0;
      cursor = dump.cursor;

      let text = "";
      if (!fileReady) {
        fileReady = true;
        await fsp.mkdir(outputDir, { recursive: true });
        const headerLines = [
          "# tasdeck trace stream v1",
          `# tas_file: ${run.fileName}`,
          `# bridge_run_id: ${run.id}`,
          `# effective_polls: ${run.frameCount}`,
          `# started: ${startedAt.toISOString()}`,
          TAS_TRACE_CSV_HEADER,
        ];
        text += `${headerLines.join("\n")}\n`;
      }
      if (dump.clippedRows > 0) {
        totalGaps += dump.clippedRows;
        const resumeSeq = dump.rows.length > 0 ? dump.rows[0].sequence : dump.cursor;
        text += `# gap: ${dump.clippedRows} rows lost before seq ${resumeSeq}\n`;
      }
      if (dump.rows.length > 0) {
        totalRows += dump.rows.length;
        text += `${formatTasTraceRowsBody(dump.rows)}\n`;
      }
      if (text) {
        await fsp.appendFile(filePath, text, "utf8");
      }

      if (draining) {
        drainBatches += 1;
        if (dump.cursor >= dump.next) {
          break;
        }
      } else if (dump.cursor >= dump.next) {
        await sleep(BRIDGE_TAS_TRACE_STREAM_IDLE_MS);
      }
    }

    if (fileReady) {
      const finalStatus = run.firmwareStatus || {};
      await fsp.appendFile(
        filePath,
        `# end: rows=${totalRows} gaps=${totalGaps} bare_strobes=${finalStatus.bare_strobes ?? 0} torn_strobes=${finalStatus.torn_strobes ?? 0}\n`,
        "utf8",
      );
      const gapNote = totalGaps > 0 ? ` (${totalGaps} rows lost to ring overwrite)` : "";
      this.broadcastBridge(`TAS trace stream saved ${totalRows} rows to ${displayPathForLog(filePath)}${gapNote}`);
    }
  }

  tasStatusPayload(command, run, status = {}) {
    const complete = Number(status.complete ?? (run.state === "complete" ? 1 : 0)) === 1 ? 1 : 0;
    const bridgeState = complete ? "complete" : status.bridge_state || run.state;
    const firmwareStatus = run.firmwareStatus || {};
    return {
      type: "tas_status",
      command,
      bridge_owned: 1,
      bridge_state: bridgeState,
      run_id: run.id,
      client_run_id: run.clientRunId || 0,
      file_name: run.fileName,
      skip_polls: run.skipPolls || 0,
      port_count: run.portCount || 1,
      original_total: run.originalFrameCount || run.frameCount,
      original_input_frame_count: run.originalInputFrameCount || run.inputFrameCount,
      input_frame_count: run.inputFrameCount,
      active: status.active ?? (complete || run.stopped ? 0 : 1),
      ready: status.ready ?? (run.state === "armed" ? 1 : 0),
      start_requested: status.start_requested ?? (run.started ? 1 : 0),
      started: status.started ?? (run.started ? 1 : 0),
      complete,
      receiving_complete: status.receiving_complete ?? (run.uploadEnded ? 1 : 0),
      current: status.current ?? firmwareStatus.current ?? 0,
      total: status.total ?? firmwareStatus.total ?? run.frameCount,
      received: status.received ?? firmwareStatus.received ?? run.nextFrameIndex,
      buffered: status.buffered ?? firmwareStatus.buffered ?? 0,
      capacity: status.capacity ?? firmwareStatus.capacity ?? 0,
      fw: status.fw ?? firmwareStatus.fw ?? "",
      latch_edge: status.latch_edge ?? firmwareStatus.latch_edge ?? "",
      clock_edge: status.clock_edge ?? firmwareStatus.clock_edge ?? "",
      mask: status.mask ?? firmwareStatus.mask ?? 0,
      mask2: status.mask2 ?? firmwareStatus.mask2 ?? 0,
      pressed: status.pressed ?? firmwareStatus.pressed ?? 0,
      pressed2: status.pressed2 ?? firmwareStatus.pressed2 ?? 0,
      latched: status.latched ?? firmwareStatus.latched ?? 0,
      latched2: status.latched2 ?? firmwareStatus.latched2 ?? 0,
      index: status.index ?? firmwareStatus.index ?? 0,
      index2: status.index2 ?? firmwareStatus.index2 ?? 0,
      data: status.data ?? firmwareStatus.data ?? 1,
      data2: status.data2 ?? firmwareStatus.data2 ?? 1,
      output_enabled: status.output_enabled ?? firmwareStatus.output_enabled ?? 0,
      start_delay_polls: status.start_delay_polls ?? firmwareStatus.start_delay_polls ?? 0,
      sync: status.sync ?? firmwareStatus.sync ?? run.syncMode,
      latch: status.latch ?? firmwareStatus.latch ?? 0,
      clock: status.clock ?? firmwareStatus.clock ?? 0,
      clock2: status.clock2 ?? firmwareStatus.clock2 ?? 0,
      bare_strobes: status.bare_strobes ?? firmwareStatus.bare_strobes ?? 0,
      torn_strobes: status.torn_strobes ?? firmwareStatus.torn_strobes ?? 0,
      anomaly_count: status.anomaly_count ?? firmwareStatus.anomaly_count ?? 0,
      anomaly_seq: status.anomaly_seq ?? firmwareStatus.anomaly_seq ?? 0,
      anomaly_kind: status.anomaly_kind ?? firmwareStatus.anomaly_kind ?? 0,
      trace_frozen: status.trace_frozen ?? firmwareStatus.trace_frozen ?? 0,
      error: status.error || firmwareStatus.error || run.error || "ok",
      message: status.message || `Bridge TAS ${bridgeState}`,
    };
  }

  commandForEvent(client, event) {
    const command = eventToBridgeCommand(event);
    if (!command || event.type !== "button") {
      return null;
    }

    const controllerPort = normalizeControllerPort(event.controllerPort ?? event.controller ?? event.port);
    const holderKey = controllerButtonKey(controllerPort, event.button);
    const holders = this.buttonHolders.get(holderKey);
    if (!holders) {
      return null;
    }

    if (event.action === "down") {
      const wasReleased = holders.size === 0;
      holders.add(client);
      client.heldButtons.add(holderKey);
      return wasReleased ? command : null;
    }

    if (event.action === "up") {
      const wasHeldByClient = holders.delete(client);
      client.heldButtons.delete(holderKey);

      if (holders.size === 0 || !wasHeldByClient) {
        return command;
      }
    }

    return null;
  }

  commandForTasMessage(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    if (message.type === "tas_begin") {
      return tasBeginToBridgeCommand(message);
    }

    if (message.type === "tas_chunk") {
      return tasChunkToBridgeCommand(message);
    }

    if (message.type === "tas_cancel") {
      return tasCancelToBridgeCommand(message);
    }

    if (message.type === "tas_end") {
      return tasEndToBridgeCommand(message);
    }

    if (message.type === "tas_start") {
      return tasStartToBridgeCommand(message);
    }

    if (message.type === "tas_status") {
      return tasStatusToBridgeCommand(message);
    }

    if (message.type === "tas_trace") {
      return tasTraceToBridgeCommand(message);
    }

    return null;
  }

  async releaseClientButtons(client, reason) {
    if (!this.isConnected() || client.heldButtons.size === 0) {
      client.heldButtons.clear();
      return;
    }

    const buttons = [...client.heldButtons];
    client.heldButtons.clear();

    for (const key of buttons) {
      const { port, button } = parseControllerButtonKey(key);
      const holders = this.buttonHolders.get(key);
      holders?.delete(client);
      if (!holders || holders.size === 0) {
        await this.writeCommand(port === 1 ? `BUTTON ${button} up` : `BUTTON ${port} ${button} up`);
      }
    }

    if (buttons.length > 0) {
      this.broadcastBridge(`Released ${buttons.map(formatControllerButtonKey).join(", ")} after ${reason}`);
    }
  }

  async releaseAllButtons(reason) {
    if (!this.isConnected()) {
      this.clearHeldButtons();
      return;
    }

    for (const key of controllerButtonKeys()) {
      const { port, button } = parseControllerButtonKey(key);
      await this.writeCommand(port === 1 ? `BUTTON ${button} up` : `BUTTON ${port} ${button} up`);
    }
    this.clearHeldButtons();
    this.broadcastBridge(`Released all controller buttons for ${reason}`);
  }

  clearHeldButtons() {
    this.clients.forEach((client) => client.heldButtons.clear());
    this.buttonHolders.forEach((holders) => holders.clear());
  }

  writeCommand(command) {
    const write = this.writeQueue.then(async () => {
      if (!this.handle) {
        throw new Error("Arduino USB serial is not connected");
      }

      await writeSerialData(this.handle, Buffer.from(`${command}\n`));
    });

    this.writeQueue = write.catch(() => {});
    return write.catch((error) => {
      this.broadcastBridge(`USB serial send failed: ${error.message}`);
      throw error;
    });
  }

  sendFirmwareTasCommand(command, matcher) {
    const responsePromise = this.waitForTasResponse(matcher);
    return this.writeCommand(command)
      .catch((error) => {
        this.rejectTasWaiters(error);
        throw error;
      })
      .then(() => responsePromise);
  }

  async requestFirmwareStatus(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline && this.handle) {
      const attemptTimeout = Math.min(SERIAL_STATUS_ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
      const responsePromise = this.waitForSerialLine((line) => /^OK\s+status\b/i.test(line), attemptTimeout);
      try {
        await this.writeCommand("STATUS");
      } catch (error) {
        this.rejectSerialWaiters(error);
        await responsePromise.catch(() => {});
        throw error;
      }

      try {
        return await responsePromise;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(lastError?.message || "Timed out waiting for Arduino firmware status");
  }

  waitForSerialLine(matcher, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.serialWaiters = this.serialWaiters.filter((item) => item !== waiter);
          reject(new Error("Timed out waiting for Arduino firmware status"));
        }, timeoutMs),
      };

      this.serialWaiters.push(waiter);
    });
  }

  resolveSerialWaiters(line) {
    const remaining = [];
    this.serialWaiters.forEach((waiter) => {
      if (waiter.matcher(line)) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        remaining.push(waiter);
      }
    });
    this.serialWaiters = remaining;
  }

  rejectSerialWaiters(error) {
    this.serialWaiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    this.serialWaiters = [];
  }

  waitForTasResponse(matcher) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.tasWaiters = this.tasWaiters.filter((item) => item !== waiter);
          reject(new Error("Timed out waiting for Arduino TAS response"));
        }, BRIDGE_TAS_WAITER_TIMEOUT_MS),
      };

      this.tasWaiters.push(waiter);
    });
  }

  resolveTasWaiters(message) {
    const remaining = [];
    this.tasWaiters.forEach((waiter) => {
      if (waiter.matcher(message)) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    });
    this.tasWaiters = remaining;
  }

  rejectTasWaiters(error) {
    this.tasWaiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    this.tasWaiters = [];
  }

  waitForDrain() {
    return this.writeQueue.catch(() => {});
  }

  async startReadLoop(handle) {
    const buffer = Buffer.alloc(512);

    try {
      while (this.handle === handle) {
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
        } catch (error) {
          if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
            await sleep(20);
            continue;
          }
          throw error;
        }

        if (bytesRead === 0) {
          await sleep(20);
          continue;
        }

        if (this.handle !== handle) {
          break;
        }

        this.handleSerialBytes(buffer.subarray(0, bytesRead));
      }
    } catch (error) {
      if (!this.disconnecting && this.handle === handle) {
        this.broadcastBridge(`Arduino serial read failed: ${error.message}`);
      }
    } finally {
      if (this.handle === handle) {
        this.handle = null;
        this.portPath = "";
        this.readBuffer = "";
        this.serialReady = false;
        this.rejectSerialWaiters(new Error("Arduino USB serial disconnected"));
        this.rejectTasWaiters(new Error("Arduino USB serial disconnected"));
        this.clearHeldButtons();
        this.broadcastBridge("Arduino USB serial disconnected");
        this.broadcastStatus();
        // A read-side USB disconnect bypasses disconnect(), so this loop owns
        // closing the FileHandle. Leaving it for garbage collection emits
        // DEP0137 and leaks descriptors across reconnects.
        await this.closeSerialHandle(handle, {
          timeoutMs: SERIAL_HANDLE_CLOSE_TIMEOUT_MS,
        });
      }
    }
  }

  handleSerialBytes(bytes) {
    this.readBuffer += bytes.toString("utf8");
    const lines = this.readBuffer.split(/\r?\n/);
    this.readBuffer = lines.pop() || "";

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.resolveSerialWaiters(trimmed);
        const tasMessage = parseTasSerialLine(trimmed);
        this.broadcastBridge(`Arduino: ${trimmed}`);
        if (tasMessage) {
          if (tasMessage.type === "tas_error") {
            this.rejectTasWaiters(new Error(tasMessage.message || tasMessage.error));
          } else {
            this.resolveTasWaiters(tasMessage);
          }
          if (!this.activeTasRun || tasMessage.type === "tas_error") {
            this.broadcast(tasMessage);
          }
        }
      }
    });
  }

  broadcastStatus() {
    this.broadcast(this.statusPayload());
  }

  broadcastBridge(message) {
    this.broadcast({ type: "bridge", message });
  }

  broadcast(payload) {
    this.clients.forEach((client) => this.sendJson(client, payload));
  }

  sendJson(client, payload) {
    if (client.socket.destroyed) {
      return;
    }

    client.socket.write(encodeWebSocketFrame(JSON.stringify(payload)));
  }
}

function createServer(options = {}) {
  const serialBridge = new SerialBridge({ serialPort: options.serialPort });
  const server = http.createServer((request, response) => {
    serveStatic(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Server error: ${error.message}`);
    });
  });

  server.on("upgrade", (request, socket) => {
    if (!isBridgeUpgrade(request)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    acceptWebSocket(request, socket, serialBridge);
  });

  return { server, serialBridge };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/bridge/status") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  const filePath = resolveStaticPath(url.pathname);
  if (!filePath) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  if (stat.isDirectory()) {
    response.writeHead(301, { location: "/" });
    response.end();
    return;
  }

  response.writeHead(200, {
    "content-length": stat.size,
    "content-type": getContentType(filePath),
  });
  fs.createReadStream(filePath).pipe(response);
}

function resolveStaticPath(rawPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, relativePath);
  const relativeToRoot = path.relative(WEB_ROOT, filePath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  return filePath;
}

function isBridgeUpgrade(request) {
  const url = new URL(request.url, "http://localhost");
  return url.pathname === "/bridge" && request.headers.upgrade?.toLowerCase() === "websocket";
}

function acceptWebSocket(request, socket, serialBridge) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    fragmentedMessage: null,
    heldButtons: new Set(),
  };
  serialBridge.addClient(client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    handleWebSocketBuffer(client, serialBridge);
  });

  socket.on("close", () => serialBridge.removeClient(client));
  socket.on("error", () => serialBridge.removeClient(client));
}

function handleWebSocketBuffer(client, serialBridge) {
  while (client.buffer.length > 0) {
    let decoded;
    try {
      decoded = decodeWebSocketFrame(client.buffer);
    } catch (error) {
      serialBridge.sendJson(client, { type: "error", message: error.message });
      client.socket.destroy();
      return;
    }

    if (!decoded) {
      return;
    }

    client.buffer = client.buffer.subarray(decoded.frameLength);

    if (decoded.opcode === 0x8) {
      client.socket.end(encodeWebSocketFrame("", 0x8));
      serialBridge.removeClient(client);
      return;
    }

    if (decoded.opcode === 0x9) {
      client.socket.write(encodeWebSocketFrame(decoded.payload, 0xA));
      continue;
    }

    if (decoded.opcode === 0x0) {
      try {
        handleWebSocketContinuation(client, serialBridge, decoded);
      } catch (error) {
        serialBridge.sendJson(client, { type: "error", message: error.message });
        client.socket.destroy();
        return;
      }
      continue;
    }

    if (decoded.opcode !== 0x1) {
      continue;
    }

    if (!decoded.fin) {
      try {
        beginWebSocketFragmentedMessage(client, decoded);
      } catch (error) {
        serialBridge.sendJson(client, { type: "error", message: error.message });
        client.socket.destroy();
        return;
      }
      continue;
    }

    handleWebSocketTextMessage(client, serialBridge, decoded.payload);
  }
}

function beginWebSocketFragmentedMessage(client, decoded) {
  if (client.fragmentedMessage) {
    throw new Error("Unexpected WebSocket message before fragmented message completed");
  }

  client.fragmentedMessage = {
    opcode: decoded.opcode,
    fragments: [],
    length: 0,
  };
  appendWebSocketFragment(client, decoded.payload);
}

function handleWebSocketContinuation(client, serialBridge, decoded) {
  if (!client.fragmentedMessage) {
    throw new Error("Unexpected WebSocket continuation frame");
  }

  appendWebSocketFragment(client, decoded.payload);
  if (!decoded.fin) {
    return;
  }

  const message = client.fragmentedMessage;
  client.fragmentedMessage = null;
  const payload = Buffer.concat(message.fragments, message.length);

  if (message.opcode === 0x1) {
    handleWebSocketTextMessage(client, serialBridge, payload);
  }
}

function appendWebSocketFragment(client, payload) {
  const message = client.fragmentedMessage;
  const nextLength = message.length + payload.length;
  if (nextLength > MAX_WS_PAYLOAD_BYTES) {
    throw new Error("WebSocket payload is too large");
  }

  message.fragments.push(payload);
  message.length = nextLength;
}

function handleWebSocketTextMessage(client, serialBridge, payload) {
  handleClientMessage(client, serialBridge, payload.toString("utf8")).catch((error) => {
    serialBridge.sendJson(client, { type: "error", message: error.message });
  });
}

async function handleClientMessage(client, serialBridge, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    serialBridge.sendJson(client, { type: "error", message: "Invalid bridge message JSON" });
    return;
  }

  if (message.type === "connect") {
    await serialBridge.connect();
    return;
  }

  if (message.type === "disconnect") {
    await serialBridge.disconnect({ reason: "Disconnected from Arduino USB serial" });
    return;
  }

  if (message.type === "event") {
    await serialBridge.handleClientEvent(client, message.event);
    return;
  }

  if (message.type === "save_event_log") {
    await serialBridge.handleEventLogSave(client, message);
    return;
  }

  if (
    message.type === "tas_upload" ||
    message.type === "tas_arm" ||
    message.type === "tas_begin" ||
    message.type === "tas_chunk" ||
    message.type === "tas_cancel" ||
    message.type === "tas_pause" ||
    message.type === "tas_resume" ||
    message.type === "tas_start" ||
    message.type === "tas_end" ||
    message.type === "tas_status" ||
    message.type === "tas_trace") {
    await serialBridge.handleClientTasMessage(client, message);
    return;
  }

  if (message.type === "status") {
    serialBridge.sendJson(client, serialBridge.statusPayload());
  }
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = Boolean(firstByte & 0x80);
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    payloadLength = high * 2 ** 32 + low;
    offset += 8;
  }

  if (payloadLength > MAX_WS_PAYLOAD_BYTES) {
    throw new Error("WebSocket payload is too large");
  }

  const maskLength = masked ? 4 : 0;
  const frameLength = offset + maskLength + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  let payload = buffer.subarray(offset + maskLength, frameLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return { fin, frameLength, opcode, payload };
}

function encodeWebSocketFrame(payload, opcode = 0x1) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = payloadBuffer.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return Buffer.concat([header, payloadBuffer]);
}

async function findSerialPort(explicitPort) {
  if (explicitPort) {
    await assertSerialPortExists(explicitPort);
    return explicitPort;
  }

  const candidates = await listCandidateSerialPorts();
  if (candidates.length === 0) {
    throw new Error(
      "No Arduino USB serial port found. Set SERIAL_PORT=/dev/cu.usbmodemXXXX before starting the server.",
    );
  }

  return candidates[0];
}

async function assertSerialPortExists(portPath) {
  try {
    await fsp.stat(portPath);
  } catch {
    throw new Error(`Serial port not found: ${portPath}`);
  }
}

async function listCandidateSerialPorts() {
  let entries;
  try {
    entries = await fsp.readdir("/dev");
  } catch {
    return [];
  }

  return entries
    .filter(isCandidateSerialDevice)
    .sort(compareSerialDevices)
    .map((entry) => path.join("/dev", entry));
}

function isCandidateSerialDevice(entry) {
  return [
    /^cu\.usbmodem/i,
    /^cu\.usbserial/i,
    /^tty\.usbmodem/i,
    /^tty\.usbserial/i,
    /^ttyACM\d+$/i,
    /^ttyUSB\d+$/i,
  ].some((pattern) => pattern.test(entry));
}

function compareSerialDevices(left, right) {
  const leftScore = left.startsWith("cu.") ? 0 : 1;
  const rightScore = right.startsWith("cu.") ? 0 : 1;
  return leftScore - rightScore || left.localeCompare(right);
}

function configureSerialPort(portPath) {
  if (process.platform === "win32") {
    throw new Error("The dependency-free serial bridge currently supports macOS and Linux serial devices.");
  }

  const args = serialPortSttyArgs(portPath);

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("stty", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`stty failed for ${portPath}: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function serialPortSttyArgs(portPath) {
  const deviceFlag = process.platform === "darwin" ? "-f" : "-F";
  return [
    deviceFlag,
    portPath,
    String(SERIAL_BAUD),
    "cs8",
    "-cstopb",
    "-parenb",
    "raw",
    "-echo",
    "min",
    "0",
    "time",
    "1",
  ];
}

async function writeSerialData(handle, data) {
  if (handle.write.length <= 1) {
    await handle.write(data.toString("utf8"));
    return;
  }

  let offset = 0;
  while (offset < data.length) {
    try {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
      if (bytesWritten === 0) {
        await sleep(20);
      } else {
        offset += bytesWritten;
      }
    } catch (error) {
      if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
        await sleep(20);
        continue;
      }
      throw error;
    }
  }
}

function parseTasSerialLine(line) {
  const okMatch = /^OK\s+(tas_begin|tas_chunk|tas_cancel|tas_start|tas_end|tas_status|tas_trace|tas_trace_resume)\b(.*)$/i.exec(line);
  if (okMatch) {
    const command = okMatch[1].toLowerCase();
    return {
      type: command === "tas_trace" ? "tas_trace" : "tas_status",
      command,
      message: line,
      ...parseKeyValueTokens(okMatch[2]),
    };
  }

  const errorMatch = /^ERR\s+(tas_[^\s]+)\b(.*)$/i.exec(line);
  if (errorMatch) {
    return {
      type: "tas_error",
      error: errorMatch[1].toLowerCase(),
      message: line,
      ...parseKeyValueTokens(errorMatch[2]),
    };
  }

  return null;
}

function normalizeUploadedMasks(value, portCount) {
  if (!Array.isArray(value)) {
    throw new Error("TAS upload frame data must be an array.");
  }

  // Two-port uploads arrive as flat interleaved bytes plus portCount; older
  // clients may still send one mask object per frame. tasMasksFromWire
  // handles both and returns per-frame masks either way.
  return tasMasksFromWire(value, portCount);
}

function normalizeControllerPort(value) {
  const normalized = value === undefined || value === null || value === "" ? 1 : Number(value);
  return normalized === 2 ? 2 : 1;
}

function controllerButtonKey(port, button) {
  return `${normalizeControllerPort(port)}:${button}`;
}

function controllerButtonKeys() {
  return [1, 2].flatMap((port) => NES_BUTTONS.map((button) => controllerButtonKey(port, button)));
}

function parseControllerButtonKey(key) {
  const [port, button] = String(key).split(":");
  if (!button) {
    return {
      port: 1,
      button: String(key),
    };
  }

  return {
    port: normalizeControllerPort(port),
    button,
  };
}

function formatControllerButtonKey(key) {
  const { port, button } = parseControllerButtonKey(key);
  return `P${port} ${button}`;
}

function normalizeTasRunStartDelayPolls(value) {
  const normalized = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > HARDWARE_TAS_MAX_START_DELAY_POLLS
  ) {
    throw new Error("TAS start delay is out of range.");
  }

  return normalized;
}

function normalizeTasRunSkipPolls(value, totalPolls) {
  const normalized = value === undefined || value === null || value === "" ? 0 : Number(value);
  const max = Math.max(0, Number(totalPolls) - 1);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > max) {
    throw new Error("TAS skip poll count is out of range.");
  }

  return normalized;
}

function normalizeTasTraceDumpCount(value) {
  const normalized =
    value === undefined || value === null || value === "" ? BRIDGE_TAS_TRACE_DEFAULT_COUNT : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error("TAS trace count is out of range.");
  }

  return Math.min(normalized, BRIDGE_TAS_TRACE_MAX_COUNT);
}

function normalizeEventLogText(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Event log text is empty.");
  }

  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_EVENT_LOG_BYTES) {
    throw new Error("Event log text is too large.");
  }

  return value;
}

function sanitizeEventLogReason(value) {
  const normalized = String(value || "event-log")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "event-log";
}

function eventLogFileName(reason, now = new Date()) {
  const timestamp = fileTimestamp(now);
  return `tasdeck-${reason}-${timestamp}.txt`;
}

function traceLogFileName(fileName, now = new Date()) {
  const timestamp = fileTimestamp(now);
  const baseName = sanitizeTraceBaseName(fileName);
  return `${timestamp}_${baseName}.trace`;
}

function streamTraceFileName(fileName, now = new Date()) {
  const timestamp = fileTimestamp(now);
  const baseName = sanitizeTraceBaseName(fileName);
  return `${timestamp}_${baseName}.stream.csv`;
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

function sanitizeTraceBaseName(fileName) {
  const rawBase = path.basename(String(fileName || "unknown").trim() || "unknown");
  const withoutTasExtension = rawBase.replace(/\.(?:tdmask|r08)$/i, "");
  const withoutExtension = withoutTasExtension === rawBase ? path.parse(rawBase).name : withoutTasExtension;
  const safe = withoutExtension
    .replace(/[^a-zA-Z0-9._,-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "unknown";
}

function normalizeEventLogMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const metadata = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null) {
      return;
    }
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      metadata[key] = rawValue;
    }
  });
  return metadata;
}

function formatTraceEventLogHeader(metadata, run, timestamp = new Date()) {
  const firmwareStatus = run?.firmwareStatus || {};
  return [
    "TASDeck Trace",
    `timestamp: ${metadata.timestamp || timestamp.toISOString()}`,
    `tas_file: ${metadata.tasFileName || metadata.tdmaskFileName || run?.fileName || "unknown"}`,
    `bridge_run_id: ${metadata.bridgeRunId ?? run?.id ?? ""}`,
    `client_run_id: ${run?.clientRunId ?? ""}`,
    `skip_polls: ${metadata.skipPolls ?? run?.skipPolls ?? 0}`,
    `delay_polls: ${metadata.delayPolls ?? ""}`,
    `sync_mode: ${metadata.syncMode ?? run?.syncMode ?? HARDWARE_TAS_SYNC_MODE}`,
    `port_count: ${metadata.portCount ?? run?.portCount ?? ""}`,
    `original_polls: ${metadata.originalPolls ?? run?.originalFrameCount ?? ""}`,
    `effective_polls: ${metadata.effectivePolls ?? run?.frameCount ?? ""}`,
    `trace_start: ${metadata.traceStart ?? ""}`,
    `trace_next: ${metadata.traceNext ?? ""}`,
    `trace_count: ${metadata.traceCount ?? ""}`,
    `trace_capacity: ${metadata.traceCapacity ?? ""}`,
    `trace_clipped: ${metadata.traceClipped ?? ""}`,
    `trace_duplicates: ${metadata.traceDuplicates ?? ""}`,
    `trace_error: ${metadata.traceError ?? ""}`,
    `bridge_state: ${run?.state ?? ""}`,
    `firmware_id: ${firmwareStatus.fw ?? ""}`,
    `firmware_latch_edge: ${firmwareStatus.latch_edge ?? ""}`,
    `firmware_clock_edge: ${firmwareStatus.clock_edge ?? ""}`,
    `firmware_current: ${firmwareStatus.current ?? ""}`,
    `firmware_total: ${firmwareStatus.total ?? ""}`,
    `firmware_received: ${firmwareStatus.received ?? ""}`,
    `firmware_buffered: ${firmwareStatus.buffered ?? ""}`,
    `firmware_error: ${firmwareStatus.error ?? run?.error ?? ""}`,
    `firmware_bare_strobes: ${firmwareStatus.bare_strobes ?? 0}`,
    `firmware_torn_strobes: ${firmwareStatus.torn_strobes ?? 0}`,
    `firmware_anomaly_count: ${firmwareStatus.anomaly_count ?? ""}`,
    `firmware_anomaly_seq: ${firmwareStatus.anomaly_seq ?? ""}`,
    `firmware_anomaly_kind: ${firmwareStatus.anomaly_kind ?? ""}`,
    `firmware_trace_frozen: ${firmwareStatus.trace_frozen ?? ""}`,
  ].join("\n");
}

function displayPathForLog(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return filePath;
}

function sanitizeTasFileName(fileName) {
  const normalized = String(fileName || "uploaded.tas").trim();
  return normalized ? normalized.slice(0, 120) : "uploaded.tas";
}

function parseTasTraceRows(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  // Rows are per-port: 13 legacy columns plus `port` on two-port firmware.
  // Rows from pre-v40 firmware have no port column and parse it as null.
  return value.split("|").filter(Boolean).map((row) => {
    const [
      sequence,
      timestampMicros,
      tasFrame,
      latchCount,
      clockCount,
      clocksSinceLatch,
      polledMask,
      nextMask,
      latchedMask,
      shiftIndex,
      result,
      clockedMask,
      diag,
      port,
    ] = row.split(",");
    return {
      sequence: Number(sequence),
      timestampMicros: Number(timestampMicros),
      tasFrame: Number(tasFrame),
      latchCount: Number(latchCount),
      clockCount: Number(clockCount),
      clocksSinceLatch: Number(clocksSinceLatch),
      polledMask: Number.parseInt(polledMask || "0", 16),
      nextMask: Number.parseInt(nextMask || "0", 16),
      latchedMask: Number.parseInt(latchedMask || "0", 16),
      shiftIndex: Number(shiftIndex),
      result: result || "unknown",
      clockedMask: clockedMask === undefined ? null : Number.parseInt(clockedMask || "0", 16),
      diag: diag === undefined ? null : Number.parseInt(diag || "0", 16),
      port: port === undefined ? null : Number(port),
      raw: row,
    };
  });
}

function formatTasTraceRowsForFile(rows) {
  return [TAS_TRACE_CSV_HEADER, formatTasTraceRowsBody(rows)].join("\n");
}

function formatTasTraceRowsBody(rows) {
  return rows.map((row) => [
    row.sequence,
    row.timestampMicros,
    row.tasFrame,
    row.latchCount,
    row.clockCount,
    row.clocksSinceLatch,
    byteToFileHex(row.polledMask),
    byteToFileHex(row.nextMask),
    byteToFileHex(row.latchedMask),
    row.shiftIndex,
    row.result,
    row.clockedMask === null ? "" : byteToFileHex(row.clockedMask),
    row.diag === null ? "" : byteToFileHex(row.diag),
    row.port === null ? "" : row.port,
  ].join(",")).join("\n");
}

function byteToFileHex(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return Number(value).toString(16).toUpperCase().padStart(2, "0");
}

function tasStatusReady(status) {
  return Number(status?.ready || 0) === 1;
}

function tasBufferIsHigh(status) {
  const capacity = Number(status?.capacity || 0);
  const buffered = Number(status?.buffered || 0);
  return capacity > 0 && buffered >= Math.max(TAS_CHUNK_FRAME_LIMIT, Math.floor(capacity * 0.75));
}

function tasBufferAvailable(status) {
  const capacity = Number(status?.capacity || 0);
  const buffered = Number(status?.buffered || 0);
  if (capacity <= 0) {
    return TAS_CHUNK_FRAME_LIMIT;
  }

  return Math.max(1, capacity - buffered);
}

function parseKeyValueTokens(rawTokens) {
  const values = {};

  String(rawTokens || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .forEach((token) => {
      const separator = token.indexOf("=");
      if (separator <= 0) {
        return;
      }

      const key = token.slice(0, separator);
      const rawValue = token.slice(separator + 1);
      values[key] = parseKeyValue(key, rawValue);
    });

  return values;
}

function parseKeyValue(key, value) {
  if (
    ["mask", "mask1", "mask2", "pressed", "pressed1", "pressed2", "latched", "latched1", "latched2"].includes(key) &&
    /^[0-9A-F]{2}$/i.test(value)
  ) {
    return Number.parseInt(value, 16);
  }

  if (/^\d+$/.test(value)) {
    const numberValue = Number(value);
    if (Number.isSafeInteger(numberValue)) {
      return numberValue;
    }
  }

  if (/^[0-9A-F]{2}$/i.test(value)) {
    return Number.parseInt(value, 16);
  }

  return value;
}

function getContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    host: env.HOST || "0.0.0.0",
    port: parsePort(env.PORT || String(DEFAULT_PORT)),
    openBrowser: !isFalsey(env.OPEN_BROWSER || "1"),
    serialPort: env.SERIAL_PORT || env.ARDUINO_PORT || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      args.host = argv[index + 1] || args.host;
      index += 1;
    } else if (arg === "--port") {
      args.port = parsePort(argv[index + 1]);
      index += 1;
    } else if (arg === "--serial-port") {
      args.serialPort = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--no-open") {
      args.openBrowser = false;
    } else if (arg === "--help") {
      args.help = true;
    }
  }

  return args;
}

function parsePort(rawPort) {
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be between 1 and 65535: ${rawPort}`);
  }
  return port;
}

function isFalsey(value) {
  return ["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function tasTraceStreamEnabled(env = process.env) {
  return String(env.BRIDGE_TAS_TRACE_STREAM || "").trim() === "1";
}

function printHelp() {
  console.log(`Usage: node scripts/bridge-server.js [options]

Options:
  --host <host>          Host to bind. Default: HOST or 0.0.0.0
  --port <port>          Port to bind. Default: PORT or ${DEFAULT_PORT}
  --serial-port <path>   Arduino serial device. Default: SERIAL_PORT or ARDUINO_PORT
  --no-open              Do not open the local browser

The server serves apps/web and exposes the USB middleware at /bridge.`);
}

function localUrls(host, port) {
  const urls = [];
  const displayHost = host === "0.0.0.0" || host === "" ? "localhost" : host;
  urls.push(`http://${displayHost}:${port}`);

  if (host === "0.0.0.0" || host === "") {
    lanAddresses().forEach((address) => {
      urls.push(`http://${address}:${port}`);
    });
  }

  return urls;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = childProcess.spawn(command, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  const { server, serialBridge } = createServer({ serialPort: args.serialPort });

  server.listen(args.port, args.host, () => {
    const urls = localUrls(args.host, args.port);
    console.log(`Serving ${path.relative(ROOT_DIR, WEB_ROOT)} through the TASDeck middleware.`);
    console.log(`Local URL: ${urls[0]}`);
    urls.slice(1).forEach((url) => console.log(`LAN URL:   ${url}`));
    console.log(`USB serial: ${args.serialPort || "auto-detect on connect"}`);

    if (args.openBrowser) {
      openBrowser(urls[0]);
    }
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      process.exit(130);
      return;
    }

    shuttingDown = true;
    console.log("\nStopping server.");

    const forceExit = setTimeout(() => {
      console.error("Forced shutdown after serial/server cleanup timeout.");
      server.closeAllConnections?.();
      process.exit(0);
    }, 1000);

    serialBridge
      .disconnect({ reason: "Server stopped" })
      .catch((error) => {
        console.error(`Shutdown serial disconnect failed: ${error.message}`);
      })
      .finally(() => {
        serialBridge.closeClients();
        server.closeIdleConnections?.();
        server.close(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  SerialBridge,
  configureSerialPort,
  createServer,
  decodeWebSocketFrame,
  encodeWebSocketFrame,
  fileTimestamp,
  findSerialPort,
  getContentType,
  handleWebSocketBuffer,
  isCandidateSerialDevice,
  listCandidateSerialPorts,
  parseArgs,
  parseTasSerialLine,
  parseTasTraceRows,
  resolveStaticPath,
  serialPortSttyArgs,
  tasTraceStreamEnabled,
  formatTasTraceRowsForFile,
};
