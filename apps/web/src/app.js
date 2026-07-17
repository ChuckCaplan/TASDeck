const {
  HARDWARE_TAS_MAX_START_DELAY_POLLS,
  HARDWARE_TAS_SYNC_MODE,
  maskToButtons,
  normalizeTasMasks,
  parseTasFileBytes,
  tasMaskHasInput,
  tasMaskPortValue,
  tasMasksPortCount,
  tasMasksToWire,
  tasRunChecksum,
  validateTasFrames,
} = globalThis.TasDeckTas;

const EVENT_LOG_LIMIT = 120;
const SERIAL_CONNECT_TIMEOUT_MS = 25000;
const EVENT_LOG_SAVE_TIMEOUT_MS = 5000;
const COPY_LOG_LABEL = "Copy";
const COPY_LOG_COPIED_LABEL = "Copied";
const COPY_LOG_RESET_MS = 1500;
const HARDWARE_TAS_TRACE_COUNT = 512;
const TAS_TRACE_EXPECTED_CLOCK_DELTA = 8;
// Games strobe up to four times per frame (SMB3 reads both controllers twice).
// The latch ISR now counts one rising edge per strobe, so up to four latch
// edges can separate the last port-1 poll of one frame from the first of the next.
const TAS_TRACE_EXPECTED_LATCH_DELTA = 4;
const TAS_TRACE_ANOMALY_LOG_LIMIT = 5;
const TAS_PREVIEW_FRAME_DURATION_MS = 1000 / 60.0988;
const HARDWARE_TAS_PAUSE_MESSAGE =
  "Hardware TAS playback already buffered on the Arduino will continue. This only pauses/stops sending more polls from the bridge.";
const KEYBOARD_BUTTONS = new Map([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["KeyZ", "b"],
  ["KeyX", "a"],
  ["Enter", "start"],
  ["ShiftLeft", "select"],
  ["ShiftRight", "select"],
]);

const state = {
  connected: false,
  connecting: false,
  selectedControllerPort: 1,
  pressed: new Set(),
  tas: {
    fileName: "None",
    frames: [],
    masks: [],
    syncMode: HARDWARE_TAS_SYNC_MODE,
    syncDelayPolls: 0,
    syncSkipPolls: 0,
    validation: null,
    currentFrame: 0,
    streamedFrames: 0,
    nextFrameIndex: 0,
    status: "empty",
    hardwareRunId: 0,
    hardwarePaused: false,
    hardwareStopped: false,
    hardwareUploadEnded: false,
    hardwareBridgeRunId: 0,
    hardwareClientRunId: 0,
    ignoredBridgeRunIds: new Set(),
    hardwareFileKey: "",
    hardwareUploadPromise: null,
    hardwareResumeStatus: "",
    hardwareMessage: "",
    hardwareStatus: null,
    fileFormat: "none",
    fileFormatLabel: "No file",
    warnings: [],
    preview: {
      active: false,
      animationFrameId: 0,
      baselineClock: null,
      baselineClock2: null,
      baselineLatch: null,
      buttons: new Set(),
      currentMask: null,
      frameIndex: -1,
      masks: [],
      runId: 0,
      syncedToHardware: false,
      startedAt: 0,
    },
  },
  eventCount: 0,
  copyingLog: false,
};

const elements = {
  connectionLabel: document.querySelector("#connectionLabel"),
  connectionDetail: document.querySelector("#connectionDetail"),
  toggleConnection: document.querySelector("#toggleConnection"),
  controllerPortButtons: document.querySelectorAll("[data-controller-port]"),
  controllerState: document.querySelector("#controllerState"),
  tasFile: document.querySelector("#tasFile"),
  playButton: document.querySelector("#playButton"),
  pauseButton: document.querySelector("#pauseButton"),
  stopButton: document.querySelector("#stopButton"),
  progressFill: document.querySelector("#progressFill"),
  progressText: document.querySelector("#progressText"),
  playbackStatusText: document.querySelector("#playbackStatusText"),
  fileName: document.querySelector("#fileName"),
  syncModeField: document.querySelector("#syncModeField"),
  syncMode: document.querySelector("#syncMode"),
  syncDelayPolls: document.querySelector("#syncDelayPolls"),
  syncSkipPolls: document.querySelector("#syncSkipPolls"),
  currentFrame: document.querySelector("#currentFrame"),
  dumpTrace: document.querySelector("#dumpTrace"),
  eventLog: document.querySelector("#eventLog"),
  eventLogSize: document.querySelector("#eventLogSize"),
  copyLog: document.querySelector("#copyLog"),
  clearLog: document.querySelector("#clearLog"),
};

class NetworkBridgeTransport {
  socket = null;
  socketOpenPromise = null;
  pendingConnect = null;
  middlewareConnected = false;
  serialConnected = false;
  serialPath = "";
  closing = false;
  tasWaiters = [];
  eventLogSaveWaiters = [];
  eventLogSaveRequestId = 0;

  isSupported() {
    return Boolean(window.WebSocket);
  }

  isConnected() {
    return this.middlewareConnected && this.serialConnected;
  }

  async connect() {
    if (!this.isSupported()) {
      throw new Error("WebSockets are not available in this browser.");
    }

    await this.ensureSocket();

    if (this.serialConnected) {
      state.connected = true;
      updateConnection();
      return;
    }

    await this.requestSerialConnect();
  }

  bridgeUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:8000";
    return `${protocol}//${host}/bridge`;
  }

  ensureSocket() {
    if (this.socket?.readyState === window.WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.socketOpenPromise) {
      return this.socketOpenPromise;
    }

    this.closing = false;
    this.socket = new window.WebSocket(this.bridgeUrl());
    this.socket.addEventListener("message", (event) => this.handleMessage(event));
    this.socket.addEventListener("close", () => this.handleClose());
    this.socket.addEventListener("error", () => this.handleSocketError());

    this.socketOpenPromise = new Promise((resolve, reject) => {
      const socket = this.socket;
      const handleOpen = () => {
        this.socketOpenPromise = null;
        this.middlewareConnected = true;
        updateConnection();
        writeLog({ type: "bridge", message: "Connected to TASDeck middleware" });
        resolve();
      };
      const handleError = () => {
        this.socketOpenPromise = null;
        reject(new Error("Could not reach the TASDeck middleware server"));
      };

      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleError, { once: true });
    });

    return this.socketOpenPromise;
  }

  requestSerialConnect() {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingConnect = null;
        reject(new Error("Timed out waiting for the middleware to connect USB serial"));
      }, SERIAL_CONNECT_TIMEOUT_MS);

      this.pendingConnect = {
        resolve: () => {
          window.clearTimeout(timer);
          this.pendingConnect = null;
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timer);
          this.pendingConnect = null;
          reject(error);
        },
      };

      try {
        this.sendMessage({ type: "connect" });
      } catch (error) {
        this.pendingConnect?.reject(error);
      }
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      writeLog({ type: "bridge", message: "Received malformed middleware message" });
      return;
    }

    if (message.type === "status") {
      this.applyStatus(message);
      return;
    }

    if (message.type === "bridge") {
      writeLog({ type: "bridge", message: message.message });
      return;
    }

    if (message.type === "tas_status") {
      updateHardwareStatusFromFirmware(message);
      this.resolveTasWaiters(message);
      return;
    }

    if (message.type === "tas_trace") {
      handleHardwareTrace(message);
      this.resolveTasWaiters(message);
      return;
    }

    if (message.type === "event_log_saved") {
      writeLog({ type: "bridge", message: `Saved event log to ${message.path || message.fileName || "logs/"}` });
      this.resolveEventLogSaveWaiters(message);
      return;
    }

    if (message.type === "event_log_error") {
      const error = new Error(message.message || "Could not save event log");
      this.rejectEventLogSaveWaiters(error, message.requestId);
      return;
    }

    if (message.type === "tas_error") {
      stopTasControllerPreview();
      state.tas.hardwareStatus = message;
      writeLog({ type: "playback", message: `Hardware TAS error: ${message.message || message.error}` });
      this.rejectTasWaiters(new Error(message.message || message.error || "Hardware TAS error"));
      updatePlaybackInfo();
      return;
    }

    if (message.type === "error") {
      const error = new Error(message.message || "TASDeck middleware error");
      writeLog({ type: "bridge", message: error.message });
      this.pendingConnect?.reject(error);
      this.rejectTasWaiters(error);
      this.rejectEventLogSaveWaiters(error);
    }
  }

  applyStatus(message) {
    this.middlewareConnected = Boolean(message.middlewareConnected);
    this.serialConnected = Boolean(message.serialConnected);
    this.serialPath = message.serialPath || "";

    state.connected = this.isConnected();
    if (!state.connected) {
      stopTasControllerPreview();
    }
    updateConnection();
    updatePlaybackInfo();

    if (this.serialConnected) {
      this.pendingConnect?.resolve();
      this.requestTasStatus().catch(() => {});
    }
  }

  handleClose() {
    const wasActive = this.middlewareConnected || this.serialConnected;
    this.socket = null;
    this.socketOpenPromise = null;
    this.middlewareConnected = false;
    this.serialConnected = false;
    this.serialPath = "";
    state.tas.ignoredBridgeRunIds.clear();

    state.connected = false;
    stopTasControllerPreview();
    updateConnection();
    updatePlaybackInfo();

    if (!this.closing && wasActive) {
      writeLog({ type: "bridge", message: "Disconnected from TASDeck middleware" });
    }

    this.pendingConnect?.reject(new Error("Disconnected from TASDeck middleware"));
    this.rejectTasWaiters(new Error("Disconnected from TASDeck middleware"));
    this.rejectEventLogSaveWaiters(new Error("Disconnected from TASDeck middleware"));
  }

  handleSocketError() {
    if (!this.closing) {
      this.pendingConnect?.reject(new Error("TASDeck middleware connection failed"));
    }
  }

  waitForDrain() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.socket || this.socket.readyState !== window.WebSocket.OPEN || this.socket.bufferedAmount === 0) {
          resolve();
          return;
        }

        window.setTimeout(check, 10);
      };

      check();
    });
  }

  async disconnect(options = {}) {
    if (this.socket?.readyState === window.WebSocket.OPEN) {
      this.sendMessage({ type: "disconnect" });
      await this.waitForDrain();
    }

    this.serialConnected = false;
    state.connected = false;
    updateConnection();

    if (options.closeSocket && this.socket) {
      this.closing = true;
      this.socket.close();
      this.socket = null;
      this.socketOpenPromise = null;
      this.middlewareConnected = false;
    }

    if (!options.silent) {
      writeLog({ type: "bridge", message: "Disconnected from Arduino USB serial" });
    }
  }

  send(event) {
    if (!this.isConnected()) {
      writeLog({
        type: "blocked",
        message: "Arduino USB serial is not connected through the middleware",
        originalType: event.type,
      });
      return false;
    }

    writeLog(event);
    this.sendMessage({ type: "event", event });
    return true;
  }

  sendTasUpload(fileName, masks, clientRunId, skipPolls = 0, syncMode = HARDWARE_TAS_SYNC_MODE) {
    const normalizedMasks = normalizeTasMasks(Array.isArray(masks) ? masks : []);
    const portCount = tasMasksPortCount(normalizedMasks);
    const normalizedSkipPolls = Number.isSafeInteger(Number(skipPolls)) ? Math.max(0, Number(skipPolls)) : 0;
    return this.sendTasMessage(
      {
        type: "tas_upload",
        fileName,
        clientRunId,
        syncMode,
        skipPolls: normalizedSkipPolls,
        portCount,
        frameCount: normalizedMasks.length,
        inputFrameCount: normalizedMasks.filter(tasMaskHasInput).length,
        // Flat interleaved bytes on the wire; the checksum stays defined over
        // the per-frame masks so both ends verify the reconstructed stream.
        masks: tasMasksToWire(normalizedMasks, portCount),
        checksum: tasRunChecksum(normalizedMasks, portCount),
      },
      this.tasCommandMatcher("tas_upload", clientRunId),
    );
  }

  sendTasArm() {
    return this.sendTasMessage({ type: "tas_arm" }, this.tasCommandMatcher("tas_arm"));
  }

  sendTasCancel() {
    return this.sendTasMessage({ type: "tas_cancel" }, this.tasCommandMatcher("tas_cancel"));
  }

  sendTasPause() {
    return this.sendTasMessage({ type: "tas_pause" }, this.tasCommandMatcher("tas_pause"));
  }

  sendTasResume() {
    return this.sendTasMessage({ type: "tas_resume" }, this.tasCommandMatcher("tas_resume"));
  }

  sendTasStart(delayPolls = 0) {
    return this.sendTasMessage({ type: "tas_start", delayPolls }, this.tasCommandMatcher("tas_start"));
  }

  requestTasStatus() {
    return this.sendTasMessage({ type: "tas_status" }, (message) => message.command === "tas_status");
  }

  requestTasTrace(count = HARDWARE_TAS_TRACE_COUNT) {
    return this.sendTasMessage({ type: "tas_trace", count }, (message) => message.command === "tas_trace");
  }

  saveEventLog(text, reason = "event-log", metadata = {}) {
    const requestId = String((this.eventLogSaveRequestId += 1));
    const responsePromise = this.waitForEventLogSave(requestId);
    try {
      this.sendMessage({ type: "save_event_log", requestId, reason, metadata, text });
    } catch (error) {
      this.rejectEventLogSaveWaiters(error, requestId);
      return Promise.reject(error);
    }
    return responsePromise;
  }

  waitForEventLogSave(requestId) {
    return new Promise((resolve, reject) => {
      const waiter = {
        requestId,
        resolve,
        reject,
        timer: window.setTimeout(() => {
          this.eventLogSaveWaiters = this.eventLogSaveWaiters.filter((item) => item !== waiter);
          reject(new Error("Timed out waiting for the middleware to save the event log"));
        }, EVENT_LOG_SAVE_TIMEOUT_MS),
      };

      this.eventLogSaveWaiters.push(waiter);
    });
  }

  resolveEventLogSaveWaiters(message) {
    const remaining = [];
    this.eventLogSaveWaiters.forEach((waiter) => {
      if (waiter.requestId === String(message.requestId || "")) {
        window.clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    });
    this.eventLogSaveWaiters = remaining;
  }

  rejectEventLogSaveWaiters(error, requestId = "") {
    const remaining = [];
    this.eventLogSaveWaiters.forEach((waiter) => {
      if (!requestId || waiter.requestId === String(requestId)) {
        window.clearTimeout(waiter.timer);
        waiter.reject(error);
      } else {
        remaining.push(waiter);
      }
    });
    this.eventLogSaveWaiters = remaining;
  }

  tasCommandMatcher(command, clientRunId = state.tas.hardwareClientRunId) {
    return (message) => {
      if (message.command !== command) {
        return false;
      }

      const expectedRunId = Number(clientRunId || 0);
      const messageRunId = Number(message.client_run_id || 0);
      return expectedRunId <= 0 || messageRunId === expectedRunId;
    };
  }

  sendTasMessage(message, matcher) {
    if (!this.isConnected()) {
      return Promise.reject(new Error("Arduino USB serial is not connected through the middleware"));
    }

    const responsePromise = this.waitForTasResponse(matcher);
    try {
      this.sendMessage(message);
    } catch (error) {
      this.rejectTasWaiters(error);
      return Promise.reject(error);
    }
    return responsePromise;
  }

  waitForTasResponse(matcher) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        resolve,
        reject,
        timer: window.setTimeout(() => {
          this.tasWaiters = this.tasWaiters.filter((item) => item !== waiter);
          reject(new Error("Timed out waiting for Arduino TAS response"));
        }, 5000),
      };

      this.tasWaiters.push(waiter);
    });
  }

  resolveTasWaiters(message) {
    const remaining = [];
    this.tasWaiters.forEach((waiter) => {
      if (waiter.matcher(message)) {
        window.clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    });
    this.tasWaiters = remaining;
  }

  rejectTasWaiters(error) {
    this.tasWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    this.tasWaiters = [];
  }

  sendMessage(message) {
    if (!this.socket || this.socket.readyState !== window.WebSocket.OPEN) {
      throw new Error("TASDeck middleware is not connected");
    }

    this.socket.send(JSON.stringify(message));
  }
}

const networkTransport = new NetworkBridgeTransport();
const nesTransport = {
  send(event) {
    return networkTransport.send(event);
  },
};
const buttonElements = new Map();
const activeButtonInputs = new Map();
const activeKeyboardInputs = new Map();

function formatButtons(buttons) {
  if (!buttons || buttons.size === 0) {
    return "None";
  }

  return [...buttons].map((button) => button.toUpperCase()).join(" + ");
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "-";
}

function formatMask(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `0x${(Math.round(value) & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
}

function writeLog(event) {
  state.eventCount += 1;
  const logItem = document.createElement("li");
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const title = document.createElement("strong");
  title.textContent = `${state.eventCount.toString().padStart(3, "0")} ${event.type}`;
  const detail = document.createElement("span");
  detail.textContent = `${timestamp} ${describeEvent(event)}`;
  logItem.append(title, detail);
  elements.eventLog.prepend(logItem);

  while (elements.eventLog.children.length > EVENT_LOG_LIMIT) {
    elements.eventLog.lastElementChild.remove();
  }

  updateEventLogSize();
}

function updateEventLogSize() {
  elements.eventLogSize.textContent = `Latest ${elements.eventLog.children.length} / ${EVENT_LOG_LIMIT}`;
  elements.copyLog.disabled = elements.eventLog.children.length === 0 || state.copyingLog;
}

function describeEvent(event) {
  if (event.type === "button") {
    return `P${event.controllerPort || 1} ${event.button.toUpperCase()} ${event.action}`;
  }

  if (event.type === "playback") {
    return event.message;
  }

  if (event.type === "blocked") {
    return `${event.message}; dropped ${event.originalType}`;
  }

  if (event.type === "bridge") {
    return event.message;
  }

  return JSON.stringify(event);
}

function eventLogText() {
  const lines = [
    "NES Event Log",
    `Latest ${elements.eventLog.children.length} / ${EVENT_LOG_LIMIT}`,
    "",
  ];

  elements.eventLog.querySelectorAll("li").forEach((item) => {
    const title = item.querySelector("strong")?.textContent || "";
    const detail = item.querySelector("span")?.textContent || "";
    lines.push(title, detail);
  });

  return lines.join("\n").trimEnd();
}

async function copyTextToClipboard(text) {
  if (window.navigator.clipboard?.writeText) {
    await window.navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command was rejected");
    }
  } finally {
    textarea.remove();
  }
}

function markCopyStarted() {
  state.copyingLog = true;
  elements.copyLog.disabled = true;
}

function markCopySucceeded() {
  elements.copyLog.textContent = COPY_LOG_COPIED_LABEL;
  window.setTimeout(() => {
    elements.copyLog.textContent = COPY_LOG_LABEL;
    state.copyingLog = false;
    updateEventLogSize();
  }, COPY_LOG_RESET_MS);
}

function markCopyFailed(error) {
  state.copyingLog = false;
  elements.copyLog.textContent = COPY_LOG_LABEL;
  updateEventLogSize();
  writeLog({
    type: "playback",
    message: `Copy event log failed: ${error.message}`,
    sentAt: new Date().toISOString(),
  });
}

async function copyEventLogText(text) {
  if (!text) {
    return;
  }

  markCopyStarted();
  try {
    await copyTextToClipboard(text);
    markCopySucceeded();
  } catch (error) {
    markCopyFailed(error);
  }
}

async function copyEventLog() {
  await copyEventLogText(eventLogText());
}

function sendButton(button, action, source = "manual") {
  if (action === "down") {
    state.pressed.add(button);
  } else {
    state.pressed.delete(button);
  }

  updateDeviceStates();
  nesTransport.send({
    type: "button",
    device: "controller",
    controllerPort: state.selectedControllerPort,
    button,
    action,
    source,
    sentAt: new Date().toISOString(),
  });
}

function bindControllerButtons() {
  document.querySelectorAll('[data-device="controller"] [data-button]').forEach((button) => {
    const buttonName = button.dataset.button;
    const key = buttonName;
    buttonElements.set(buttonName, button);

    const press = (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      event.preventDefault();
      if (activeButtonInputs.has(key)) {
        return;
      }

      activeButtonInputs.set(key, {
        element: button,
        pointerId: event.pointerId,
        button: buttonName,
      });
      updateButtonVisual(buttonName);
      button.setPointerCapture?.(event.pointerId);
      if (!state.pressed.has(buttonName)) {
        sendButton(buttonName, "down");
      }
    };

    const release = (event) => {
      if (releaseActiveButton(key, "manual", event?.pointerId)) {
        event?.preventDefault();
      }
    };

    const releaseIfOutside = (event) => {
      const active = activeButtonInputs.get(key);
      if (!active || active.pointerId !== event.pointerId || !eventIsOutsideButton(event, button)) {
        return;
      }

      releaseActiveButton(key, "pointer_leave", event.pointerId);
      event.preventDefault();
    };

    button.draggable = false;
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointermove", releaseIfOutside);
    button.addEventListener("pointerleave", releaseIfOutside);
    button.addEventListener("lostpointercapture", (event) => {
      releaseActiveButton(key, "pointer_lost", event.pointerId);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  });

  document.addEventListener("pointerup", (event) => {
    releasePointerButtons(event);
  });
  document.addEventListener("pointercancel", (event) => {
    releasePointerButtons(event, "pointer_cancel");
  });
}

function bindControllerPortSelector() {
  elements.controllerPortButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const port = Number(button.dataset.controllerPort);
      if (port !== 1 && port !== 2) {
        return;
      }

      if (port === state.selectedControllerPort) {
        return;
      }

      releaseAllInputs("controller_switch");
      state.selectedControllerPort = port;
      updateControllerPortSelector();
      renderTasControllerPreview();
    });
  });
}

function updateControllerPortSelector() {
  elements.controllerPortButtons.forEach((button) => {
    const selected = Number(button.dataset.controllerPort) === state.selectedControllerPort;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function releaseAllInputs(source = "release") {
  clearActiveButtonInputs();
  clearActiveKeyboardInputs();
  [...state.pressed].forEach((button) => {
    sendButton(button, "up", source);
  });
}

function updateDeviceStates() {
  const port = state.selectedControllerPort;
  if (state.tas.preview.active) {
    const manualText = state.pressed.size > 0 ? ` · Manual: ${formatButtons(state.pressed)}` : "";
    elements.controllerState.textContent = `P${port} TAS: ${formatButtons(state.tas.preview.buttons)}${manualText}`;
    return;
  }

  elements.controllerState.textContent = `P${port}: ${formatButtons(state.pressed)}`;
}

function startTasControllerPreview(runId, status) {
  stopTasControllerPreview();

  const masks = state.tas.masks.slice(state.tas.syncSkipPolls);
  if (masks.length === 0) {
    return;
  }

  const preview = state.tas.preview;
  preview.active = true;
  preview.runId = runId;
  preview.masks = masks;
  preview.baselineClock = hardwareCounter(status?.clock);
  preview.baselineClock2 = hardwareCounter(status?.clock2);
  preview.baselineLatch = hardwareCounter(status?.latch);
  renderTasControllerPreview();
}

function syncTasControllerPreview(status) {
  const preview = state.tas.preview;
  if (!preview.active || preview.runId !== state.tas.hardwareRunId || preview.masks.length === 0) {
    return;
  }

  const current = Math.max(0, Math.min(Number(status.current || 0), preview.masks.length - 1));
  if (!preview.syncedToHardware) {
    const playbackStarted = Number(status.started || 0) === 1;
    const hardwareAdvanced = current > 0;
    const pollCompleted =
      hardwareCounterDelta(status.clock, preview.baselineClock) >= 8 ||
      hardwareCounterDelta(status.clock2, preview.baselineClock2) >= 8;
    const latchAccepted = hardwareCounterDelta(status.latch, preview.baselineLatch) > 0;
    const consoleReadObserved = state.tas.syncMode === "latch" ? latchAccepted : pollCompleted;
    if (!playbackStarted || (!consoleReadObserved && !hardwareAdvanced)) {
      return;
    }

    preview.syncedToHardware = true;
  }

  preview.frameIndex = current;
  preview.currentMask = preview.masks[current];
  preview.startedAt = window.performance.now() - current * TAS_PREVIEW_FRAME_DURATION_MS;
  renderTasControllerPreview();
  if (!preview.animationFrameId) {
    preview.animationFrameId = window.requestAnimationFrame(animateTasControllerPreview);
  }
}

function animateTasControllerPreview(timestamp) {
  const preview = state.tas.preview;
  if (
    !preview.active ||
    !preview.syncedToHardware ||
    preview.runId !== state.tas.hardwareRunId ||
    state.tas.hardwareStopped
  ) {
    stopTasControllerPreview();
    return;
  }

  const frameIndex = Math.floor((timestamp - preview.startedAt) / TAS_PREVIEW_FRAME_DURATION_MS);
  if (frameIndex >= preview.masks.length) {
    stopTasControllerPreview();
    return;
  }

  if (frameIndex >= 0 && frameIndex !== preview.frameIndex) {
    preview.frameIndex = frameIndex;
    preview.currentMask = preview.masks[frameIndex];
    renderTasControllerPreview();
  }

  preview.animationFrameId = window.requestAnimationFrame(animateTasControllerPreview);
}

function stopTasControllerPreview() {
  const preview = state.tas.preview;
  if (preview.animationFrameId) {
    window.cancelAnimationFrame(preview.animationFrameId);
  }

  preview.active = false;
  preview.animationFrameId = 0;
  preview.baselineClock = null;
  preview.baselineClock2 = null;
  preview.baselineLatch = null;
  preview.buttons.clear();
  preview.currentMask = null;
  preview.frameIndex = -1;
  preview.masks = [];
  preview.runId = 0;
  preview.syncedToHardware = false;
  preview.startedAt = 0;
  renderTasControllerPreview();
}

function hardwareCounter(value) {
  const counter = Number(value);
  return Number.isFinite(counter) && counter >= 0 ? Math.trunc(counter) : null;
}

function hardwareCounterDelta(value, baseline) {
  const counter = hardwareCounter(value);
  if (counter === null || baseline === null) {
    return 0;
  }
  return (counter - baseline) >>> 0;
}

function renderTasControllerPreview() {
  const preview = state.tas.preview;
  const mask = preview.currentMask === null
    ? 0
    : tasMaskPortValue(preview.currentMask, state.selectedControllerPort);
  preview.buttons = new Set(preview.active ? maskToButtons(mask) : []);
  buttonElements.forEach((_element, button) => updateButtonVisual(button));
  updateDeviceStates();
}

function eventIsOutsideButton(event, button) {
  const rect = button.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function releaseActiveButton(key, source = "manual", pointerId = undefined) {
  const active = activeButtonInputs.get(key);
  if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) {
    return false;
  }

  activeButtonInputs.delete(key);
  if (active.pointerId !== undefined && active.element.hasPointerCapture?.(active.pointerId)) {
    active.element.releasePointerCapture(active.pointerId);
  }
  updateButtonVisual(active.button);
  if (!isKeyboardButtonActive(active.button)) {
    sendButton(active.button, "up", source);
  }
  return true;
}

function releasePointerButtons(event, source = "manual") {
  let released = false;
  activeButtonInputs.forEach((active, key) => {
    if (active.pointerId === event.pointerId) {
      released = releaseActiveButton(key, source, event.pointerId) || released;
    }
  });

  if (released) {
    event.preventDefault();
  }
}

function clearActiveButtonInputs() {
  const buttons = new Set([...activeButtonInputs.values()].map((active) => active.button));
  activeButtonInputs.clear();
  buttons.forEach(updateButtonVisual);
}

function bindKeyboardControls() {
  window.addEventListener("keydown", (event) => {
    const button = keyboardButtonForEvent(event);
    if (!button || isEditableKeyboardTarget(event.target)) {
      return;
    }

    event.preventDefault();
    if (activeKeyboardInputs.has(event.code)) {
      return;
    }

    activeKeyboardInputs.set(event.code, button);
    updateButtonVisual(button);
    if (!state.pressed.has(button)) {
      sendButton(button, "down", "keyboard");
    }
  });

  window.addEventListener("keyup", (event) => {
    const button = activeKeyboardInputs.get(event.code);
    if (!button) {
      return;
    }

    event.preventDefault();
    activeKeyboardInputs.delete(event.code);
    updateButtonVisual(button);
    if (!isKeyboardButtonActive(button) && !isPointerButtonActive(button)) {
      sendButton(button, "up", "keyboard");
    }
  });
}

function keyboardButtonForEvent(event) {
  return KEYBOARD_BUTTONS.get(event.code) || "";
}

function isEditableKeyboardTarget(target) {
  return Boolean(
    target?.closest?.("input, select, textarea") ||
      target?.isContentEditable,
  );
}

function clearActiveKeyboardInputs() {
  const buttons = new Set(activeKeyboardInputs.values());
  activeKeyboardInputs.clear();
  buttons.forEach(updateButtonVisual);
}

function isKeyboardButtonActive(button, exceptCode = "") {
  return [...activeKeyboardInputs.entries()].some(([code, activeButton]) => {
    return code !== exceptCode && activeButton === button;
  });
}

function isPointerButtonActive(button) {
  return [...activeButtonInputs.values()].some((active) => active.button === button);
}

function updateButtonVisual(button) {
  const element = buttonElements.get(button);
  element?.classList.toggle("pressed", isPointerButtonActive(button) || isKeyboardButtonActive(button));
  element?.classList.toggle("tas-pressed", state.tas.preview.buttons.has(button));
}

function bindConnection() {
  elements.toggleConnection.addEventListener("click", async () => {
    if (networkTransport.isConnected()) {
      await disconnectNetworkTransport();
    } else {
      await connectNetworkTransport();
    }
  });
}

function connectNetworkTransport() {
  state.connecting = true;
  updateConnection();

  return networkTransport
    .connect()
    .catch((error) => {
      state.connected = false;
      writeLog({ type: "bridge", message: error.message });
    })
    .finally(() => {
      state.connecting = false;
      updateConnection();
      if (networkTransport.isConnected() && tasReadyForPlayback()) {
        queueHardwareTasUpload();
      }
    });
}

function disconnectNetworkTransport(options = {}) {
  stopTasControllerPreview();
  releaseAllInputs("disconnect");
  return networkTransport.waitForDrain().then(() => {
    return networkTransport.disconnect(options);
  });
}

function updateConnection() {
  document.body.classList.toggle("disconnected", !state.connected);

  elements.toggleConnection.disabled = state.connecting || !networkTransport.isSupported();

  if (state.connecting) {
    elements.connectionLabel.textContent = "Connecting Arduino USB";
    elements.connectionDetail.textContent = "Asking the middleware to open the Arduino serial port.";
    elements.toggleConnection.textContent = "Connecting";
    return;
  }

  if (!networkTransport.isSupported()) {
    elements.connectionLabel.textContent = "Arduino bridge unavailable";
    elements.connectionDetail.textContent = "This browser does not support WebSockets.";
    elements.toggleConnection.textContent = "Connect";
    return;
  }

  elements.connectionLabel.textContent = state.connected ? "Arduino USB online" : "Arduino USB offline";
  elements.connectionDetail.textContent = state.connected
    ? `USB serial is owned by the middleware${networkTransport.serialPath ? ` at ${networkTransport.serialPath}` : ""}.`
    : "Start the middleware on this computer, then connect the Arduino serial port.";
  elements.toggleConnection.textContent = state.connected ? "Disconnect" : "Connect";
}

async function handleTasFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const contents = await file.arrayBuffer();
    loadTasFromParseResult(file.name, parseTasFileBytes(file.name, contents));
  } catch (error) {
    loadTasParseError(file.name, error);
  }
}

function loadTasParseError(fileName, error) {
  loadTasFromParseResult(fileName, {
    frames: [],
    format: "unknown",
    label: "TAS file",
    warnings: [],
    error,
  });
}

function loadTasFromParseResult(fileName, parseResult) {
  stopPlayback({ silent: true, fenceCancel: true });
  state.tas.hardwareRunId += 1;

  let frames = [];
  let validation;
  const parseError = parseResult?.error || null;
  if (!parseError) {
    frames = parseResult?.frames || [];
    validation = validateTasFrames(frames);
  } else {
    validation = {
      valid: false,
      errors: [parseError.message || "TAS file could not be parsed."],
      frameCount: 0,
      inputFrameCount: 0,
      masks: [],
    };
  }

  state.tas.fileName = fileName;
  state.tas.frames = frames;
  state.tas.masks = validation.masks;
  state.tas.syncMode = parseResult?.syncMode === "latch" ? "latch" : HARDWARE_TAS_SYNC_MODE;
  elements.syncMode.value = state.tas.syncMode;
  state.tas.syncDelayPolls = 0;
  state.tas.syncSkipPolls = 0;
  elements.syncDelayPolls.value = "0";
  elements.syncSkipPolls.value = "0";
  elements.syncSkipPolls.max = validation.masks.length > 0 ? String(validation.masks.length - 1) : "0";
  state.tas.validation = validation;
  state.tas.currentFrame = 0;
  state.tas.streamedFrames = 0;
  state.tas.nextFrameIndex = 0;
  state.tas.status = validation.valid ? "loaded" : "invalid";
  state.tas.hardwarePaused = false;
  state.tas.hardwareStopped = false;
  state.tas.hardwareUploadEnded = false;
  state.tas.hardwareBridgeRunId = 0;
  state.tas.hardwareClientRunId = state.tas.hardwareRunId;
  state.tas.hardwareFileKey = "";
  state.tas.hardwareUploadPromise = null;
  state.tas.hardwareResumeStatus = "";
  state.tas.hardwareMessage = validation.valid
    ? loadedTasStatusMessage(parseResult, validation)
    : validation.errors.join(" ");
  state.tas.hardwareStatus = null;
  state.tas.fileFormat = parseResult?.format || "unknown";
  state.tas.fileFormatLabel = parseResult?.label || "TAS file";
  state.tas.warnings = parseResult?.warnings || [];
  updatePlaybackInfo();

  const message = validation.valid
    ? loadedTasLogMessage(fileName, parseResult, validation)
    : `Rejected ${fileName}: ${parseError?.message || validation.errors.join(" ")}`;

  writeLog({
    type: "playback",
    message,
    sentAt: new Date().toISOString(),
  });

  if (validation.valid && networkTransport.isConnected()) {
    queueHardwareTasUpload();
  }
}

function loadedTasLogMessage(fileName, parseResult, validation) {
  const unit = parseResult?.format === "r08"
    ? "record"
    : parseResult?.format === "raw-mask" || parseResult?.format === "raw-mask-v2"
      ? "frame mask"
      : "frame";
  const unitPlural = validation.frameCount === 1 ? unit : `${unit}s`;
  const inputPlural = validation.inputFrameCount === 1 ? unit : `${unit}s`;
  const warningText = parseResult?.warnings?.length ? ` Warning: ${parseResult.warnings[0]}` : "";

  return `Loaded ${parseResult?.label || "TAS file"} ${fileName} with ${validation.frameCount} ${unitPlural} and ${validation.inputFrameCount} input ${inputPlural}.${warningText}`;
}

function loadedTasStatusMessage(parseResult, validation) {
  if (parseResult?.format === "r08") {
    return `Ready · R08 · ${validation.frameCount} record${validation.frameCount === 1 ? "" : "s"}`;
  }

  if (parseResult?.format === "raw-mask" || parseResult?.format === "raw-mask-v2") {
    return `Ready · TD2P · ${validation.frameCount} mask${validation.frameCount === 1 ? "" : "s"} · completed reads`;
  }

  if (parseResult?.format === "fm2") {
    return parseResult.warnings[0] || "Loaded raw FM2 emulator frames.";
  }

  return parseResult?.warnings?.[0] || "";
}

function playTas() {
  playHardwareTas();
}

function pauseTas() {
  pauseHardwareTas();
}

function stopPlayback(options = {}) {
  stopHardwareTas(options);
}

function tasReadyForPlayback() {
  return state.tas.frames.length > 0 && state.tas.validation?.valid;
}

function playbackUnavailableMessage() {
  if (state.tas.status === "invalid") {
    return state.tas.hardwareMessage || "Playback requested with an invalid TAS file";
  }

  return "Playback requested without a loaded TAS file";
}

function playHardwareTas() {
  if (state.tas.status === "paused") {
    resumeHardwareTas();
    return;
  }

  if (state.tas.status === "armed") {
    startArmedHardwareTas();
    return;
  }

  if (!tasReadyForPlayback()) {
    writeLog({
      type: "playback",
      message: playbackUnavailableMessage(),
      sentAt: new Date().toISOString(),
    });
    return;
  }

  if (!networkTransport.isConnected()) {
    writeLog({
      type: "blocked",
      message: "Arduino USB bridge must be connected before hardware TAS playback",
      originalType: "playback",
      sentAt: new Date().toISOString(),
    });
    return;
  }

  if (state.tas.hardwareClientRunId <= 0) {
    state.tas.hardwareRunId += 1;
  }
  state.tas.hardwareClientRunId = state.tas.hardwareRunId;
  state.tas.hardwarePaused = false;
  state.tas.hardwareStopped = false;
  state.tas.hardwareUploadEnded = false;
  state.tas.hardwareResumeStatus = "";
  state.tas.hardwareStatus = null;
  state.tas.hardwareMessage = "Uploading TAS to the bridge before arming the Arduino.";
  state.tas.currentFrame = 0;
  state.tas.streamedFrames = 0;
  state.tas.nextFrameIndex = 0;
  state.tas.status = "uploading";
  updatePlaybackInfo();

  writeLog({
    type: "playback",
    message:
      "Hardware TAS upload started. The bridge will own Arduino streaming after this upload.",
    sentAt: new Date().toISOString(),
  });

  const runId = state.tas.hardwareRunId;
  prepareHardwareTas(runId)
    .catch((error) => {
      if (!hardwareRunIsCurrent(runId)) {
        return;
      }

      state.tas.status = "error";
      state.tas.hardwareMessage = error.message;
      updatePlaybackInfo();
      writeLog({
        type: "playback",
        message: `Hardware TAS streaming failed: ${error.message}`,
        sentAt: new Date().toISOString(),
      });
    });
}

function queueHardwareTasUpload() {
  const runId = state.tas.hardwareRunId;
  ensureHardwareTasUploaded(runId).catch((error) => {
    if (!hardwareRunIsCurrent(runId)) {
      return;
    }

    state.tas.status = "error";
    state.tas.hardwareMessage = error.message;
    updatePlaybackInfo();
    writeLog({
      type: "playback",
      message: `Hardware TAS bridge auto-upload failed: ${error.message}`,
      sentAt: new Date().toISOString(),
    });
  });
}

function hardwareTasFileKey() {
  if (!tasReadyForPlayback()) {
    return "";
  }

  return [
    state.tas.fileName,
    state.tas.masks.length,
    state.tas.syncSkipPolls,
    state.tas.syncMode,
    tasMasksPortCount(state.tas.masks),
    tasRunChecksum(state.tas.masks, tasMasksPortCount(state.tas.masks)),
  ].join(":");
}

async function ensureHardwareTasUploaded(runId) {
  const fileKey = hardwareTasFileKey();
  if (!fileKey) {
    throw new Error("Playback requested without a loaded TAS file");
  }

  if (state.tas.hardwareFileKey === fileKey && state.tas.hardwareBridgeRunId > 0) {
    return state.tas.hardwareStatus;
  }

  if (state.tas.hardwareUploadPromise) {
    return state.tas.hardwareUploadPromise;
  }

  const previousStatus = state.tas.status;
  if (!["arming", "streaming", "playing"].includes(previousStatus)) {
    state.tas.status = "uploading";
  }
  state.tas.hardwareMessage = "Uploading TAS to the bridge so it can stream independently of the browser.";
  updatePlaybackInfo();

  const uploadPromise = networkTransport
    .sendTasUpload(
      state.tas.fileName,
      state.tas.masks,
      runId,
      state.tas.syncSkipPolls,
      state.tas.syncMode,
    )
    .then((status) => {
      if (!hardwareRunIsCurrent(runId)) {
        return status;
      }

      state.tas.hardwareBridgeRunId = Number(status.run_id || 0);
      state.tas.hardwareFileKey = fileKey;
      state.tas.hardwareStatus = status;
      state.tas.streamedFrames = Number(status.received || 0);
      if (state.tas.status === "uploading") {
        state.tas.status = "loaded";
        state.tas.hardwareMessage = "TAS uploaded to the bridge. Manual controls stay active until Play arms the Arduino.";
      }
      updatePlaybackInfo();
      writeLog({
        type: "playback",
        message: "Bridge accepted TAS upload; manual controls stay active until Play",
        sentAt: new Date().toISOString(),
      });
      return status;
    })
    .finally(() => {
      if (state.tas.hardwareUploadPromise === uploadPromise) {
        state.tas.hardwareUploadPromise = null;
      }
    });

  state.tas.hardwareUploadPromise = uploadPromise;
  return state.tas.hardwareUploadPromise;
}

async function prepareHardwareTas(runId) {
  await ensureHardwareTasUploaded(runId);
  if (!hardwareRunIsCurrent(runId)) {
    return;
  }

  state.tas.status = "arming";
  state.tas.hardwareMessage = "Bridge is prebuffering TAS frames on the Arduino.";
  updatePlaybackInfo();

  const status = await networkTransport.sendTasArm();
  if (!hardwareRunIsCurrent(runId) || state.tas.hardwareStopped) {
    return;
  }

  applyHardwareArmedState(status);
  writeLog({
    type: "playback",
    message: "Hardware TAS armed. Press Start at the exact console sync point to begin frame 0.",
    sentAt: new Date().toISOString(),
  });
}

function startArmedHardwareTas() {
  const runId = state.tas.hardwareRunId;
  state.tas.status = "streaming";
  state.tas.hardwareMessage = "Starting Arduino TAS playback at the next NES latch window.";
  updatePlaybackInfo();

  continueHardwareTas(runId).catch((error) => {
    if (!hardwareRunIsCurrent(runId)) {
      return;
    }

    state.tas.status = "error";
    state.tas.hardwareMessage = error.message;
    updatePlaybackInfo();
    writeLog({
      type: "playback",
      message: `Hardware TAS streaming failed: ${error.message}`,
      sentAt: new Date().toISOString(),
    });
  });
}

async function continueHardwareTas(runId) {
  const status = await networkTransport.sendTasStart(state.tas.syncDelayPolls);
  if (!hardwareRunIsCurrent(runId) || state.tas.hardwareStopped) {
    return;
  }

  state.tas.status = "playing";
  updateHardwareStatusFromFirmware(status, { quiet: true });
  startTasControllerPreview(runId, status);
  writeLog({
    type: "playback",
    message: "Arduino TAS start accepted; the bridge will keep streaming chunks even if the browser sleeps",
    sentAt: new Date().toISOString(),
  });
}

function applyHardwareArmedState(status) {
  state.tas.status = "armed";
  state.tas.hardwareMessage =
    "Arduino armed. Press Start at the exact console sync point; frame 0 will be applied at the next NES latch window.";
  updateHardwareStatusFromFirmware(status, { quiet: true });
}

function updateHardwareStatusFromFirmware(status, options = {}) {
  if (!status || status.type !== "tas_status") {
    return;
  }

  const clientRunId = Number(status.client_run_id || 0);
  if (clientRunId > 0 && clientRunId !== state.tas.hardwareClientRunId) {
    return;
  }

  const bridgeRunId = Number(status.run_id || 0);
  if (bridgeRunId > 0 && state.tas.ignoredBridgeRunIds.has(bridgeRunId)) {
    return;
  }

  if (state.tas.hardwareStopped) {
    return;
  }

  if (bridgeRunId > 0) {
    if (state.tas.hardwareBridgeRunId > 0 && state.tas.hardwareBridgeRunId !== bridgeRunId) {
      return;
    }
    state.tas.hardwareBridgeRunId = bridgeRunId;
  }

  if (status.file_name && state.tas.fileName === "None") {
    state.tas.fileName = status.file_name;
  }

  const total = Number(status.total || state.tas.frames.length || 0);
  const current = Number(status.current || 0);
  const received = Number(status.received || state.tas.streamedFrames || 0);
  const buffered = Number(status.buffered || 0);
  const capacity = Number(status.capacity || 0);
  const bridgeState = status.bridge_state || "";
  const isComplete = Number(status.complete) === 1 || bridgeState === "complete";
  const wasComplete = state.tas.status === "complete";

  if (total > 0) {
    state.tas.currentFrame = Math.min(current, total);
  }
  state.tas.streamedFrames = Math.max(state.tas.streamedFrames, received);
  state.tas.nextFrameIndex = state.tas.streamedFrames;
  state.tas.hardwareStatus = status;

  if (!isComplete && (!status.error || status.error === "ok")) {
    syncTasControllerPreview(status);
  }

  if (status.error && status.error !== "ok") {
    stopTasControllerPreview();
    state.tas.status = "error";
    state.tas.hardwareMessage = `Arduino TAS error: ${status.error}`;
    if (!options.quiet) {
      writeLog({
        type: "playback",
        message: state.tas.hardwareMessage,
        sentAt: new Date().toISOString(),
      });
    }
  } else if (isComplete) {
    stopTasControllerPreview();
    state.tas.status = "complete";
    state.tas.hardwareMessage = "Hardware TAS playback complete.";
    if (!options.quiet && !wasComplete) {
      writeLog({
        type: "playback",
        message: "Hardware TAS playback complete",
        sentAt: new Date().toISOString(),
      });
    }
  } else if (bridgeState === "uploaded") {
    if (state.tas.status === "uploading") {
      state.tas.status = "loaded";
    }
    state.tas.hardwareMessage = "TAS uploaded to the bridge. Manual controls stay active until Play arms the Arduino.";
  } else if (bridgeState === "arming") {
    state.tas.status = "arming";
    state.tas.hardwareMessage = `Bridge is prebuffering the Arduino: ${received} / ${total} frames sent.`;
  } else if (bridgeState === "armed") {
    state.tas.status = "armed";
    state.tas.hardwareMessage =
      "Arduino armed. Press Start at the exact console sync point; frame 0 will be applied at the next NES latch window.";
  } else if (bridgeState === "streaming") {
    state.tas.status = "playing";
    state.tas.hardwareMessage = `Bridge streaming to Arduino: buffer ${buffered}${capacity ? ` / ${capacity}` : ""} frames; ${received} / ${total} sent.`;
  } else if (bridgeState === "paused") {
    state.tas.status = "paused";
    state.tas.hardwareMessage = HARDWARE_TAS_PAUSE_MESSAGE;
  } else if (bridgeState === "stopped") {
    stopTasControllerPreview();
    state.tas.status = stoppedStatusForLoadedTas();
    state.tas.hardwareMessage = HARDWARE_TAS_PAUSE_MESSAGE;
  } else if (state.tas.status === "streaming" || state.tas.status === "playing") {
    state.tas.hardwareMessage = `Arduino buffer ${buffered}${capacity ? ` / ${capacity}` : ""} frames; streamed ${state.tas.streamedFrames} / ${state.tas.frames.length}.`;
  }

  updatePlaybackInfo();
}

function handleHardwareTrace(message) {
  const rows = Array.isArray(message.rows) ? message.rows : [];
  const anomalies = findTasTraceAnomalies(rows);
  window.__lastTasTrace = message;
  window.__lastTasTraceAnomalies = anomalies;
  writeLog({
    type: "playback",
    message: `TAS trace captured ${rows.length} row${rows.length === 1 ? "" : "s"} from poll ${message.start ?? "-"} to ${message.next ?? "-"}`,
    sentAt: new Date().toISOString(),
  });

  const clippedRows = Number(message.clipped || 0);
  const duplicateRows = Number(message.duplicates || 0);
  if (clippedRows > 0 || duplicateRows > 0) {
    const duplicateText =
      duplicateRows > 0
        ? `; dropped ${formatInteger(duplicateRows)} duplicate row${duplicateRows === 1 ? "" : "s"}`
        : "";
    writeLog({
      type: "bridge",
      message: `TAS trace capture clipped ${formatInteger(clippedRows)} row${clippedRows === 1 ? "" : "s"} while paging${duplicateText}`,
      sentAt: new Date().toISOString(),
    });
  }

  if (rows.length > 1) {
    writeLog({
      type: anomalies.length > 0 ? "bridge" : "playback",
      message:
        anomalies.length > 0
          ? `TAS trace anomalies: ${formatTraceAnomalySummary(anomalies)}`
          : "TAS trace anomalies: none detected",
      sentAt: new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    writeLog({
      type: "bridge",
      message: `TAS trace rows: ${rows.map(formatTraceRow).join(" | ")}`,
      sentAt: new Date().toISOString(),
    });
  }
}

function traceNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function traceDelta(previousValue, currentValue) {
  const previous = traceNumber(previousValue);
  const current = traceNumber(currentValue);
  return previous !== null && current !== null ? current - previous : null;
}

function findTasTraceAnomalies(rows) {
  const anomalies = [];
  const previousByPort = new Map();

  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const globalPrevious = rows[index - 1] || null;
    const port = traceNumber(current.port) || 1;
    const previous = previousByPort.get(port) || null;
    const sequenceDelta = globalPrevious ? traceDelta(globalPrevious.sequence, current.sequence) : null;
    const latchDelta = previous ? traceDelta(previous.latchCount, current.latchCount) : null;
    const clockDelta = previous ? traceDelta(previous.clockCount, current.clockCount) : null;
    const clocksSinceLatch = traceNumber(current.clocksSinceLatch);
    const polledMask = traceNumber(current.polledMask);
    const clockedMask = traceNumber(current.clockedMask);
    const clockedMaskMismatch =
      polledMask !== null && clockedMask !== null && polledMask !== clockedMask;
    const result = String(current.result || "unknown").toLowerCase();
    const hasAnomaly =
      (sequenceDelta !== null && sequenceDelta !== 1) ||
      (clockDelta !== null && clockDelta !== TAS_TRACE_EXPECTED_CLOCK_DELTA) ||
      (latchDelta !== null && (latchDelta > TAS_TRACE_EXPECTED_LATCH_DELTA || latchDelta < 0)) ||
      (clocksSinceLatch !== null && clocksSinceLatch !== TAS_TRACE_EXPECTED_CLOCK_DELTA) ||
      clockedMaskMismatch ||
      result !== "ok";

    if (hasAnomaly) {
      anomalies.push({
        port,
        previousSequence: previous ? traceNumber(previous.sequence) : null,
        sequence: traceNumber(current.sequence),
        sequenceDelta,
        latchDelta,
        clockDelta,
        clocksSinceLatch,
        polledMask,
        clockedMask,
        clockedMaskMismatch,
        result,
      });
    }

    previousByPort.set(port, current);
  }

  return anomalies;
}

function formatSignedInteger(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function formatTraceAnomaly(anomaly) {
  const parts = [
    `p=${formatInteger(anomaly.port)}`,
    `#${formatInteger(anomaly.sequence)}`,
    `after #${formatInteger(anomaly.previousSequence)}`,
  ];

  if (anomaly.sequenceDelta !== null && anomaly.sequenceDelta !== 1) {
    parts.push(`ds=${formatSignedInteger(anomaly.sequenceDelta)}`);
  }
  if (anomaly.clockDelta !== null) {
    parts.push(`dc=${formatSignedInteger(anomaly.clockDelta)}`);
  }
  if (anomaly.latchDelta !== null) {
    parts.push(`dl=${formatSignedInteger(anomaly.latchDelta)}`);
  }
  if (anomaly.clocksSinceLatch !== null && anomaly.clocksSinceLatch !== TAS_TRACE_EXPECTED_CLOCK_DELTA) {
    parts.push(`csl=${formatInteger(anomaly.clocksSinceLatch)}`);
  }
  if (anomaly.clockedMaskMismatch) {
    parts.push(`line=${formatMask(anomaly.clockedMask)}`);
    parts.push(`mask=${formatMask(anomaly.polledMask)}`);
  }
  if (anomaly.result !== "ok") {
    parts.push(`result=${anomaly.result}`);
  }

  return parts.join(" ");
}

function formatTraceAnomalySummary(anomalies) {
  const visible = anomalies.slice(0, TAS_TRACE_ANOMALY_LOG_LIMIT).map(formatTraceAnomaly);
  const remainder = anomalies.length - visible.length;
  const summary = visible.join(" | ");
  const total = ` (${anomalies.length} total${remainder > 0 ? `, ${remainder} more` : ""})`;
  return `${summary}${total}`;
}

function formatTraceRow(row) {
  const port = traceNumber(row.port) || 1;
  const parts = [
    `#${formatInteger(Number(row.sequence))}`,
    `p=${formatInteger(port)}`,
    `f=${formatInteger(Number(row.tasFrame))}`,
    `l=${formatInteger(Number(row.latchCount))}`,
    `c=${formatInteger(Number(row.clockCount))}`,
    `csl=${formatInteger(Number(row.clocksSinceLatch))}`,
    `mask=${formatMask(Number(row.polledMask))}`,
    `next=${formatMask(Number(row.nextMask))}`,
  ];
  if (traceNumber(row.clockedMask) !== null) {
    parts.push(`line=${formatMask(Number(row.clockedMask))}`);
  }
  if (traceNumber(row.diag) !== null) {
    parts.push(`diag=${formatMask(Number(row.diag))}`);
  }
  parts.push(`result=${row.result || "unknown"}`);
  return parts.join(" ");
}

function pauseHardwareTas() {
  if (!["arming", "streaming", "playing"].includes(state.tas.status)) {
    return;
  }

  state.tas.hardwarePaused = true;
  state.tas.hardwareResumeStatus = state.tas.status;
  state.tas.status = "paused";
  state.tas.hardwareMessage = HARDWARE_TAS_PAUSE_MESSAGE;
  updatePlaybackInfo();
  networkTransport.sendTasPause().catch((error) => {
    writeLog({
      type: "playback",
      message: `Hardware TAS pause failed: ${error.message}`,
      sentAt: new Date().toISOString(),
    });
  });
  writeLog({
    type: "playback",
    message: `Paused bridge TAS streaming. ${HARDWARE_TAS_PAUSE_MESSAGE}`,
    sentAt: new Date().toISOString(),
  });
}

function resumeHardwareTas() {
  state.tas.hardwarePaused = false;
  state.tas.status = state.tas.hardwareResumeStatus || "streaming";
  state.tas.hardwareMessage = "Resumed bridge-owned TAS streaming.";
  updatePlaybackInfo();
  networkTransport.sendTasResume().catch((error) => {
    writeLog({
      type: "playback",
      message: `Hardware TAS resume failed: ${error.message}`,
      sentAt: new Date().toISOString(),
    });
  });
  writeLog({
    type: "playback",
    message: "Resumed bridge-owned hardware TAS streaming",
    sentAt: new Date().toISOString(),
  });
}

function stopHardwareTas(options = {}) {
  stopTasControllerPreview();
  const bridgeRunId = Number(state.tas.hardwareBridgeRunId || state.tas.hardwareStatus?.run_id || 0);
  const hadHardwareRun =
    ["arming", "armed", "streaming", "playing", "paused"].includes(state.tas.status) ||
    state.tas.streamedFrames > 0 ||
    bridgeRunId > 0;
  if (hadHardwareRun && options.fenceCancel) {
    rememberCanceledBridgeRun();
  }
  if (hadHardwareRun && networkTransport.isConnected()) {
    networkTransport.sendTasCancel().catch((error) => {
      writeLog({
        type: "playback",
        message: `Hardware TAS cancel failed: ${error.message}`,
        sentAt: new Date().toISOString(),
      });
    });
  }
  state.tas.hardwareRunId += 1;
  state.tas.hardwarePaused = false;
  state.tas.hardwareStopped = true;
  state.tas.hardwareUploadEnded = false;
  state.tas.hardwareResumeStatus = "";
  state.tas.hardwareBridgeRunId = 0;
  state.tas.hardwareFileKey = "";
  state.tas.hardwareUploadPromise = null;
  state.tas.status = stoppedStatusForLoadedTas();
  state.tas.hardwareMessage = hadHardwareRun ? HARDWARE_TAS_PAUSE_MESSAGE : "";
  updatePlaybackInfo();

  if (!options.silent && state.tas.frames.length > 0) {
    writeLog({
      type: "playback",
      message: hadHardwareRun
        ? `Stopped bridge TAS streaming. ${HARDWARE_TAS_PAUSE_MESSAGE}`
        : "Playback stopped",
      sentAt: new Date().toISOString(),
    });
  }
}

function rememberCanceledBridgeRun() {
  const bridgeRunId = Number(state.tas.hardwareBridgeRunId || state.tas.hardwareStatus?.run_id || 0);
  if (bridgeRunId <= 0) {
    return;
  }

  state.tas.ignoredBridgeRunIds.add(bridgeRunId);
}

function stoppedStatusForLoadedTas() {
  if (state.tas.frames.length === 0) {
    return "empty";
  }

  return state.tas.validation?.valid ? "stopped" : "invalid";
}

function hardwareRunIsCurrent(runId) {
  return runId === state.tas.hardwareRunId;
}

function updatePlaybackInfo() {
  const hardwareTotal = Number(state.tas.hardwareStatus?.total || 0);
  const total = hardwareTotal || state.tas.frames.length;
  const current = Math.min(state.tas.currentFrame, total);
  const progress = total === 0 ? 0 : (current / total) * 100;
  const frame = state.tas.frames.length > 0 ? state.tas.frames[Math.min(current, state.tas.frames.length - 1)] : null;
  const isActive = ["uploading", "arming", "playing", "streaming"].includes(state.tas.status);
  const canPause = ["arming", "playing", "streaming"].includes(state.tas.status);
  const isPaused = state.tas.status === "paused";
  const isArmed = state.tas.status === "armed";
  const canPlayLoadedTas = tasReadyForPlayback() && (!isActive || isArmed) && networkTransport.isConnected();

  elements.progressFill.style.width = `${progress}%`;
  elements.progressText.textContent =
    state.tas.streamedFrames > 0
      ? `${current} / ${total} played, ${state.tas.streamedFrames} sent`
      : `${current} / ${total} frames`;
  const statusMessage = playbackStatusMessage();
  elements.playbackStatusText.textContent = statusMessage || playbackLabel();
  elements.fileName.textContent = state.tas.fileName;
  elements.syncModeField.classList.toggle(
    "hidden",
    state.tas.fileFormat !== "r08" || !state.tas.validation?.valid,
  );
  elements.syncMode.value = state.tas.syncMode;
  elements.currentFrame.textContent =
    state.tas.status === "invalid"
      ? state.tas.hardwareMessage
      : frame
        ? `${state.tas.fileFormatLabel}: #${frame.frame}: ${formatTasFrameInput(frame)}`
        : "Load a TAS file to preview input.";

  elements.playButton.textContent = isPaused ? "Resume" : isArmed ? "Start" : "Play";
  elements.playButton.disabled = !canPlayLoadedTas && !isPaused;
  elements.pauseButton.disabled = !canPause;
  elements.stopButton.disabled = total === 0 || state.tas.status === "invalid";
  elements.dumpTrace.disabled = !networkTransport.isConnected();
  const syncControlsDisabled = ["uploading", "arming", "armed", "playing", "streaming", "paused"].includes(
    state.tas.status,
  );
  elements.syncDelayPolls.disabled = syncControlsDisabled;
  elements.syncSkipPolls.disabled = syncControlsDisabled;
  elements.syncMode.disabled = syncControlsDisabled;
}

function formatTasFrameInput(frame) {
  const player1 = frame.player1 || frame.buttons || [];
  const player2 = frame.player2 || [];
  const p1Text = player1.join("+") || "none";
  if (!player2.length) {
    return p1Text;
  }

  return `P1 ${p1Text}; P2 ${player2.join("+") || "none"}`;
}

function playbackStatusMessage() {
  if (state.tas.status === "invalid") {
    return state.tas.hardwareMessage;
  }

  return state.tas.hardwareMessage || "";
}

function playbackLabel() {
  if (state.tas.status === "empty") {
    return "No file loaded";
  }

  if (state.tas.status === "invalid") {
    return "Invalid TAS file";
  }

  return state.tas.status[0].toUpperCase() + state.tas.status.slice(1);
}

function bindPlayback() {
  elements.tasFile.addEventListener("change", handleTasFile);
  elements.playButton.addEventListener("click", playTas);
  elements.pauseButton.addEventListener("click", pauseTas);
  elements.stopButton.addEventListener("click", stopPlayback);
  elements.syncMode.addEventListener("change", handleSyncModeChange);
  elements.syncDelayPolls.addEventListener("change", handleSyncDelayChange);
  elements.syncDelayPolls.addEventListener("input", handleSyncDelayChange);
  elements.syncSkipPolls.addEventListener("change", handleSyncSkipChange);
  elements.syncSkipPolls.addEventListener("input", handleSyncSkipChange);
}

function bindDiagnostics() {
  elements.dumpTrace.addEventListener("click", dumpHardwareTrace);
}

async function dumpHardwareTrace() {
  if (!networkTransport.isConnected()) {
    writeLog({
      type: "blocked",
      message: "Arduino USB serial is not connected through the middleware",
      originalType: "tas_trace",
    });
    return;
  }

  elements.dumpTrace.disabled = true;
  try {
    const trace = await networkTransport.requestTasTrace(HARDWARE_TAS_TRACE_COUNT);
    const text = eventLogText();
    try {
      await networkTransport.saveEventLog(text, "tas-trace", traceEventLogMetadata(trace));
    } catch (error) {
      writeLog({
        type: "playback",
        message: `TAS trace event log save failed: ${error.message}`,
        sentAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    writeLog({
      type: "playback",
      message: `TAS trace dump failed: ${error.message}`,
      sentAt: new Date().toISOString(),
    });
    try {
      await networkTransport.saveEventLog(
        eventLogText(),
        "tas-trace",
        traceEventLogMetadata({ error: error.message }),
      );
    } catch {
      // The original trace error is the useful user-facing failure.
    }
  } finally {
    updatePlaybackInfo();
  }
}

function traceEventLogMetadata(trace = {}) {
  return {
    timestamp: new Date().toISOString(),
    tasFileName: state.tas.fileName,
    fileFormat: state.tas.fileFormat,
    fileFormatLabel: state.tas.fileFormatLabel,
    originalPolls: state.tas.masks.length,
    effectivePolls: Math.max(0, state.tas.masks.length - state.tas.syncSkipPolls),
    portCount: tasMasksPortCount(state.tas.masks),
    skipPolls: state.tas.syncSkipPolls,
    delayPolls: state.tas.syncDelayPolls,
    syncMode: state.tas.syncMode,
    hardwareRunId: state.tas.hardwareRunId,
    bridgeRunId: state.tas.hardwareBridgeRunId,
    traceStart: trace.start,
    traceNext: trace.next,
    traceCount: trace.count,
    traceCapacity: trace.capacity,
    traceClipped: trace.clipped,
    traceDuplicates: trace.duplicates,
    traceError: trace.error,
  };
}

function handleSyncDelayChange() {
  const value = Number(elements.syncDelayPolls.value);
  const normalized = Number.isSafeInteger(value)
    ? Math.max(0, Math.min(HARDWARE_TAS_MAX_START_DELAY_POLLS, value))
    : 0;
  state.tas.syncDelayPolls = normalized;
  if (String(normalized) !== elements.syncDelayPolls.value) {
    elements.syncDelayPolls.value = String(normalized);
  }
}

function handleSyncModeChange() {
  if (state.tas.fileFormat !== "r08") {
    elements.syncMode.value = HARDWARE_TAS_SYNC_MODE;
    return;
  }

  state.tas.syncMode = elements.syncMode.value === "latch" ? "latch" : HARDWARE_TAS_SYNC_MODE;
  state.tas.hardwareFileKey = "";
  state.tas.hardwareUploadPromise = null;
  state.tas.hardwareMessage = loadedTasStatusMessage({ format: "r08" }, state.tas.validation);
  updatePlaybackInfo();
}

function handleSyncSkipChange() {
  const value = Number(elements.syncSkipPolls.value);
  const max = Math.max(0, state.tas.masks.length - 1);
  const normalized = Number.isSafeInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
  state.tas.syncSkipPolls = normalized;
  if (String(normalized) !== elements.syncSkipPolls.value) {
    elements.syncSkipPolls.value = String(normalized);
  }
  state.tas.hardwareFileKey = "";
  state.tas.hardwareUploadPromise = null;
}

function bindLogActions() {
  elements.copyLog.addEventListener("click", copyEventLog);
  elements.clearLog.addEventListener("click", () => {
    elements.eventLog.replaceChildren();
    state.eventCount = 0;
    updateEventLogSize();
  });
}

function bindInputSafety() {
  window.addEventListener("blur", () => {
    releaseAllInputs("window_blur");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAllInputs("visibility_hidden");
    }
  });
}

function init() {
  bindControllerButtons();
  bindControllerPortSelector();
  bindKeyboardControls();
  bindConnection();
  bindPlayback();
  bindDiagnostics();
  bindLogActions();
  bindInputSafety();
  updateConnection();
  updateControllerPortSelector();
  updateDeviceStates();
  updatePlaybackInfo();
  updateEventLogSize();
  writeLog({
    type: "bridge",
    message: "Arduino USB bridge ready; press Connect to open serial",
  });
}

init();
