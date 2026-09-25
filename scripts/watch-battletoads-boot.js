#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { setInterval, clearInterval } = require("node:timers");

const DEFAULT_LOG = path.resolve(__dirname, "../logs/trace/boot-timing.log");
// Reference tables: docs/design/battletoads-real-cartridge.md and the 2026-09-23
// research sweeps, which ran every modeled power-on state at each Start delay.
// These are model predictions, not measured cartridge odds. They hold for an
// original cartridge and for the EverDrive v2 D and v5 ROMs, not for the plain
// ROM on an EverDrive, whose work RAM breaks level 3 and the game-end glitch.
// Each row: rounded title gaps, first title gap in cycles, gameplay gap difference,
// verdict, explanation.
const TABLES = {
  "battletoads_geg.r08": {
    1: [
      ["12/10/13", 356886, 306, "GOOD", "matches a winning GEG model class"],
      ["12/10/13", 357205, 306, "BAD", "model predicts a race-level stall"],
      ["12/11/13", 357205, 306, "MAYBE", "two of the three start states behind this fingerprint win"],
      ["12/11/13", 356886, 306, "BAD", "model predicts a race-level stall"],
      ["12/11/14", 357205, 306, "BAD", "model predicts a speeder-bike loss"],
      ["12/11/14", 356886, 306, "BAD", "model predicts a race-level stall"],
      ["13/11/14", 386985, 306, "MAYBE", "winning and losing states share this fingerprint"],
      ["13/11/14", 386983, 296, "BAD", "model predicts the Dark Queen taunt or a race-level stall"],
    ],
    4: [
      ["13/10/13", 387143, 296, "GOOD", "matches a winning GEG model class"],
      ["13/10/13", 387143, 302, "BAD", "model predicts a speeder-bike loss"],
      ["12/10/13", 356822, 306, "GOOD", "matches a winning GEG model class"],
      ["12/10/13", 357359, 302, "BAD", "model predicts a speeder-bike loss"],
      ["12/10/14", 356828, 306, "BAD", "model predicts a race-level stall"],
      ["12/11/13", 356827, 306, "MAYBE", "this fingerprint includes wins and losses (34/45 model states won)"],
      ["12/11/13", 356826, 302, "BAD", "model predicts a speeder-bike loss"],
      ["12/11/13", 357359, 302, "BAD", "model predicts a speeder-bike loss"],
      ["12/11/13", 357359, 296, "BAD", "model predicts a speeder-bike loss"],
      ["12/11/14", 356828, 306, "BAD", "model predicts a speeder-bike loss"],
      ["13/11/13", 387143, 306, "BAD", "model predicts a race-level stall"],
    ],
  },
  "battletoads_2p_warp.r08": {
    1: [
      ["13/10/13", 386985, 306, "GOOD", "matches a winning warps reference"],
      ["13/10/13", 386983, 296, "BAD", "model predicts a level-3 stall"],
      ["12/10/13", 356886, 306, "GOOD", "matches a winning warps reference"],
      ["12/10/13", 356886, 296, "BAD", "model predicts a level-3 stall"],
      ["12/10/13", 357205, 306, "BAD", "model predicts a level-3 stall"],
      ["12/11/13", 357205, 306, "MAYBE", "one of the three start states behind this fingerprint wins; the others die at Robo-Manus or in level 3"],
      ["12/11/13", 356886, 306, "BAD", "model predicts a level-3 stall"],
      ["12/11/14", 357205, 306, "BAD", "model predicts a Robo-Manus loss"],
    ],
  },
  "battletoads_2p.r08": {
    1: [
      ["13/10/13", 386985, 306, "GOOD", "matches the winning warpless start state (the v5 target)"],
      ["13/10/13", 386983, 296, "BAD", "model predicts a loss in level 1 or 3"],
      ["12/10/13", 356886, 306, "GOOD", "matches a winning warpless start state"],
      ["12/10/13", 356886, 296, "BAD", "model predicts a level-1 loss"],
      ["12/10/13", 357205, 306, "BAD", "model predicts a level-1 loss"],
      ["12/11/13", 357205, 306, "MAYBE", "one of the three start states behind this fingerprint wins; the others fail in level 1"],
      ["12/11/13", 356886, 306, "BAD", "model predicts a level-1 loss"],
      ["12/11/14", 357205, 306, "BAD", "model predicts a level-1 loss"],
    ],
  },
};
// A Reset-button launch (such as the EverDrive-to-cartridge swap used for Golf
// and R.B.I. Baseball) can lack the extra boot latch a power-on produces. The
// log then starts at the game's first poll, so Start delay d gives the game the
// boot that power-on delay d+1 gives it, with every gap one index earlier. The
// cold intro's blank polls are 4, 8 and 1 frames apart; a warm boot (RAM kept
// `$FD` = `$28`) polls every frame instead.
const INTRO_POLL_GAPS = [4, 8, 1];

// Heuristic tolerances for residual clock wander and micros() quantization after
// per-boot calibration. They are not statistical confidence bounds. Overlapping
// outcomes stay MAYBE.
const FIRST_GAP_TOLERANCE = 120;
const DIFFERENCE_TOLERANCE = 4;

// Per-boot clock calibration. The bridge converts Arduino micros() with one fixed
// factor, but the remaining error wandered from +110 to +370 ppm between boots
// minutes apart on 2026-09-23: up to ~150 cycles on a 13-frame title gap. Every
// modeled trajectory in the tables spends 405,344 cycles (+/-2), or exactly one
// frame more, from the ~9.6-frame gap after the title through the next four
// gameplay gaps, so scaling that span to the model removes the error.
const CALIBRATION_SPANS = [405344, 435124];
const CALIBRATION_GAPS = 5;
const MAX_CLOCK_ERROR = 0.001;
const CYCLES_PER_FRAME = 29780.5;
const MAYBE_TITLE = "13/10/13";

// scripts/boot-timing-test/build.py SCHEDULE: the test ROM's cycle-exact read gaps,
// which the log reports as gaps 2 onward. Gap 1 (power-on latch to first read) is
// not comparable.
const TIMING_TEST_MOVIE = "boot_timing_test.r08";
const TIMING_TEST_SCHEDULE = [386985, 328925, 415412, 285769, 29540, 29846, 29897, 30292, 29543,
  29846, 29898, 30287, 29546, 29840, 29903, 30290, 29543, 29844, 29900];

function parseBootLine(line) {
  const match = line.match(/^(\S+) (.+) delay=(\d+) Boot timing from latch (\d+): gaps in frames ([\d. ]+); in CPU cycles ([\d ]+)\s*$/);
  if (!match) {
    return null;
  }
  const [, timestamp, movie, delayText, latchText, framesText, cyclesText] = match;
  const frames = framesText.trim().split(/\s+/).map(Number);
  const cycles = cyclesText.trim().split(/\s+/).map(Number);
  const consistent = Number(latchText) === 1 && frames.length === cycles.length &&
    frames.every((value) => Number.isFinite(value) && value > 0) &&
    cycles.every((value) => Number.isSafeInteger(value) && value > 0) &&
    frames.every((value, index) => Math.abs(value - cycles[index] / CYCLES_PER_FRAME) <= 0.02);
  return { timestamp, movie, delay: Number(delayText), frames, cycles, consistent };
}

function classifyBootLine(line) {
  if (!line.includes("Boot timing")) {
    return null;
  }
  const parsed = parseBootLine(line);
  if (!parsed) {
    return { verdict: "UNKNOWN", reason: "unrecognized boot-timing line; expected the saved log format" };
  }
  const { timestamp, movie, delay, frames, cycles, consistent } = parsed;
  const result = { timestamp, movie, delay, verdict: "UNKNOWN" };
  if (movie.toLowerCase() === TIMING_TEST_MOVIE) {
    return checkTimingTest(parsed, result);
  }
  // "Battletoads_GEG+tail1830R.r08" and similar variants add input after the
  // movie's last record only, so they share the original's boot fingerprints.
  const byDelay = TABLES[movie.toLowerCase().replace(/\+[^.]*(\.r08)$/, "$1")];
  if (!byDelay) {
    return { ...result, reason: "no reference table for this movie and Start delay" };
  }
  // At delay 1, title gaps are 2-4, gap 5 is ~9.6 frames and gameplay starts at
  // gap 6; the difference is gap 7 minus 6. Each additional blank shifts those
  // indices by one (delay 4: title 5-7, difference gap 10 minus 9). Without the
  // boot latch the ~1,163-frame startup gap is missing and the same Start delay
  // lands the title one gap earlier, at the same index as the delay itself.
  if (!consistent || frames.length < delay + 3 + CALIBRATION_GAPS) {
    return { ...result, reason: "incomplete or inconsistent timing data; need the first latches" };
  }
  const bootLatch = frames[0] >= 900;
  if (bootLatch && delay === 0) {
    return { ...result, reason: "this launch has the extra boot latch before the title (gap 1 is the startup gap); use Start delay 1" };
  }
  if (!bootLatch && frames.slice(0, Math.min(delay, INTRO_POLL_GAPS.length)).some((value, index) =>
    Math.round(value) !== INTRO_POLL_GAPS[index])) {
    return { ...result, reason: "short startup gap without the cold intro's polls: a warm boot. Power off longer, or clear $FD before a Reset launch" };
  }
  const equivalentDelay = bootLatch ? delay : delay + 1;
  const table = byDelay[equivalentDelay];
  if (!table) {
    if (bootLatch) {
      return { ...result, reason: "no reference table for this movie and Start delay" };
    }
    const alternatives = Object.keys(byDelay).map((value) => Number(value) - 1).join(" or ");
    return {
      ...result,
      reason: `no boot latch before the game's first poll (a Reset launch), so Start delay ${delay} acts like power-on delay ${equivalentDelay}, which has no table; use Start delay ${alternatives}`,
    };
  }
  const launchNote = bootLatch ? "" : ` (no boot latch: read as power-on delay ${equivalentDelay})`;
  const measuredSpan = cycles.slice(delay + 3, delay + 3 + CALIBRATION_GAPS).reduce((sum, value) => sum + value, 0);
  const expectedSpan = CALIBRATION_SPANS.reduce((best, span) =>
    Math.abs(span - measuredSpan) < Math.abs(best - measuredSpan) ? span : best);
  const scale = expectedSpan / measuredSpan;
  if (Math.abs(scale - 1) > MAX_CLOCK_ERROR) {
    return { ...result, reason: "post-title gaps do not match the modeled boot path; cannot calibrate this boot" };
  }
  const scaled = cycles.map((value) => value * scale);
  const title = scaled.slice(delay, delay + 3).map((value) => Math.round(value / CYCLES_PER_FRAME)).join("/");
  const firstCycles = Math.round(scaled[delay]);
  const difference = Math.round(scaled[delay + 5] - scaled[delay + 4]);
  const clockPpm = Math.round((scale - 1) * 1e6);
  const measured = { ...result, title, firstCycles, difference, clockPpm };
  const matches = table.filter(([gaps, first, diff]) => gaps === title &&
    Math.abs(firstCycles - first) <= FIRST_GAP_TOLERANCE &&
    Math.abs(difference - diff) <= DIFFERENCE_TOLERANCE);
  if (matches.length === 0) {
    return {
      ...measured,
      verdict: "OFF-MODEL",
      reason: `no modeled power-on state produces this title timing, so the model cannot predict this boot${launchNote}`,
    };
  }
  const verdicts = new Set(matches.map((row) => row[3]));
  const [verdict, reason] = verdicts.size > 1
    ? ["MAYBE", "measurement tolerance overlaps different model outcomes"]
    : [matches[0][3], matches[0][4]];
  // MAYBE only fires on a 13/10/13 title, the GOOD fingerprint's title; the
  // losing twin there dies to the speeder-bike enemy before the glitch, so the
  // attempt shows itself early. Other ambiguous fingerprints are skipped.
  if (verdict === "MAYBE" && title !== MAYBE_TITLE) {
    return { ...measured, verdict: "SKIP", reason: `ambiguous (${reason}); MAYBE only fires on ${MAYBE_TITLE} titles${launchNote}` };
  }
  return { ...measured, verdict, reason: `${reason}${launchNote}` };
}

// The test ROM reads at gaps it controls to the cycle, so the log should equal the
// schedule up to TASDeck's clock scale. Fitting measured = k * (expected + offset)
// estimates that scale and any fixed per-gap offset from the data instead of
// assuming them; an offset common to every latch cancels in gaps and cannot
// matter. The gap from the last Start delay latch to the first playback latch is
// held out of the fit and reported on its own: before firmware v76 it read about
// 13 us long.
function checkTimingTest({ frames, cycles, consistent, delay }, result) {
  if (!consistent || frames.length < 8) {
    return { ...result, reason: "incomplete or inconsistent timing data; need the first latches" };
  }
  const switchIndex = delay - 1;
  const points = [];
  let switchPoint = null;
  for (let index = 1; index < cycles.length && index - 1 < TIMING_TEST_SCHEDULE.length; index += 1) {
    const expected = TIMING_TEST_SCHEDULE[index - 1];
    // Sigma: micros() quantization plus clock wander within one boot.
    const point = { gap: index + 1, expected, measured: cycles[index], sigma: 2 + 5e-5 * expected };
    if (index === switchIndex) {
      switchPoint = point;
    } else {
      points.push(point);
    }
  }
  let w = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { expected: x, measured: y, sigma } of points) {
    const weight = 1 / (sigma * sigma);
    w += weight;
    sx += weight * x;
    sy += weight * y;
    sxx += weight * x * x;
    sxy += weight * x * y;
  }
  const determinant = w * sxx - sx * sx;
  const slope = (w * sxy - sx * sy) / determinant;
  const intercept = (sxx * sy - sx * sxy) / determinant;
  const residualOf = ({ expected, measured }) => measured / slope - intercept / slope - expected;
  const chi2 = points.reduce((sum, point) => sum + (residualOf(point) / point.sigma) ** 2, 0);
  const offset = intercept / slope;
  const offsetError = Math.sqrt((sxx / determinant) * Math.max(1, chi2 / (points.length - 2))) / slope;
  const worst = points.reduce((best, point) =>
    Math.abs(residualOf(point)) / point.sigma > Math.abs(residualOf(best)) / best.sigma ? point : best);
  const problems = [];
  const clockPpm = Math.round((1 / slope - 1) * 1e6);
  if (Math.abs(offset) > Math.max(3, 3 * offsetError)) {
    problems.push(`every gap carries a ${signed(offset.toFixed(1))}-cycle offset`);
  }
  for (const point of points) {
    if (Math.abs(residualOf(point)) > 3 * point.sigma) {
      problems.push(`gap ${point.gap} is ${signed(Math.round(residualOf(point)))} cycles off`);
    }
  }
  let switchText = "Start delay 1 hides the delay-to-playback gap in gap 1; use Start delay 6 to test it";
  if (switchPoint) {
    const switchResidual = Math.round(residualOf(switchPoint));
    switchText = `delay-to-playback gap ${switchPoint.gap} ${signed(switchResidual)} cycles`;
    if (Math.abs(switchResidual) > 3 * switchPoint.sigma) {
      problems.push(`the delay-to-playback gap ${switchPoint.gap} is ${signed(switchResidual)} cycles off (firmware before v76 stamps it late)`);
    }
  }
  const summary = `clock ${signed(clockPpm)} ppm beyond the fixed correction; per-gap offset ${signed(offset.toFixed(1))} +/- ${offsetError.toFixed(1)} cycles; ` +
    `worst gap ${worst.gap} ${signed(Math.round(residualOf(worst)))} cycles; ${switchText}`;
  if (problems.length > 0) {
    return { ...result, verdict: "FAIL", reason: `${problems.join("; ")}. ${summary}` };
  }
  return { ...result, verdict: "PASS", reason: `TASDeck's gaps match the ROM's cycle-exact reads. ${summary}` };
}

function signed(value) {
  return Number(value) >= 0 ? `+${value}` : `${value}`;
}

function formatVerdict(result) {
  const attempt = result.movie ? `${result.timestamp} ${result.movie} delay=${result.delay}: ` : "";
  const timing = result.title
    ? ` [title ${result.title}; first ${result.firstCycles} cycles; difference ${signed(result.difference)}; clock ${signed(result.clockPpm)} ppm]`
    : "";
  return `[${result.verdict}] ${attempt}${result.reason}${timing}`;
}

// Poll by filename so the watcher also works before the bridge creates the file,
// and after log rotation or truncation. Only complete lines are emitted.
function createLogReader(filePath, { fromStart = false } = {}) {
  let initialized = false;
  let identity = null;
  let position = 0;
  let pending = "";
  let decoder = new StringDecoder("utf8");
  return function readNewLines() {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      initialized = true;
      identity = null;
      return [];
    }
    try {
      const stat = fs.fstatSync(fd);
      const currentIdentity = `${stat.dev}:${stat.ino}`;
      if (!initialized && !fromStart) {
        position = stat.size;
      } else if (identity !== currentIdentity || stat.size < position) {
        position = 0;
        pending = "";
        decoder = new StringDecoder("utf8");
      }
      initialized = true;
      identity = currentIdentity;
      const lines = [];
      const buffer = Buffer.alloc(65536);
      while (position < stat.size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (count === 0) {
          break;
        }
        position += count;
        pending += decoder.write(buffer.subarray(0, count));
        const pieces = pending.split("\n");
        pending = pieces.pop();
        lines.push(...pieces.map((line) => line.replace(/\r$/, "")));
      }
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  };
}

function main(args) {
  let filePath = DEFAULT_LOG;
  let once = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") {
      console.log("Usage: node scripts/watch-battletoads-boot.js [--log PATH] [--once]\nWithout --once, follows new attempts only. --once classifies the existing log and exits.");
      return;
    }
    if (args[index] === "--once") {
      once = true;
    } else if (args[index] === "--log" && args[index + 1] && !args[index + 1].startsWith("--")) {
      filePath = path.resolve(args[++index]);
    } else {
      throw new Error(`Unknown or incomplete option: ${args[index]}`);
    }
  }
  console.log(`Battletoads boot predictions: EverDrive v5 / v2 D ROM, unchanged R08, per-strobe, Skip first 0.\nGOOD = promising; BAD = predicted loss; MAYBE = ambiguous 13/10/13 title, worth playing;\nSKIP = other ambiguous fingerprint; OFF-MODEL = no modeled state matches; UNKNOWN = no prediction. ${TIMING_TEST_MOVIE} runs get a PASS/FAIL timing check.\nThese are model predictions, not guarantees. On an original cartridge the published\nBattletoads_GEG.r08 lands on the Dark Queen even from GOOD boots; use a +tail variant.`);
  const readNewLines = createLogReader(filePath, { fromStart: once });
  function poll() {
    for (const line of readNewLines()) {
      const result = classifyBootLine(line);
      if (result) {
        console.log(formatVerdict(result));
      }
    }
  }
  poll();
  if (!once) {
    console.log(`Watching ${filePath}\nWaiting for NEW attempts (about 20 seconds after NES power-on). Ctrl+C stops this watcher.`);
    const timer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        clearInterval(timer);
        console.error(`Boot watcher: ${error.message}`);
        process.exitCode = 1;
      }
    }, 500);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Boot watcher: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { classifyBootLine, createLogReader, formatVerdict, TIMING_TEST_SCHEDULE };
