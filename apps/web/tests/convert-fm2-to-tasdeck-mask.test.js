const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, realpath, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { clearTimeout, setTimeout } = require("node:timers");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/convert-fm2-to-tasdeck-mask.sh");
const luaPath = path.resolve("scripts/fceux-export-tasdeck-mask.lua");
const td2pHeader = Buffer.from([
  0x54, 0x44, 0x32, 0x50, 0x02, 0x02, 0x0d, 0x0a,
  // Big-endian source movie frame count (1).
  0x00, 0x00, 0x00, 0x01,
]);

const standardFm2 = `version 3
fourscore 0
microphone 0
port0 1
port1 1
port2 0
|0|........|........||
`;

function resolveBashExecutable() {
  const names = process.platform === "win32" ? ["bash.exe", "bash"] : ["bash"];
  for (const directoryEntry of (process.env.PATH || "").split(path.delimiter)) {
    const directory = directoryEntry.replace(/^"(.*)"$/, "$1");
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (directory && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "bash";
}

const bashExecutable = resolveBashExecutable();

function execBash(script, args = [], options = {}) {
  return execFileAsync(bashExecutable, [script, ...args], options);
}

// The wrapper reads these overrides, so a developer's exported values must not
// redirect a test's outputs outside its temporary directory.
function converterEnv(overrides = {}) {
  return {
    ...process.env,
    TASDECK_R08_OUTPUT: "",
    TASDECK_MASK_TRACE_OUTPUT: "",
    ...overrides,
  };
}

test("uses native FCEUX arguments and paths from Windows Git Bash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-windows-"));
  try {
    const moviePath = path.join(tempDir, "test movie.fm2");
    const romPath = path.join(tempDir, "test game.nes");
    const outputPath = path.join(tempDir, "test output.tdmask");
    const argumentLogPath = path.join(tempDir, "fceux-arguments.txt");
    const fceuxPath = path.join(tempDir, "fceux64.exe");
    const cygpathPath = path.join(tempDir, "cygpath");

    await writeFile(moviePath, standardFm2);
    await writeFile(romPath, Buffer.from("NES\x1a"));
    await writeFile(
      cygpathPath,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-aw" ]]
shift
if [[ "\${1:-}" == "--" ]]; then
  shift
fi
input=$1
case "$input" in
  /[A-Za-z]/*)
    drive=$(printf '%s' "\${input:1:1}" | tr '[:lower:]' '[:upper:]')
    rest=\${input:3}
    rest=\${rest//\\//\\\\}
    printf 'WIN:%s:\\\\%s\\n' "$drive" "$rest"
    ;;
  *)
    printf 'WIN:%s\\n' "$input"
    ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      fceuxPath,
      `#!/usr/bin/env bash
set -euo pipefail
for native_path in \\
  "$TASDECK_MASK_OUTPUT" \\
  "$TASDECK_MASK_TRACE_OUTPUT" \\
  "$TASDECK_R08_OUTPUT" \\
  "$TASDECK_MASK_COMPLETION_OUTPUT"; do
  [[ "$native_path" == WIN:* ]]
done
printf '%s\\n' "$@" > "$FCEUX_ARGUMENT_LOG"
output_path=\${TASDECK_MASK_OUTPUT#WIN:}
trace_path=\${TASDECK_MASK_TRACE_OUTPUT#WIN:}
r08_path=\${TASDECK_R08_OUTPUT#WIN:}
completion_path=\${TASDECK_MASK_COMPLETION_OUTPUT#WIN:}
printf '\\124\\104\\062\\120\\002\\002\\015\\012\\000\\000\\000\\001\\001\\002' > "$output_path"
printf 'poll_index,movie_frame,mask1_hex,mask2_hex\\n0,0,01,02\\n' > "$trace_path"
printf '\\200\\100' > "$r08_path"
printf 'complete frames=1 polls=1 latches=1 unread_latches=0 dmc_enables=0 mismatches=0 reason=movie_length\\n' > "$completion_path"
`,
      { mode: 0o755 },
    );

    const commandPath = [
      tempDir,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter);
    const { stdout } = await execBash(scriptPath, [moviePath, romPath, outputPath], {
      env: converterEnv({
        FCEUX_BIN: "",
        FCEUX_ARGUMENT_LOG: argumentLogPath,
        MSYSTEM: "UCRT64",
        PATH: commandPath,
      }),
    });

    assert.deepEqual(
      await readFile(outputPath),
      Buffer.concat([td2pHeader, Buffer.from([0x01, 0x02])]),
    );
    assert.deepEqual(
      await readFile(path.join(tempDir, "test output.polls.r08")),
      Buffer.from([0x80, 0x40]),
    );
    assert.deepEqual(
      (await readFile(argumentLogPath, "utf8")).trim().split("\n"),
      [
        "-readonly",
        "1",
        "-playmovie",
        `WIN:${moviePath}`,
        "-lua",
        `WIN:${luaPath}`,
        `WIN:${romPath}`,
      ],
    );
    assert.match(stdout, /FCEUX:\s+.*fceux64\.exe/);
    assert.match(stdout, /Wrote 14 byte\(s\)/);
    assert.match(stdout, /Wrote 2 byte\(s\): .*test output\.polls\.r08/);
    assert.match(stdout, /Latches: 1 over 1 polled frame\(s\) \(1\.00 per frame, difference 0\), 0 with no completed read/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Git Bash always reports a Windows OSTYPE, so the native FCEUX branch only
// runs on macOS and Linux.
const posixOnly = process.platform === "win32" && "exercises the macOS/Linux FCEUX options";

// The fake records the output paths it was handed in fake-fceux-env.txt, which
// also proves whether the wrapper got as far as launching FCEUX.
async function writeFakeFceux(tempDir, {
  r08Bytes = Buffer.from([0x80, 0x40]),
  completion = "complete frames=1 polls=1 latches=1 unread_latches=0 dmc_enables=0 mismatches=0 reason=movie_length",
} = {}) {
  const r08SourcePath = path.join(tempDir, "fake.r08");
  const completionSourcePath = path.join(tempDir, "fake-completion.txt");
  const envLogPath = path.join(tempDir, "fake-fceux-env.txt");
  const fceuxPath = path.join(tempDir, "fceux");
  await writeFile(r08SourcePath, r08Bytes);
  await writeFile(completionSourcePath, `${completion}\n`);
  await writeFile(
    fceuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$TASDECK_MASK_OUTPUT" "$TASDECK_R08_OUTPUT" "$TASDECK_MASK_TRACE_OUTPUT" > "${envLogPath}"
printf '\\124\\104\\062\\120\\002\\002\\015\\012\\000\\000\\000\\001\\001\\002' > "$TASDECK_MASK_OUTPUT"
printf 'poll_index,movie_frame,mask1_hex,mask2_hex\\n0,0,01,02\\n' > "$TASDECK_MASK_TRACE_OUTPUT"
cp "${r08SourcePath}" "$TASDECK_R08_OUTPUT"
cp "${completionSourcePath}" "$TASDECK_MASK_COMPLETION_OUTPUT"
`,
    { mode: 0o755 },
  );
  return fceuxPath;
}

test("writes the per-latch stream to an .r08 output path and the .tdmask beside it", { skip: posixOnly }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-r08-"));
  try {
    const moviePath = path.join(tempDir, "movie.fm2");
    const romPath = path.join(tempDir, "game.nes");
    await writeFile(moviePath, standardFm2);
    await writeFile(romPath, Buffer.from("NES\x1a"));
    const fceuxPath = await writeFakeFceux(tempDir, {
      r08Bytes: Buffer.from([0x80, 0x00, 0x80, 0x00, 0x00, 0x00]),
      completion: "complete frames=1 polls=2 latches=3 unread_latches=1 dmc_enables=4 mismatches=2 reason=movie_length",
    });

    const { stdout, stderr } = await execBash(
      scriptPath,
      [romPath, moviePath, path.join(tempDir, "out", "movie.polls.r08")],
      { env: converterEnv({ FCEUX_BIN: fceuxPath }) },
    );

    assert.deepEqual(
      await readFile(path.join(tempDir, "out", "movie.polls.r08")),
      Buffer.from([0x80, 0x00, 0x80, 0x00, 0x00, 0x00]),
    );
    assert.deepEqual(
      await readFile(path.join(tempDir, "out", "movie.tdmask")),
      Buffer.concat([td2pHeader, Buffer.from([0x01, 0x02])]),
    );
    assert.ok(existsSync(path.join(tempDir, "out", "movie.tdmask.trace.csv")));
    assert.match(stdout, /Latches: 3 over 1 polled frame\(s\) \(3\.00 per frame, difference 2\), 1 with no completed read/);
    assert.match(stderr, /2 controller read\(s\) returned input that changed after the latch/);
    assert.match(stderr, /wrote \$4015 with the DPCM enable bit set 4 time\(s\).*Start with the \.tdmask/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects a per-latch stream whose record count disagrees with the exporter", { skip: posixOnly }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-r08-count-"));
  try {
    const moviePath = path.join(tempDir, "movie.fm2");
    const romPath = path.join(tempDir, "game.nes");
    await writeFile(moviePath, standardFm2);
    await writeFile(romPath, Buffer.from("NES\x1a"));
    const fceuxPath = await writeFakeFceux(tempDir, {
      r08Bytes: Buffer.from([0x80, 0x00]),
      completion: "complete frames=1 polls=1 latches=2 unread_latches=0 dmc_enables=0 mismatches=0 reason=movie_length",
    });

    await assert.rejects(
      execBash(scriptPath, [moviePath, romPath, path.join(tempDir, "movie.tdmask")], {
        env: converterEnv({ FCEUX_BIN: fceuxPath }),
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /holds 1 record\(s\) but the exporter counted 2 latch\(es\)/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("documents the FCEUX Windows executable override in help output", async () => {
  const { stderr } = await execBash(scriptPath, ["--help"]);
  assert.match(stderr, /FCEUX_BIN=\/path\/to\/fceux/);
  assert.match(stderr, /\/c\/FCEUX\/fceux64\.exe/);
});

async function makeMovieFixture(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const moviePath = path.join(tempDir, "movie.fm2");
  const romPath = path.join(tempDir, "game.nes");
  await writeFile(moviePath, standardFm2);
  await writeFile(romPath, Buffer.from("NES\x1a"));
  return { tempDir, moviePath, romPath };
}

// Every output is deleted before FCEUX starts, so each of these must be refused
// before the wrapper touches a file.
const unsafeOutputCases = [
  {
    name: "an .r08 override that names the movie through ./",
    env: { TASDECK_R08_OUTPUT: "./movie.fm2" },
    error: /must not overwrite the FM2 or ROM file: \.\/movie\.fm2/,
  },
  {
    name: "a positional output that is the ROM's absolute path",
    output: (tempDir) => path.join(tempDir, "game.nes"),
    error: /must not overwrite the FM2 or ROM file: .*game\.nes/,
  },
  {
    name: "a trace override that names the ROM through ./",
    env: { TASDECK_MASK_TRACE_OUTPUT: "./game.nes" },
    error: /must not overwrite the FM2 or ROM file: \.\/game\.nes/,
  },
  {
    name: "an .r08 override that is a symlink to the movie",
    env: { TASDECK_R08_OUTPUT: "link.r08" },
    setup: (tempDir) => symlink(path.join(tempDir, "movie.fm2"), path.join(tempDir, "link.r08")),
    error: /must not overwrite the FM2 or ROM file: link\.r08/,
  },
  {
    name: "an .r08 override equal to the .tdmask",
    env: { TASDECK_R08_OUTPUT: "out.tdmask" },
    error: /three different files/,
  },
  {
    name: "an .r08 override that names the trace through ./",
    env: { TASDECK_R08_OUTPUT: "./out.tdmask.trace.csv" },
    error: /three different files/,
  },
  {
    name: "an .r08 override that differs from the .tdmask only by case",
    env: { TASDECK_R08_OUTPUT: "OUT.TDMASK" },
    error: /three different files/,
  },
];

for (const unsafe of unsafeOutputCases) {
  test(`refuses ${unsafe.name} before deleting anything`, { skip: posixOnly }, async () => {
    const { tempDir, moviePath, romPath } = await makeMovieFixture("tasdeck-fm2-unsafe-");
    try {
      const fceuxPath = await writeFakeFceux(tempDir);
      await unsafe.setup?.(tempDir);
      const output = unsafe.output ? unsafe.output(tempDir) : "out.tdmask";

      await assert.rejects(
        execBash(scriptPath, ["movie.fm2", "game.nes", output], {
          cwd: tempDir,
          env: converterEnv({ FCEUX_BIN: fceuxPath, ...unsafe.env }),
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, unsafe.error);
          return true;
        },
      );
      assert.equal(await readFile(moviePath, "utf8"), standardFm2);
      assert.deepEqual(await readFile(romPath), Buffer.from("NES\x1a"));
      assert.equal(existsSync(path.join(tempDir, "fake-fceux-env.txt")), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("refuses an .r08 override that differs from the movie only by case on a case-insensitive volume", { skip: posixOnly }, async (t) => {
  const { tempDir, moviePath } = await makeMovieFixture("tasdeck-fm2-case-");
  try {
    if (!existsSync(path.join(tempDir, "MOVIE.FM2"))) {
      t.skip("the temporary volume is case-sensitive");
      return;
    }
    const fceuxPath = await writeFakeFceux(tempDir);

    await assert.rejects(
      execBash(scriptPath, ["movie.fm2", "game.nes", "out.tdmask"], {
        cwd: tempDir,
        env: converterEnv({ FCEUX_BIN: fceuxPath, TASDECK_R08_OUTPUT: "MOVIE.FM2" }),
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /must not overwrite the FM2 or ROM file: MOVIE\.FM2/);
        return true;
      },
    );
    assert.equal(await readFile(moviePath, "utf8"), standardFm2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("hands FCEUX absolute output paths when given relative ones", { skip: posixOnly }, async () => {
  const { tempDir } = await makeMovieFixture("tasdeck-fm2-relative-");
  try {
    const fceuxPath = await writeFakeFceux(tempDir);

    await execBash(scriptPath, ["movie.fm2", "game.nes", "rel/out.tdmask"], {
      cwd: tempDir,
      env: converterEnv({ FCEUX_BIN: fceuxPath }),
    });

    // FCEUX runs the Lua exporter from scripts/, so relative paths would land there.
    const resolvedDir = path.join(await realpath(tempDir), "rel");
    assert.deepEqual(
      (await readFile(path.join(tempDir, "fake-fceux-env.txt"), "utf8")).trim().split("\n"),
      [
        path.join(resolvedDir, "out.tdmask"),
        path.join(resolvedDir, "out.polls.r08"),
        path.join(resolvedDir, "out.tdmask.trace.csv"),
      ],
    );
    assert.ok(existsSync(path.join(tempDir, "rel", "out.polls.r08")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("derives sibling output names case-insensitively and reports a replaced .r08", { skip: posixOnly }, async () => {
  const { tempDir, moviePath, romPath } = await makeMovieFixture("tasdeck-fm2-suffix-");
  try {
    const fceuxPath = await writeFakeFceux(tempDir);
    const env = converterEnv({ FCEUX_BIN: fceuxPath });

    await execBash(scriptPath, [moviePath, romPath, path.join(tempDir, "upper.POLLS.R08")], { env });
    assert.deepEqual(await readFile(path.join(tempDir, "upper.POLLS.R08")), Buffer.from([0x80, 0x40]));
    assert.ok(existsSync(path.join(tempDir, "upper.tdmask")));
    assert.equal(existsSync(path.join(tempDir, "upper.POLLS.tdmask")), false);

    await writeFile(path.join(tempDir, "mask.polls.r08"), "REFERENCE");
    const { stderr } = await execBash(scriptPath, [moviePath, romPath, path.join(tempDir, "mask.TDMASK")], { env });
    assert.match(stderr, /Replacing existing per-latch output: .*mask\.polls\.r08/);
    assert.deepEqual(await readFile(path.join(tempDir, "mask.polls.r08")), Buffer.from([0x80, 0x40]));
    assert.equal(existsSync(path.join(tempDir, "mask.TDMASK.polls.r08")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The tests below run the real Lua exporter inside FCEUX against a synthetic
// NROM image, so they skip when FCEUX is not installed.
function findFceux() {
  if (process.platform === "win32" || process.env.TASDECK_SKIP_FCEUX_TESTS === "1") {
    return null;
  }
  if (process.env.FCEUX_BIN) {
    return existsSync(process.env.FCEUX_BIN) ? process.env.FCEUX_BIN : null;
  }
  const directories = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin"];
  for (const directory of directories) {
    const candidate = path.join(directory, "fceux");
    if (directory && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const fceuxBin = findFceux();
const needsFceux = !fceuxBin &&
  "needs FCEUX on PATH, at /opt/homebrew/bin/fceux, or in FCEUX_BIN (and TASDECK_SKIP_FCEUX_TESTS unset)";

// Kills a process and every descendant, children first. FCEUX may sit below a
// launcher script, so killing only the wrapper's direct child is not enough.
function killProcessTree(pid) {
  let children = [];
  try {
    children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    // pgrep exits 1 when there are no children.
  }
  for (const child of children) {
    killProcessTree(Number(child));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

// A hung FCEUX must not outlive its test, so a timeout kills the whole tree.
// The wrapper stays in the terminal's process group so Ctrl-C still reaches it.
function runConverterWithTimeout(args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable, [scriptPath, ...args], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`converter still running after ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`converter exited with ${code}\n${stderr}`));
      }
    });
  });
}

// One 16 KiB PRG bank at $C000 plus 8 KiB of blank CHR. The reset routine sits
// at $C000, an RTI at $C0FF serves IRQ, and the NMI handler starts at $C100.
function buildNromImage({ reset, nmi = [0x40] }) {
  assert.ok(reset.length < 0xff && nmi.length < 0x100);
  const prg = Buffer.alloc(0x4000, 0xea);
  Buffer.from(reset).copy(prg, 0x0000);
  prg[0x00ff] = 0x40;
  Buffer.from(nmi).copy(prg, 0x0100);
  prg.writeUInt16LE(0xc100, 0x3ffa);
  prg.writeUInt16LE(0xc000, 0x3ffc);
  prg.writeUInt16LE(0xc0ff, 0x3ffe);
  const chr = Buffer.alloc(0x2000);
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum = createHash("md5").update(Buffer.concat([prg, chr])).digest("base64");
  return { rom: Buffer.concat([header, prg, chr]), checksum };
}

const STROBE_HIGH = [0xa9, 0x01, 0x8d, 0x16, 0x40]; // LDA #$01; STA $4016
const STROBE_LOW = [0xa9, 0x00, 0x8d, 0x16, 0x40]; // LDA #$00; STA $4016

// Every movie frame gets distinct port 1 and port 2 masks so a stream can be
// matched back to the frames it came from. Masks use TD2P order (A = bit 0).
function syntheticMovie(checksum, frameCount) {
  const columns = "RLDUTSBA";
  const field = (mask) => [...columns].map((column, index) => (mask & (0x80 >> index) ? column : ".")).join("");
  const masks = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    masks.push([(frame * 37 + 11) & 0xff, (frame * 53 + 7) & 0xff]);
  }
  const rows = masks.map(([port1, port2]) => `|0|${field(port1)}|${field(port2)}||`);
  const text = [
    "version 3",
    "emuVersion 22020",
    "rerecordCount 0",
    "palFlag 0",
    "romFilename synthetic",
    `romChecksum base64:${checksum}`,
    "guid 00000000-0000-0000-0000-000000000000",
    "fourscore 0",
    "microphone 0",
    "port0 1",
    "port1 1",
    "port2 0",
    "FDS 0",
    "NewPPU 0",
    ...rows,
    "",
  ].join("\n");
  return { text, masks };
}

function reverseBits(value) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    if (value & (1 << bit)) {
      reversed |= 0x80 >> bit;
    }
  }
  return reversed;
}

async function convertSynthetic(program, frameCount) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-fceux-"));
  try {
    return await runSyntheticConversion(tempDir, program, frameCount);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function runSyntheticConversion(tempDir, program, frameCount) {
  const { rom, checksum } = buildNromImage(program);
  const movie = syntheticMovie(checksum, frameCount);
  await writeFile(path.join(tempDir, "synthetic.nes"), rom);
  await writeFile(path.join(tempDir, "synthetic.fm2"), movie.text);
  const { stdout, stderr } = await runConverterWithTimeout(
    ["synthetic.fm2", "synthetic.nes", "out/synthetic.tdmask"],
    {
      cwd: tempDir,
      env: converterEnv({
        FCEUX_BIN: fceuxBin,
        HOME: path.join(tempDir, "home"),
        QT_QPA_PLATFORM: "offscreen",
      }),
    },
    45_000,
  );
  return {
    tempDir,
    movie,
    stdout,
    stderr,
    r08: await readFile(path.join(tempDir, "out", "synthetic.polls.r08")),
    tdmask: await readFile(path.join(tempDir, "out", "synthetic.tdmask")),
  };
}

test("exports one record per rising latch edge and counts unread latches in real FCEUX", { skip: needsFceux, timeout: 60_000 }, async () => {
  // The NMI handler latches three times per frame: once with a repeated high
  // write followed by eight reads of each port, once with no read, and once
  // followed by only seven port 1 reads. It then writes $4015 = $10.
  // This does not exercise the exporter ignoring hooks before the movie
  // restarts: with --playmov, FCEUX has not been seen to emulate a frame first.
  const nmi = [
    ...STROBE_HIGH, 0x8d, 0x16, 0x40, ...STROBE_LOW,
    0xa2, 0x08, 0xad, 0x16, 0x40, 0xad, 0x17, 0x40, 0xca, 0xd0, 0xf7,
    ...STROBE_HIGH, ...STROBE_LOW,
    ...STROBE_HIGH, ...STROBE_LOW,
    0xa2, 0x07, 0xad, 0x16, 0x40, 0xca, 0xd0, 0xfa,
    0xa9, 0x10, 0x8d, 0x15, 0x40,
    0x40,
  ];
  // SEI; CLD; LDX #$FF; TXS; LDA #$80; STA $2000 (NMI on); JMP *
  const reset = [0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xa9, 0x80, 0x8d, 0x00, 0x20, 0x4c, 0x0a, 0xc0];
  const frameCount = 90;
  const result = await convertSynthetic({ reset, nmi }, frameCount);
  try {
    const frames = [];
    for (let offset = 12; offset < result.tdmask.length; offset += 2) {
      frames.push([result.tdmask[offset], result.tdmask[offset + 1]]);
    }
    const polledFrames = frames.length;
    assert.ok(polledFrames >= frameCount - 4, `only ${polledFrames} polled frame(s)`);

    // The repeated high write adds no record: three per frame, all the same input.
    assert.equal(result.r08.length, polledFrames * 3 * 2);
    frames.forEach(([port1, port2], index) => {
      for (let latch = 0; latch < 3; latch += 1) {
        const offset = (index * 3 + latch) * 2;
        assert.deepEqual(
          [result.r08[offset], result.r08[offset + 1]],
          [reverseBits(port1), reverseBits(port2)],
          `frame record ${index}, latch ${latch}`,
        );
      }
    });

    const start = result.movie.masks.findIndex((_, index) =>
      frames.every((mask, offset) => {
        const source = result.movie.masks[index + offset];
        return source && source[0] === mask[0] && source[1] === mask[1];
      }));
    assert.notEqual(start, -1, "the exported frames are not a contiguous run of movie frames");
    // FCEUX delivers the first NMI a frame or two in; after that every frame
    // polls, so the export must run through the movie's last frame.
    assert.ok(start <= 4, `export starts at movie frame ${start}`);
    assert.equal(start + polledFrames, frameCount);

    assert.match(
      result.stdout,
      new RegExp(`Latches: ${polledFrames * 3} over ${polledFrames} polled frame\\(s\\) \\(3\\.00 per frame, difference ${polledFrames * 2}\\), ${polledFrames * 2} with no completed read`),
    );
    assert.match(result.stderr, new RegExp(`DPCM enable bit set ${polledFrames} time\\(s\\)`));
    assert.doesNotMatch(result.stderr, /returned input that changed after the latch/);
  } finally {
    await rm(result.tempDir, { recursive: true, force: true });
  }
});

test("warns when reads return input that changed after their latch in real FCEUX", { skip: needsFceux, timeout: 60_000 }, async () => {
  // With NMI off, the main loop latches, busy-waits about 41,000 cycles (more
  // than a frame), then reads port 1 eight times, so each read gets a later
  // frame's input than the one the latch sampled.
  const reset = [
    0x78, 0xd8, 0xa2, 0xff, 0x9a, // SEI; CLD; LDX #$FF; TXS
    ...STROBE_HIGH, ...STROBE_LOW, // $C005
    0xa0, 0x20, // LDY #$20
    0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x88, 0xd0, 0xf8, // LDX #0; DEX; BNE; DEY; BNE
    0xa2, 0x08, 0xad, 0x16, 0x40, 0xca, 0xd0, 0xfa, // eight port 1 reads
    0x4c, 0x05, 0xc0, // JMP $C005
  ];
  const result = await convertSynthetic({ reset }, 90);
  try {
    const mismatch = result.stderr.match(/(\d+) controller read\(s\) returned input that changed after the latch/);
    assert.ok(mismatch, result.stderr);
    assert.ok(Number(mismatch[1]) > 0);
  } finally {
    await rm(result.tempDir, { recursive: true, force: true });
  }
});
