const assert = require("node:assert/strict");
const test = require("node:test");

const {
  eventToBridgeCommand,
  tasBeginToBridgeCommand,
  tasCancelToBridgeCommand,
  tasChunkToBridgeCommand,
  tasEndToBridgeCommand,
  tasStartToBridgeCommand,
  tasStatusToBridgeCommand,
  tasTraceToBridgeCommand,
} = require("../src/transport.js");

test("converts manual controller events to firmware protocol commands", () => {
  assert.equal(
    eventToBridgeCommand({
      type: "button",
      button: "a",
      action: "down",
      source: "manual",
    }),
    "BUTTON a down",
  );

  assert.equal(
    eventToBridgeCommand({
      type: "button",
      button: "right",
      action: "up",
      source: "disconnect",
    }),
    "BUTTON right up",
  );

  assert.equal(
    eventToBridgeCommand({
      type: "button",
      controllerPort: 2,
      button: "a",
      action: "down",
      source: "manual",
    }),
    "BUTTON 2 a down",
  );
});

test("does not send browser-timed TAS button diffs to the hardware bridge", () => {
  assert.equal(
    eventToBridgeCommand({
      type: "button",
      button: "a",
      action: "down",
      source: "tas:12",
    }),
    null,
  );

  assert.equal(
    eventToBridgeCommand({
      type: "button",
      controllerPort: 3,
      button: "a",
      action: "down",
      source: "manual",
    }),
    null,
  );
});

test("rejects malformed controller events before they reach firmware", () => {
  assert.equal(
    eventToBridgeCommand({
      type: "button",
      button: "power",
      action: "down",
      source: "manual",
    }),
    null,
  );

  assert.equal(
    eventToBridgeCommand({
      type: "button",
      button: "a",
      action: "tap",
      source: "manual",
    }),
    null,
  );
});

test("formats hardware TAS protocol commands", () => {
  assert.equal(
    tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 120, syncMode: "poll" }),
    "TAS_BEGIN 120 poll",
  );
  assert.equal(
    tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 120, syncMode: "poll", portCount: 2 }),
    "TAS_BEGIN 120 poll 2",
  );
  assert.equal(
    tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 120, syncMode: "latch" }),
    "TAS_BEGIN 120 latch",
  );
  assert.equal(
    tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 120, syncMode: "strobe", portCount: 2 }),
    "TAS_BEGIN 120 strobe 2",
  );
  assert.equal(
    tasChunkToBridgeCommand({
      type: "tas_chunk",
      startIndex: 0,
      masks: [0x01, 0x00, 0x80],
      checksum: 0x82,
    }),
    "TAS_CHUNK 0 3 010080 82",
  );
  assert.equal(
    tasChunkToBridgeCommand({
      type: "tas_chunk",
      startIndex: 0,
      masks: [
        { p1: 0x01, p2: 0x02 },
        { p1: 0x00, p2: 0x00 },
        { p1: 0x80, p2: 0x08 },
      ],
      checksum: 0x8a,
    }),
    "TAS_CHUNK 0 3 2 010200008008 8A",
  );
  assert.equal(tasCancelToBridgeCommand({ type: "tas_cancel" }), "TAS_CANCEL");
  assert.equal(tasEndToBridgeCommand({ type: "tas_end" }), "TAS_END");
  assert.equal(tasStartToBridgeCommand({ type: "tas_start" }), "TAS_START");
  assert.equal(tasStartToBridgeCommand({ type: "tas_start", delayPolls: 12 }), "TAS_START 12");
  assert.equal(tasStatusToBridgeCommand({ type: "tas_status" }), "TAS_STATUS");
  assert.equal(tasTraceToBridgeCommand({ type: "tas_trace" }), "TAS_TRACE 12");
  assert.equal(tasTraceToBridgeCommand({ type: "tas_trace", count: 4, start: 120 }), "TAS_TRACE 4 120");
});

test("rejects malformed hardware TAS protocol messages", () => {
  assert.equal(tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 0, syncMode: "poll" }), null);
  assert.equal(tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 1, syncMode: "60" }), null);
  assert.equal(tasBeginToBridgeCommand({ type: "tas_begin", frameCount: 1, syncMode: "frame" }), null);
  assert.equal(tasStartToBridgeCommand({ type: "tas_start", delayPolls: -1 }), null);
  assert.equal(tasTraceToBridgeCommand({ type: "tas_trace", count: 13 }), null);
  assert.equal(tasTraceToBridgeCommand({ type: "tas_trace", count: 1, start: -1 }), null);
  assert.equal(
    tasChunkToBridgeCommand({
      type: "tas_chunk",
      startIndex: 0,
      masks: [0x01, 0x00, 0x80],
      checksum: 0x00,
    }),
    null,
  );
});
