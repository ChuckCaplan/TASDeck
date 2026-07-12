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
  if (!header || !header.startsWith("poll_index,movie_frame,")) {
    fail(`unexpected exporter trace CSV header in ${tracePath}`);
  }

  const frames = [];
  let currentMovieFrame = null;
  for (const [lineIndex, line] of lines.entries()) {
    const columns = line.split(",");
    const pollIndex = Number(columns[0]);
    const movieFrame = Number(columns[1]);
    const mask = parseHexByte(columns[3]);
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

function parseFm2Masks(fm2Path) {
  if (!fs.existsSync(fm2Path)) {
    fail(`FM2 file not found: ${fm2Path}`);
  }

  const masks = [];
  for (const line of fs.readFileSync(fm2Path, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      continue;
    }

    const gamepadField = line.split("|")[2] || "";
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

function buildExpandedMask(masks, exporterFrames, fm2Masks, insertions) {
  const insertionsByFrame = new Map();
  for (const insertion of insertions) {
    insertionsByFrame.set(insertion.beforeFrame, insertion);
  }

  const output = [];
  const outputFrames = [];
  for (let frame = 0; frame < masks.length; frame += 1) {
    const insertion = insertionsByFrame.get(frame);
    if (insertion) {
      for (let movieFrame = insertion.firstInsertedMovieFrame; movieFrame < insertion.currentMovieFrame; movieFrame += 1) {
        if (movieFrame < 0 || movieFrame >= fm2Masks.length) {
          fail(`FM2 frame ${movieFrame} needed for insertion before .tdmask frame ${frame}, but FM2 is too short`);
        }
        output.push(fm2Masks[movieFrame]);
        outputFrames.push({
          movieFrame,
          mask: fm2Masks[movieFrame],
        });
      }
    }

    output.push(masks[frame]);
    outputFrames.push(exporterFrames[frame]);
  }

  return {
    buffer: Buffer.from(output),
    frames: outputFrames,
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

  const tdmask = fs.readFileSync(options.tdmaskPath);
  const exporterFrames = parseExporterTrace(`${options.tdmaskPath}.trace.csv`, tdmask);
  const hardwareRows = parseHardwareStream(options.streamPath);
  const firstRows = firstHardwareRowsByFrame(hardwareRows);
  const framePeriodMicros = estimateFramePeriodMicros(firstRows, exporterFrames);
  const insertions = findInsertions(firstRows, exporterFrames, framePeriodMicros, options.startFrame);

  console.log(`${path.basename(options.tdmaskPath)}: ${tdmask.length} frame mask(s)`);
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

  const fm2Masks = parseFm2Masks(fm2Path);
  const output = buildExpandedMask(tdmask, exporterFrames, fm2Masks, insertions);
  fs.writeFileSync(outputPath, output.buffer);
  const tracePath = writeExpandedTraceCsv(outputPath, output.frames);
  console.log(`wrote ${outputPath} (${output.buffer.length} frame mask(s), +${output.buffer.length - tdmask.length})`);
  console.log(`wrote ${tracePath}`);
  console.log(
    `inserted masks: ${insertions.map((insertion) => String(insertion.missingFrames)).join(" + ")} = ` +
      `${output.buffer.length - tdmask.length}`,
  );
}

main();
