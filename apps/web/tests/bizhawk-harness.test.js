const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { promisify } = require("node:util");

const tas = require("../src/tas.js");
const movie = require("../../../scripts/bizhawk-harness/movie.js");
const profiles = require("../../../scripts/bizhawk-harness/profiles.js");
const checks = require("../../../scripts/bizhawk-harness/check.js");
const { csproj } = require("../../../scripts/bizhawk-harness/build.js");

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("scripts/bizhawk-harness.js");

const NESHAWK_LOG_KEY = "#Power|Reset|#P1 Up|P1 Down|P1 Left|P1 Right|P1 Start|P1 Select|P1 B|P1 A|#P2 Up|P2 Down|P2 Left|P2 Right|P2 Start|P2 Select|P2 B|P2 A|";
const SUBNESHAWK_LOG_KEY = `#Reset Cycle|Power|Reset|${NESHAWK_LOG_KEY.slice("#Power|Reset|".length)}`;
const BK2_PAD_ORDER = ["Up", "Down", "Left", "Right", "Start", "Select", "B", "A"];
const BK2_PAD_CHARS = "UDLRSsBA";

function padField(mask) {
  return BK2_PAD_ORDER.map((button, index) => (mask & movie.BUTTON_BITS[button] ? BK2_PAD_CHARS[index] : ".")).join("");
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(text);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, content);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const count = Object.keys(entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function bk2(header, rows, logKey = NESHAWK_LOG_KEY) {
  return storedZip({
    "Header.txt": Object.entries(header).map(([key, value]) => `${key} ${value}`).join("\n"),
    "SyncSettings.json": JSON.stringify({ o: { Controls: { NesLeftPort: "ControllerNES", NesRightPort: "ControllerNES" } } }),
    "Input Log.txt": `[Input]\nLogKey:${logKey}\n${rows.join("\n")}\n[/Input]\n`,
  });
}

test("parses NesHawk Input Log rows into TD2P-order pads", () => {
  const rows = movie.parseInputLog(
    [
      "[Input]",
      `LogKey:${NESHAWK_LOG_KEY}`,
      "|..|........|........|",
      "|..|.......A|U.......|",
      "|P.|UDLRSsBA|......B.|",
      "|.r|...R....|........|",
      "[/Input]",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { p1: 0x00, p2: 0x00, power: false, reset: false, resetCycle: 0 },
    { p1: 0x01, p2: 0x10, power: false, reset: false, resetCycle: 0 },
    { p1: 0xff, p2: 0x02, power: true, reset: false, resetCycle: 0 },
    { p1: 0x80, p2: 0x00, power: false, reset: true, resetCycle: 0 },
  ]);
});

test("parses SubNESHawk rows with a Reset Cycle axis before the buttons", () => {
  const rows = movie.parseInputLog(
    [`LogKey:${SUBNESHAWK_LOG_KEY}`, "|    0,..|....S...|........|", "| 1234,.r|........|.......A|"].join("\n"),
  );
  assert.deepEqual(rows, [
    { p1: 0x08, p2: 0x00, power: false, reset: false, resetCycle: 0 },
    { p1: 0x00, p2: 0x01, power: false, reset: true, resetCycle: 1234 },
  ]);
});

test("rejects rows whose field count does not match the LogKey", () => {
  assert.throws(() => movie.parseInputLog(`LogKey:${NESHAWK_LOG_KEY}\n|..|........|\n`), /LogKey declares 3/);
});

test("encodes rows as seven bytes each for the harness", () => {
  const buffer = movie.encodeRows([
    { p1: 0x81, p2: 0x02, power: true, reset: false, resetCycle: 0 },
    { p1: 0x00, p2: 0x00, power: false, reset: true, resetCycle: 0x01020304 },
  ]);
  assert.deepEqual([...buffer], [0x81, 0x02, 0x01, 0, 0, 0, 0, 0x00, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01]);
});

test("writes .r08 in NES serial order and .tdmask with a v2 header that TASDeck parses", () => {
  const masks = Buffer.from([0x01, 0x80, 0x09, 0x00]);
  assert.deepEqual([...movie.r08FromMasks(masks)], [0x80, 0x01, 0x90, 0x00]);

  const tdmask = movie.tdmaskFromMasks(masks, 1234);
  assert.deepEqual([...tdmask.subarray(0, 12)], [0x54, 0x44, 0x32, 0x50, 2, 2, 0x0d, 0x0a, 0, 0, 0x04, 0xd2]);
  const parsed = tas.parseTasFileBytes("movie.tdmask", new Uint8Array(tdmask));
  assert.equal(parsed.sourceFrameCount, 1234);
  assert.deepEqual(parsed.frames.map(tas.frameToPortMasks), [{ p1: 0x01, p2: 0x80 }, { p1: 0x09, p2: 0x00 }]);
});

test("reads .r08 and .tdmask files back as TD2P-order pad pairs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-"));
  try {
    await writeFile(path.join(dir, "a.r08"), Buffer.from([0x80, 0x01]));
    await writeFile(path.join(dir, "a.tdmask"), movie.tdmaskFromMasks(Buffer.from([0x01, 0x80]), 5));
    assert.deepEqual(movie.readStream(path.join(dir, "a.r08")), { masks: Buffer.from([0x01, 0x80]), format: "r08", syncMode: "strobe" });
    assert.deepEqual(movie.readStream(path.join(dir, "a.tdmask")), { masks: Buffer.from([0x01, 0x80]), format: "tdmask", syncMode: "poll" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes the same trace CSV columns as the BizHawk Lua exporter", () => {
  assert.equal(
    movie.traceCsv([{ frame: 4, p1: 0x0a, p2: 0 }, { frame: 6, p1: 0xff, p2: 0x10 }]),
    "frame_index,source_frame,mask1_hex,mask2_hex,source_format\n0,4,0A,00,bk2\n1,6,FF,10,bk2\n",
  );
  assert.deepEqual(movie.decodePolledFrames(Buffer.from([4, 0, 0, 0, 0x0a, 0, 6, 0, 0, 0, 0xff, 0x10])), [
    { frame: 4, p1: 0x0a, p2: 0 },
    { frame: 6, p1: 0xff, p2: 0x10 },
  ]);
});

test("matches a movie's ROM hash against the whole file or the file without its iNES header", () => {
  const body = Buffer.from("prg and chr");
  const rom = Buffer.concat([Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), body]);
  const sha1 = (data) => createHash("sha1").update(data).digest("hex").toUpperCase();
  assert.equal(movie.romMatchesMovie({ SHA1: sha1(rom) }, rom), true);
  assert.equal(movie.romMatchesMovie({ SHA1: sha1(body).toLowerCase() }, rom), true);
  assert.equal(movie.romMatchesMovie({ MD5: createHash("md5").update(body).digest("hex") }, rom), true);
  assert.equal(movie.romMatchesMovie({ SHA1: "00" }, rom), false);
  assert.equal(movie.romMatchesMovie({}, rom), null);
});

test("readBk2 accepts NES NesHawk and SubNESHawk movies and rejects other cores", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-"));
  try {
    const file = path.join(dir, "m.bk2");
    await writeFile(file, bk2({ Platform: "NES", Core: "SubNESHawk" }, ["|    0,..|.......A|........|"], SUBNESHAWK_LOG_KEY));
    const read = movie.readBk2(file);
    assert.equal(read.core, "SubNESHawk");
    assert.deepEqual(read.rows, [{ p1: 1, p2: 0, power: false, reset: false, resetCycle: 0 }]);

    await writeFile(file, bk2({ Platform: "NES", Core: "QuickNes" }, ["|..|........|........|"]));
    assert.throws(() => movie.readBk2(file), /recorded on QuickNes/);
    await writeFile(file, bk2({ Platform: "SNES" }, ["|..|........|........|"]));
    assert.throws(() => movie.readBk2(file), /SNES movie/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("picks the BizHawk core by the movie's recording version", () => {
  assert.equal(profiles.profileForMovie("Version 2.3.2"), "2.6.3");
  assert.equal(profiles.profileForMovie("Version 2.7.0"), "2.6.3");
  assert.equal(profiles.profileForMovie("Version 2.8"), "2.11.1");
  assert.equal(profiles.profileForMovie("Version 2.11.1"), "2.11.1");
  assert.equal(profiles.profileForMovie(undefined), profiles.DEFAULT_PROFILE);
});

test("applies source patches in the file's own line endings and refuses ambiguous ones", () => {
  const patch = { file: "a.cs", find: "\t\tprivate bool x;\n", replace: "\t\tpublic bool x;\n" };
  assert.equal(profiles.applyPatch("class A\r\n{\r\n\t\tprivate bool x;\r\n}\r\n", patch), "class A\r\n{\r\n\t\tpublic bool x;\r\n}\r\n");
  assert.equal(profiles.applyPatch("\t\tprivate bool x;\n", patch), "\t\tpublic bool x;\n");
  assert.throws(() => profiles.applyPatch("\t\tprivate bool x;\n\t\tprivate bool x;\n", patch), /not unique/);
  assert.throws(() => profiles.applyPatch("nothing here", patch), /not found/);

  const scoped = { file: "a.cs", after: "class B\n", find: "Latch();\n", replace: "Latch2();\n" };
  assert.equal(profiles.applyPatch("class A\nLatch();\nclass B\nLatch();\n", scoped), "class A\nLatch();\nclass B\nLatch2();\n");
  assert.throws(() => profiles.applyPatch("class A\nLatch();\n", scoped), /anchor not found/);
});

test("every profile hooks the strobe once and shares the common hooks", () => {
  for (const [name, profile] of Object.entries(profiles.PROFILES)) {
    const strobeHooks = profile.patches.filter((patch) => patch.replace.includes("HookJoyWrite?.Invoke"));
    assert.equal(strobeHooks.length, 1, name);
    assert.ok(profile.patches.some((patch) => patch.replace.includes("OverreadLevel(PortIndex)")), name);
    const project = csproj(profile, "/bizhawk");
    for (const constant of profile.defineConstants) {
      assert.match(project, new RegExp(`;${constant}<`));
    }
    for (const [pkg, version] of profile.packages) {
      assert.match(project, new RegExp(`Include="${pkg.replaceAll(".", "\\.")}" Version="${version.replaceAll(".", "\\.")}"`));
    }
  }
});

test("lints the harness helpers with the shared scripts rules", async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint();
  const dir = path.resolve("scripts/bizhawk-harness");
  const files = [cliPath, ...(await readdir(dir)).filter((name) => name.endsWith(".js")).map((name) => path.join(dir, name))];
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.languageOptions.sourceType, "commonjs", file);
    assert.equal(config.rules["no-undef"]?.[0], 2, file);
    assert.equal(config.rules["no-console"]?.[0], 0, file);
  }
});

test("refuses check settings the bridge would ignore or refuse, before building anything", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-"));
  try {
    await writeFile(path.join(dir, "game.nes"), Buffer.alloc(16));
    await writeFile(path.join(dir, "run.r08"), Buffer.from([0x80, 0x00, 0x00, 0x00, 0x01, 0x00]));
    await writeFile(path.join(dir, "run.tdmask"), movie.tdmaskFromMasks(Buffer.from([0x01, 0x00]), 1));
    // A cache under a regular file: a check that got as far as the build step would fail at once with
    // ENOTDIR instead of fetching .NET or BizHawk.
    const env = { ...process.env, TASDECK_HARNESS_CACHE: path.join(dir, "game.nes", "cache") };
    const refused = (args, pattern) =>
      assert.rejects(execFileAsync(process.execPath, [cliPath, "check", "game.nes", ...args], { cwd: dir, env, timeout: 20_000 }), (error) => {
        assert.match(error.stderr, pattern);
        return true;
      });
    await refused(["--file", "run.r08", "--mode", "poll", "--guard-until", "2"], /--guard-until applies only in strobe mode/);
    await refused(["--file", "run.tdmask", "--overread", "pressed"], /--overread applies only in strobe mode/);
    await refused(["--file", "run.r08", "--guard-until", "4"], /--guard-until 4 is past the end of the file's 3 records/);
    assert.deepEqual((await readdir(dir)).sort(), ["game.nes", "run.r08", "run.tdmask"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keys cached movie runs by the BIOS contents, not its path", async () => {
  const { movieCacheKey } = require("../../../scripts/bizhawk-harness.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-"));
  try {
    const file = (name) => path.join(dir, name);
    await writeFile(file("m.bk2"), "movie");
    await writeFile(file("g.fds"), "disk");
    await writeFile(file("disksys.rom"), "bios one");
    const key = movieCacheKey(file("m.bk2"), file("g.fds"), 600, file("disksys.rom"));
    assert.equal(movieCacheKey(file("m.bk2"), file("g.fds"), 600, path.relative(process.cwd(), file("disksys.rom"))), key);
    await writeFile(file("disksys.rom"), "bios two");
    assert.notEqual(movieCacheKey(file("m.bk2"), file("g.fds"), 600, file("disksys.rom")), key);
    assert.notEqual(movieCacheKey(file("m.bk2"), file("g.fds"), 600, null), key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("starts no harness run after one fails and waits for the running ones", async () => {
  const { runAll } = require("../../../scripts/bizhawk-harness.js");
  const events = [];
  const task = (index, ms, error) => async () => {
    events.push(`start ${index}`);
    await sleep(ms);
    events.push(`end ${index}`);
    if (error) {
      throw new Error(error);
    }
    return index * 10;
  };
  await assert.rejects(
    runAll([task(0, 5, "run 0 failed"), task(1, 40), task(2, 5, "run 2 failed"), task(3, 5)], 2, () => {}),
    /^Error: run 0 failed$/,
  );
  events.push("rejected");
  assert.deepEqual(events, ["start 0", "start 1", "end 0", "end 1", "rejected"]);

  const done = [];
  assert.deepEqual(await runAll([task(0, 10), task(1, 1), task(2, 1)], 2, (index) => done.push(index)), [0, 10, 20]);
  assert.deepEqual(done.sort(), [0, 1, 2]);
});

test("moves a dropped-record variant's checkpoints and guard boundary with its records", () => {
  const base = { startDelay: 0, overread: "pressed", guardUntil: 677, checkpointOffset: 2 };
  const [powerOn, ...rest] = checks.buildVariants({ launches: 0, randomRam: 0 });
  const [later, earlier] = rest;
  assert.deepEqual(checks.variantJob(base, powerOn), { skipRecords: 0, job: base });
  assert.deepEqual(checks.variantJob(base, later), { skipRecords: 0, job: { ...base, startDelay: 1 } });
  // At Start delay 0, "one lower" drops record 0: the run's record j is the file's record j + 1.
  assert.deepEqual(checks.variantJob(base, earlier), { skipRecords: 1, job: { ...base, guardUntil: 676, checkpointOffset: 3 } });
  assert.equal(checks.variantJob({ ...base, guardUntil: 1 }, earlier).job.guardUntil, 0);
  assert.equal(checks.variantJob({ ...base, guardUntil: 0 }, earlier).job.guardUntil, 0);
});

test("builds repeatable variant lists with EverDrive launches and Start delay checks", () => {
  const first = checks.buildVariants({ launches: 3, randomRam: 1 });
  assert.deepEqual(first, checks.buildVariants({ launches: 3, randomRam: 1 }));
  assert.deepEqual(first.map((variant) => variant.group), ["base", "everdrive", "everdrive", "everdrive", "cart", "alignment", "alignment"]);
  for (const launch of first.filter((variant) => variant.group === "everdrive")) {
    assert.equal(launch.job.ram, "everdrive");
    assert.ok(launch.job.launchFrames >= 30 && launch.job.launchFrames < 120);
    assert.ok(launch.job.launchCycle >= 0 && launch.job.launchCycle < 29781);
  }
  assert.deepEqual(first.at(-2).job, { startDelay: 1 });
  assert.deepEqual(first.at(-1).job, { skipRecords: 1 });
  assert.deepEqual(checks.buildVariants({ launches: 0, randomRam: 0, startDelay: 2 }).at(-1).job, { startDelay: 1 });
  assert.equal(checks.buildVariants({ launches: 0, randomRam: 0, powerOn: true, alignment: false }).length, 1 + 24 + 2);
  assert.deepEqual(
    checks.buildVariants({ launches: 0, randomRam: 0, alignment: false, overreads: ["pressed"] }).at(-1),
    { name: "overread-pressed", group: "overread", job: { overread: "pressed" } },
  );
});

test("reads results as a verdict with the Start delay to use", () => {
  const win = { allRecordsServed: true, records: 10, recordsServed: 10, endSimilarity: 1, divergence: null };
  const lose = { allRecordsServed: true, records: 10, recordsServed: 10, endSimilarity: 0.3, divergence: { record: 4 } };
  const result = (name, group, summary) => ({ variant: { name, group, job: {} }, summary });
  const context = { hasMovie: true, mode: "strobe", startDelay: 0 };

  const allWin = checks.verdict(
    [result("power-on", "base", win), result("everdrive-1", "everdrive", win), result("everdrive-2", "everdrive", win), result("start-delay+1", "alignment", lose), result("start-delay-1", "alignment", lose)],
    context,
  );
  assert.match(allWin[0], /Should play from an EverDrive menu launch: 2 of 2/);
  assert.match(allWin.at(-1), /Start delay must be exact: use 1 from the EverDrive menu/);

  const lottery = checks.verdict([result("power-on", "base", win), result("everdrive-1", "everdrive", win), result("everdrive-2", "everdrive", lose)], context);
  assert.match(lottery[0], /lottery on the EverDrive: 1 of 2 .*about 50%/);

  const tolerant = checks.verdict(
    [result("power-on", "base", win), result("start-delay+1", "alignment", win), result("start-delay-1", "alignment", lose)],
    { ...context, mode: "poll" },
  );
  assert.match(tolerant.at(-1), /Start delay 0 from the EverDrive menu; one higher also reaches the ending/);
  // Windowed at Start delay 0, "one lower" drops the first record: there is no Start delay -1.
  const skipFirstWins = checks.verdict(
    [result("power-on", "base", win), result("start-delay+1", "alignment", win), result("start-delay-1", "alignment", win)],
    { ...context, mode: "poll" },
  );
  assert.equal(skipFirstWins.at(-1), "Start delay 0 from the EverDrive menu; one higher and Skip first 1 also reach the ending.");
  const windowedExact = checks.verdict(
    [result("power-on", "base", win), result("start-delay+1", "alignment", lose), result("start-delay-1", "alignment", lose)],
    { ...context, mode: "latch" },
  );
  assert.equal(windowedExact.at(-1), "Start delay must be exact: use 0 from the EverDrive menu; one higher or Skip first 1 loses.");
  const strobeLower = checks.verdict([result("power-on", "base", win), result("start-delay+1", "alignment", lose), result("start-delay-1", "alignment", win)], context);
  assert.equal(strobeLower.at(-1), "Start delay 1 from the EverDrive menu; one lower also reaches the ending.");

  assert.match(checks.verdict([result("power-on", "base", lose)], context)[0], /Does not reach the movie's ending/);
  const overread = (level, summary) => ({ variant: { name: `overread-${level}`, group: "overread", job: { overread: level } }, summary });
  const rescued = checks.verdict([result("power-on", "base", lose), overread("pressed", win), overread("released", lose)], context);
  assert.deepEqual(rescued.slice(1), [
    "With BRIDGE_TAS_OVERREAD=pressed: same ending.",
    "With BRIDGE_TAS_OVERREAD=released: different ending (screens 30% alike); screens part near record 4.",
    "Check again with --overread pressed to see how it plays from EverDrive launches.",
  ]);
  assert.equal(checks.describeRun(lose), "different ending (screens 30% alike); screens part near record 4");

  // No movie, and the power-on reference stops being read early: it saved no ending, so every other
  // run scores -1 when it reads every record, and the verdict says what went wrong instead.
  const stalled = { allRecordsServed: false, records: 10, recordsServed: 7, endSimilarity: 1, divergence: null };
  const noEnding = { allRecordsServed: true, records: 10, recordsServed: 10, endSimilarity: -1, divergence: null };
  assert.equal(checks.describeRun(noEnding), "used every record; no ending to compare with");
  assert.deepEqual(
    checks.verdict(
      [
        result("power-on", "base", stalled),
        result("everdrive-1", "everdrive", noEnding),
        result("everdrive-2", "everdrive", { ...stalled, endSimilarity: 0 }),
        result("random-ram-1", "cart", { ...stalled, endSimilarity: 0 }),
        result("start-delay+1", "alignment", noEnding),
      ],
      { ...context, hasMovie: false },
    ),
    [
      "From a default power-on the game stops reading the file after 7 of its 10 records, so it does not play to its end. " +
        "That run is the reference, so there is no ending to compare the other runs with.",
      "Runs that read every record: EverDrive launches 1 of 2, cartridge power-on states 0 of 1.",
    ],
  );
  // A reference that plays to its end is compared with as before.
  assert.match(
    checks.verdict([result("power-on", "base", win), result("everdrive-1", "everdrive", win)], { ...context, hasMovie: false })[0],
    /Should play from an EverDrive menu launch: 1 of 1/,
  );
  assert.equal(checks.describeRun({ ...win, allRecordsServed: false, recordsServed: 7 }), "used 7 of 10 records");
});

test("notes movie traits that change how TASDeck should play it", () => {
  const notes = checks.movieNotes({
    latchesPerFrame: { 0: 5, 1: 90, 2: 3 },
    readsPerLatch: { port1: { 8: 95, ">8": 1 }, port2: { 8: 96 } },
    overreadLatches: 1,
    firstOverreadLatch: 40,
    multiLatchFrames: 3,
    perLatchInputWithinFrame: 0,
    oddReads: [{ address: 0x6000, pc: 0xc123, count: 2 }],
    consolePresses: [{ button: "Reset", row: 900, afterRecord: 812 }],
    endUniformity: 0.99,
  }).join("\n");
  assert.match(notes, /90 frame\(s\) with 1, 3 frame\(s\) with 2/);
  assert.match(notes, /read past the eighth clock \(first at latch 40\)/);
  assert.match(notes, /3 frame\(s\) strobe more than once/);
  assert.match(notes, /\$6000 \(PC \$C123, 2x\)/);
  assert.match(notes, /presses Reset at movie row 900 \(after record 812\)/);
  assert.match(notes, /almost one colour/);
});

// End-to-end: build a synthetic NROM whose NMI strobes once per frame, reads both ports, and folds
// port 1 into the backdrop colour (acc += pad XOR frame count, for non-zero pads). The colour
// freezes once the records run out, and a record served one latch off changes it. Runs only when
// the 2.6.3 harness is already built (npm run bk2 -- setup), or when TASDECK_HARNESS_TESTS=1
// allows building it.
const harnessBuilt = existsSync(path.resolve(".cache/bizhawk-harness/build/2.6.3/out/tasdeck-harness.dll"));
const needsHarness =
  !(harnessBuilt || process.env.TASDECK_HARNESS_TESTS === "1") && "needs the BizHawk harness: run `npm run bk2 -- setup` first";

function syntheticRom() {
  const prg = Buffer.alloc(0x4000, 0xea);
  // SEI; CLD; NMI off; LDX #$FF; TXS; wait two vblanks; clear $10-$12; show background; NMI on;
  // JMP *. Turning NMI off first matters on an EverDrive launch, which leaves the PPU running.
  const reset = [
    0x78, 0xd8, 0xa9, 0x00, 0x8d, 0x00, 0x20, 0xa2, 0xff, 0x9a,
    0x2c, 0x02, 0x20, 0x10, 0xfb,
    0x2c, 0x02, 0x20, 0x10, 0xfb,
    0xa9, 0x00, 0x85, 0x10, 0x85, 0x11, 0x85, 0x12,
    0xa9, 0x08, 0x8d, 0x01, 0x20,
    0xa9, 0x80, 0x8d, 0x00, 0x20,
    0x4c, 0x26, 0xc0,
  ];
  const nmi = [
    0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40, // strobe
    0xa2, 0x08, 0xad, 0x16, 0x40, 0x4a, 0x66, 0x10, 0xad, 0x17, 0x40, 0xca, 0xd0, 0xf4, // 8 reads of each port
    0xe6, 0x12, 0xa5, 0x10, 0xf0, 0x07, 0x45, 0x12, 0x18, 0x65, 0x11, 0x85, 0x11, // frame++; if pad: acc += pad ^ frame
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa5, 0x11, 0x29, 0x3f, 0x8d, 0x07, 0x20, // backdrop = acc
    0xa9, 0x00, 0x8d, 0x06, 0x20, 0x8d, 0x06, 0x20, 0x8d, 0x05, 0x20, 0x8d, 0x05, 0x20, 0x40,
  ];
  Buffer.from(reset).copy(prg, 0);
  prg[0xff] = 0x40;
  Buffer.from(nmi).copy(prg, 0x100);
  prg.writeUInt16LE(0xc100, 0x3ffa);
  prg.writeUInt16LE(0xc000, 0x3ffc);
  prg.writeUInt16LE(0xc0ff, 0x3ffe);
  return Buffer.concat([Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), prg, Buffer.alloc(0x2000)]);
}

test("converts a synthetic NesHawk movie and checks it on the built harness", { skip: needsHarness, timeout: 900_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-e2e-"));
  try {
    const rom = syntheticRom();
    const frames = 120;
    const pads = Array.from({ length: frames }, (_, index) => [(index * 37 + 11) & 0xff, (index * 53 + 7) & 0xff]);
    await writeFile(path.join(dir, "synthetic.nes"), rom);
    await writeFile(
      path.join(dir, "synthetic.bk2"),
      bk2(
        { Platform: "NES", Core: "NesHawk", emuVersion: "Version 2.6.3", SHA1: createHash("sha1").update(rom).digest("hex").toUpperCase() },
        pads.map(([p1, p2]) => `|..|${padField(p1)}|${padField(p2)}|`),
      ),
    );
    const env = { ...process.env, TASDECK_HARNESS_CACHE: path.resolve(".cache/bizhawk-harness") };
    const run = (...args) => execFileAsync(process.execPath, [cliPath, ...args], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });

    const converted = await run("convert", "synthetic.bk2", "synthetic.nes", "--tail-frames", "120");
    assert.doesNotMatch(converted.stderr, /hashes differently/);
    const r08 = await readFile(path.join(dir, "synthetic.r08"));
    const records = r08.length / 2;
    // The NMI is on from the third frame, and every frame after that latches once.
    assert.ok(records >= frames - 4 && records < frames, `${records} records`);
    const expected = pads.slice(frames - records).flat();
    assert.deepEqual([...r08], expected.map(tas.reverseByteBits));
    const tdmask = await readFile(path.join(dir, "synthetic.tdmask"));
    assert.equal(tas.twoControllerMaskSourceFrameCount(tdmask), frames);
    assert.deepEqual([...tdmask.subarray(12)], expected);
    assert.equal((await readFile(path.join(dir, "synthetic.tdmask.trace.csv"), "utf8")).split("\n").length, records + 2);
    assert.ok((await readdir(dir)).includes("synthetic.movie-end.png"));

    const checked = await run("check", "synthetic.bk2", "synthetic.nes", "--launches", "2", "--tail-frames", "120", "--out-dir", "check");
    assert.match(checked.stdout, /power-on +same ending/);
    assert.match(checked.stdout, /everdrive-1 +same ending/);
    assert.match(checked.stdout, /start-delay\+1 +different ending/);
    assert.match(checked.stdout, /start-delay-1 +different ending/);
    assert.match(checked.stdout, /Should play from an EverDrive menu launch: 2 of 2/);
    assert.match(checked.stdout, /Start delay must be exact: use 1 from the EverDrive menu/);
    // Checkpoints use the file's record numbers, so a run that drops a record starts one later.
    const checkRun = async (name, file) => JSON.parse(await readFile(path.join(dir, "check", name, file), "utf8"));
    assert.equal((await checkRun("power-on", "job.json")).checkpointOffset, 0);
    assert.equal((await checkRun("start-delay-1", "job.json")).checkpointOffset, 1);

    // Reusing an --out-dir must play the new file, not the records an earlier check left there.
    const altered = Buffer.from(expected);
    altered[2 * (records >> 1)] ^= 0x01;
    await writeFile(path.join(dir, "altered.r08"), Buffer.from(altered.map(tas.reverseByteBits)));
    const alteredCheck = await run("check", "synthetic.bk2", "synthetic.nes", "--file", "altered.r08", "--launches", "0", "--tail-frames", "120", "--out-dir", "check");
    assert.match(alteredCheck.stdout, /power-on +different ending/);
    assert.deepEqual(await readFile(path.join(dir, "check", "records.bin")), altered);
    assert.deepEqual(await readFile(path.join(dir, "check", "records-skip1.bin")), altered.subarray(2));
    const skipCheck = await run("check", "synthetic.bk2", "synthetic.nes", "--skip-first", "1", "--launches", "0", "--no-alignment", "--tail-frames", "120", "--out-dir", "check");
    assert.match(skipCheck.stdout, /power-on +different ending/);
    assert.deepEqual(await readFile(path.join(dir, "check", "records.bin")), Buffer.from(expected.slice(2)));
    assert.ok(existsSync(path.join(dir, "check", "power-on", "divergence.png")));
    // With Skip first, the divergence is reported as a record of the file, which is a checkpoint.
    const skipJob = await checkRun("power-on", "job.json");
    const { divergence } = await checkRun("power-on", "summary.json");
    assert.equal(skipJob.checkpointOffset, 1);
    assert.ok(skipJob.checkpointEvery > 1);
    assert.equal(divergence.record % skipJob.checkpointEvery, 0);
    assert.match(skipCheck.stdout, new RegExp(`power-on +different ending .*near record ${divergence.record}\\n`));
    // ...and must not leave that check's divergence screen behind in a run that now matches.
    const againCheck = await run("check", "synthetic.bk2", "synthetic.nes", "--launches", "0", "--no-alignment", "--tail-frames", "120", "--out-dir", "check");
    assert.match(againCheck.stdout, /power-on +same ending/);
    assert.ok(!existsSync(path.join(dir, "check", "power-on", "divergence.png")));

    const polled = await run("check", "synthetic.bk2", "synthetic.nes", "--file", "synthetic.tdmask", "--launches", "1", "--no-alignment", "--tail-frames", "120", "--out-dir", "check-tdmask");
    assert.match(polled.stdout, /records in poll mode/);
    assert.match(polled.stdout, /Should play from an EverDrive menu launch: 1 of 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// SubNESHawk ends a row at a latch or at the end of a frame. Once the synthetic ROM's NMI strobes
// every frame, each frame takes two rows, so of two movies a row apart one ends on a latch row,
// partway through a frame. That frame is still the movie's last polled frame.
test("keeps the last polled frame of a SubNESHawk movie that ends on a latch row", { skip: needsHarness, timeout: 900_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-harness-sub-"));
  try {
    const rom = syntheticRom();
    await writeFile(path.join(dir, "synthetic.nes"), rom);
    const env = { ...process.env, TASDECK_HARNESS_CACHE: path.resolve(".cache/bizhawk-harness") };
    const header = { Platform: "NES", Core: "SubNESHawk", emuVersion: "Version 2.6.3", SHA1: createHash("sha1").update(rom).digest("hex").toUpperCase() };
    for (const rowCount of [200, 201]) {
      const name = `sub${rowCount}`;
      const rows = Array.from({ length: rowCount }, (_, index) => `|    0,..|${padField((index * 37 + 11) & 0xff)}|${padField((index * 53 + 7) & 0xff)}|`);
      await writeFile(path.join(dir, `${name}.bk2`), bk2(header, rows, SUBNESHAWK_LOG_KEY));
      await execFileAsync(process.execPath, [cliPath, "convert", `${name}.bk2`, "synthetic.nes", "--tail-frames", "120"], { cwd: dir, env });

      const r08 = await readFile(path.join(dir, `${name}.r08`));
      const tdmask = await readFile(path.join(dir, `${name}.tdmask`));
      // One strobe per frame: every latch is a polled frame of its own.
      assert.deepEqual([...tdmask.subarray(12)], [...r08].map(tas.reverseByteBits), name);
      const traceRows = (await readFile(path.join(dir, `${name}.tdmask.trace.csv`), "utf8")).trim().split("\n");
      const lastSourceFrame = Number(traceRows.at(-1).split(",")[1]);
      assert.equal(tas.twoControllerMaskSourceFrameCount(tdmask), lastSourceFrame + 1, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
