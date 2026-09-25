const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { setTimeout, clearTimeout } = require("node:timers");
const test = require("node:test");
const {
  classifyBootLine,
  createLogReader,
  formatVerdict,
  TIMING_TEST_SCHEDULE,
} = require("../../../scripts/watch-battletoads-boot.js");

const script = path.resolve(path.dirname(module.filename), "../../../scripts/watch-battletoads-boot.js");
const timingTestBuilder = path.resolve(path.dirname(module.filename), "../../../scripts/boot-timing-test/build.py");

// `clock` is the per-boot error, in ppm, left after the bridge's fixed micros()
// correction: the logged cycles run that much short of the console's.
function logLine({ movie, delay, startup = 1163, clock = 0 }, model) {
  const cycles = model.map((value) => Math.round(value / (1 + clock / 1e6)));
  cycles[0] = Math.round(startup * 29780.5);
  const frames = cycles.map((value) => (value / 29780.5).toFixed(2));
  return `2026-09-24T00:03:50.575Z ${movie} delay=${delay} Boot timing from latch 1: gaps in frames ${frames.join(" ")}; in CPU cycles ${cycles.join(" ")}`;
}

function bootLine({
  movie = "Battletoads_GEG.r08", delay = 1, title = [12, 10, 13],
  first = 356886, difference = 306, startup = 1163, clock = 0,
} = {}) {
  const model = Array(15).fill(29780);
  // The cold intro's blank polls before the title.
  [119286, 237915, 30005].slice(0, Math.max(0, delay - 1)).forEach((value, index) => { model[index + 1] = value; });
  title.forEach((frames, index) => { model[delay + index] = Math.round(frames * 29780.5); });
  model[delay] = first;
  // The ~9.6-frame gap after the title and the first gameplay frames, as modeled.
  model[delay + 3] = 285769;
  model[delay + 4] = 29540;
  model[delay + 5] = 29540 + difference;
  model[delay + 6] = 29897;
  model[delay + 7] = 30292;
  return logLine({ movie, delay, startup, clock }, model);
}

// A boot_timing_test.r08 capture: gap 1 is power-on, gaps 2 onward follow the
// ROM's schedule. `offset` adds cycles to every gap, `switchExtra` to the gap
// from the last Start delay latch to the first playback latch (gap `delay`).
function timingTestLine({ delay = 6, clock = 0, offset = 0, switchExtra = 0 } = {}) {
  const model = [0, ...TIMING_TEST_SCHEDULE.slice(0, 14)].map((value, index) =>
    // +/-1 cycle of micros() quantization.
    value + (index > 0 ? offset + [1, -1, 0][index % 3] : 0) + (index === delay - 1 ? switchExtra : 0));
  return logLine({ movie: "boot_timing_test.r08", delay, clock }, model);
}

function tempLog(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasdeck-boot-watcher-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "boot-timing.log");
}

test("GEG delay 1 separates the winning and losing 12/10/13 classes", () => {
  assert.equal(classifyBootLine(bootLine()).verdict, "GOOD");
  assert.equal(classifyBootLine(bootLine({ first: 357205 })).verdict, "BAD");
  // Ambiguous fingerprints without a 13/10/13 title are skipped, not MAYBE.
  for (const options of [
    { title: [12, 11, 13], first: 357205 },
    { title: [13, 11, 14], first: 386985 },
  ]) {
    const result = classifyBootLine(bootLine(options));
    assert.equal(result.verdict, "SKIP");
    assert.match(result.reason, /MAYBE only fires on 13\/10\/13 titles/);
  }
});

test("GEG delay 4 reads the shifted title/gameplay gaps and preserves mixed outcomes", () => {
  assert.equal(classifyBootLine(bootLine({ delay: 4, title: [13, 10, 13], first: 387143, difference: 296 })).verdict, "GOOD");
  assert.equal(classifyBootLine(bootLine({ delay: 4, first: 356822 })).verdict, "GOOD");
  assert.equal(classifyBootLine(bootLine({ delay: 4, first: 357359, difference: 302 })).verdict, "BAD");
  const mixed = classifyBootLine(bootLine({ delay: 4, title: [12, 11, 13], first: 356827, difference: 309 }));
  assert.equal(mixed.verdict, "SKIP");
  assert.match(mixed.reason, /34\/45/);
});

test("measurement overlap stays MAYBE instead of arbitrarily choosing a nearby class", () => {
  const result = classifyBootLine(bootLine({ delay: 4, title: [13, 10, 13], first: 387143, difference: 299 }));
  assert.equal(result.verdict, "MAYBE");
  assert.match(result.reason, /overlaps/);
});

test("timings no modeled state produces are OFF-MODEL, not forced to the nearest class", () => {
  for (const options of [{ first: 358000 }, { difference: 330 }, { title: [12, 12, 13] }]) {
    const result = classifyBootLine(bootLine(options));
    assert.equal(result.verdict, "OFF-MODEL", JSON.stringify(options));
    assert.match(result.reason, /cannot predict/);
  }
});

test("per-boot calibration recovers fingerprints the fixed clock correction pushes out of tolerance", () => {
  // 2026-09-23 boots needed +110 to +370 ppm beyond the fixed correction. At
  // +370 ppm the raw first title gap reads 132 cycles short of the model.
  for (const clock of [-370, 0, 370]) {
    const result = classifyBootLine(bootLine({ delay: 4, first: 356822, clock }));
    assert.equal(result.verdict, "GOOD", `clock ${clock}`);
    assert.ok(Math.abs(result.clockPpm - clock) <= 3, `clock ${clock} estimated ${result.clockPpm}`);
    assert.ok(Math.abs(result.firstCycles - 356822) <= 3);
  }
  assert.match(formatVerdict(classifyBootLine(bootLine({ clock: 250 }))), /clock \+2[45]\d ppm\]$/);
});

test("a boot whose post-title gaps do not fit the model is not calibrated", () => {
  const line = bootLine().replace(/in CPU cycles (.*)$/, (match, cycles) => {
    const values = cycles.split(" ").map(Number);
    values[4] += 2000;
    return `in CPU cycles ${values.join(" ")}`;
  }).replace(/gaps in frames (.*);/, (match, frames) => {
    const values = frames.split(" ");
    values[4] = (Number(values[4]) + 2000 / 29780.5).toFixed(2);
    return `gaps in frames ${values.join(" ")};`;
  });
  const result = classifyBootLine(line);
  assert.equal(result.verdict, "UNKNOWN");
  assert.match(result.reason, /cannot calibrate/);
});

test("the 2026-09-23 hardware log classifies as analyzed", () => {
  const lines = {
    // EverDrive v5 on target: shares its delay-1 fingerprint with a losing state.
    SKIP: "2026-09-23T23:32:05.821Z Battletoads_GEG.r08 delay=1 Boot timing from latch 1: gaps in frames 1291.57 12.99 11.04 13.94 9.59 0.99 1.00 1.00 1.02 0.99 1.00 1.00 1.02 0.99 1.00; in CPU cycles 38463615 386897 328803 415284 285697 29532 29838 29888 30284 29535 29836 29888 30279 29539 29833",
    // Cartridge, the watcher's first GOOD (it lost): still GOOD after calibration.
    GOOD: "2026-09-24T02:07:27.286Z Battletoads_GEG.r08 delay=4 Boot timing from latch 1: gaps in frames 1162.71 4.00 7.99 1.01 13.00 10.04 12.95 9.59 0.99 1.00 1.00 1.02 0.99 1.00 1.00; in CPU cycles 34625983 119266 237863 30019 387069 298868 385542 285696 29537 29833 29892 30286 29539 29836 29890",
    // Cartridge: title timing no modeled state produces.
    "OFF-MODEL": "2026-09-24T02:05:26.181Z Battletoads_GEG.r08 delay=4 Boot timing from latch 1: gaps in frames 1162.63 4.00 7.99 1.01 12.98 10.05 12.95 9.59 0.99 1.00 1.00 1.02 0.99 1.00 1.00; in CPU cycles 34623720 119265 237877 30023 386546 299408 385557 285723 29533 29842 29892 30288 29541 29840 29895",
  };
  for (const [verdict, line] of Object.entries(lines)) {
    assert.equal(classifyBootLine(line).verdict, verdict, line.slice(0, 60));
  }
  // UNKNOWN under the fixed correction; +242 ppm puts it back on a modeled class.
  const rescued = classifyBootLine("2026-09-24T02:02:50.552Z Battletoads_GEG.r08 delay=4 Boot timing from latch 1: gaps in frames 1162.58 4.00 7.99 1.01 11.98 11.05 12.95 9.59 0.99 1.00 1.00 1.02 0.99 1.00 1.00; in CPU cycles 34622165 119250 237834 30016 356690 329142 385528 285701 29533 29838 29890 30284 29539 29838 29890");
  assert.equal(rescued.verdict, "SKIP");
  assert.equal(rescued.clockPpm, 242);
});

// A Reset launch without the power-on boot latch: drop the startup gap and
// lower the Start delay by one, which gives the game the same boot.
function withoutBootLatch(line, delay) {
  return line.replace(/delay=\d+ /, `delay=${delay} `)
    .replace(/(gaps in frames )\S+ /, "$1").replace(/(in CPU cycles )\d+ /, "$1");
}

test("a Reset launch without the boot latch reads as power-on delay + 1", () => {
  const zero = classifyBootLine(withoutBootLatch(bootLine({ clock: 200 }), 0));
  assert.equal(zero.verdict, "GOOD", zero.reason);
  assert.equal(zero.title, "12/10/13");
  assert.match(zero.reason, /no boot latch: read as power-on delay 1/);
  const three = classifyBootLine(withoutBootLatch(
    bootLine({ delay: 4, title: [13, 10, 13], first: 387143, difference: 296, clock: 300 }), 3));
  assert.equal(three.verdict, "GOOD", three.reason);
  assert.match(three.reason, /read as power-on delay 4/);
  // Start delay 4 without the boot latch is power-on delay 5: no table.
  const four = classifyBootLine(withoutBootLatch(bootLine({ delay: 5 }), 4));
  assert.equal(four.verdict, "UNKNOWN");
  assert.match(four.reason, /Start delay 4 acts like power-on delay 5.*use Start delay 0 or 3/);
});

test("a power-on boot latch at Start delay 0, and warm boots, get the right advice", () => {
  const withBootLatch = classifyBootLine(bootLine({ delay: 1 }).replace(/delay=1 /, "delay=0 "));
  assert.equal(withBootLatch.verdict, "UNKNOWN");
  assert.match(withBootLatch.reason, /use Start delay 1/);
  // Warm boot: the intro polls every frame instead of 4, 8 and 1 frames apart.
  const warm = bootLine({ delay: 4, startup: 1 }).replace(/(in CPU cycles )(\d+ ){4}/, "$129780 29780 29780 29780 ")
    .replace(/(gaps in frames )(\S+ ){4}/, "$11.00 1.00 1.00 1.00 ");
  const result = classifyBootLine(warm);
  assert.equal(result.verdict, "UNKNOWN");
  assert.match(result.reason, /warm boot/);
});

test("+tail variants of a movie use the original movie's tables", () => {
  const result = classifyBootLine(bootLine({ movie: "Battletoads_GEG+tail1830R.r08", delay: 4, title: [13, 10, 13], first: 387143, difference: 296 }));
  assert.equal(result.verdict, "GOOD");
  assert.match(formatVerdict(result), /Battletoads_GEG\+tail1830R\.r08 delay=4/);
});

test("timing test ROM passes when only TASDeck's clock scale differs", () => {
  const result = classifyBootLine(timingTestLine({ clock: 250 }));
  assert.equal(result.verdict, "PASS", result.reason);
  assert.match(result.reason, /clock \+2[45]\d ppm/);
  assert.match(result.reason, /delay-to-playback gap 6 [+-][0-2] cycles/);
});

test("timing test ROM fits a fixed per-gap offset instead of assuming none", () => {
  const result = classifyBootLine(timingTestLine({ clock: 250, offset: 8 }));
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /every gap carries a \+[78]\.\d-cycle offset/);
});

test("timing test ROM catches a late first playback latch after the Start delay", () => {
  // Firmware before v76 stamped the first fast-path latch ~13 us (24 cycles) late.
  const result = classifyBootLine(timingTestLine({ switchExtra: 24 }));
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /delay-to-playback gap 6 is \+2\d cycles off \(firmware before v76/);
  assert.doesNotMatch(result.reason, /every gap carries/);
});

test("timing test ROM at Start delay 1 still checks the schedule but notes the hidden gap", () => {
  const result = classifyBootLine(timingTestLine({ delay: 1, clock: -120 }));
  assert.equal(result.verdict, "PASS", result.reason);
  assert.match(result.reason, /use Start delay 6/);
});

test("timing test schedule matches the ROM builder", () => {
  const source = fs.readFileSync(timingTestBuilder, "utf8");
  const schedule = source.match(/^SCHEDULE = \[([\d,\s]+)\]/m)[1].split(",").map((value) => Number(value.trim()));
  assert.deepEqual(TIMING_TEST_SCHEDULE, schedule);
});

test("warps accepts observed clock error and identifies modeled losses", () => {
  const movie = "battletoads_2p_warp.r08";
  const good = classifyBootLine(bootLine({ movie, title: [13, 10, 13], first: 386897, difference: 307 }));
  assert.equal(good.verdict, "GOOD");
  assert.equal(classifyBootLine(bootLine({ movie, title: [13, 10, 13], first: 386983, difference: 296 })).verdict, "BAD");
  assert.equal(classifyBootLine(bootLine({ movie, title: [12, 11, 14], first: 357205 })).verdict, "BAD");
  assert.equal(classifyBootLine(bootLine({ movie, title: [12, 11, 13], first: 357205 })).verdict, "SKIP");
  assert.match(formatVerdict(good), /^\[GOOD\].*battletoads_2p_warp.r08 delay=1:.*title 13\/10\/13.*difference \+307/);
});

test("warpless separates winning, losing and mixed fingerprints", () => {
  const movie = "battletoads_2p.r08";
  for (const options of [{}, { title: [13, 10, 13], first: 386895, difference: 305 }]) {
    assert.equal(classifyBootLine(bootLine({ movie, ...options })).verdict, "GOOD");
  }
  assert.equal(classifyBootLine(bootLine({ movie, first: 357179, difference: 308 })).verdict, "BAD");
  assert.equal(classifyBootLine(bootLine({ movie, title: [12, 11, 13], first: 357205 })).verdict, "SKIP");
});

test("unsupported movies/delays, warm starts and incomplete data receive no prediction", () => {
  for (const line of [
    bootLine({ movie: "another.r08" }),
    bootLine({ movie: "battletoads_2p_warp.r08", delay: 4 }),
    bootLine({ delay: 2 }),
    bootLine({ startup: 4 }),
    bootLine().replace("from latch 1:", "from latch 2:"),
    bootLine().replace(/in CPU cycles .*/, "in CPU cycles 20 30"),
    bootLine().replace("gaps in frames ", "gaps in frames 1.2.3 "),
    "Boot timing capture failed: disconnected",
  ]) {
    assert.equal(classifyBootLine(line).verdict, "UNKNOWN", line);
  }
  assert.equal(classifyBootLine("ordinary unrelated log entry"), null);
});

test("reader waits for file creation and complete lines, then reads each append once", (t) => {
  const file = tempLog(t);
  const read = createLogReader(file);
  assert.deepEqual(read(), []);
  const line = bootLine();
  fs.writeFileSync(file, line.slice(0, 70));
  assert.deepEqual(read(), []);
  fs.appendFileSync(file, `${line.slice(70)}\n${line}\n`);
  assert.deepEqual(read(), [line, line]);
  assert.deepEqual(read(), []);
});

test("reader skips old attempts by default and can read history explicitly", (t) => {
  const file = tempLog(t);
  fs.writeFileSync(file, "old\n");
  const read = createLogReader(file);
  assert.deepEqual(read(), []);
  fs.appendFileSync(file, "new\r\n");
  assert.deepEqual(read(), ["new"]);
  assert.deepEqual(createLogReader(file, { fromStart: true })(), ["old", "new"]);
});

test("reader follows a replacement log and an observed truncation", (t) => {
  const file = tempLog(t);
  fs.writeFileSync(file, "old\nunfinished");
  const read = createLogReader(file, { fromStart: true });
  assert.deepEqual(read(), ["old"]);
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, "replacement\n");
  assert.deepEqual(read(), ["replacement"]);
  fs.truncateSync(file, 0);
  assert.deepEqual(read(), []);
  fs.appendFileSync(file, "after truncate\n");
  assert.deepEqual(read(), ["after truncate"]);
});

test("CLI --once classifies a saved log and exits", (t) => {
  const file = tempLog(t);
  fs.writeFileSync(file, `${bootLine()}\n${bootLine({ first: 357205 })}\n`);
  const stdout = execFileSync(process.execPath, [script, "--log", file, "--once"], { encoding: "utf8" });
  assert.match(stdout, /\[GOOD\]/);
  assert.match(stdout, /\[BAD\]/);
  assert.doesNotMatch(stdout, /Waiting for NEW/);
});

test("live CLI prints a verdict when the bridge creates its first log entry", async (t) => {
  const file = tempLog(t);
  const child = spawn(process.execPath, [script, "--log", file], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const output = await new Promise((resolve, reject) => {
    let stdout = "";
    let written = false;
    const timer = setTimeout(() => reject(new Error(`watcher did not produce a verdict: ${stdout}`)), 5000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!written && stdout.includes("Waiting for NEW")) {
        written = true;
        fs.writeFileSync(file, `${bootLine()}\n`);
      }
      if (stdout.includes("[GOOD]")) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`watcher exited early (${code}): ${stdout}`));
    });
  });
  assert.match(output, /Battletoads_GEG.r08 delay=1/);
});
