(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.TasDeckTas = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const NES_BUTTONS = ["a", "b", "select", "start", "up", "down", "left", "right"];
  const FM2_GAMEPAD_COLUMNS = ["right", "left", "down", "up", "start", "select", "b", "a"];
  const TAS_INPUTS = [...NES_BUTTONS];
  const TWO_CONTROLLER_MASK_MAGIC = "TD2P";
  const TWO_CONTROLLER_MASK_VERSION = 1;
  // Version 2 appends a big-endian uint32 after the 8-byte header: the source
  // movie's total video-frame count including lag frames, which times the run
  // exactly. Zero means the exporter could not learn the count; readers fall
  // back to estimating the duration, exactly as they must for version 1.
  const TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES = 2;
  const TWO_CONTROLLER_MASK_FRAME_COUNT_BYTES = 4;
  const TAS_CONTROLLER_PORT_COUNT = 2;
  const NES_FRAMES_PER_SECOND = 60.0988;
  const TWO_CONTROLLER_MASK_HEADER = Uint8Array.from([
    ...Array.from(TWO_CONTROLLER_MASK_MAGIC, (char) => char.charCodeAt(0)),
    TWO_CONTROLLER_MASK_VERSION,
    TAS_CONTROLLER_PORT_COUNT,
    0x0d,
    0x0a,
  ]);
  const HARDWARE_TAS_SYNC_MODE = "poll";
  const HARDWARE_TAS_SYNC_MODES = ["poll", "latch", "strobe"];
  const HARDWARE_TAS_MAX_START_DELAY_POLLS = 3600;
  const TAS_CHUNK_FRAME_LIMIT = 48;
  // Accepted aliases for a frame's player-2 input, in precedence order. Keep
  // every consumer (normalization, mask conversion, two-controller detection)
  // on this one list.
  const PLAYER2_FRAME_KEYS = ["player2", "controller2", "p2"];

  // Hold an exact-duration run at its movie time during the one-second grace
  // period where status latency can keep the measured timer running. Preserve
  // longer overruns because they can indicate a real playback slowdown or
  // stall.
  function reconcileExactRunElapsed(elapsedMs, totalMs) {
    const elapsed = Number(elapsedMs);
    const total = Number(totalMs);
    if (!Number.isFinite(elapsed) || !Number.isFinite(total)) {
      return elapsedMs;
    }

    return elapsed > total && elapsed <= total + 1000 ? total : elapsed;
  }

  function parseTas(contents) {
    return parseTasText(contents).frames;
  }

  function parseTasText(contents, fileName = "") {
    const trimmed = String(contents ?? "").trim();
    if (!trimmed) {
      return parseResult([], {
        format: "empty",
        label: "Empty TAS",
        fileName,
      });
    }

    try {
      const data = JSON.parse(trimmed);
      const frames = Array.isArray(data) ? data : data.frames;
      if (Array.isArray(frames)) {
        return parseResult(frames.map((frame, index) => normalizeJsonFrame(frame, index)), {
          format: "json",
          label: "JSON TAS",
          fileName,
        });
      }
    } catch {
      // Text TAS and FM2 files are handled below.
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));

    if (isFm2(lines)) {
      return parseResult(parseFm2Frames(lines), {
        format: "fm2",
        label: "Raw FM2",
        fileName,
        warnings: inspectFm2Warnings(lines),
      });
    }

    return parseResult(lines.map((line, index) => parseTextFrame(line, index)), {
      format: "text",
      label: "Text TAS",
      fileName,
    });
  }

  function parseTasFileBytes(fileName, bytes) {
    const normalizedBytes = normalizeBytes(bytes);
    const extension = extensionForFileName(fileName);

    if (extension === ".r08") {
      // Raw .r08 dumps carry one record per strobe, so default them to the
      // TAStm32-parity strobe mode; the picker can still select poll or latch
      // for dumps documented as needing --dpcm window playback.
      return parseResult(parseR08Bytes(normalizedBytes), {
        format: "r08",
        label: "R08 two-controller stream",
        fileName,
        syncMode: "strobe",
      });
    }

    if (extension !== ".tdmask") {
      throw new Error("TASDeck only accepts .tdmask and .r08 files.");
    }

    if (!isTwoControllerMaskStream(normalizedBytes)) {
      throw new Error("TASDeck requires a versioned TD2P .tdmask file with a valid header.");
    }

    return parseResult(parseTwoControllerMaskBytes(normalizedBytes), {
      format: "raw-mask-v2",
      label: "TASDeck two-controller mask stream",
      fileName,
      syncMode: HARDWARE_TAS_SYNC_MODE,
      sourceFrameCount: twoControllerMaskSourceFrameCount(normalizedBytes),
    });
  }

  function parseRawMaskBytes(bytes) {
    return Array.from(normalizeBytes(bytes), (mask, index) => ({
      frame: index,
      buttons: maskToButtons(mask),
      raw: `0x${byteToHex(mask)}`,
    }));
  }

  function parseTwoControllerMaskBytes(bytes) {
    const normalizedBytes = normalizeBytes(bytes);
    const version = twoControllerMaskStreamVersion(normalizedBytes);
    if (version === 0) {
      throw new Error("Two-controller TASDeck mask stream has an unsupported or invalid header.");
    }

    const payload = normalizedBytes.slice(twoControllerMaskHeaderLength(version));
    if (payload.length % TAS_CONTROLLER_PORT_COUNT !== 0) {
      throw new Error("Two-controller TASDeck mask stream has an incomplete frame.");
    }

    const frames = [];
    for (let index = 0; index < payload.length; index += TAS_CONTROLLER_PORT_COUNT) {
      const port1Mask = payload[index];
      const port2Mask = payload[index + 1];
      frames.push({
        frame: index / TAS_CONTROLLER_PORT_COUNT,
        buttons: maskToButtons(port1Mask),
        player1: maskToButtons(port1Mask),
        player2: maskToButtons(port2Mask),
        raw: `p1=0x${byteToHex(port1Mask)} p2=0x${byteToHex(port2Mask)}`,
      });
    }

    return frames;
  }

  function reverseByteBits(value) {
    let source = Number(value) & 0xff;
    let reversed = 0;
    for (let index = 0; index < 8; index += 1) {
      reversed = (reversed << 1) | (source & 1);
      source >>>= 1;
    }
    return reversed;
  }

  function parseR08Bytes(bytes) {
    const normalizedBytes = normalizeBytes(bytes);
    if (normalizedBytes.length === 0) {
      throw new Error("R08 stream is empty.");
    }
    if (normalizedBytes.length % TAS_CONTROLLER_PORT_COUNT !== 0) {
      throw new Error("R08 stream has an incomplete two-controller record.");
    }

    const frames = [];
    for (let index = 0; index < normalizedBytes.length; index += TAS_CONTROLLER_PORT_COUNT) {
      const port1Mask = reverseByteBits(normalizedBytes[index]);
      const port2Mask = reverseByteBits(normalizedBytes[index + 1]);
      frames.push({
        frame: index / TAS_CONTROLLER_PORT_COUNT,
        buttons: maskToButtons(port1Mask),
        player1: maskToButtons(port1Mask),
        player2: maskToButtons(port2Mask),
        raw: `p1=0x${byteToHex(port1Mask)} p2=0x${byteToHex(port2Mask)}`,
      });
    }

    return frames;
  }

  function parseResult(frames, options = {}) {
    return {
      frames,
      format: options.format || "unknown",
      label: options.label || "TAS file",
      fileName: options.fileName || "",
      syncMode: options.syncMode || HARDWARE_TAS_SYNC_MODE,
      sourceFrameCount: options.sourceFrameCount || 0,
      warnings: options.warnings || [],
    };
  }

  // Frames carry player1/player2 keys only when the source declared a second
  // controller with input; single-port sources keep the legacy buttons-only
  // shape that downstream consumers treat as port 1.
  function makeTasFrame(frameNumber, player1Buttons, player2Buttons, raw) {
    const result = {
      frame: frameNumber,
      buttons: player1Buttons,
      raw,
    };

    if (player2Buttons.length > 0) {
      result.player1 = player1Buttons;
      result.player2 = player2Buttons;
    }

    return result;
  }

  function framePlayer2Input(frame) {
    for (const key of PLAYER2_FRAME_KEYS) {
      const value = frame[key];
      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return [];
  }

  function normalizeJsonFrame(frame, index) {
    const normalizedFrame = frame && typeof frame === "object" ? frame : {};
    const buttons =
      normalizedFrame.buttons ??
      normalizedFrame.input ??
      normalizedFrame.player1 ??
      [];
    const frameNumber = Number(normalizedFrame.frame ?? index);
    return makeTasFrame(
      Number.isFinite(frameNumber) ? frameNumber : index,
      normalizeButtons(buttons),
      normalizeButtons(framePlayer2Input(normalizedFrame)),
      JSON.stringify(frame),
    );
  }

  function parseTextFrame(line, index) {
    const lineWithoutFrame = line.replace(/^\d+\s*[:|,]\s*/, "");
    const fields = lineWithoutFrame.split("|");
    return makeTasFrame(index, normalizeButtons(fields[0]), normalizeButtons(fields[1] ?? ""), line);
  }

  function isFm2(lines) {
    return lines.some((line) => line.startsWith("version ")) && lines.some((line) => line.startsWith("|"));
  }

  function parseFm2Frames(lines) {
    return lines
      .filter((line) => line.startsWith("|"))
      .map((line, index) => parseFm2Frame(line, index))
      .filter(Boolean);
  }

  function parseFm2Frame(line, index) {
    const fields = line.split("|");
    return makeTasFrame(
      index,
      parseFm2GamepadField(fields[2] ?? ""),
      parseFm2GamepadField(fields[3] ?? ""),
      line,
    );
  }

  function parseFm2GamepadField(field) {
    const markers = "RLDUTSBA";
    return FM2_GAMEPAD_COLUMNS.filter((button, index) => {
      const value = String(field[index] ?? ".").toUpperCase();
      return value === markers[index];
    });
  }

  function inspectFm2Warnings(lines) {
    const warnings = [];
    const inputLines = lines.filter((line) => line.startsWith("|"));
    const hasCommandMarkers = inputLines.some((line) => {
      const commandField = line.split("|")[1]?.trim() ?? "";
      return commandField !== "" && commandField !== "0";
    });
    if (hasCommandMarkers) {
      warnings.push(
        "FM2 command/reset/power markers are not converted into hardware pre-roll or reset behavior.",
      );
    }

    warnings.push(
      "Raw FM2 rows include emulator lag frames and can miss repeated controller reads. For real NES playback, generate a FCEUX poll-accurate mask file and load that instead.",
    );

    return warnings;
  }

  function normalizeButtons(value) {
    const tokens = Array.isArray(value)
      ? value
      : String(value)
          .split(/[\s,+/|]+/)
          .filter(Boolean);

    return tokens
      .map((token) => String(token).toLowerCase())
      .map((token) => (token === "s" ? "start" : token))
      .map((token) => (token === "sel" ? "select" : token))
      .map((token) => (token === "u" ? "up" : token))
      .map((token) => (token === "d" ? "down" : token))
      .map((token) => (token === "l" ? "left" : token))
      .map((token) => (token === "r" ? "right" : token))
      .filter((token) => TAS_INPUTS.includes(token));
  }

  function frameButtonsToMask(buttons) {
    return normalizeButtons(buttons).reduce((mask, button) => {
      const index = NES_BUTTONS.indexOf(button);
      return index === -1 ? mask : mask | (1 << index);
    }, 0);
  }

  function maskToButtons(mask) {
    const normalizedMask = Number(mask) & 0xff;
    return NES_BUTTONS.filter((button, index) => (normalizedMask & (1 << index)) !== 0);
  }

  function tasFramesToMasks(frames) {
    const portMasks = frames.map(frameToPortMasks);
    const explicitlyTwoController = frames.some(frameDeclaresSecondController);
    if (!explicitlyTwoController && portMasks.every((mask) => mask.p2 === 0)) {
      return portMasks.map((mask) => mask.p1);
    }

    return portMasks;
  }

  function frameDeclaresSecondController(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return false;
    }

    return PLAYER2_FRAME_KEYS.some((key) => Object.prototype.hasOwnProperty.call(frame, key));
  }

  function frameToPortMasks(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return {
        p1: frameButtonsToMask(frame ?? []),
        p2: 0,
      };
    }

    return {
      p1: frameButtonsToMask(frame.player1 ?? frame.buttons ?? frame.input ?? []),
      p2: frameButtonsToMask(framePlayer2Input(frame)),
    };
  }

  function validateTasFrames(frames) {
    const errors = [];
    const normalizedFrames = Array.isArray(frames) ? frames : [];

    if (normalizedFrames.length === 0) {
      errors.push("TAS file has no playable frames.");
    }

    const masks = tasFramesToMasks(normalizedFrames);
    const inputFrameCount = masks.filter(tasMaskHasInput).length;
    if (normalizedFrames.length > 0 && inputFrameCount === 0) {
      errors.push("TAS file contains no recognized NES controller input.");
    }

    return {
      valid: errors.length === 0,
      errors,
      frameCount: normalizedFrames.length,
      inputFrameCount,
      masks,
    };
  }

  function byteToHex(value) {
    return Number(value & 0xff).toString(16).toUpperCase().padStart(2, "0");
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

    return Uint8Array.from(bytes ?? []);
  }

  function extensionForFileName(fileName) {
    const normalized = String(fileName || "").toLowerCase();
    const dotIndex = normalized.lastIndexOf(".");
    return dotIndex === -1 ? "" : normalized.slice(dotIndex);
  }

  function hasTwoControllerMaskMagic(bytes) {
    if (!bytes || bytes.length < TWO_CONTROLLER_MASK_MAGIC.length) {
      return false;
    }

    for (let index = 0; index < TWO_CONTROLLER_MASK_MAGIC.length; index += 1) {
      if (bytes[index] !== TWO_CONTROLLER_MASK_MAGIC.charCodeAt(index)) {
        return false;
      }
    }

    return true;
  }

  function twoControllerMaskStreamVersion(bytes) {
    if (!bytes || bytes.length < TWO_CONTROLLER_MASK_HEADER.length || !hasTwoControllerMaskMagic(bytes)) {
      return 0;
    }

    const version = bytes[TWO_CONTROLLER_MASK_MAGIC.length];
    if (version !== TWO_CONTROLLER_MASK_VERSION && version !== TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES) {
      return 0;
    }
    if (
      bytes[TWO_CONTROLLER_MASK_MAGIC.length + 1] !== TAS_CONTROLLER_PORT_COUNT ||
      bytes[TWO_CONTROLLER_MASK_MAGIC.length + 2] !== 0x0d ||
      bytes[TWO_CONTROLLER_MASK_MAGIC.length + 3] !== 0x0a
    ) {
      return 0;
    }
    if (bytes.length < twoControllerMaskHeaderLength(version)) {
      return 0;
    }

    return version;
  }

  function twoControllerMaskHeaderLength(version) {
    return version === TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES
      ? TWO_CONTROLLER_MASK_HEADER.length + TWO_CONTROLLER_MASK_FRAME_COUNT_BYTES
      : TWO_CONTROLLER_MASK_HEADER.length;
  }

  // Reads the version-2 source-movie frame count; 0 for version 1 or an
  // exporter that could not learn the count.
  function twoControllerMaskSourceFrameCount(bytes) {
    if (twoControllerMaskStreamVersion(bytes) !== TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES) {
      return 0;
    }

    const offset = TWO_CONTROLLER_MASK_HEADER.length;
    return (
      bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]
    );
  }

  function twoControllerMaskHeaderWithFrames(totalFrames) {
    const count = Number.isSafeInteger(totalFrames) && totalFrames > 0 ? Math.min(totalFrames, 0xffffffff) : 0;
    return Uint8Array.from([
      ...Array.from(TWO_CONTROLLER_MASK_MAGIC, (char) => char.charCodeAt(0)),
      TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES,
      TAS_CONTROLLER_PORT_COUNT,
      0x0d,
      0x0a,
      (count >>> 24) & 0xff,
      (count >>> 16) & 0xff,
      (count >>> 8) & 0xff,
      count & 0xff,
    ]);
  }

  function isTwoControllerMaskStream(bytes) {
    return twoControllerMaskStreamVersion(bytes) !== 0;
  }

  // The *Normalized variants assume the caller already ran normalizeTasMasks;
  // the public wrappers normalize for callers holding raw input. formatTasChunk
  // normalizes its slice exactly once and uses the internals directly.
  function encodeNormalizedTasMasks(normalizedMasks, portCount) {
    return normalizedMasks
      .flatMap((mask) => {
        const ports = [tasMaskPortValue(mask, 1)];
        if (portCount >= TAS_CONTROLLER_PORT_COUNT) {
          ports.push(tasMaskPortValue(mask, 2));
        }
        return ports;
      })
      .map(byteToHex)
      .join("");
  }

  function encodeTasMasks(masks, portCount = tasMasksPortCount(masks)) {
    return encodeNormalizedTasMasks(normalizeTasMasks(masks), portCount);
  }

  function normalizedTasChunkChecksum(startIndex, normalizedMasks, portCount) {
    let checksum = Number(startIndex) >>> 0;
    checksum ^= (checksum >>> 8) & 0xff;
    checksum ^= (checksum >>> 16) & 0xff;
    checksum ^= (checksum >>> 24) & 0xff;
    checksum ^= normalizedMasks.length & 0xff;
    if (portCount >= TAS_CONTROLLER_PORT_COUNT) {
      checksum ^= TAS_CONTROLLER_PORT_COUNT;
    }

    normalizedMasks.forEach((mask) => {
      checksum ^= tasMaskPortValue(mask, 1);
      if (portCount >= TAS_CONTROLLER_PORT_COUNT) {
        checksum ^= tasMaskPortValue(mask, 2);
      }
    });

    return checksum & 0xff;
  }

  function tasChunkChecksum(startIndex, masks, portCount = tasMasksPortCount(masks)) {
    return normalizedTasChunkChecksum(startIndex, normalizeTasMasks(masks), portCount);
  }

  function tasRunChecksum(masks, portCount = tasMasksPortCount(masks)) {
    if (!Array.isArray(masks)) {
      return 0;
    }

    const normalizedMasks = normalizeTasMasks(masks);
    let checksum = normalizedMasks.length >>> 0;
    checksum ^= (checksum >>> 8) & 0xff;
    checksum ^= (checksum >>> 16) & 0xff;
    checksum ^= (checksum >>> 24) & 0xff;
    if (portCount >= TAS_CONTROLLER_PORT_COUNT) {
      checksum ^= TAS_CONTROLLER_PORT_COUNT << 4;
    }

    normalizedMasks.forEach((mask, index) => {
      checksum = ((checksum << 5) | (checksum >>> 3)) & 0xff;
      checksum ^= tasMaskPortValue(mask, 1);
      checksum ^= index & 0xff;
      if (portCount >= TAS_CONTROLLER_PORT_COUNT) {
        checksum = ((checksum << 5) | (checksum >>> 3)) & 0xff;
        checksum ^= tasMaskPortValue(mask, 2);
        checksum ^= (index + TAS_CONTROLLER_PORT_COUNT) & 0xff;
      }
    });

    return checksum & 0xff;
  }

  function formatTasChunk(startIndex, masks, portCount) {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
      throw new Error("TAS chunk start index must be a non-negative integer.");
    }

    if (!Array.isArray(masks) || masks.length === 0 || masks.length > TAS_CHUNK_FRAME_LIMIT) {
      throw new Error(`TAS chunks must contain 1-${TAS_CHUNK_FRAME_LIMIT} frames.`);
    }

    const normalizedMasks = normalizeTasMasks(masks);
    // Callers that know the run's port count (the bridge threads it from
    // TAS_BEGIN) pass it explicitly so a chunk slice can never re-infer a
    // different count than the run was armed with.
    const normalizedPortCount = portCount === undefined
      ? tasMasksPortCount(normalizedMasks)
      : Number(portCount);
    if (normalizedPortCount !== 1 && normalizedPortCount !== TAS_CONTROLLER_PORT_COUNT) {
      throw new Error("TAS chunk port count must be 1 or 2.");
    }

    return {
      startIndex,
      count: normalizedMasks.length,
      portCount: normalizedPortCount,
      encodedMasks: encodeNormalizedTasMasks(normalizedMasks, normalizedPortCount),
      checksum: normalizedTasChunkChecksum(startIndex, normalizedMasks, normalizedPortCount),
      masks: normalizedMasks,
    };
  }

  function normalizeTasMasks(masks) {
    if (!Array.isArray(masks)) {
      return [];
    }

    return masks.map(normalizeTasMask);
  }

  function normalizeTasMask(mask) {
    if (mask && typeof mask === "object") {
      return {
        p1: normalizeTasMaskByte(mask.p1 ?? mask.player1 ?? mask.mask1 ?? mask.port1 ?? mask[0] ?? 0),
        p2: normalizeTasMaskByte(mask.p2 ?? mask.player2 ?? mask.mask2 ?? mask.port2 ?? mask[1] ?? 0),
      };
    }

    return normalizeTasMaskByte(mask);
  }

  function normalizeTasMaskByte(mask) {
    const normalized = Number(mask);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 0xff) {
      throw new Error("TAS frame masks must be bytes.");
    }

    return normalized;
  }

  function tasMasksPortCount(masks) {
    if (!Array.isArray(masks)) {
      return 1;
    }

    return masks.some((mask) => mask && typeof mask === "object")
      ? TAS_CONTROLLER_PORT_COUNT
      : 1;
  }

  function tasMaskPortValue(mask, port) {
    if (mask && typeof mask === "object") {
      return normalizeTasMaskByte(port === 2 ? mask.p2 ?? 0 : mask.p1 ?? 0);
    }

    return port === 2 ? 0 : normalizeTasMaskByte(mask);
  }

  function tasMaskHasInput(mask) {
    return tasMaskPortValue(mask, 1) !== 0 || tasMaskPortValue(mask, 2) !== 0;
  }

  // Wire form for WebSocket uploads: two-port streams travel as one flat
  // interleaved byte array (p1, p2, p1, p2, ...) plus a portCount field
  // instead of one {p1,p2} object per frame, keeping large uploads several
  // times smaller as JSON. tasMasksFromWire reverses it and still accepts the
  // per-frame object shape for compatibility.
  function tasMasksToWire(masks, portCount = tasMasksPortCount(masks)) {
    const normalizedMasks = normalizeTasMasks(masks);
    if (portCount < TAS_CONTROLLER_PORT_COUNT) {
      return normalizedMasks.map((mask) => tasMaskPortValue(mask, 1));
    }

    return normalizedMasks.flatMap((mask) => [tasMaskPortValue(mask, 1), tasMaskPortValue(mask, 2)]);
  }

  function tasMasksFromWire(masks, portCount) {
    if (!Array.isArray(masks)) {
      return [];
    }

    if (
      Number(portCount) !== TAS_CONTROLLER_PORT_COUNT ||
      masks.some((mask) => mask && typeof mask === "object")
    ) {
      return normalizeTasMasks(masks);
    }

    if (masks.length % TAS_CONTROLLER_PORT_COUNT !== 0) {
      throw new Error("Two-controller TAS uploads need one byte per port per frame.");
    }

    const frames = [];
    for (let index = 0; index < masks.length; index += TAS_CONTROLLER_PORT_COUNT) {
      frames.push({
        p1: normalizeTasMaskByte(masks[index]),
        p2: normalizeTasMaskByte(masks[index + 1]),
      });
    }

    return frames;
  }

  return {
    NES_BUTTONS,
    FM2_GAMEPAD_COLUMNS,
    HARDWARE_TAS_MAX_START_DELAY_POLLS,
    HARDWARE_TAS_SYNC_MODE,
    HARDWARE_TAS_SYNC_MODES,
    NES_FRAMES_PER_SECOND,
    TAS_INPUTS,
    TAS_CHUNK_FRAME_LIMIT,
    TAS_CONTROLLER_PORT_COUNT,
    TWO_CONTROLLER_MASK_HEADER,
    TWO_CONTROLLER_MASK_MAGIC,
    TWO_CONTROLLER_MASK_VERSION,
    TWO_CONTROLLER_MASK_VERSION_WITH_FRAMES,
    twoControllerMaskHeaderWithFrames,
    twoControllerMaskSourceFrameCount,
    encodeTasMasks,
    formatTasChunk,
    frameToPortMasks,
    frameButtonsToMask,
    frameDeclaresSecondController,
    hasTwoControllerMaskMagic,
    inspectFm2Warnings,
    isTwoControllerMaskStream,
    isFm2,
    maskToButtons,
    normalizeButtons,
    normalizeTasMasks,
    parseFm2Frame,
    parseFm2Frames,
    parseFm2GamepadField,
    parseRawMaskBytes,
    parseR08Bytes,
    parseTwoControllerMaskBytes,
    parseTas,
    parseTasFileBytes,
    parseTasText,
    parseTextFrame,
    reconcileExactRunElapsed,
    reverseByteBits,
    tasMaskHasInput,
    tasMaskPortValue,
    tasMasksFromWire,
    tasMasksPortCount,
    tasMasksToWire,
    tasChunkChecksum,
    tasFramesToMasks,
    tasRunChecksum,
    validateTasFrames,
  };
});
