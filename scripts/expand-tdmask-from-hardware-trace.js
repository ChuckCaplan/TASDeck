#!/usr/bin/env node
"use strict";

// Builds a corrected .tdmask when a real hardware trace shows that the console
// polled during movie frames the emulator exporter treated as lag/no-poll.
//
// Usage:
//   node scripts/expand-tdmask-from-hardware-trace.js movie.tdmask hardware.stream.csv [--output out.tdmask]
//
// The script needs the exporter's sibling movie.tdmask.trace.csv and the source
// FM2 file next to movie.tdmask (or pass --fm2 movie.fm2). It never overwrites
// the input .tdmask; without --output it writes movie.hardware-expanded.tdmask.

const fs = require("node:fs");
const path = require("node:path");

const BUTTON_BITS = {
  a: 0x01,
  b: 0x02,
  select: 0x04,
  start: 0x08,
  up: 0x10,
  down: 0x20,
  left: 0x40,
  right: 0x80,
};
const FM2_GAMEPAD_COLUMNS = ["right", "left", "down", "up", "start", "select", "b", "a"];
const DEFAULT_START_FRAME = 30;
const DEFAULT_TOLERANCE_FRAMES = 0.65;
const TD2P_MAGIC = Buffer.from("TD2P");
const TD2P_HEADER_LENGTH = 8;
// Version 2 appends a big-endian uint32 source-movie frame count.
const TD2P_V2_HEADER_LENGTH = 12;

// The core diff/insertion logic works on a flat per-frame P1 mask array. Modern
// .tdmask files are TD2P: an 8- (v1) or 12-byte (v2) header then two
// interleaved bytes (P1, P2) per frame. Split that here so the rest of the
// tool is format-agnostic, and re-wrap on output — the v2 movie-frame count
// stays valid because expansion changes record granularity, not the movie. A
// header-less buffer is treated as the legacy single-port stream (one byte per
// frame).
function readTdmask(buffer) {
  const isTd2p =
    buffer.length >= TD2P_HEADER_LENGTH && buffer.subarray(0, 4).equals(TD2P_MAGIC);
  if (!isTd2p) {
    return { portCount: 1, header: null, p1: Array.from(buffer), p2: null };
  }

  const version = buffer[TD2P_MAGIC.length];
  const headerLength = version >= 2 ? TD2P_V2_HEADER_LENGTH : TD2P_HEADER_LENGTH;
  if (buffer.length < headerLength) {
    fail("TD2P tdmask header is truncated");
  }
  const payload = buffer.subarray(headerLength);
  if (payload.length % 2 !== 0) {
    fail("TD2P tdmask payload has an incomplete two-controller frame");
  }
  const p1 = [];
  const p2 = [];
  for (let index = 0; index < payload.length; index += 2) {
    p1.push(payload[index]);
    p2.push(payload[index + 1]);
  }
  return { portCount: 2, header: Buffer.from(buffer.subarray(0, headerLength)), p1, p2 };
}

function usage() {
  console.error(
    "usage: node scripts/expand-tdmask-from-hardware-trace.js <movie.tdmask> <hardware.stream.csv> " +
      "[--fm2 movie.fm2] [--output output.tdmask] [--dry-run] [--start-frame N]",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    dryRun: false,
    fm2Path: "",
    outputPath: "",
    startFrame: DEFAULT_START_FRAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--fm2") {
      index += 1;
      options.fm2Path = argv[index] || "";
    } else if (arg === "--output") {
      index += 1;
      options.outputPath = argv[index] || "";
    } else if (arg === "--start-frame") {
      index += 1;
      options.startFrame = Number(argv[index]);
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (
    positional.length !== 2 ||
    !Number.isInteger(options.startFrame) ||
    options.startFrame < 0 ||
    (options.fm2Path === "" && argv.includes("--fm2")) ||
    (options.outputPath === "" && argv.includes("--output"))
  ) {
    usage();
  }

  return {
    tdmaskPath: positional[0],
    streamPath: positional[1],
    ...options,
  };
}

function parseExporterTrace(tracePath, masks) {
  if (!fs.existsSync(tracePath)) {
    fail(`exporter trace not found: ${tracePath}`);
  }

  const lines = fs.readFileSync(tracePath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines.shift();
  // Two exporter trace layouts carry the same "poll index -> movie frame + mask"
  // data: the FM2/FCEUX exporter (poll_index,movie_frame,...,mask@col3) and the
  // bk2 converter (frame_index,source_frame,mask1_hex@col2,...). Both list one
  // sequential row per polled frame, so only the mask column differs.
  let maskColumn;
  if (header && header.startsWith("poll_index,movie_frame,")) {
    maskColumn = 3;
  } else if (header && header.startsWith("frame_index,source_frame,")) {
    maskColumn = 2;
  } else {
    fail(`unexpected exporter trace CSV header in ${tracePath}`);
  }

  const frames = [];
  let currentMovieFrame = null;
  for (const [lineIndex, line] of lines.entries()) {
    const columns = line.split(",");
    const pollIndex = Number(columns[0]);
    const movieFrame = Number(columns[1]);
    const mask = parseHexByte(columns[maskColumn]);
    if (!Number.isInteger(pollIndex) || pollIndex !== lineIndex || !Number.isInteger(movieFrame) || mask === null) {
      fail(`unexpected exporter trace row ${lineIndex + 2} in ${tracePath}: ${line}`);
    }

    if (movieFrame !== currentMovieFrame) {
      frames.push({ movieFrame, mask });
      currentMovieFrame = movieFrame;
    } else if (frames.at(-1).mask !== mask) {
      console.warn(
        `warning: exporter trace has an intra-frame mask change at poll ${pollIndex}; using first poll's mask`,
      );
    }
  }

  if (frames.length !== masks.length) {
    fail(`tdmask has ${masks.length} byte(s), but exporter trace has ${frames.length} unique polled frame(s)`);
  }

  const mismatches = frames.filter((frame, index) => frame.mask !== masks[index]).length;
  if (mismatches > 0) {
    fail(`tdmask bytes do not match exporter trace masks (${mismatches} mismatch(es)); regenerate the .tdmask first`);
  }

  return frames;
}

function parseHardwareStream(streamPath) {
  if (!fs.existsSync(streamPath)) {
    fail(`hardware stream trace not found: ${streamPath}`);
  }

  const rows = [];
  const lines = fs.readFileSync(streamPath, "utf8").split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (line === "" || line.startsWith("#") || line.startsWith("sequence,")) {
      continue;
    }

    const columns = line.split(",");
    const sequence = Number(columns[0]);
    const timestampMicros = Number(columns[1]);
    const tasFrame = Number(columns[2]);
    const polledMask = parseHexByte(columns[6]);
    if (
      !Number.isInteger(sequence) ||
      !Number.isFinite(timestampMicros) ||
      !Number.isInteger(tasFrame) ||
      polledMask === null
    ) {
      fail(`unexpected hardware stream row ${lineIndex + 1} in ${streamPath}: ${line}`);
    }

    rows.push({
      sequence,
      timestampMicros,
      tasFrame,
      polledMask,
    });
  }

  if (rows.length === 0) {
    fail(`hardware stream trace has no rows: ${streamPath}`);
  }

  return rows;
}

function parseFm2Masks(fm2Path, portColumn = 2) {
  if (!fs.existsSync(fm2Path)) {
    fail(`FM2 file not found: ${fm2Path}`);
  }

  const masks = [];
  for (const line of fs.readFileSync(fm2Path, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      continue;
    }

    // split("|")[2] is the P1 gamepad field; [3] is P2.
    const gamepadField = line.split("|")[portColumn] || "";
    masks.push(fm2GamepadMask(gamepadField));
  }

  if (masks.length === 0) {
    fail(`FM2 file has no input rows: ${fm2Path}`);
  }

  return masks;
}

function fm2GamepadMask(field) {
  let mask = 0;
  for (const [index, button] of FM2_GAMEPAD_COLUMNS.entries()) {
    const value = field[index] || ".";
    if (value !== "." && value !== " ") {
      mask |= BUTTON_BITS[button];
    }
  }
  return mask;
}

function firstHardwareRowsByFrame(rows) {
  const firstRows = new Map();
  for (const row of rows) {
    if (!firstRows.has(row.tasFrame)) {
      firstRows.set(row.tasFrame, row);
    }
  }
  return firstRows;
}

function estimateFramePeriodMicros(firstRows, exporterFrames) {
  const samples = [];
  const frames = Array.from(firstRows.keys()).sort((left, right) => left - right);
  for (const frame of frames) {
    if (frame <= 0 || frame >= exporterFrames.length || !firstRows.has(frame - 1)) {
      continue;
    }

    const expectedFrames = exporterFrames[frame].movieFrame - exporterFrames[frame - 1].movieFrame;
    const deltaMicros = firstRows.get(frame).timestampMicros - firstRows.get(frame - 1).timestampMicros;
    if (expectedFrames === 1 && deltaMicros >= 10000 && deltaMicros <= 25000) {
      samples.push(deltaMicros);
    }
  }

  if (samples.length === 0) {
    fail("could not estimate the hardware frame period from the stream trace");
  }

  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

function findInsertions(firstRows, exporterFrames, framePeriodMicros, startFrame) {
  const insertions = [];
  const frames = Array.from(firstRows.keys()).sort((left, right) => left - right);
  for (const frame of frames) {
    if (frame <= Math.max(0, startFrame) || frame >= exporterFrames.length || !firstRows.has(frame - 1)) {
      continue;
    }

    const previousFrame = exporterFrames[frame - 1];
    const currentFrame = exporterFrames[frame];
    const expectedFrames = currentFrame.movieFrame - previousFrame.movieFrame;
    if (expectedFrames <= 1) {
      continue;
    }

    const deltaMicros = firstRows.get(frame).timestampMicros - firstRows.get(frame - 1).timestampMicros;
    const actualFramesFloat = deltaMicros / framePeriodMicros;
    const actualFrames = Math.max(1, Math.round(actualFramesFloat));
    const missingFrames = expectedFrames - actualFrames;
    if (missingFrames <= 0 || Math.abs(actualFramesFloat - actualFrames) > DEFAULT_TOLERANCE_FRAMES) {
      continue;
    }

    insertions.push({
      beforeFrame: frame,
      previousMovieFrame: previousFrame.movieFrame,
      currentMovieFrame: currentFrame.movieFrame,
      actualFrames,
      expectedFrames,
      missingFrames,
      firstInsertedMovieFrame: currentFrame.movieFrame - missingFrames,
      hardwareSequence: firstRows.get(frame).sequence,
      deltaMicros,
    });
  }

  return insertions;
}

function buildExpandedMask(parsed, exporterFrames, fm2, insertions) {
  const { portCount, header, p1: masks, p2 } = parsed;
  const insertionsByFrame = new Map();
  for (const insertion of insertions) {
    insertionsByFrame.set(insertion.beforeFrame, insertion);
  }

  const outP1 = [];
  const outP2 = [];
  const outputFrames = [];
  const emit = (mask1, mask2, frameMeta) => {
    outP1.push(mask1);
    outP2.push(mask2);
    outputFrames.push(frameMeta);
  };

  for (let frame = 0; frame < masks.length; frame += 1) {
    const insertion = insertionsByFrame.get(frame);
    if (insertion) {
      for (let movieFrame = insertion.firstInsertedMovieFrame; movieFrame < insertion.currentMovieFrame; movieFrame += 1) {
        if (movieFrame < 0 || movieFrame >= fm2.p1.length) {
          fail(`FM2 frame ${movieFrame} needed for insertion before .tdmask frame ${frame}, but FM2 is too short`);
        }
        emit(fm2.p1[movieFrame], fm2.p2[movieFrame] || 0, { movieFrame, mask: fm2.p1[movieFrame] });
      }
    }

    emit(masks[frame], p2 ? p2[frame] : 0, exporterFrames[frame]);
  }

  let buffer;
  if (portCount >= 2) {
    const payload = Buffer.alloc(outP1.length * 2);
    for (let index = 0; index < outP1.length; index += 1) {
      payload[index * 2] = outP1[index];
      payload[index * 2 + 1] = outP2[index];
    }
    buffer = Buffer.concat([header, payload]);
  } else {
    buffer = Buffer.from(outP1);
  }

  return {
    buffer,
    frames: outputFrames,
    frameCount: outP1.length,
    addedFrames: outP1.length - masks.length,
  };
}

function writeExpandedTraceCsv(outputPath, frames) {
  const lines = [
    "poll_index,movie_frame,strobe_index,mask_hex,observed_hex,observed_valid,mismatch,incomplete_reads,ignored_reads,total_mismatches",
  ];
  for (const [index, frame] of frames.entries()) {
    const mask = byteToHex(frame.mask);
    lines.push(`${index},${frame.movieFrame},${index + 1},${mask},${mask},1,0,0,0,0`);
  }

  const tracePath = `${outputPath}.trace.csv`;
  fs.writeFileSync(tracePath, `${lines.join("\n")}\n`);
  return tracePath;
}

function parseHexByte(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{2}$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 16);
}

function byteToHex(value) {
  return Number(value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function defaultFm2Path(tdmaskPath) {
  const directPath = tdmaskPath.replace(/\.tdmask$/i, ".fm2");
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  return tdmaskPath.replace(/\.hardware-expanded\.tdmask$/i, ".fm2");
}

function defaultOutputPath(tdmaskPath) {
  return tdmaskPath.replace(/\.tdmask$/i, ".hardware-expanded.tdmask");
}

function printInsertionSummary(insertions) {
  if (insertions.length === 0) {
    console.log("No emulator-lag gaps needed expansion for this hardware trace.");
    return;
  }

  console.log("Expansions:");
  for (const insertion of insertions) {
    console.log(
      `  before tdmask frame ${insertion.beforeFrame}: insert ${insertion.missingFrames} FM2 frame(s) ` +
        `${insertion.firstInsertedMovieFrame}-${insertion.currentMovieFrame - 1} ` +
        `(hardware ${insertion.actualFrames} frame(s), emulator ${insertion.expectedFrames}, seq ${insertion.hardwareSequence})`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.tdmaskPath)) {
    fail(`tdmask not found: ${options.tdmaskPath}`);
  }

  const parsed = readTdmask(fs.readFileSync(options.tdmaskPath));
  const masks = parsed.p1;
  const exporterFrames = parseExporterTrace(`${options.tdmaskPath}.trace.csv`, masks);
  const hardwareRows = parseHardwareStream(options.streamPath);
  const firstRows = firstHardwareRowsByFrame(hardwareRows);
  const framePeriodMicros = estimateFramePeriodMicros(firstRows, exporterFrames);
  const insertions = findInsertions(firstRows, exporterFrames, framePeriodMicros, options.startFrame);

  console.log(`${path.basename(options.tdmaskPath)}: ${masks.length} frame mask(s) (${parsed.portCount}-port)`);
  console.log(`${path.basename(options.streamPath)}: ${hardwareRows.length} hardware poll row(s)`);
  console.log(`estimated hardware frame period: ${framePeriodMicros} us`);
  printInsertionSummary(insertions);

  if (insertions.length === 0 || options.dryRun) {
    return;
  }

  const fm2Path = options.fm2Path || defaultFm2Path(options.tdmaskPath);
  const outputPath = options.outputPath || defaultOutputPath(options.tdmaskPath);
  if (path.resolve(outputPath) === path.resolve(options.tdmaskPath)) {
    fail("output path must not overwrite the input .tdmask");
  }

  const fm2 = {
    p1: parseFm2Masks(fm2Path, 2),
    p2: parseFm2Masks(fm2Path, 3),
  };
  const output = buildExpandedMask(parsed, exporterFrames, fm2, insertions);
  fs.writeFileSync(outputPath, output.buffer);
  const tracePath = writeExpandedTraceCsv(outputPath, output.frames);
  console.log(`wrote ${outputPath} (${output.frameCount} frame mask(s), +${output.addedFrames})`);
  console.log(`wrote ${tracePath}`);
  console.log(
    `inserted masks: ${insertions.map((insertion) => String(insertion.missingFrames)).join(" + ")} = ` +
      `${output.addedFrames}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { readTdmask, buildExpandedMask, parseFm2Masks, fm2GamepadMask };
