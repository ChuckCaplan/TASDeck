#!/usr/bin/env node
"use strict";

// Converts BizHawk .bk2 movies to TASDeck .r08/.tdmask files and checks how a file plays, using
// BizHawk's own NES core built from source on first use (no BizHawk install, any OS with Node and
// git). See docs/design/bizhawk-harness.md.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");
const { cacheRoot, ensureHarness } = require("./bizhawk-harness/build.js");
const { DEFAULT_PROFILE, PROFILES, profileForMovie } = require("./bizhawk-harness/profiles.js");
const movieFormats = require("./bizhawk-harness/movie.js");
const checks = require("./bizhawk-harness/check.js");

const USAGE = `usage:
  npm run bk2 -- convert <movie.bk2> <rom.nes> [--out-dir DIR]
  npm run bk2 -- check <movie.bk2> <rom.nes> [--file FILE.r08|FILE.tdmask] [check options]
  npm run bk2 -- check <rom.nes> --file FILE.r08|FILE.tdmask [check options]
  npm run bk2 -- setup
  npm run bk2 -- clean

convert writes <movie>.r08 (one record per latch), <movie>.tdmask and its .trace.csv (one mask per
polled frame, like the Windows converter), and <movie>.movie-end.png, the screen the movie ends on.

setup builds the harness ahead of time; clean deletes cached movie runs and check output.

check plays a file the way TASDeck serves it and compares the ending with the movie's, from a
default power-on, from simulated EverDrive menu launches, and with Start delay one off each way.
Without --file it checks the .r08 that convert would write. Without a movie it can only compare
launches with the default power-on run.

options:
  --bizhawk VERSION   BizHawk core to build and use: ${Object.keys(PROFILES).join(", ")} (default: by the movie's version)
  --bios FILE         FDS BIOS (disksys.rom) for Famicom Disk System movies
  --out-dir DIR       where to write outputs (convert: current directory)
  --mode MODE         strobe, poll or latch (default: strobe for .r08, poll for .tdmask)
  --start-delay N     Start delay counted from the game's first latch (default 0); the report
                      gives the matching EverDrive menu value
  --skip-first N      drop N records first, like the UI's Skip first
  --window-us N       latch window for poll/latch mode and the strobe guard (default 8000)
  --overread LEVEL    preadvance, pressed or released after the 8th clock (strobe; default preadvance)
  --guard-until N     serve records below N one per latch window (strobe), like BRIDGE_TAS_GUARD_UNTIL
  --launches N        simulated EverDrive launches (default 8)
  --power-on          also sweep cartridge power-on timing states and all-00/all-FF RAM
  --no-alignment      skip the Start delay one-off runs
  --tail-frames N     frames after the last record to compare (default 600)
  --jobs N            runs at once (default: CPU count - 1)`;

const OPTIONS = {
  bizhawk: { type: "string" },
  bios: { type: "string" },
  "out-dir": { type: "string" },
  file: { type: "string" },
  mode: { type: "string" },
  "start-delay": { type: "string" },
  "skip-first": { type: "string" },
  "window-us": { type: "string" },
  overread: { type: "string" },
  "guard-until": { type: "string" },
  launches: { type: "string" },
  "power-on": { type: "boolean" },
  "no-alignment": { type: "boolean" },
  "tail-frames": { type: "string" },
  jobs: { type: "string" },
  help: { type: "boolean", short: "h" },
};

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function integerOption(values, name, fallback, minimum = 0) {
  if (values[name] === undefined) {
    return fallback;
  }
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < minimum) {
    fail(`--${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function sortInputs(positionals) {
  const movie = positionals.find((file) => file.toLowerCase().endsWith(".bk2"));
  const rom = positionals.find((file) => file !== movie);
  if (positionals.length > 2 || !rom) {
    fail("expected a .bk2 movie and a ROM, or just a ROM with --file");
  }
  for (const file of [movie, rom].filter(Boolean)) {
    if (!fs.existsSync(file)) {
      fail(`file not found: ${file}`);
    }
  }
  return { movie, rom };
}

function hashFiles(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(Buffer.isBuffer(part) ? part : String(part));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function runJob(harness, job, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const jobFile = path.join(dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify({ ...job, gamedb: harness.gamedb, outDir: dir }, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn(harness.dotnet, [harness.dll, jobFile], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`harness job in ${dir} failed (exit ${code})\n${stderr.trim().split("\n").slice(-20).join("\n")}`));
        return;
      }
      resolve(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")));
    });
  });
}

// Runs tasks a few at a time. After a failure it starts no more and waits for the running ones, so
// no harness process outlives the CLI, then rejects with the first error.
async function runAll(tasks, jobs, onDone) {
  const results = new Array(tasks.length);
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure && next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]();
        onDone(index, results[index]);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  if (failure) {
    throw failure.error;
  }
  return results;
}

function log(message) {
  console.log(message);
}

async function prepare(values, movieFile) {
  const movie = movieFile ? movieFormats.readBk2(movieFile) : null;
  const profile = values.bizhawk || (movie ? profileForMovie(movie.header.OriginalEmuVersion || movie.header.emuVersion) : DEFAULT_PROFILE);
  if (!PROFILES[profile]) {
    fail(`unknown --bizhawk ${profile}; choose one of ${Object.keys(PROFILES).join(", ")}`);
  }
  const harness = await ensureHarness(profile, log);
  return { movie, harness };
}

// A movie run depends on the contents of the movie, ROM and BIOS and on the tail length, not on the
// paths that name the files.
function movieCacheKey(movieFile, romFile, tailFrames, biosFile) {
  return hashFiles(fs.readFileSync(movieFile), fs.readFileSync(romFile), tailFrames, biosFile ? fs.readFileSync(biosFile) : "");
}

// Plays the movie once and caches the result by movie, ROM, BIOS and tail length, under a folder for
// the harness build; runs from older builds of the same version are removed.
async function runMovie(harness, movie, movieFile, romFile, values, tailFrames) {
  const build = `${harness.profile}-${hashFiles(fs.readFileSync(harness.dll))}`;
  const moviesRoot = path.join(cacheRoot(), "movies");
  if (fs.existsSync(moviesRoot)) {
    for (const entry of fs.readdirSync(moviesRoot)) {
      if (entry.startsWith(`${harness.profile}-`) && entry !== build) {
        fs.rmSync(path.join(moviesRoot, entry), { recursive: true, force: true });
      }
    }
  }
  const key = movieCacheKey(movieFile, romFile, tailFrames, values.bios);
  const dir = path.join(moviesRoot, build, key);
  const summaryFile = path.join(dir, "summary.json");
  if (!fs.existsSync(summaryFile)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rows.bin"), movieFormats.encodeRows(movie.rows));
    if (movie.syncSettings) {
      fs.writeFileSync(path.join(dir, "SyncSettings.json"), movie.syncSettings);
    }
    const rowWord = movie.core === "SubNESHawk" ? "sub-frame rows" : "frames";
    log(`Playing ${path.basename(movieFile)} on BizHawk ${harness.profile} ${movie.core} (${movie.rows.length.toLocaleString("en-US")} ${rowWord})...`);
    await runJob(
      harness,
      {
        mode: "movie",
        rom: path.resolve(romFile),
        firmware: values.bios ? path.resolve(values.bios) : null,
        syncSettings: movie.syncSettings ? path.join(dir, "SyncSettings.json") : null,
        core: movie.core,
        rows: path.join(dir, "rows.bin"),
        tailFrames,
        checkpointEvery: Math.max(1, Math.ceil(movie.rows.length / 40)),
      },
      dir,
    );
  }
  const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  return {
    dir,
    summary,
    latches: fs.readFileSync(path.join(dir, "latches.bin")),
    frames: movieFormats.decodePolledFrames(fs.readFileSync(path.join(dir, "frames.bin"))),
  };
}

// BizHawk records the hash its game database gives the ROM, which can cover the whole file, so a
// dump with the same PRG and CHR but a different iNES header can differ. Warn, don't stop.
function warnRom(movie, romFile, summary) {
  const expected = [movie.header.SHA1, movie.header.MD5].filter(Boolean).map((value) => value.toUpperCase());
  const computed = String(summary.romHash || "").replace(/^(SHA1|MD5):/i, "").toUpperCase();
  if (expected.length === 0 || expected.includes(computed) || movieFormats.romMatchesMovie(movie.header, fs.readFileSync(romFile))) {
    return;
  }
  console.warn(
    `note: ${path.basename(romFile)} hashes differently from the movie's ROM (${expected[0]}). ` +
      "A different file header alone does this; if the movie's end screen is not the ending, try another dump.",
  );
}

async function convert(values, positionals) {
  const { movie: movieFile, rom: romFile } = sortInputs(positionals);
  if (!movieFile) {
    fail("convert needs a .bk2 movie");
  }
  const { movie, harness } = await prepare(values, movieFile);
  const tailFrames = integerOption(values, "tail-frames", 600, 60);
  const result = await runMovie(harness, movie, movieFile, romFile, values, tailFrames);
  const summary = result.summary;
  warnRom(movie, romFile, summary);
  const outDir = path.resolve(values["out-dir"] || ".");
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(movieFile).replace(/\.bk2$/i, ""));

  fs.writeFileSync(`${base}.r08`, movieFormats.r08FromMasks(result.latches));
  log(`Wrote ${base}.r08: ${summary.latches.toLocaleString("en-US")} records, one per latch.`);
  if (summary.perLatchInputWithinFrame > 0) {
    log(`No .tdmask: input changes between latches inside a frame (first at frame ${summary.firstPerLatchInputFrame}); only the .r08 carries it.`);
  } else {
    const masks = Buffer.from(result.frames.flatMap((frame) => [frame.p1, frame.p2]));
    fs.writeFileSync(`${base}.tdmask`, movieFormats.tdmaskFromMasks(masks, summary.movieFrames));
    fs.writeFileSync(`${base}.tdmask.trace.csv`, movieFormats.traceCsv(result.frames));
    log(`Wrote ${base}.tdmask: ${result.frames.length.toLocaleString("en-US")} polled frames of ${summary.movieFrames.toLocaleString("en-US")}.`);
  }
  fs.copyFileSync(path.join(result.dir, "end.png"), `${base}.movie-end.png`);
  log(`Wrote ${base}.movie-end.png: the screen ${tailFrames} frames after the last input. It should show the game's ending.`);
  for (const note of checks.movieNotes(summary)) {
    log(`- ${note}`);
  }
}

async function check(values, positionals) {
  const { movie: movieFile, rom: romFile } = sortInputs(positionals);
  if (!movieFile && !values.file) {
    fail("check needs a .bk2 movie, a --file to play, or both");
  }

  // Settings first, so a check the bridge could not play fails before anything is built or run.
  const stream = values.file ? movieFormats.readStream(values.file) : null;
  const format = stream ? stream.format : "r08";
  const mode = values.mode || (format === "r08" ? "strobe" : "poll");
  if (!["strobe", "poll", "latch"].includes(mode)) {
    fail("--mode must be strobe, poll or latch");
  }
  const overread = values.overread || "preadvance";
  if (!["preadvance", "pressed", "released"].includes(overread)) {
    fail("--overread must be preadvance, pressed or released");
  }
  // The bridge sends BRIDGE_TAS_OVERREAD and BRIDGE_TAS_GUARD_UNTIL only for strobe runs.
  for (const name of ["overread", "guard-until"]) {
    if (values[name] !== undefined && mode !== "strobe") {
      fail(`--${name} applies only in strobe mode`);
    }
  }
  const skipFirst = integerOption(values, "skip-first", 0);
  const startDelay = integerOption(values, "start-delay", 0);
  const guardOption = integerOption(values, "guard-until", 0);
  // Like the bridge, count the guard in records of the file as loaded, before Skip first.
  const checkGuard = (recordCount) => {
    if (guardOption > recordCount) {
      fail(`--guard-until ${guardOption} is past the end of the file's ${recordCount} records; the bridge would not arm it`);
    }
  };
  if (stream) {
    checkGuard(stream.masks.length / 2);
  }
  const guardUntil = Math.max(0, guardOption - skipFirst);

  const { movie, harness } = await prepare(values, movieFile);
  const tailFrames = integerOption(values, "tail-frames", 600, 60);
  const reference = movie ? await runMovie(harness, movie, movieFile, romFile, values, tailFrames) : null;
  if (reference) {
    warnRom(movie, romFile, reference.summary);
  }

  const masks = stream ? stream.masks : reference.latches;
  const label = stream ? path.basename(values.file) : `${path.basename(movieFile).replace(/\.bk2$/i, "")}.r08 (converted)`;
  if (!stream) {
    checkGuard(masks.length / 2);
  }
  const records = masks.subarray(2 * skipFirst);
  if (records.length === 0) {
    fail("no records left to play");
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const outDir = path.resolve(values["out-dir"] || path.join(cacheRoot(), "checks", `${label.replace(/[^\w.-]+/g, "_")}-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });

  const overreadRuns = mode === "strobe" && reference && reference.summary.overreadLatches > 0 ? ["pressed", "released", "preadvance"].filter((level) => level !== overread) : [];
  const variants = checks.buildVariants({
    launches: integerOption(values, "launches", 8),
    powerOn: Boolean(values["power-on"]),
    alignment: !values["no-alignment"],
    overreads: overreadRuns,
    startDelay,
  });
  const recordCount = records.length / 2;
  // Checkpoint screens line up with the movie's latches only when the file holds those latches,
  // like the .r08 convert writes; a replay dump may add blank records after the movie ends.
  const movieLatches = reference ? reference.latches.subarray(2 * skipFirst) : null;
  const overlap = movieLatches ? Math.min(records.length, movieLatches.length) : 0;
  const perLatch =
    reference && overlap >= 0.9 * records.length && records.subarray(0, overlap).equals(movieLatches.subarray(0, overlap));
  const every = reference ? (perLatch ? reference.summary.checkpointEvery : 0) : Math.max(1, Math.ceil(recordCount / 40));
  const referenceLast = reference ? reference.summary.lastLatchFrame : 0;
  const baseJob = {
    mode: "replay",
    rom: path.resolve(romFile),
    firmware: values.bios ? path.resolve(values.bios) : null,
    syncSettings: reference && movie.syncSettings ? path.join(reference.dir, "SyncSettings.json") : null,
    serve: mode,
    windowUs: integerOption(values, "window-us", 8000, 1),
    startDelay,
    guardUntil,
    overread,
    ports: 2,
    tailFrames,
    checkpointEvery: every,
    checkpointOffset: skipFirst,
    maxFrames: reference ? Math.ceil(referenceLast * 1.25) + tailFrames + 3600 : 0,
    reference: reference ? path.join(reference.dir, "reference.bin") : null,
  };

  // Written fresh before any run starts: an --out-dir can hold an earlier check's records, and a
  // run must never read a file that another is rewriting.
  const recordFiles = new Map();
  for (const skip of new Set(variants.map((variant) => variant.job.skipRecords ?? 0))) {
    const file = path.join(outDir, skip ? `records-skip${skip}.bin` : "records.bin");
    fs.writeFileSync(file, records.subarray(2 * skip));
    recordFiles.set(skip, file);
  }

  log(`Checking ${label}: ${recordCount.toLocaleString("en-US")} records in ${mode} mode, ${variants.length} runs...`);
  const jobs = integerOption(values, "jobs", Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1), 1);
  const makeTask = (variant, extra = {}) => () => {
    const { skipRecords, job } = checks.variantJob({ ...baseJob, ...extra }, variant);
    const dir = path.join(outDir, variant.name);
    // Clear an earlier check's screens, such as a divergence.png this run would not rewrite.
    fs.rmSync(dir, { recursive: true, force: true });
    return runJob(harness, { ...job, records: recordFiles.get(skipRecords) }, dir);
  };

  let results = [];
  let todo = variants;
  if (!reference) {
    // No movie: the default power-on run becomes the reference for the rest.
    const [base, ...rest] = variants;
    const summary = await makeTask(base, { writeReference: true, reference: null })();
    results.push({ variant: base, summary: { ...summary, endSimilarity: 1 } });
    log(`  ${base.name.padEnd(18)} reference (${summary.allRecordsServed ? "all records used" : `used ${summary.recordsServed} of ${summary.records}`})`);
    baseJob.reference = path.join(outDir, base.name, "reference.bin");
    baseJob.maxFrames = Math.ceil(Math.max(summary.lastRecordFrame, summary.frames) * 1.25) + tailFrames + 3600;
    todo = rest;
  }
  const summaries = await runAll(
    todo.map((variant) => makeTask(variant)),
    jobs,
    (index, summary) => log(`  ${todo[index].name.padEnd(18)} ${checks.describeRun(summary)}`),
  );
  results = results.concat(todo.map((variant, index) => ({ variant, summary: summaries[index] })));

  const context = { hasMovie: Boolean(reference), mode, startDelay };
  const report = [];
  report.push(`${label}: ${recordCount.toLocaleString("en-US")} records, ${mode} mode${overread !== "preadvance" && mode === "strobe" ? `, over-read ${overread}` : ""}${guardUntil ? `, guard until ${guardUntil}` : ""}`);
  if (reference) {
    report.push(`Movie: ${path.basename(movieFile)} on BizHawk ${harness.profile} ${movie.core}; its ending screen: ${path.join(reference.dir, "end.png")}`);
    for (const note of checks.movieNotes(reference.summary)) {
      report.push(`- ${note}`);
    }
  }
  report.push("");
  for (const line of checks.verdict(results, context)) {
    report.push(line);
  }
  const settings = [`Sync Mode ${mode}`, "Ports 2", `Skip first ${skipFirst}`, `Start delay ${checks.recommendedDelay(mode) + startDelay} from the EverDrive menu`];
  const env = [overread !== "preadvance" && mode === "strobe" ? `BRIDGE_TAS_OVERREAD=${overread}` : null, guardUntil ? `BRIDGE_TAS_GUARD_UNTIL=${guardUntil + skipFirst}` : null].filter(Boolean);
  report.push(`Settings: ${settings.join(", ")}${env.length ? `; start the bridge with ${env.join(" ")}` : ""}.`);
  report.push(`Screens for every run (end.png, and divergence.png where one went wrong): ${outDir}`);
  fs.writeFileSync(path.join(outDir, "report.txt"), `${report.join("\n")}\n`);
  log("");
  log(report.join("\n"));
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (error) {
    fail(`${error.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, ...inputs] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command === "setup") {
    const harness = await ensureHarness(values.bizhawk || DEFAULT_PROFILE, log);
    log(`Ready: BizHawk ${harness.profile} harness at ${harness.dll}`);
  } else if (command === "clean") {
    for (const name of ["movies", "checks"]) {
      fs.rmSync(path.join(cacheRoot(), name), { recursive: true, force: true });
    }
    log(`Removed cached movie runs and check output from ${cacheRoot()}.`);
  } else if (command === "convert") {
    await convert(values, inputs);
  } else if (command === "check") {
    await check(values, inputs);
  } else {
    fail(`unknown command ${command}\n${USAGE}`);
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message));
}

module.exports = { movieCacheKey, runAll };
