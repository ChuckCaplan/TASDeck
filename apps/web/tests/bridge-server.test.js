const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SerialBridge,
  decodeWebSocketFrame,
  fileTimestamp,
  formatTasTraceRowsForFile,
  handleWebSocketBuffer,
  isCandidateSerialDevice,
  parseArgs,
  parseTasSerialLine,
  parseTasTraceRows,
  serialPortSttyArgs,
  tasTraceStreamEnabled,
} = require("../../../scripts/bridge-server.js");
const { tasRunChecksum } = require("../src/tas.js");

function encodeMaskedWebSocketFrame(payload, options = {}) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const fin = options.fin ?? true;
  const opcode = options.opcode ?? 0x1;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const length = payloadBuffer.length;
  let header;

  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  const maskedPayload = Buffer.alloc(payloadBuffer.length);
  for (let index = 0; index < payloadBuffer.length; index += 1) {
    maskedPayload[index] = payloadBuffer[index] ^ mask[index % mask.length];
  }

  return Buffer.concat([header, mask, maskedPayload]);
}

test("detects likely Arduino USB serial devices", () => {
  assert.equal(isCandidateSerialDevice("cu.usbmodem1051DB36B9C82"), true);
  assert.equal(isCandidateSerialDevice("ttyACM0"), true);
  assert.equal(isCandidateSerialDevice("ttyUSB1"), true);
  assert.equal(isCandidateSerialDevice("cu.Bluetooth-Incoming-Port"), false);
  assert.equal(isCandidateSerialDevice("disk4"), false);
});

test("parses bridge server command line options", () => {
  assert.deepEqual(
    parseArgs(["--host", "127.0.0.1", "--port", "8765", "--serial-port", "/dev/cu.usbmodem1", "--no-open"], {}),
    {
      host: "127.0.0.1",
      port: 8765,
      openBrowser: false,
      serialPort: "/dev/cu.usbmodem1",
    },
  );
});

test("configures serial reads with a short timeout so close can complete", () => {
  const args = serialPortSttyArgs("/dev/cu.usbmodem-test");

  assert.deepEqual(args.slice(-4), ["min", "0", "time", "1"]);
});

test("keeps continuous TAS trace streaming opt-in", () => {
  assert.equal(tasTraceStreamEnabled({}), false);
  assert.equal(tasTraceStreamEnabled({ BRIDGE_TAS_TRACE_STREAM: "0" }), false);
  assert.equal(tasTraceStreamEnabled({ BRIDGE_TAS_TRACE_STREAM: "1" }), true);
});

test("closes the serial FileHandle after an unexpected read failure", async () => {
  const bridge = new SerialBridge();
  let closeCalls = 0;
  const handle = {
    async read() {
      throw new Error("USB disconnected");
    },
    async close() {
      closeCalls += 1;
    },
  };
  bridge.handle = handle;
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  await bridge.startReadLoop(handle);

  assert.equal(closeCalls, 1);
  assert.equal(bridge.handle, null);
  assert.equal(bridge.serialReady, false);
});

test("decodes masked browser WebSocket text frames", () => {
  const payload = Buffer.from(JSON.stringify({ type: "status" }));
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const frame = Buffer.alloc(2 + mask.length + payload.length);

  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);

  for (let index = 0; index < payload.length; index += 1) {
    frame[2 + mask.length + index] = payload[index] ^ mask[index % mask.length];
  }

  const decoded = decodeWebSocketFrame(frame);

  assert.equal(decoded.fin, true);
  assert.equal(decoded.opcode, 0x1);
  assert.equal(decoded.frameLength, frame.length);
  assert.equal(decoded.payload.toString("utf8"), payload.toString("utf8"));
});

test("formats file timestamps with the local timezone offset", () => {
  const easternDaylightTime = {
    getFullYear: () => 2026,
    getMonth: () => 6,
    getDate: () => 3,
    getHours: () => 21,
    getMinutes: () => 5,
    getSeconds: () => 1,
    getMilliseconds: () => 472,
    getTimezoneOffset: () => 240,
  };
  const indiaStandardTime = {
    getFullYear: () => 2026,
    getMonth: () => 0,
    getDate: () => 2,
    getHours: () => 3,
    getMinutes: () => 4,
    getSeconds: () => 5,
    getMilliseconds: () => 6,
    getTimezoneOffset: () => -330,
  };

  assert.equal(fileTimestamp(easternDaylightTime), "2026-07-03T21-05-01-472-0400");
  assert.equal(fileTimestamp(indiaStandardTime), "2026-01-02T03-04-05-006+0530");
});

test("saves browser event log snapshots", async () => {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-event-log-"));
  const bridge = new SerialBridge({ logDir });
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };

  try {
    await bridge.handleEventLogSave(client, {
      type: "save_event_log",
      requestId: "42",
      reason: "tas trace",
      metadata: {
        timestamp: "2026-07-03T20:39:34.149Z",
        tdmaskFileName: "lordtom,maru,tompav2-smb3-warps.tdmask",
        originalPolls: 72254,
        effectivePolls: 72252,
        skipPolls: 2,
        delayPolls: 0,
      },
      text: "NES Event Log\nLatest 2 / 120\n\n001 playback\nTAS trace captured 2 rows\n",
    });

    const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
    assert.equal(decoded.type, "event_log_saved");
    assert.equal(decoded.requestId, "42");
    assert.match(
      decoded.fileName,
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}[+-]\d{4}_lordtom,maru,tompav2-smb3-warps\.trace$/,
    );
    assert.equal(decoded.path, path.join(logDir, "trace", decoded.fileName));

    const saved = await fsp.readFile(path.join(logDir, "trace", decoded.fileName), "utf8");
    assert.match(saved, /^TASDeck Trace\n/);
    assert.match(saved, /tdmask_file: lordtom,maru,tompav2-smb3-warps\.tdmask\n/);
    assert.match(saved, /skip_polls: 2\n/);
    assert.match(saved, /effective_polls: 72252\n/);
    assert.match(saved, /\n\nNES Event Log\nLatest 2 \/ 120\n\n001 playback\nTAS trace captured 2 rows\n$/);
  } finally {
    await fsp.rm(logDir, { recursive: true, force: true });
  }
});

test("reassembles fragmented browser WebSocket TAS uploads", () => {
  const bridge = new SerialBridge();
  const socketWrites = [];
  const client = {
    buffer: Buffer.alloc(0),
    fragmentedMessage: null,
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = Array.from({ length: 62685 }, (_, index) => (index % 3 === 0 ? 0x01 : 0x00));
  const payload = Buffer.from(
    JSON.stringify({
      type: "tas_upload",
      fileName: "smb1 playaround2.fm2",
      frameCount: masks.length,
      inputFrameCount: masks.filter((mask) => mask !== 0).length,
      masks,
      checksum: tasRunChecksum(masks),
    }),
  );
  const firstSplit = 51000;
  const secondSplit = 102000;

  assert.equal(payload.length > 65535, true);

  bridge.addClient(client);
  client.buffer = Buffer.concat([
    encodeMaskedWebSocketFrame(payload.subarray(0, firstSplit), { fin: false, opcode: 0x1 }),
    encodeMaskedWebSocketFrame(payload.subarray(firstSplit, secondSplit), { fin: false, opcode: 0x0 }),
    encodeMaskedWebSocketFrame(payload.subarray(secondSplit), { fin: true, opcode: 0x0 }),
  ]);

  handleWebSocketBuffer(client, bridge);

  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(client.socket.destroyed, false);
  assert.equal(decoded.type, "tas_status");
  assert.equal(decoded.command, "tas_upload");
  assert.equal(decoded.total, masks.length);
  assert.equal(decoded.file_name, "smb1 playaround2.fm2");
  assert.equal(bridge.activeTasRun.frameCount, masks.length);
});

test("closes WebSocket clients and clears held buttons on server shutdown", () => {
  const bridge = new SerialBridge();
  const socketCalls = [];
  const client = {
    heldButtons: new Set(["1:a"]),
    socket: {
      destroyed: false,
      destroy() {
        socketCalls.push("destroy");
        this.destroyed = true;
      },
      end(frame) {
        socketCalls.push(frame);
      },
      write(frame) {
        socketCalls.push(frame);
      },
    },
  };

  bridge.addClient(client);
  bridge.buttonHolders.get("1:a").add(client);
  bridge.closeClients();

  assert.equal(bridge.clients.size, 0);
  assert.equal(client.heldButtons.size, 0);
  assert.equal(bridge.buttonHolders.get("1:a").size, 0);
  assert.equal(client.socket.destroyed, true);
  assert.equal(socketCalls.includes("destroy"), true);
});

test("releases held player two buttons when a client disconnects", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const client = {
    heldButtons: new Set(["2:a"]),
    socket: {
      destroyed: false,
      write() {},
    },
  };

  bridge.handle = {
    async write(command) {
      writes.push(command);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.buttonHolders.get("2:a").add(client);

  await bridge.releaseClientButtons(client, "disconnect");

  assert.deepEqual(writes, ["BUTTON 2 a up\n"]);
  assert.equal(client.heldButtons.size, 0);
  assert.equal(bridge.buttonHolders.get("2:a").size, 0);
});

test("waits for firmware status before reporting serial connected", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  bridge.handle = {
    async write(command) {
      writes.push(command);
      globalThis.setTimeout(() => {
        bridge.handleSerialBytes(Buffer.from("TASDeck Uno R4 serial bridge ready\nOK status fw=test\n"));
      }, 0);
    },
  };

  assert.equal(bridge.isConnected(), false);
  await bridge.requestFirmwareStatus(200);

  assert.deepEqual(writes, ["STATUS\n"]);
  assert.equal(bridge.isConnected(), false);
});

test("formats TAS serial commands from bridge messages", () => {
  const bridge = new SerialBridge();

  assert.equal(
    bridge.commandForTasMessage({ type: "tas_begin", frameCount: 81, syncMode: "poll" }),
    "TAS_BEGIN 81 poll",
  );
  assert.equal(
    bridge.commandForTasMessage({ type: "tas_begin", frameCount: 81, syncMode: "poll", portCount: 2 }),
    "TAS_BEGIN 81 poll 2",
  );
  assert.equal(
    bridge.commandForTasMessage({ type: "tas_begin", frameCount: 81, syncMode: "latch" }),
    "TAS_BEGIN 81 latch",
  );
  assert.equal(
    bridge.commandForTasMessage({
      type: "tas_begin",
      frameCount: 81,
      syncMode: "frame",
    }),
    null,
  );
  assert.equal(
    bridge.commandForTasMessage({
      type: "tas_chunk",
      startIndex: 0,
      masks: [0x01, 0x00, 0x80],
      checksum: 0x82,
    }),
    "TAS_CHUNK 0 3 010080 82",
  );
  assert.equal(
    bridge.commandForTasMessage({
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
  assert.equal(bridge.commandForTasMessage({ type: "tas_cancel" }), "TAS_CANCEL");
  assert.equal(bridge.commandForTasMessage({ type: "tas_end" }), "TAS_END");
  assert.equal(bridge.commandForTasMessage({ type: "tas_start" }), "TAS_START");
  assert.equal(bridge.commandForTasMessage({ type: "tas_start", delayPolls: 12 }), "TAS_START 12");
  assert.equal(bridge.commandForTasMessage({ type: "tas_status" }), "TAS_STATUS");
  assert.equal(bridge.commandForTasMessage({ type: "tas_trace" }), "TAS_TRACE 12");
  assert.equal(bridge.commandForTasMessage({ type: "tas_trace", count: 4, start: 120 }), "TAS_TRACE 4 120");
  assert.equal(
    bridge.commandForTasMessage({
      type: "tas_chunk",
      startIndex: 0,
      masks: [0x01, 0x00, 0x80],
      checksum: 0x00,
    }),
    null,
  );
});

test("dumps TAS trace rows through the bridge", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=4 capacity=192 first=10 next=14 page_start=13 page_next=14 count=1 rows=13,400,13,8,64,8,80,00,80,8,ok,80\n",
            ),
          );
          return;
        }

        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_trace total=4 capacity=192 first=10 next=14 page_start=11 page_next=14 count=3 rows=11,200,11,4,32,8,01,00,01,8,ok,01|12,300,12,6,48,8,00,80,00,8,ok,00|13,400,13,8,64,8,80,00,80,8,ok,80\n",
          ),
        );
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  await bridge.handleClientTasMessage(client, { type: "tas_trace", count: 3 });

  assert.deepEqual(writes, ["TAS_TRACE 1\n", "TAS_TRACE 3 11\n"]);
  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.type, "tas_trace");
  assert.equal(decoded.count, 3);
  assert.equal(decoded.start, 11);
  assert.deepEqual(decoded.rows.map((row) => row.sequence), [11, 12, 13]);
  assert.deepEqual(decoded.rows.map((row) => row.polledMask), [0x01, 0x00, 0x80]);
  assert.deepEqual(decoded.rows.map((row) => row.clockedMask), [0x01, 0x00, 0x80]);
});

test("reports clipped and duplicate TAS trace rows", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=5 capacity=192 first=10 next=15 page_start=14 page_next=15 count=1 rows=14,500,14,10,80,8,02,02,02,8,ok,02,04\n",
            ),
          );
          return;
        }

        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_trace total=5 capacity=192 first=10 next=15 page_start=12 page_next=15 count=4 rows=12,300,12,6,48,8,00,00,00,8,ok,00,02|13,400,13,8,64,8,80,80,80,8,ok,80,02|13,400,13,8,64,8,80,80,80,8,ok,80,02|14,500,14,10,80,8,02,02,02,8,ok,02,04\n",
          ),
        );
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  await bridge.handleClientTasMessage(client, { type: "tas_trace", count: 4 });

  assert.deepEqual(writes, ["TAS_TRACE 1\n", "TAS_TRACE 4 11\n"]);
  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.type, "tas_trace");
  assert.equal(decoded.count, 3);
  assert.equal(decoded.start, 11);
  assert.equal(decoded.clipped, 1);
  assert.equal(decoded.duplicates, 1);
  assert.deepEqual(decoded.rows.map((row) => row.sequence), [12, 13, 14]);
  assert.deepEqual(decoded.rows.map((row) => row.diag), [0x02, 0x02, 0x04]);
});

test("saves manual TAS trace dumps as timestamped CSV files", async () => {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-manual-trace-"));
  const bridge = new SerialBridge({ logDir });
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };

  bridge.handle = {
    async write(command) {
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=3 capacity=192 first=10 next=13 page_start=12 page_next=13 count=1 rows=12,300,12,6,48,8,00,80,00,8,ok,00,02\n",
            ),
          );
          return;
        }

        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_trace total=3 capacity=192 first=10 next=13 page_start=10 page_next=13 count=3 rows=10,100,10,2,16,8,01,00,01,8,ok,01,03|11,200,11,4,32,8,00,80,00,8,ok,00,02|12,300,12,6,48,8,00,80,00,8,ok,00,02\n",
          ),
        );
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.activeTasRun = {
    id: 7,
    clientRunId: 7,
    fileName: "manual-test.tdmask",
    skipPolls: 0,
    originalFrameCount: 3,
    frameCount: 3,
    state: "streaming",
    firmwareStatus: { trace_frozen: 0, anomaly_count: 0 },
  };

  await bridge.handleClientTasMessage(client, { type: "tas_trace", count: 3 });

  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.type, "tas_trace");
  assert.ok(decoded.saved_path, "manual dump should report a saved file path");
  const traceDir = path.join(logDir, "trace");
  const files = await fsp.readdir(traceDir);
  assert.equal(files.length, 1);
  const contents = await fsp.readFile(path.join(traceDir, files[0]), "utf8");
  assert.match(contents, /manual_trace_dump: 1/);
  assert.match(contents, /sequence,timestampMicros,tasFrame/);
  assert.match(contents, /^10,100,10,2,16,8,01,00,01,8,ok,01,03(?:,.*)?$/m);
  await fsp.rm(logDir, { recursive: true, force: true });
});

test("collects TAS trace rows forward from a cursor and counts overwritten rows as gaps", async () => {
  const bridge = new SerialBridge();
  const writes = [];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=4 capacity=192 first=10 next=14 page_start=13 page_next=14 count=1 rows=13,400,13,8,64,8,80,00,80,8,ok,80,02\n",
            ),
          );
          return;
        }

        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_trace total=4 capacity=192 first=10 next=14 page_start=10 page_next=14 count=4 rows=10,100,10,2,16,8,01,00,01,8,ok,01,03|11,200,11,4,32,8,00,80,00,8,ok,00,02|12,300,12,6,48,8,00,80,00,8,ok,00,02|13,400,13,8,64,8,80,00,80,8,ok,80,02\n",
          ),
        );
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  const dump = await bridge.collectTasTraceRowsFrom(8, 16);

  assert.deepEqual(writes, ["TAS_TRACE 1\n", "TAS_TRACE 4 10\n"]);
  assert.equal(dump.clippedRows, 2);
  assert.equal(dump.cursor, 14);
  assert.equal(dump.next, 14);
  assert.deepEqual(dump.rows.map((row) => row.sequence), [10, 11, 12, 13]);
});

test("streams TAS trace rows to a per-run CSV with a final drain", async () => {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-stream-trace-"));
  const bridge = new SerialBridge({ logDir });

  bridge.handle = {
    async write(command) {
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=3 capacity=192 first=0 next=3 page_start=2 page_next=3 count=1 rows=2,300,2,6,48,8,80,00,80,8,ok,80,02\n",
            ),
          );
          return;
        }

        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_trace total=3 capacity=192 first=0 next=3 page_start=0 page_next=3 count=3 rows=0,100,0,2,16,8,01,00,01,8,ok,01,03|1,200,1,4,32,8,00,80,00,8,ok,00,02|2,300,2,6,48,8,80,00,80,8,ok,80,02\n",
          ),
        );
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  const run = {
    id: 3,
    clientRunId: 3,
    fileName: "stream-test.tdmask",
    skipPolls: 0,
    originalFrameCount: 3,
    frameCount: 3,
    nextFrameIndex: 3,
    state: "complete",
    stopped: false,
    paused: false,
    uploadEnded: true,
    firmwareStatus: { trace_frozen: 0 },
    traceStreamTask: null,
  };
  bridge.activeTasRun = run;

  run.traceStreamTask = bridge.streamTasTraceRows(run);
  await run.traceStreamTask;

  const traceDir = path.join(logDir, "trace");
  const files = await fsp.readdir(traceDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.stream\.csv$/);
  const contents = await fsp.readFile(path.join(traceDir, files[0]), "utf8");
  assert.match(contents, /# tasdeck trace stream v1/);
  assert.match(contents, /sequence,timestampMicros,tasFrame/);
  assert.match(contents, /^0,100,0,2,16,8,01,00,01,8,ok,01,03(?:,.*)?$/m);
  assert.match(contents, /^2,300,2,6,48,8,80,00,80,8,ok,80,02(?:,.*)?$/m);
  assert.match(contents, /# end: rows=3 gaps=0/);
  await fsp.rm(logDir, { recursive: true, force: true });
});

test("auto-saves frozen TAS trace rows and rearms firmware capture", async () => {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-auto-trace-"));
  const bridge = new SerialBridge({ logDir });
  const writes = [];
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      globalThis.setTimeout(() => {
        if (trimmed === "TAS_TRACE 1") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=2 capacity=512 first=10 next=12 page_start=11 page_next=12 count=1 rows=11,200,9,4,24,8,00,80,00,8,ok,00,02\n",
            ),
          );
          return;
        }

        if (trimmed === "TAS_TRACE 2 10") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace total=2 capacity=512 first=10 next=12 page_start=10 page_next=12 count=2 rows=10,100,8,2,16,8,01,00,01,8,ok,01,12|11,200,9,4,24,8,00,80,00,8,ok,00,02\n",
            ),
          );
          return;
        }

        if (trimmed === "TAS_TRACE_RESUME") {
          bridge.handleSerialBytes(
            Buffer.from(
              "OK tas_trace_resume active=1 ready=1 started=1 complete=0 current=9 total=3 received=3 buffered=2 capacity=512 error=ok anomaly_count=0 anomaly_seq=0 anomaly_kind=0 trace_frozen=0\n",
            ),
          );
        }
      }, 0);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.addClient(client);
  await bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.tdmask",
    frameCount: masks.length,
    inputFrameCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });

  const run = bridge.activeTasRun;
  bridge.markTasRunStarted(run);
  bridge.applyTasFirmwareStatus(
    run,
    {
      type: "tas_status",
      command: "tas_status",
      active: 1,
      ready: 1,
      started: 1,
      complete: 0,
      current: 9,
      total: 3,
      received: 3,
      buffered: 2,
      capacity: 512,
      error: "ok",
      anomaly_count: 1,
      anomaly_seq: 10,
      anomaly_kind: 2,
      trace_frozen: 1,
    },
    "tas_status",
  );

  await run.traceDumpTask;

  assert.deepEqual(writes, ["TAS_TRACE 1\n", "TAS_TRACE 2 10\n", "TAS_TRACE_RESUME\n"]);
  assert.equal(run.firmwareStatus.trace_frozen, 0);
  assert.equal(run.firmwareStatus.anomaly_count, 0);
  const files = await fsp.readdir(path.join(logDir, "trace"));
  assert.equal(files.length, 1);
  assert.match(files[0], /_run\.trace$/);
  const saved = await fsp.readFile(path.join(logDir, "trace", files[0]), "utf8");
  assert.match(saved, /auto_trace_dump: 1\n/);
  assert.match(saved, /trigger_anomaly_seq: 10\n/);
  assert.match(saved, /sequence,timestampMicros,tasFrame,latchCount,clockCount/);
  assert.match(saved, /10,100,8,2,16,8,01,00,01,8,ok,01,12/);

  const decoded = socketWrites
    .map((frame) => JSON.parse(decodeWebSocketFrame(frame).payload.toString("utf8")))
    .filter((message) => message.type === "tas_status")
    .at(-1);
  assert.equal(decoded.command, "tas_trace_resume");
  assert.equal(decoded.trace_frozen, 0);

  await fsp.rm(logDir, { recursive: true, force: true });
});

test("does not release manual buttons before arming hardware TAS playback", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const client = {
    heldButtons: new Set(["1:a"]),
    socket: {
      destroyed: false,
      write() {},
    },
  };

  bridge.handle = {
    async write(command) {
      writes.push(command);
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.addClient(client);
  bridge.buttonHolders.get("1:a").add(client);

  await bridge.handleClientTasMessage(client, {
    type: "tas_begin",
    frameCount: 3,
    syncMode: "poll",
  });

  assert.deepEqual(writes, ["TAS_BEGIN 3 poll\n"]);
  assert.equal(client.heldButtons.size, 1);
  assert.equal(bridge.buttonHolders.get("1:a").size, 1);
});

test("stores validated TAS uploads on the bridge", () => {
  const bridge = new SerialBridge();
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.addClient(client);
  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.fm2",
    frameCount: masks.length,
    inputFrameCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });

  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.type, "tas_status");
  assert.equal(decoded.command, "tas_upload");
  assert.equal(decoded.bridge_owned, 1);
  assert.equal(decoded.bridge_state, "uploaded");
  assert.equal(decoded.total, 3);
  assert.equal(decoded.original_total, 3);
  assert.equal(decoded.skip_polls, 0);
  assert.equal(decoded.port_count, 1);
  assert.equal(decoded.sync, "poll");
  assert.equal(decoded.file_name, "run.fm2");
});

test("bridge-owned TAS arm preserves latch synchronization", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const client = {
    heldButtons: new Set(),
    socket: { destroyed: false, write() {} },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      if (trimmed === "TAS_BEGIN 3 latch") {
        bridge.handleSerialBytes(Buffer.from("OK tas_begin active=1 ready=0 current=0 total=3 received=0 buffered=0 capacity=512 ports=1 sync=latch error=ok\n"));
      } else if (trimmed.startsWith("TAS_CHUNK")) {
        bridge.handleSerialBytes(Buffer.from("OK tas_chunk active=1 ready=1 current=0 total=3 received=3 buffered=3 capacity=512 ports=1 sync=latch error=ok\n"));
      } else if (trimmed === "TAS_END") {
        bridge.handleSerialBytes(Buffer.from("OK tas_end active=1 ready=1 receiving_complete=1 current=0 total=3 received=3 buffered=3 capacity=512 ports=1 sync=latch error=ok\n"));
      }
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.tdmask",
    frameCount: masks.length,
    inputFrameCount: 2,
    syncMode: "latch",
    masks,
    checksum: tasRunChecksum(masks),
  });
  assert.equal(bridge.activeTasRun.syncMode, "latch");

  await bridge.handleClientTasMessage(client, { type: "tas_arm" });
  assert.equal(writes[0], "TAS_BEGIN 3 latch\n");
});

test("bridge-owned TAS upload streams two-controller masks", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write() {},
    },
  };
  const masks = [
    { p1: 0x01, p2: 0x02 },
    { p1: 0x00, p2: 0x00 },
    { p1: 0x80, p2: 0x08 },
  ];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      if (trimmed === "TAS_BEGIN 3 poll 2") {
        bridge.handleSerialBytes(Buffer.from("OK tas_begin active=1 ready=0 current=0 total=3 received=0 buffered=0 capacity=512 ports=2 sync=poll error=ok\n"));
      } else if (trimmed.startsWith("TAS_CHUNK")) {
        bridge.handleSerialBytes(Buffer.from("OK tas_chunk active=1 ready=1 current=0 total=3 received=3 buffered=3 capacity=512 ports=2 sync=poll error=ok\n"));
      } else if (trimmed === "TAS_END") {
        bridge.handleSerialBytes(Buffer.from("OK tas_end active=1 ready=1 receiving_complete=1 current=0 total=3 received=3 buffered=3 capacity=512 ports=2 sync=poll error=ok\n"));
      }
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "two-player.tdmask",
    frameCount: masks.length,
    inputFrameCount: 2,
    portCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });
  assert.equal(bridge.activeTasRun.portCount, 2);

  await bridge.handleClientTasMessage(client, { type: "tas_arm" });

  assert.equal(writes[0], "TAS_BEGIN 3 poll 2\n");
  assert.equal(writes.includes("TAS_CHUNK 0 3 2 010200008008 8A\n"), true);
  assert.equal(writes.includes("TAS_END\n"), true);
});

test("bridge skips initial TAS poll masks before streaming to firmware", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      if (trimmed === "TAS_BEGIN 2 poll") {
        bridge.handleSerialBytes(Buffer.from("OK tas_begin active=1 ready=0 current=0 total=2 received=0 buffered=0 capacity=512 sync=poll error=ok\n"));
      } else if (trimmed.startsWith("TAS_CHUNK")) {
        bridge.handleSerialBytes(Buffer.from("OK tas_chunk active=1 ready=1 current=0 total=2 received=2 buffered=2 capacity=512 sync=poll error=ok\n"));
      } else if (trimmed === "TAS_END") {
        bridge.handleSerialBytes(Buffer.from("OK tas_end active=1 ready=1 receiving_complete=1 current=0 total=2 received=2 buffered=2 capacity=512 sync=poll error=ok\n"));
      }
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.addClient(client);

  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.tdmask",
    frameCount: masks.length,
    inputFrameCount: 2,
    skipPolls: 1,
    masks,
    checksum: tasRunChecksum(masks),
  });
  await bridge.handleClientTasMessage(client, { type: "tas_arm" });

  const uploadStatus = socketWrites
    .map((frame) => JSON.parse(decodeWebSocketFrame(frame).payload.toString("utf8")))
    .find((message) => message.type === "tas_status" && message.command === "tas_upload");
  assert.equal(uploadStatus.total, 2);
  assert.equal(uploadStatus.original_total, 3);
  assert.equal(uploadStatus.skip_polls, 1);
  assert.equal(writes[0], "TAS_BEGIN 2 poll\n");
  assert.match(writes.join(""), /TAS_CHUNK 0 2 0080 [0-9A-F]{2}\n/);
});

test("rejects malformed TAS uploads on the bridge", () => {
  const bridge = new SerialBridge();
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };

  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "bad.fm2",
    frameCount: 2,
    masks: [0x01, 0x02],
    checksum: 0x00,
  });

  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.type, "tas_error");
  assert.equal(decoded.command, "tas_upload");
});

test("bridge-owned TAS arm streams prebuffer chunks to firmware", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write() {},
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      const trimmed = command.trim();
      if (trimmed === "TAS_BEGIN 3 poll") {
        bridge.handleSerialBytes(Buffer.from("OK tas_begin active=1 ready=0 current=0 total=3 received=0 buffered=0 capacity=512 sync=poll error=ok\n"));
      } else if (trimmed.startsWith("TAS_CHUNK")) {
        bridge.handleSerialBytes(Buffer.from("OK tas_chunk active=1 ready=1 current=0 total=3 received=3 buffered=3 capacity=512 sync=poll error=ok\n"));
      } else if (trimmed === "TAS_END") {
        bridge.handleSerialBytes(Buffer.from("OK tas_end active=1 ready=1 receiving_complete=1 current=0 total=3 received=3 buffered=3 capacity=512 sync=poll error=ok\n"));
      }
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;

  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.fm2",
    frameCount: masks.length,
    inputFrameCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });
  await bridge.handleClientTasMessage(client, { type: "tas_arm" });

  assert.equal(writes.some((command) => command.startsWith("BUTTON ")), false);
  assert.equal(writes[0], "TAS_BEGIN 3 poll\n");
  assert.equal(writes.includes("TAS_BEGIN 3 poll\n"), true);
  assert.equal(writes.includes("TAS_CHUNK 0 3 010080 82\n"), true);
  assert.equal(writes.includes("TAS_END\n"), true);
});

test("bridge-owned TAS completion overrides streaming state", async () => {
  const bridge = new SerialBridge();
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.addClient(client);
  await bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.fm2",
    frameCount: masks.length,
    inputFrameCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });

  const run = bridge.activeTasRun;
  bridge.markTasRunStarted(run);
  bridge.applyTasFirmwareStatus(
    run,
    {
      type: "tas_status",
      command: "tas_status",
      active: 0,
      ready: 0,
      started: 1,
      complete: 1,
      current: 3,
      total: 3,
      received: 3,
      buffered: 0,
      capacity: 512,
      error: "ok",
    },
    "tas_status",
  );

  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(run.state, "complete");
  assert.equal(decoded.bridge_state, "complete");
  assert.equal(decoded.complete, 1);
  assert.equal(decoded.active, 0);
});

test("bridge-owned TAS cancel reaches firmware after start request", async () => {
  const bridge = new SerialBridge();
  const writes = [];
  const socketWrites = [];
  const client = {
    heldButtons: new Set(),
    socket: {
      destroyed: false,
      write(frame) {
        socketWrites.push(frame);
      },
    },
  };
  const masks = [0x01, 0x00, 0x80];

  bridge.handle = {
    async write(command) {
      writes.push(command);
      if (command.trim() === "TAS_CANCEL") {
        bridge.handleSerialBytes(
          Buffer.from(
            "OK tas_cancel active=0 ready=0 start_requested=0 started=0 complete=0 current=0 total=3 received=3 buffered=0 capacity=512 sync=poll error=ok\n",
          ),
        );
      }
    },
  };
  bridge.portPath = "/dev/cu.usbmodem-test";
  bridge.serialReady = true;
  bridge.addClient(client);
  bridge.handleClientTasMessage(client, {
    type: "tas_upload",
    fileName: "run.fm2",
    frameCount: masks.length,
    inputFrameCount: 2,
    masks,
    checksum: tasRunChecksum(masks),
  });

  const run = bridge.activeTasRun;
  bridge.markTasRunStarted(run);
  run.firmwareStatus = {
    start_requested: 1,
    started: 0,
    complete: 0,
    current: 0,
    total: 3,
    received: 3,
    buffered: 3,
    capacity: 512,
    error: "ok",
  };

  await bridge.handleClientTasMessage(client, { type: "tas_cancel" });

  assert.equal(writes.includes("TAS_CANCEL\n"), true);
  const decoded = JSON.parse(decodeWebSocketFrame(socketWrites.at(-1)).payload.toString("utf8"));
  assert.equal(decoded.command, "tas_cancel");
  assert.equal(decoded.bridge_state, "stopped");
  assert.equal(decoded.active, 0);
});

test("parses structured TAS firmware status and errors", () => {
  assert.deepEqual(parseTasSerialLine("OK tas_chunk active=1 ready=1 start_requested=0 current=12 total=81 buffered=64 mask=0A start_delay_polls=2 latch=120 clock=960 error=ok"), {
    type: "tas_status",
    command: "tas_chunk",
    message: "OK tas_chunk active=1 ready=1 start_requested=0 current=12 total=81 buffered=64 mask=0A start_delay_polls=2 latch=120 clock=960 error=ok",
    active: 1,
    ready: 1,
    start_requested: 0,
    current: 12,
    total: 81,
    buffered: 64,
    mask: 10,
    start_delay_polls: 2,
    latch: 120,
    clock: 960,
    error: "ok",
  });

  assert.deepEqual(parseTasSerialLine("OK tas_status current=80 buffered=10 mask=80 pressed=10 latched=40"), {
    type: "tas_status",
    command: "tas_status",
    message: "OK tas_status current=80 buffered=10 mask=80 pressed=10 latched=40",
    current: 80,
    buffered: 10,
    mask: 128,
    pressed: 16,
    latched: 64,
  });

  assert.deepEqual(parseTasSerialLine("OK tas_status ports=2 mask=80 mask2=08 pressed=10 pressed2=02 latched=40 latched2=08 clock=960 clock2=944"), {
    type: "tas_status",
    command: "tas_status",
    message: "OK tas_status ports=2 mask=80 mask2=08 pressed=10 pressed2=02 latched=40 latched2=08 clock=960 clock2=944",
    ports: 2,
    mask: 128,
    mask2: 8,
    pressed: 16,
    pressed2: 2,
    latched: 64,
    latched2: 8,
    clock: 960,
    clock2: 944,
  });

  assert.deepEqual(parseTasSerialLine("OK tas_trace_resume active=1 trace_frozen=0 anomaly_count=0"), {
    type: "tas_status",
    command: "tas_trace_resume",
    message: "OK tas_trace_resume active=1 trace_frozen=0 anomaly_count=0",
    active: 1,
    trace_frozen: 0,
    anomaly_count: 0,
  });

  assert.deepEqual(
    parseTasSerialLine(
      "OK tas_trace total=2 capacity=192 first=10 next=12 page_start=10 page_next=12 count=2 rows=10,100,8,2,16,8,01,00,01,8,ok|11,200,9,4,24,8,00,80,00,8,complete",
    ),
    {
      type: "tas_trace",
      command: "tas_trace",
      message:
        "OK tas_trace total=2 capacity=192 first=10 next=12 page_start=10 page_next=12 count=2 rows=10,100,8,2,16,8,01,00,01,8,ok|11,200,9,4,24,8,00,80,00,8,complete",
      total: 2,
      capacity: 192,
      first: 10,
      next: 12,
      page_start: 10,
      page_next: 12,
      count: 2,
      rows: "10,100,8,2,16,8,01,00,01,8,ok|11,200,9,4,24,8,00,80,00,8,complete",
    },
  );

  assert.deepEqual(parseTasSerialLine("ERR tas_overflow command=tas_chunk"), {
    type: "tas_error",
    error: "tas_overflow",
    message: "ERR tas_overflow command=tas_chunk",
    command: "tas_chunk",
  });

  assert.equal(parseTasSerialLine("OK button a up"), null);
});

test("parses and formats the per-port TAS trace row schema", () => {
  const raw = "10,100,8,2,16,8,01,02,01,8,ok,01,03,2";
  const rows = parseTasTraceRows(raw);

  assert.deepEqual(rows, [
    {
      sequence: 10,
      timestampMicros: 100,
      tasFrame: 8,
      latchCount: 2,
      clockCount: 16,
      clocksSinceLatch: 8,
      polledMask: 0x01,
      nextMask: 0x02,
      latchedMask: 0x01,
      shiftIndex: 8,
      result: "ok",
      clockedMask: 0x01,
      diag: 0x03,
      port: 2,
      raw,
    },
  ]);

  assert.equal(
    formatTasTraceRowsForFile(rows),
    [
      "sequence,timestampMicros,tasFrame,latchCount,clockCount,clocksSinceLatch,polledMask,nextMask,latchedMask,shiftIndex,result,clockedMask,diag,port",
      raw,
    ].join("\n"),
  );
});

test("parses legacy trace rows without a port column", () => {
  const rows = parseTasTraceRows("10,100,8,2,16,8,01,02,01,8,ok,01,03");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].port, null);
  assert.equal(rows[0].diag, 0x03);
});
