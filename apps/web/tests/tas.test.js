const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatTasChunk,
  frameButtonsToMask,
  inspectFm2Warnings,
  maskToButtons,
  normalizeButtons,
  normalizeTasMasks,
  parseRawMaskBytes,
  parseR08Bytes,
  parseTwoControllerMaskBytes,
  parseTas,
  parseTasFileBytes,
  parseTasText,
  reconcileCompletedExactRunElapsed,
  reverseByteBits,
  HARDWARE_TAS_SYNC_MODES,
  TAS_CHUNK_FRAME_LIMIT,
  TWO_CONTROLLER_MASK_HEADER,
  TWO_CONTROLLER_MASK_MAGIC,
  TWO_CONTROLLER_MASK_VERSION,
  twoControllerMaskHeaderWithFrames,
  twoControllerMaskSourceFrameCount,
  tasChunkChecksum,
  tasFramesToMasks,
  tasMasksPortCount,
  tasRunChecksum,
  validateTasFrames,
} = require("../src/tas.js");

test("exposes all hardware TAS synchronization modes", () => {
  assert.deepEqual(HARDWARE_TAS_SYNC_MODES, ["poll", "latch", "strobe"]);
});

test("reconciles only a one-second displayed completion overrun", () => {
  const exactTotalMs = (17868 / 60.0988) * 1000;

  // Completion-status latency produces 4:58 / 4:57, so show 4:57 / 4:57.
  assert.equal(reconcileCompletedExactRunElapsed(exactTotalMs + 700, exactTotalMs), exactTotalMs);

  // A displayed two-second overrun remains visible as 4:59 / 4:57.
  assert.equal(reconcileCompletedExactRunElapsed(exactTotalMs + 2000, exactTotalMs), exactTotalMs + 2000);
});

test("parses JSON frame arrays and normalizes aliases", () => {
  const frames = parseTas(
    JSON.stringify({
      frames: [
        { frame: 12, player1: ["Start", "A"] },
        { input: "u+r" },
        { buttons: "b+select" },
      ],
    }),
  );

  assert.deepEqual(frames, [
    {
      frame: 12,
      buttons: ["start", "a"],
      raw: '{"frame":12,"player1":["Start","A"]}',
    },
    {
      frame: 1,
      buttons: ["up", "right"],
      raw: '{"input":"u+r"}',
    },
    {
      frame: 2,
      buttons: ["b", "select"],
      raw: '{"buttons":"b+select"}',
    },
  ]);
});

test("parses plain text frames for one controller", () => {
  const frames = parseTas(`
    # comments are ignored
    A+B | Right
    8: Up,Right | Select
    none
  `);

  assert.deepEqual(frames, [
    { frame: 0, buttons: ["a", "b"], player1: ["a", "b"], player2: ["right"], raw: "A+B | Right" },
    { frame: 1, buttons: ["up", "right"], player1: ["up", "right"], player2: ["select"], raw: "8: Up,Right | Select" },
    { frame: 2, buttons: [], raw: "none" },
  ]);
});

test("parses FM2 player one gamepad fields", () => {
  const frames = parseTas(`
    version 3
    |0|R.......|........|
    |0|........|128 120 1 |
  `);

  assert.deepEqual(frames, [
    { frame: 0, buttons: ["right"], raw: "|0|R.......|........|" },
    { frame: 1, buttons: [], raw: "|0|........|128 120 1 |" },
  ]);
});

test("parses FM2 player two gamepad fields", () => {
  const frames = parseTas(`
    version 3
    |0|R.......|......B.|
    |0|........|....T...|
  `);

  assert.deepEqual(frames, [
    {
      frame: 0,
      buttons: ["right"],
      player1: ["right"],
      player2: ["b"],
      raw: "|0|R.......|......B.|",
    },
    {
      frame: 1,
      buttons: [],
      player1: [],
      player2: ["start"],
      raw: "|0|........|....T...|",
    },
  ]);
  assert.deepEqual(tasFramesToMasks(frames), [
    { p1: 0x80, p2: 0x02 },
    { p1: 0x00, p2: 0x08 },
  ]);
});

test("reports FM2 hardware playback warnings", () => {
  const result = parseTasText(`
    version 3
    |1|R.......|........|
    |0|........|......B.|
  `);

  assert.equal(result.format, "fm2");
  assert.deepEqual(result.frames, [
    { frame: 0, buttons: ["right"], raw: "|1|R.......|........|" },
    { frame: 1, buttons: [], player1: [], player2: ["b"], raw: "|0|........|......B.|" },
  ]);
  assert.deepEqual(result.warnings, [
    "FM2 command/reset/power markers are not converted into hardware pre-roll or reset behavior.",
    "Raw FM2 rows include emulator lag frames and can miss repeated controller reads. For real NES playback, generate a FCEUX poll-accurate mask file and load that instead.",
  ]);
  assert.deepEqual(inspectFm2Warnings(["|0|........|........|"]), [
    "Raw FM2 rows include emulator lag frames and can miss repeated controller reads. For real NES playback, generate a FCEUX poll-accurate mask file and load that instead.",
  ]);
});

test("normalizes known button shorthands and drops unknown input", () => {
  assert.deepEqual(normalizeButtons("s sel u d l r start coin"), [
    "start",
    "select",
    "up",
    "down",
    "left",
    "right",
    "start",
  ]);
});

test("converts TAS frames to NES hardware masks", () => {
  assert.equal(frameButtonsToMask(["a", "b", "right"]), 0x83);
  assert.deepEqual(maskToButtons(0x82), ["b", "right"]);
  assert.deepEqual(
    tasFramesToMasks([
      { buttons: ["start"] },
      { buttons: ["up", "left"] },
      { buttons: [] },
    ]),
    [0x08, 0x50, 0x00],
  );
});

test("parses raw TASDeck mask bytes without trimming idle polls", () => {
  assert.deepEqual(parseRawMaskBytes(Uint8Array.from([0x01, 0x02, 0x08, 0x82, 0x00])), [
    { frame: 0, buttons: ["a"], raw: "0x01" },
    { frame: 1, buttons: ["b"], raw: "0x02" },
    { frame: 2, buttons: ["start"], raw: "0x08" },
    { frame: 3, buttons: ["b", "right"], raw: "0x82" },
    { frame: 4, buttons: [], raw: "0x00" },
  ]);
});

test("rejects unversioned .tdmask uploads", () => {
  assert.throws(
    () => parseTasFileBytes("movie.tdmask", Uint8Array.from([0x00, 0x01, 0x80]).buffer),
    /requires a versioned TD2P \.tdmask file/,
  );
});

test("parses two-controller .tdmask uploads with TD2P header", () => {
  const bytes = Uint8Array.from([
    ...TWO_CONTROLLER_MASK_HEADER,
    0x01,
    0x02,
    0x00,
    0x08,
  ]);
  const result = parseTasFileBytes("movie.tdmask", bytes.buffer);

  assert.equal(result.format, "raw-mask-v2");
  assert.equal(result.syncMode, "poll");
  assert.equal(result.sourceFrameCount, 0);
  assert.equal(TWO_CONTROLLER_MASK_VERSION, 1);
  assert.equal(result.label, "TASDeck two-controller mask stream");
  assert.deepEqual(result.frames, [
    { frame: 0, buttons: ["a"], player1: ["a"], player2: ["b"], raw: "p1=0x01 p2=0x02" },
    { frame: 1, buttons: [], player1: [], player2: ["start"], raw: "p1=0x00 p2=0x08" },
  ]);
  assert.deepEqual(parseTwoControllerMaskBytes(bytes), result.frames);
  assert.deepEqual(tasFramesToMasks(result.frames), [
    { p1: 0x01, p2: 0x02 },
    { p1: 0x00, p2: 0x08 },
  ]);
});

test("parses paired R08 records with reversed controller-bit order", () => {
  const bytes = Uint8Array.from([
    0x80, // P1 A -> TASDeck bit 0
    0x40, // P2 B -> TASDeck bit 1
    0x01, // P1 Right -> TASDeck bit 7
    0x00,
  ]);
  const result = parseTasFileBytes("movie.R08", bytes);

  assert.equal(result.format, "r08");
  assert.equal(result.label, "R08 two-controller stream");
  assert.equal(result.syncMode, "strobe");
  assert.deepEqual(result.frames, [
    { frame: 0, buttons: ["a"], player1: ["a"], player2: ["b"], raw: "p1=0x01 p2=0x02" },
    { frame: 1, buttons: ["right"], player1: ["right"], player2: [], raw: "p1=0x80 p2=0x00" },
  ]);
  assert.deepEqual(parseR08Bytes(bytes), result.frames);
  assert.deepEqual(tasFramesToMasks(result.frames), [
    { p1: 0x01, p2: 0x02 },
    { p1: 0x80, p2: 0x00 },
  ]);
  assert.equal(tasMasksPortCount(tasFramesToMasks(result.frames)), 2);
});

test("reverses every R08 controller bit and preserves an idle second port", () => {
  for (let bit = 0; bit < 8; bit += 1) {
    assert.equal(reverseByteBits(1 << bit), 1 << (7 - bit));
  }

  const masks = tasFramesToMasks(parseTasFileBytes("one-player.r08", Uint8Array.from([0x80, 0x00])).frames);
  assert.equal(tasMasksPortCount(masks), 2);
  assert.deepEqual(masks, [{ p1: 0x01, p2: 0x00 }]);
});

test("rejects empty and incomplete R08 streams", () => {
  assert.throws(() => parseTasFileBytes("empty.r08", new Uint8Array()), /R08 stream is empty/);
  assert.throws(
    () => parseTasFileBytes("incomplete.r08", Uint8Array.from([0x80, 0x00, 0x40])),
    /incomplete two-controller record/,
  );
});

test("preserves an explicitly two-controller stream when player two is idle", () => {
  const bytes = Uint8Array.from([
    ...TWO_CONTROLLER_MASK_HEADER,
    0x01,
    0x00,
    0x80,
    0x00,
  ]);
  const result = parseTasFileBytes("idle-player-two.tdmask", bytes);
  const masks = tasFramesToMasks(result.frames);

  assert.equal(result.format, "raw-mask-v2");
  assert.equal(tasMasksPortCount(masks), 2);
  assert.deepEqual(masks, [
    { p1: 0x01, p2: 0x00 },
    { p1: 0x80, p2: 0x00 },
  ]);
});

test("rejects incomplete or unsupported TD2P headers", () => {
  const bareMagic = Uint8Array.from(Array.from(TWO_CONTROLLER_MASK_MAGIC, (char) => char.charCodeAt(0)));
  assert.throws(
    () => parseTasFileBytes("old-interim.tdmask", bareMagic),
    /requires a versioned TD2P \.tdmask file/,
  );

  const wrongVersion = Uint8Array.from(TWO_CONTROLLER_MASK_HEADER);
  wrongVersion[TWO_CONTROLLER_MASK_MAGIC.length] = 3;
  assert.throws(
    () => parseTasFileBytes("future.tdmask", wrongVersion),
    /requires a versioned TD2P \.tdmask file/,
  );

  // A version-2 header cut off before its frame-count field is invalid.
  const truncatedV2 = Uint8Array.from(TWO_CONTROLLER_MASK_HEADER);
  truncatedV2[TWO_CONTROLLER_MASK_MAGIC.length] = 2;
  assert.throws(
    () => parseTasFileBytes("truncated.tdmask", truncatedV2),
    /requires a versioned TD2P \.tdmask file/,
  );
});

test("parses TD2P v2 headers with a source movie frame count", () => {
  const bytes = Uint8Array.from([
    ...twoControllerMaskHeaderWithFrames(30000),
    0x01,
    0x02,
    0x00,
    0x08,
  ]);
  const result = parseTasFileBytes("movie.tdmask", bytes);

  assert.equal(result.format, "raw-mask-v2");
  assert.equal(result.sourceFrameCount, 30000);
  assert.deepEqual(tasFramesToMasks(result.frames), [
    { p1: 0x01, p2: 0x02 },
    { p1: 0x00, p2: 0x08 },
  ]);
  assert.equal(twoControllerMaskSourceFrameCount(bytes), 30000);

  // Big-endian byte order in the frame-count field.
  assert.deepEqual(Array.from(twoControllerMaskHeaderWithFrames(0x01020304).slice(8)), [1, 2, 3, 4]);

  // A zero count means the exporter could not learn the total; readers treat
  // the duration as unknown and estimate instead.
  const unknownCount = Uint8Array.from([...twoControllerMaskHeaderWithFrames(0), 0x01, 0x02]);
  assert.equal(parseTasFileBytes("unknown.tdmask", unknownCount).sourceFrameCount, 0);
});

test("rejects uploads without a supported hardware-stream extension", () => {
  assert.throws(
    () => parseTasFileBytes("movie.fm2", TWO_CONTROLLER_MASK_HEADER),
    /only accepts \.tdmask and \.r08 files/,
  );
});

test("validates TAS files before hardware streaming", () => {
  assert.deepEqual(validateTasFrames([{ buttons: [] }]), {
    valid: false,
    errors: ["TAS file contains no recognized NES controller input."],
    frameCount: 1,
    inputFrameCount: 0,
    masks: [0],
  });

  assert.deepEqual(validateTasFrames([{ buttons: ["a"] }, { buttons: [] }]), {
    valid: true,
    errors: [],
    frameCount: 2,
    inputFrameCount: 1,
    masks: [1, 0],
  });

  assert.deepEqual(validateTasFrames([{ player2: ["start"] }, { buttons: [] }]), {
    valid: true,
    errors: [],
    frameCount: 2,
    inputFrameCount: 1,
    masks: [{ p1: 0, p2: 8 }, { p1: 0, p2: 0 }],
  });
});

test("formats compact TAS chunks with checksum", () => {
  assert.equal(tasChunkChecksum(0, [0x01, 0x00, 0x80]), 0x82);
  assert.deepEqual(formatTasChunk(0, [0x01, 0x00, 0x80]), {
    startIndex: 0,
    count: 3,
    portCount: 1,
    encodedMasks: "010080",
    checksum: 0x82,
    masks: [0x01, 0x00, 0x80],
  });
  assert.equal(TAS_CHUNK_FRAME_LIMIT, 48);
  assert.equal(formatTasChunk(0, Array.from({ length: TAS_CHUNK_FRAME_LIMIT }, () => 0)).count, 48);
  assert.throws(
    () => formatTasChunk(0, Array.from({ length: TAS_CHUNK_FRAME_LIMIT + 1 }, () => 0)),
    /1-48 frames/,
  );
});

test("formats two-controller TAS chunks with interleaved masks", () => {
  const masks = [
    { p1: 0x01, p2: 0x02 },
    { p1: 0x00, p2: 0x00 },
    { p1: 0x80, p2: 0x08 },
  ];

  assert.equal(tasMasksPortCount(masks), 2);
  assert.deepEqual(normalizeTasMasks(masks), masks);
  assert.equal(tasChunkChecksum(0, masks), 0x8a);
  assert.deepEqual(formatTasChunk(0, masks), {
    startIndex: 0,
    count: 3,
    portCount: 2,
    encodedMasks: "010200008008",
    checksum: 0x8a,
    masks,
  });
});

test("formats a maximum-size two-controller TAS chunk", () => {
  const masks = Array.from({ length: TAS_CHUNK_FRAME_LIMIT }, (_, index) => ({
    p1: index,
    p2: 0xff - index,
  }));
  const chunk = formatTasChunk(0xffffffff, masks);

  assert.equal(chunk.count, TAS_CHUNK_FRAME_LIMIT);
  assert.equal(chunk.portCount, 2);
  assert.equal(chunk.encodedMasks.length, TAS_CHUNK_FRAME_LIMIT * 4);
  assert.equal(chunk.checksum, tasChunkChecksum(0xffffffff, masks, 2));
});

test("formats whole-run TAS checksums for bridge upload validation", () => {
  assert.equal(tasRunChecksum([0x01, 0x00, 0x80]), 0x27);
  assert.equal(tasRunChecksum([0x01, 0x80, 0x00]), 0xb7);
  assert.equal(tasRunChecksum([{ p1: 0x01, p2: 0x02 }, { p1: 0x00, p2: 0x00 }, { p1: 0x80, p2: 0x08 }]), 0x1a);
});
