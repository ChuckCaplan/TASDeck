"use strict";

// Pure helpers for the harness: reading a .bk2, encoding its Input Log for the C# side, and
// writing the .r08, .tdmask and trace CSV formats TASDeck plays.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readZipTextEntries, validateBk2Metadata } = require("../validate-tasdeck-movie-inputs.js");
const tas = require("../../apps/web/src/tas.js");

// TD2P bit order, which the harness uses for every pad byte.
const BUTTON_BITS = { A: 0x01, B: 0x02, Select: 0x04, Start: 0x08, Up: 0x10, Down: 0x20, Left: 0x40, Right: 0x80 };
const AXIS_COLUMNS = new Set(["Reset Cycle"]);
const ROW_BYTES = 7;

function parseHeader(text) {
  const header = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (match) {
      header[match[1]] = match[2].trim();
    }
  }
  return header;
}

// Input Log columns come in "#"-separated groups, one pipe-delimited field per group. In a field,
// an axis column is a number followed by a comma and a button column is one character ('.' = up).
function parseInputLog(text) {
  const lines = text.split(/\r?\n/);
  const logKey = lines.find((line) => line.startsWith("LogKey:"));
  if (!logKey) {
    throw new Error('bk2 "Input Log.txt" has no LogKey line');
  }
  const groups = logKey
    .slice("LogKey:".length)
    .split("#")
    .map((group) => group.split("|").filter(Boolean))
    .filter((group) => group.length > 0);

  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("|")) {
      continue;
    }
    const fields = line.split("|").slice(1, -1);
    if (fields.length !== groups.length) {
      throw new Error(`Input Log row ${rows.length} has ${fields.length} fields; LogKey declares ${groups.length}`);
    }
    const row = { p1: 0, p2: 0, power: false, reset: false, resetCycle: 0 };
    groups.forEach((columns, groupIndex) => {
      const field = fields[groupIndex];
      let at = 0;
      for (const column of columns) {
        if (AXIS_COLUMNS.has(column)) {
          const comma = field.indexOf(",", at);
          if (comma < 0) {
            throw new Error(`Input Log row ${rows.length} is missing the ${column} value`);
          }
          const value = Number.parseInt(field.slice(at, comma).trim(), 10);
          if (column === "Reset Cycle") {
            row.resetCycle = Number.isFinite(value) ? value : 0;
          }
          at = comma + 1;
          continue;
        }
        const pressed = at < field.length && field[at] !== "." && field[at] !== " ";
        at += 1;
        if (!pressed) {
          continue;
        }
        const pad = /^P([12]) (\w+)$/.exec(column);
        if (pad && BUTTON_BITS[pad[2]]) {
          row[pad[1] === "1" ? "p1" : "p2"] |= BUTTON_BITS[pad[2]];
        } else if (column === "Power") {
          row.power = true;
        } else if (column === "Reset") {
          row.reset = true;
        }
      }
    });
    rows.push(row);
  }
  return rows;
}

function readBk2(filePath) {
  const entries = readZipTextEntries(fs.readFileSync(filePath), ["Header.txt", "SyncSettings.json", "Input Log.txt"]);
  const headerText = entries.get("header.txt");
  const syncSettings = entries.get("syncsettings.json");
  const inputLog = entries.get("input log.txt");
  if (headerText === undefined || inputLog === undefined) {
    throw new Error(`${filePath} is not a BizHawk movie (no Header.txt or Input Log.txt)`);
  }
  const header = parseHeader(headerText);
  if (header.Platform && header.Platform !== "NES") {
    throw new Error(`${path.basename(filePath)} is a ${header.Platform} movie; the harness plays NES movies`);
  }
  const core = header.Core || "NesHawk";
  if (core !== "NesHawk" && core !== "SubNESHawk") {
    throw new Error(`${path.basename(filePath)} was recorded on ${core}; the harness plays NesHawk and SubNESHawk movies`);
  }
  if (syncSettings !== undefined) {
    validateBk2Metadata(syncSettings, inputLog);
  }
  return { header, core, syncSettings: syncSettings ?? null, rows: parseInputLog(inputLog) };
}

function encodeRows(rows) {
  const buffer = Buffer.alloc(rows.length * ROW_BYTES);
  rows.forEach((row, index) => {
    const offset = index * ROW_BYTES;
    buffer[offset] = row.p1;
    buffer[offset + 1] = row.p2;
    buffer[offset + 2] = (row.power ? 1 : 0) | (row.reset ? 2 : 0);
    buffer.writeInt32LE(row.resetCycle, offset + 3);
  });
  return buffer;
}

// Pad pairs in TD2P order -> .r08 bytes (each controller byte reversed to NES serial order).
function r08FromMasks(masks) {
  return Buffer.from(Array.from(masks, (value) => tas.reverseByteBits(value)));
}

function tdmaskFromMasks(masks, movieFrames) {
  return Buffer.concat([Buffer.from(tas.twoControllerMaskHeaderWithFrames(movieFrames)), Buffer.from(masks)]);
}

// Same columns as scripts/bizhawk-export-tasdeck-mask.lua writes next to its .tdmask.
function traceCsv(frames) {
  const hex = (value) => value.toString(16).toUpperCase().padStart(2, "0");
  return [
    "frame_index,source_frame,mask1_hex,mask2_hex,source_format",
    ...frames.map((frame, index) => `${index},${frame.frame},${hex(frame.p1)},${hex(frame.p2)},bk2`),
    "",
  ].join("\n");
}

// frames.bin from a movie job: int32 LE source frame, then the two pad bytes.
function decodePolledFrames(buffer) {
  const frames = [];
  for (let offset = 0; offset + 6 <= buffer.length; offset += 6) {
    frames.push({ frame: buffer.readInt32LE(offset), p1: buffer[offset + 4], p2: buffer[offset + 5] });
  }
  return frames;
}

// Reads a .r08 or .tdmask the way the TASDeck UI does and returns pad pairs in TD2P order.
function readStream(filePath) {
  const parsed = tas.parseTasFileBytes(path.basename(filePath), new Uint8Array(fs.readFileSync(filePath)));
  const masks = Buffer.alloc(parsed.frames.length * 2);
  parsed.frames.forEach((frame, index) => {
    const { p1, p2 } = tas.frameToPortMasks(frame);
    masks[2 * index] = p1;
    masks[2 * index + 1] = p2;
  });
  return { masks, format: parsed.format === "r08" ? "r08" : "tdmask", syncMode: parsed.syncMode };
}

function digests(buffer) {
  const sha1 = crypto.createHash("sha1").update(buffer).digest("hex").toUpperCase();
  const md5 = crypto.createHash("md5").update(buffer).digest("hex").toUpperCase();
  return [sha1, md5];
}

// BizHawk movies store the ROM's SHA-1 or MD5, of the whole file or of the ROM without its iNES
// header, depending on the game database. Any of those matching is a match.
function romMatchesMovie(header, rom) {
  const expected = [header.SHA1, header.MD5].filter(Boolean).map((value) => value.toUpperCase());
  if (expected.length === 0) {
    return null;
  }
  const candidates = [...digests(rom)];
  if (rom.length > 16 && rom.toString("latin1", 0, 4) === "NES\x1a") {
    candidates.push(...digests(rom.subarray(16)));
  }
  return expected.some((value) => candidates.includes(value));
}

module.exports = {
  BUTTON_BITS,
  ROW_BYTES,
  decodePolledFrames,
  encodeRows,
  parseHeader,
  parseInputLog,
  r08FromMasks,
  readBk2,
  readStream,
  romMatchesMovie,
  tdmaskFromMasks,
  traceCsv,
};
