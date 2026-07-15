(function attachTransportHelpers(root) {
  const tasApi =
    root.TasDeckTas ||
    (typeof module !== "undefined" && module.require ? module.require("./tas.js") : {});
  const TAS_SOURCE_PREFIX = "tas:";
  const HARDWARE_TAS_SYNC_MODE = tasApi.HARDWARE_TAS_SYNC_MODE || "poll";
  const HARDWARE_TAS_SYNC_MODES = new Set(tasApi.HARDWARE_TAS_SYNC_MODES || ["poll", "latch", "strobe"]);
  const HARDWARE_TAS_MAX_START_DELAY_POLLS = tasApi.HARDWARE_TAS_MAX_START_DELAY_POLLS || 3600;
  const TAS_CONTROLLER_PORT_COUNT = tasApi.TAS_CONTROLLER_PORT_COUNT || 2;
  const HARDWARE_BUTTONS = new Set(["a", "b", "select", "start", "up", "down", "left", "right"]);
  const HARDWARE_ACTIONS = new Set(["down", "up"]);

  function isTasSource(source) {
    return typeof source === "string" && source.startsWith(TAS_SOURCE_PREFIX);
  }

  function eventToBridgeCommand(event) {
    if (!event || isTasSource(event.source)) {
      return null;
    }

    if (event.type === "button") {
      if (!HARDWARE_BUTTONS.has(event.button) || !HARDWARE_ACTIONS.has(event.action)) {
        return null;
      }

      const controllerPort = normalizeControllerPort(event.controllerPort ?? event.controller ?? event.port);
      if (controllerPort === null) {
        return null;
      }
      return controllerPort === 1
        ? `BUTTON ${event.button} ${event.action}`
        : `BUTTON ${controllerPort} ${event.button} ${event.action}`;
    }

    return null;
  }

  function tasBeginToBridgeCommand(message) {
    const frameCount = Number(message?.frameCount);
    const syncMode = message?.syncMode || HARDWARE_TAS_SYNC_MODE;
    const portCount = normalizeTasPortCount(message?.portCount ?? message?.ports ?? message?.controllerPorts);

    if (
      !Number.isSafeInteger(frameCount) ||
      frameCount <= 0 ||
      !HARDWARE_TAS_SYNC_MODES.has(syncMode) ||
      portCount === null
    ) {
      return null;
    }

    return portCount === 1
      ? `TAS_BEGIN ${frameCount} ${syncMode}`
      : `TAS_BEGIN ${frameCount} ${syncMode} ${portCount}`;
  }

  // The one place the TAS_CHUNK wire syntax is spelled out. Both the client
  // relay path (tasChunkToBridgeCommand) and the bridge's own streaming loop
  // format their commands through this helper.
  function formatTasChunkCommand(chunk) {
    const checksum = chunk.checksum.toString(16).toUpperCase().padStart(2, "0");
    return chunk.portCount === 1
      ? `TAS_CHUNK ${chunk.startIndex} ${chunk.count} ${chunk.encodedMasks} ${checksum}`
      : `TAS_CHUNK ${chunk.startIndex} ${chunk.count} ${chunk.portCount} ${chunk.encodedMasks} ${checksum}`;
  }

  function tasChunkToBridgeCommand(message) {
    if (!tasApi.formatTasChunk) {
      return null;
    }

    try {
      const portCount = message?.portCount === undefined
        ? undefined
        : normalizeTasPortCount(message.portCount);
      if (portCount === null) {
        return null;
      }

      const chunk = tasApi.formatTasChunk(Number(message?.startIndex), message?.masks, portCount);
      if (Number(message?.checksum) !== chunk.checksum) {
        return null;
      }

      return formatTasChunkCommand(chunk);
    } catch {
      return null;
    }
  }

  function tasCancelToBridgeCommand() {
    return "TAS_CANCEL";
  }

  function tasEndToBridgeCommand() {
    return "TAS_END";
  }

  function tasStartToBridgeCommand(message = {}) {
    const delayPolls = normalizeTasStartDelayPolls(
      message?.delayPolls ??
        message?.startDelayPolls ??
        message?.start_delay_polls,
    );
    if (delayPolls === null) {
      return null;
    }

    return delayPolls > 0 ? `TAS_START ${delayPolls}` : "TAS_START";
  }

  function tasStatusToBridgeCommand() {
    return "TAS_STATUS";
  }

  function tasTraceToBridgeCommand(message = {}) {
    const count = normalizeTasTraceCount(message?.count);
    const start = normalizeTasTraceStart(message?.start ?? message?.pageStart ?? message?.page_start);
    if (count === null || start === null) {
      return null;
    }

    return start === undefined ? `TAS_TRACE ${count}` : `TAS_TRACE ${count} ${start}`;
  }

  function normalizeTasStartDelayPolls(value) {
    const normalized = value === undefined || value === null || value === "" ? 0 : Number(value);
    if (
      !Number.isSafeInteger(normalized) ||
      normalized < 0 ||
      normalized > HARDWARE_TAS_MAX_START_DELAY_POLLS
    ) {
      return null;
    }

    return normalized;
  }

  function normalizeTasTraceCount(value) {
    const normalized = value === undefined || value === null || value === "" ? 12 : Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > 12) {
      return null;
    }

    return normalized;
  }

  function normalizeTasTraceStart(value) {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
      return null;
    }

    return normalized;
  }

  function normalizeControllerPort(value) {
    const normalized = value === undefined || value === null || value === "" ? 1 : Number(value);
    return normalized === 1 || normalized === 2 ? normalized : null;
  }

  function normalizeTasPortCount(value) {
    const normalized = value === undefined || value === null || value === "" ? 1 : Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > TAS_CONTROLLER_PORT_COUNT) {
      return null;
    }

    return normalized;
  }

  const api = {
    eventToBridgeCommand,
    formatTasChunkCommand,
    tasBeginToBridgeCommand,
    tasCancelToBridgeCommand,
    tasChunkToBridgeCommand,
    tasEndToBridgeCommand,
    tasStartToBridgeCommand,
    tasStatusToBridgeCommand,
    tasTraceToBridgeCommand,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.TasDeckTransport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
