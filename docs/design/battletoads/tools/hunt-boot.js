#!/usr/bin/env node
"use strict";

// Power-cycles the NES through a TP-Link Kasa smart plug until a Battletoads boot
// gets an accepted watch-boot.js verdict, then lets that run play out.
// Each attempt: cancel the previous run, power off, re-upload, arm, and start the
// .r08 while the console is off, power on, and classify the bridge's Boot timing
// line. Re-uploading every attempt matters: the bridge captures Boot timing once
// per uploaded run. Nothing is armed during the off time, so the operator can press
// the Arduino's RESET button then after a rejected boot without wiping the run.
// Requires `npm start` with the Arduino connected; close the web UI tab so it does
// not act on the runs this script drives.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  parseTasFileBytes,
  tasFramesToMasks,
  tasMaskHasInput,
  tasMasksPortCount,
  tasMasksToWire,
  tasRunChecksum,
} = require("../../../../apps/web/src/tas.js");
const { classifyBootLine, createLogReader, formatVerdict } = require("./watch-boot.js");

const DEFAULT_LOG = path.resolve(__dirname, "../../../../logs/trace/boot-timing.log");
const HUNT_LOG = path.resolve(__dirname, "../../../../logs/trace/boot-hunt.log");
const DEFAULTS = {
  plugHost: process.env.TASDECK_PLUG_HOST || "",
  bridge: "ws://localhost:8000/bridge",
  delay: null,
  offSeconds: 10,
  bootTimeoutSeconds: 60,
  maxAttempts: 50,
  accept: ["GOOD"],
  log: DEFAULT_LOG,
};
// Consecutive attempts with no Boot timing line before giving up: the console is
// probably not booting (cartridge seating, plug, or Arduino wiring).
const MAX_SILENT_BOOTS = 3;

const { WebSocket } = globalThis;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(text) {
  console.log(`${new Date().toLocaleTimeString()} ${text}`);
}

// Kasa legacy local protocol (HS103 firmware 1.0.x): TCP 9999, 4-byte length
// prefix, autokey XOR starting at 171. No cloud and no credentials.
function kasaEncode(text) {
  const bytes = Buffer.from(text);
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(bytes.length);
  let key = 171;
  bytes.forEach((byte, index) => {
    key ^= byte;
    out[4 + index] = key;
  });
  return out;
}

function kasaDecode(bytes) {
  let key = 171;
  return Buffer.from(bytes.map((byte) => {
    const plain = key ^ byte;
    key = byte;
    return plain;
  })).toString();
}

function setPlugOnce(host, on) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ system: { set_relay_state: { state: on ? 1 : 0 } } });
    const socket = net.connect(9999, host, () => socket.write(kasaEncode(request)));
    let buffer = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error(`smart plug ${host} timed out`)));
    socket.on("error", reject);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) {
        return;
      }
      socket.end();
      try {
        const reply = JSON.parse(kasaDecode(buffer.subarray(4, 4 + buffer.readUInt32BE(0))));
        const code = reply.system?.set_relay_state?.err_code;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`smart plug refused the switch: ${JSON.stringify(reply)}`));
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function setPlug(host, on) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await setPlugOnce(host, on);
      return;
    } catch (error) {
      if (attempt >= 3) {
        throw new Error(`could not switch the plug ${on ? "on" : "off"}: ${error.message}`);
      }
      await sleep(1000);
    }
  }
}

class BridgeClient {
  constructor(url) {
    this.url = url;
    this.waiters = new Set();
    this.listeners = new Set();
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => {
        reject(new Error(`cannot reach the bridge at ${this.url}; is npm start running?`));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.dispatch(message);
      });
      socket.addEventListener("close", () => {
        for (const waiter of [...this.waiters]) {
          waiter.settle(waiter.reject, new Error("bridge WebSocket closed"));
        }
      });
    });
  }

  dispatch(message) {
    this.listeners.forEach((listener) => listener(message));
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        waiter.settle(waiter.resolve, message);
      } else if (message.type === "error" || message.type === "tas_error") {
        waiter.settle(waiter.reject, new Error(`${waiter.label}: ${message.message || JSON.stringify(message)}`));
      }
    }
  }

  waitFor(predicate, label, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, resolve, reject };
      const timer = timeoutMs > 0
        ? setTimeout(() => waiter.settle(reject, new Error(`timed out waiting for ${label}`)), timeoutMs)
        : null;
      waiter.settle = (fn, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        fn(value);
      };
      this.waiters.add(waiter);
    });
  }

  request(message, predicate, label = message.type, timeoutMs = 30000) {
    const reply = this.waitFor(predicate, label, timeoutMs);
    this.socket.send(JSON.stringify(message));
    return reply;
  }

  close() {
    this.socket?.close();
  }
}

async function connectArduino(bridge) {
  const status = await bridge.request({ type: "status" }, (message) => message.type === "status", "bridge status");
  if (status.serialConnected) {
    return status;
  }
  return bridge.request(
    { type: "connect" },
    (message) => message.type === "status" && message.serialConnected,
    "Arduino connect",
    20000,
  );
}

function notify(text) {
  process.stdout.write("\x07");
  execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "TASDeck boot hunt"`], () => {});
}

function appendHuntLog(fields) {
  try {
    fs.mkdirSync(path.dirname(HUNT_LOG), { recursive: true });
    fs.appendFileSync(HUNT_LOG, `${[new Date().toISOString(), ...fields].join("\t")}\n`);
  } catch {}
}

function loadUpload(filePath) {
  const fileName = path.basename(filePath);
  const parsed = parseTasFileBytes(fileName, fs.readFileSync(filePath));
  if (parsed.format !== "r08") {
    throw new Error("this hunt only drives .r08 files (per-strobe playback)");
  }
  const masks = tasFramesToMasks(parsed.frames);
  const portCount = tasMasksPortCount(masks);
  if (portCount !== 2) {
    throw new Error(`expected a two-port .r08, got ${portCount} port(s)`);
  }
  return {
    type: "tas_upload",
    fileName,
    syncMode: "strobe",
    skipPolls: 0,
    portCount,
    frameCount: masks.length,
    inputFrameCount: masks.filter(tasMaskHasInput).length,
    masks: tasMasksToWire(masks, portCount),
    checksum: tasRunChecksum(masks, portCount),
  };
}

async function waitForBootVerdict(readNewLines, fileName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of readNewLines()) {
      const result = classifyBootLine(line);
      if (result && result.movie === fileName) {
        return result;
      }
    }
    await sleep(250);
  }
  return null;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const valueOf = (index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argv[index]}`);
    }
    return value;
  };
  const positiveNumber = (text, name) => {
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
    } else if (arg === "--plug") {
      options.plugHost = valueOf(index++);
    } else if (arg === "--bridge") {
      options.bridge = valueOf(index++);
    } else if (arg === "--delay") {
      options.delay = positiveNumber(valueOf(index++), "--delay");
    } else if (arg === "--off-seconds") {
      options.offSeconds = positiveNumber(valueOf(index++), "--off-seconds");
    } else if (arg === "--boot-timeout") {
      options.bootTimeoutSeconds = positiveNumber(valueOf(index++), "--boot-timeout");
    } else if (arg === "--max-attempts") {
      options.maxAttempts = positiveNumber(valueOf(index++), "--max-attempts");
    } else if (arg === "--accept") {
      options.accept = valueOf(index++).toUpperCase().split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--log") {
      options.log = path.resolve(valueOf(index++));
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!options.file) {
      options.file = path.resolve(arg);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

const USAGE = `Usage: node docs/design/battletoads/tools/hunt-boot.js FILE.r08 [options]
  --accept GOOD[,MAYBE]   verdicts that get played out (default GOOD)
  --delay N               Start delay in strobes (default 4 for GEG files, else 1)
  --off-seconds N         power-off time before each boot (default 10)
  --boot-timeout N        seconds to wait for Boot timing after power-on (default 60)
  --max-attempts N        stop after this many boots (default 50)
  --plug HOST             Kasa smart plug address (or set TASDECK_PLUG_HOST)
  --bridge URL            bridge WebSocket (default ws://localhost:8000/bridge)
Requires npm start. Close the web UI tab while it runs. Ctrl+C cancels the run.`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.file) {
    console.log(USAGE);
    return;
  }
  if (!options.plugHost) {
    throw new Error("no smart plug address: pass --plug HOST or set TASDECK_PLUG_HOST");
  }
  const upload = loadUpload(options.file);
  const { fileName } = upload;
  // Cart GEG runs (the +tail1830R win, the +test1950L check) all used Start
  // delay 4, the watcher's GEG table fitted to them; warps and warpless use 1.
  options.delay ??= /geg/i.test(fileName) ? 4 : 1;

  const bridge = new BridgeClient(options.bridge);
  await bridge.open();
  await connectArduino(bridge);

  let runId = 0;
  let accepted = false;
  const isRun = (message) => message.type === "tas_status" && message.run_id === runId;
  const cancelRun = async () => {
    if (!runId) {
      return;
    }
    await bridge.request({ type: "tas_cancel" }, (message) => isRun(message) && message.command === "tas_cancel", "cancel", 5000);
  };

  process.on("SIGINT", () => {
    const finish = () => {
      log("Stopped. The NES power was left as it is.");
      process.exit(130);
    };
    if (accepted || !runId) {
      finish();
      return;
    }
    log("Cancelling the armed run...");
    Promise.race([cancelRun(), sleep(3000)]).catch(() => {}).finally(finish);
  });

  log(`Hunting for ${options.accept.join("/")} boots of ${fileName}: ${upload.frameCount} records, strobe, 2 ports, Start delay ${options.delay}.`);
  const tally = {};
  let silentBoots = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    // A RESET press can land while this is in flight; the reset clears the run anyway.
    await cancelRun().catch(() => {});
    await setPlug(options.plugHost, false);
    log(`NES off for ${options.offSeconds} s; press the Arduino's RESET button now if you want to.`);
    await sleep(options.offSeconds * 1000);
    await connectArduino(bridge);

    // Upload, arm, and start after the off time (and any RESET press) but before
    // power-on, so power-up strobes land on an armed run.
    const clientRunId = Date.now();
    const uploaded = await bridge.request(
      { ...upload, clientRunId },
      (message) => message.type === "tas_status" && message.command === "tas_upload" && message.client_run_id === clientRunId,
      "upload",
    );
    runId = uploaded.run_id;
    await bridge.request(
      { type: "tas_arm" },
      (message) => isRun(message) && message.command === "tas_arm" && message.bridge_state === "armed",
      "arm",
      60000,
    );
    await bridge.request(
      { type: "tas_start", delayPolls: options.delay },
      (message) => isRun(message) && message.command === "tas_start",
      "start",
    );

    const readNewLines = createLogReader(options.log);
    readNewLines();
    await setPlug(options.plugHost, true);
    log(`Attempt ${attempt}: power on, waiting for Boot timing...`);
    const result = await waitForBootVerdict(readNewLines, fileName, options.bootTimeoutSeconds * 1000);
    if (!result) {
      silentBoots += 1;
      appendHuntLog([fileName, attempt, "NO-BOOT-TIMING", ""]);
      log(`Attempt ${attempt}: no Boot timing within ${options.bootTimeoutSeconds} s.`);
      if (silentBoots >= MAX_SILENT_BOOTS) {
        await cancelRun();
        await setPlug(options.plugHost, false);
        throw new Error(`${silentBoots} boots in a row produced no Boot timing; check the cartridge, plug, and Arduino. NES powered off.`);
      }
      continue;
    }
    silentBoots = 0;
    tally[result.verdict] = (tally[result.verdict] || 0) + 1;
    appendHuntLog([fileName, attempt, result.verdict, result.title || "", result.firstCycles ?? "", result.difference ?? "", result.reason]);
    log(`Attempt ${attempt}: ${formatVerdict(result)}`);
    if (result.verdict === "UNKNOWN" && /no reference table/.test(result.reason)) {
      await cancelRun();
      await setPlug(options.plugHost, false);
      throw new Error("the watcher has no prediction for this movie and delay, so no boot can ever be accepted. NES powered off.");
    }
    if (!options.accept.includes(result.verdict)) {
      continue;
    }

    accepted = true;
    notify(`${result.verdict} boot on attempt ${attempt}; ${fileName} is playing`);
    log(`${result.verdict} boot: letting ${fileName} play out. Tally: ${JSON.stringify(tally)}`);
    let lastProgress = 0;
    bridge.listeners.add((message) => {
      if (isRun(message) && Date.now() - lastProgress > 15000) {
        lastProgress = Date.now();
        log(`  record ${message.current}/${message.total}`);
      }
    });
    await bridge.waitFor((message) => isRun(message) && Number(message.complete) === 1, "run completion", 0);
    notify(`${fileName} served every record`);
    log(`All ${upload.frameCount} records served. The NES is still on: watch the ending.`);
    bridge.close();
    return;
  }

  await cancelRun();
  await setPlug(options.plugHost, false);
  log(`No accepted boot in ${options.maxAttempts} attempts. Tally: ${JSON.stringify(tally)}. NES powered off.`);
  bridge.close();
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Boot hunt: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { kasaDecode, kasaEncode, loadUpload, parseArgs };
