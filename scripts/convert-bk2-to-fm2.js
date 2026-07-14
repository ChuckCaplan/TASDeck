#!/usr/bin/env node
"use strict";

// Bridges a BizHawk .bk2 to the FCEUX-style .fm2 that
// expand-tdmask-from-hardware-trace.js needs as its per-frame input source.
//
// The expander only reads lines beginning with "|" and looks at the P1 gamepad
// field (split("|")[2]); when a hardware trace shows the console polled a frame
// the exporter dropped as lag, it fetches that movie frame's mask from the FM2.
// A .bk2 carries the same per-frame Input Log, just in bk2 column form, so this
// re-serialises it into fm2 rows one-for-one (movie frame N -> fm2 row N).
//
// Usage:
//   node scripts/convert-bk2-to-fm2.js <movie.bk2> [--output movie.fm2] [--no-verify]
//
// Without --output it writes <movie>.fm2 next to the input. If a sibling
// <movie>.tdmask.trace.csv exists it verifies every polled source frame's mask
// round-trips, which catches any column-order mistake.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// FM2 gamepad field order and the mask bit each button sets, matching
// expand-tdmask-from-hardware-trace.js (FM2_GAMEPAD_COLUMNS / BUTTON_BITS).
const FM2_COLUMNS = ["right", "left", "down", "up", "start", "select", "b", "a"];
const FM2_CHAR = { right: "R", left: "L", down: "D", up: "U", start: "S", select: "s", b: "B", a: "A" };
const BUTTON_BITS = { a: 0x01, b: 0x02, select: 0x04, start: 0x08, up: 0x10, down: 0x20, left: 0x40, right: 0x80 };

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { bk2Path: "", outputPath: "", verify: true };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.outputPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--no-verify") {
      options.verify = false;
    } else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/convert-bk2-to-fm2.js <movie.bk2> [--output movie.fm2] [--no-verify]");
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    fail("expected exactly one <movie.bk2> argument (see --help)");
  }
  options.bk2Path = positional[0];
  if (!options.outputPath) {
    options.outputPath = `${options.bk2Path.replace(/\.bk2$/i, "")  }.fm2`;
  }
  return options;
}

function readInputLog(bk2Path) {
  if (!fs.existsSync(bk2Path)) {
    fail(`bk2 file not found: ${bk2Path}`);
  }
  try {
    return execFileSync("unzip", ["-p", bk2Path, "Input Log.txt"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    fail(`could not extract "Input Log.txt" from ${bk2Path}: ${error.message}`);
  }
}

// A bk2 LogKey groups columns with "#": each "#" starts a new pipe-delimited
// data field. We locate the P1/P2 groups and, within each, which position
// carries which NES button, so column order changes don't break parsing.
function parseLogKey(logKeyLine) {
  const body = logKeyLine.slice("LogKey:".length);
  const groups = [];
  let current = null;
  for (const token of body.split("|")) {
    if (token === "") {
      continue;
    }
    if (token.startsWith("#")) {
      current = { columns: [] };
      groups.push(current);
      current.columns.push(token.slice(1));
    } else if (current) {
      current.columns.push(token);
    }
  }

  const portMaps = {};
  groups.forEach((group, groupIndex) => {
    group.columns.forEach((column, columnIndex) => {
      const match = /^P(\d)\s+(\w+)$/.exec(column);
      if (!match) {
        return;
      }
      const port = Number(match[1]);
      const button = match[2].toLowerCase();
      if (!(port in portMaps)) {
        portMaps[port] = { fieldIndex: groupIndex, buttons: {} };
      }
      portMaps[port].buttons[columnIndex] = button;
    });
  });

  if (!portMaps[1]) {
    fail("LogKey has no P1 controller columns; unsupported bk2 layout");
  }
  return portMaps;
}

function pressedButtons(field, buttonsByPosition) {
  const pressed = new Set();
  for (const [positionText, button] of Object.entries(buttonsByPosition)) {
    const char = field[Number(positionText)];
    if (char && char !== "." && char !== " ") {
      pressed.add(button);
    }
  }
  return pressed;
}

function fm2Field(pressed) {
  return FM2_COLUMNS.map((button) => (pressed.has(button) ? FM2_CHAR[button] : ".")).join("");
}

function buttonsToMask(pressed) {
  let mask = 0;
  for (const button of pressed) {
    mask |= BUTTON_BITS[button] || 0;
  }
  return mask;
}

function convert(inputLog) {
  const lines = inputLog.split(/\r?\n/);
  const logKeyLine = lines.find((line) => line.startsWith("LogKey:"));
  if (!logKeyLine) {
    fail("Input Log has no LogKey line");
  }
  const portMaps = parseLogKey(logKeyLine);

  const fm2Rows = [];
  const p1Masks = [];
  for (const line of lines) {
    if (!line.startsWith("|")) {
      continue;
    }
    // Drop the leading empty split and the trailing empty split so field N maps
    // to LogKey group N (group 0 is the console Power/Reset field).
    const fields = line.split("|").slice(1, -1);
    const readPort = (port) => {
      const map = portMaps[port];
      if (!map) {
        return new Set();
      }
      return pressedButtons(fields[map.fieldIndex] || "", map.buttons);
    };
    const p1 = readPort(1);
    const p2 = readPort(2);
    p1Masks.push(buttonsToMask(p1));
    fm2Rows.push(`|0|${fm2Field(p1)}|${fm2Field(p2)}|`);
  }

  if (fm2Rows.length === 0) {
    fail("Input Log has no input rows");
  }
  return { fm2Rows, p1Masks };
}

// Every polled source frame in the exporter trace must round-trip: the fm2 mask
// at that movie frame has to equal the mask the converter emitted. A mismatch
// means a column-order bug, so we fail loudly rather than hand the expander bad
// input.
function verifyAgainstTrace(bk2Path, p1Masks) {
  const traceCandidates = [
    `${bk2Path.replace(/\.bk2$/i, "")  }.tdmask.trace.csv`,
    bk2Path.replace(/\.bk2$/i, ".tdmask.trace.csv"),
  ];
  const tracePath = traceCandidates.find((candidate) => fs.existsSync(candidate));
  if (!tracePath) {
    console.log("verify: no sibling .tdmask.trace.csv found; skipping round-trip check");
    return;
  }

  const rows = fs.readFileSync(tracePath, "utf8").split(/\r?\n/);
  let checked = 0;
  let mismatches = 0;
  for (const row of rows.slice(1)) {
    if (!row.trim()) {
      continue;
    }
    const [, sourceFrame, mask1Hex] = row.split(",");
    const source = Number(sourceFrame);
    const expected = parseInt(mask1Hex, 16);
    if (!Number.isInteger(source) || Number.isNaN(expected)) {
      continue;
    }
    if (source >= p1Masks.length) {
      mismatches += 1;
      if (mismatches <= 5) {
        console.error(`  source frame ${source} beyond fm2 length ${p1Masks.length}`);
      }
      continue;
    }
    checked += 1;
    if (p1Masks[source] !== expected) {
      mismatches += 1;
      if (mismatches <= 5) {
        console.error(
          `  mismatch at source frame ${source}: fm2=0x${p1Masks[source].toString(16)} trace=0x${expected.toString(16)}`,
        );
      }
    }
  }

  if (mismatches > 0) {
    fail(`round-trip verification failed: ${mismatches} mismatch(es) across ${checked} polled frames`);
  }
  console.log(`verify: ${checked} polled source frames round-trip cleanly against ${path.basename(tracePath)}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputLog = readInputLog(options.bk2Path);
  const { fm2Rows, p1Masks } = convert(inputLog);

  const header = [
    "version 3",
    "emuVersion 22020",
    "rerecordCount 0",
    "palFlag 0",
    "romFilename bk2-source",
    `comment converted from ${  path.basename(options.bk2Path)  } by convert-bk2-to-fm2.js`,
    "guid 00000000-0000-0000-0000-000000000000",
    "port0 1",
    "port1 1",
    "port2 0",
    "fourscore 0",
  ];
  fs.writeFileSync(options.outputPath, `${header.join("\n")  }\n${  fm2Rows.join("\n")  }\n`);
  console.log(`wrote ${fm2Rows.length} frame(s): ${options.outputPath}`);

  if (options.verify) {
    verifyAgainstTrace(options.bk2Path, p1Masks);
  }
}

main();
