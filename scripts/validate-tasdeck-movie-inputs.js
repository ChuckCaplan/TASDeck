#!/usr/bin/env node
"use strict";

// Fail before launching an emulator when an FM2 or BK2 declares controller
// hardware or input columns that TASDeck cannot reproduce. TASDeck emits only
// the eight standard NES buttons on the D0 data line for ports 1 and 2.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const NES_BUTTONS = new Set(["Up", "Down", "Left", "Right", "Start", "Select", "B", "A"]);
const BK2_CONSOLE_COLUMNS = new Set(["Power", "Reset", "Reset Cycle"]);
const BK2_SUPPORTED_PORT_DEVICES = new Set(["ControllerNES", "UnpluggedNES"]);
const USAGE = "usage: node scripts/validate-tasdeck-movie-inputs.js <movie.fm2|movie.bk2>";

class UnsupportedMovieInputsError extends Error {}

function parseFm2Header(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith("|")) {
      break;
    }
    const match = /^(\S+)\s+(.*)$/.exec(rawLine);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    const entries = values.get(key) || [];
    entries.push(value);
    values.set(key, entries);
  }
  return values;
}

function fm2Values(header, key) {
  return header.get(key) || [];
}

function validateFm2Text(text) {
  const header = parseFm2Header(text);
  const issues = [];

  for (const value of fm2Values(header, "fourscore")) {
    if (value !== "0") {
      issues.push(`fourscore=${value} (Four Score/P3/P4 input is unsupported)`);
    }
  }

  for (const key of ["port0", "port1"]) {
    for (const value of fm2Values(header, key)) {
      if (value !== "0" && value !== "1") {
        issues.push(`${key}=${value} (only no device=0 or standard gamepad=1 is supported)`);
      }
    }
  }

  for (const value of fm2Values(header, "port2")) {
    if (value !== "0") {
      issues.push(`port2=${value} (Famicom/NES expansion-port controllers are unsupported)`);
    }
  }

  for (const value of fm2Values(header, "microphone")) {
    if (value !== "0") {
      issues.push(`microphone=${value} (Famicom controller microphone input is unsupported)`);
    }
  }

  if (issues.length > 0) {
    throw new UnsupportedMovieInputsError(`unsupported FM2 controller configuration:\n- ${issues.join("\n- ")}`);
  }
}

function findEndOfCentralDirectory(data) {
  const minimumOffset = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimumOffset; offset -= 1) {
    if (data.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }
    const commentLength = data.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === data.length) {
      return offset;
    }
  }
  throw new Error("not a supported BK2 ZIP archive (end-of-central-directory record not found)");
}

function readZipTextEntries(data, wantedNames) {
  const endOffset = findEndOfCentralDirectory(data);
  const diskNumber = data.readUInt16LE(endOffset + 4);
  const centralDisk = data.readUInt16LE(endOffset + 6);
  const entryCount = data.readUInt16LE(endOffset + 10);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("multi-disk and ZIP64 BK2 archives are unsupported");
  }

  const wanted = new Set(wantedNames.map((name) => name.toLowerCase()));
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("BK2 ZIP central directory is malformed");
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.length) {
      throw new Error("BK2 ZIP entry name is truncated");
    }
    const name = data.toString("utf8", nameStart, nameEnd).replaceAll("\\", "/");
    const baseName = name.slice(name.lastIndexOf("/") + 1).toLowerCase();

    if (wanted.has(baseName)) {
      if ((flags & 0x0001) !== 0) {
        throw new Error(`BK2 ZIP entry is encrypted: ${name}`);
      }
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error(`ZIP64 BK2 entry is unsupported: ${name}`);
      }
      if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`BK2 ZIP local header is malformed: ${name}`);
      }
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const contentStart = localOffset + 30 + localNameLength + localExtraLength;
      const contentEnd = contentStart + compressedSize;
      if (contentEnd > data.length) {
        throw new Error(`BK2 ZIP entry is truncated: ${name}`);
      }
      const compressed = data.subarray(contentStart, contentEnd);
      let content;
      if (method === 0) {
        content = compressed;
      } else if (method === 8) {
        content = zlib.inflateRawSync(compressed);
      } else {
        throw new Error(`BK2 ZIP entry uses unsupported compression method ${method}: ${name}`);
      }
      if (content.length !== uncompressedSize) {
        throw new Error(`BK2 ZIP entry has the wrong uncompressed size: ${name}`);
      }
      if (entries.has(baseName)) {
        throw new Error(`BK2 ZIP contains duplicate ${baseName} entries`);
      }
      entries.set(baseName, content.toString("utf8"));
    }

    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function syncSettingStrings(syncSettings, key) {
  const expression = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "g");
  return [...syncSettings.matchAll(expression)].map((match) => match[1]);
}

function parseBk2LogColumns(inputLog) {
  const logKey = inputLog.split(/\r?\n/).find((line) => line.startsWith("LogKey:"));
  if (!logKey) {
    throw new Error('BK2 "Input Log.txt" has no LogKey line');
  }
  return logKey
    .slice("LogKey:".length)
    .split("|")
    .filter(Boolean)
    .map((column) => column.replace(/^#/, ""));
}

function validateBk2Metadata(syncSettings, inputLog) {
  const issues = [];
  for (const key of ["NesLeftPort", "NesRightPort"]) {
    for (const device of syncSettingStrings(syncSettings, key)) {
      if (!BK2_SUPPORTED_PORT_DEVICES.has(device)) {
        issues.push(`${key}=${device} (only ControllerNES or UnpluggedNES is supported)`);
      }
    }
  }
  for (const device of syncSettingStrings(syncSettings, "FamicomExpPort")) {
    if (device !== "UnpluggedFam") {
      issues.push(`FamicomExpPort=${device} (Famicom expansion controllers are unsupported)`);
    }
  }

  for (const column of parseBk2LogColumns(inputLog)) {
    if (BK2_CONSOLE_COLUMNS.has(column)) {
      continue;
    }
    const controllerColumn = /^P(\d+) (.+)$/.exec(column);
    if (
      controllerColumn
      && (controllerColumn[1] === "1" || controllerColumn[1] === "2")
      && NES_BUTTONS.has(controllerColumn[2])
    ) {
      continue;
    }
    issues.push(`input column "${column}" is not a standard P1/P2 NES controller button`);
  }

  if (issues.length > 0) {
    throw new UnsupportedMovieInputsError(`unsupported BK2 controller configuration:\n- ${issues.join("\n- ")}`);
  }
}

function validateMovieFile(moviePath) {
  const extension = path.extname(moviePath).toLowerCase();
  const data = fs.readFileSync(moviePath);
  if (extension === ".fm2") {
    validateFm2Text(data.toString("utf8"));
    return "FM2 uses only standard NES controllers on ports 1 and 2";
  }
  if (extension === ".bk2") {
    const entries = readZipTextEntries(data, ["SyncSettings.json", "Input Log.txt"]);
    const syncSettings = entries.get("syncsettings.json");
    const inputLog = entries.get("input log.txt");
    if (syncSettings === undefined || inputLog === undefined) {
      throw new Error('BK2 must contain both "SyncSettings.json" and "Input Log.txt"');
    }
    validateBk2Metadata(syncSettings, inputLog);
    return "BK2 uses only standard NES controllers on ports 1 and 2";
  }
  throw new Error(`expected an .fm2 or .bk2 movie, got: ${moviePath}`);
}

function printUsage(stream) {
  stream.write(`${USAGE}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage(process.stdout);
    return;
  }
  if (args.length !== 1) {
    console.error("error: expected exactly one <movie.fm2|movie.bk2> argument");
    printUsage(process.stderr);
    process.exit(2);
  }
  try {
    const result = validateMovieFile(args[0]);
    console.log(`Controller preflight passed: ${result}.`);
  } catch (error) {
    console.error(`Controller preflight failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  UnsupportedMovieInputsError,
  readZipTextEntries,
  validateBk2Metadata,
  validateFm2Text,
  validateMovieFile,
};

if (require.main === module) {
  main();
}
