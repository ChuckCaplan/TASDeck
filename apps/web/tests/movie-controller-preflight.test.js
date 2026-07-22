const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { promisify } = require("node:util");

const {
  validateBk2Metadata,
  validateFm2Text,
} = require("../../../scripts/validate-tasdeck-movie-inputs.js");

const execFileAsync = promisify(execFile);
const fm2ConverterPath = path.resolve("scripts/convert-fm2-to-tasdeck-mask.sh");
const validatorPath = path.resolve("scripts/validate-tasdeck-movie-inputs.js");
const bk2ToFm2ConverterPath = path.resolve("scripts/convert-bk2-to-fm2.js");

const standardFm2 = `version 3
fourscore 0
microphone 0
port0 1
port1 1
port2 0
|0|........|........||
`;

const standardBk2Sync = JSON.stringify({
  o: {
    Controls: {
      Famicom: false,
      NesLeftPort: "ControllerNES",
      NesRightPort: "ControllerNES",
      FamicomExpPort: "UnpluggedFam",
    },
  },
});
const standardBk2Log = `[Input]
LogKey:#Power|Reset|#P1 Up|P1 Down|P1 Left|P1 Right|P1 Start|P1 Select|P1 B|P1 A|#P2 Up|P2 Down|P2 Left|P2 Right|P2 Start|P2 Select|P2 B|P2 A|
|..|........|........|
[/Input]
`;

test("CLI help uses stdout while argument errors use stderr", async () => {
  for (const scriptPath of [validatorPath, bk2ToFm2ConverterPath]) {
    const help = await execFileAsync(process.execPath, [scriptPath, "--help"]);
    assert.match(help.stdout, /^usage:/);
    assert.equal(help.stderr, "");

    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath]),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /^error: .+\nusage:/s);
        return true;
      },
    );
  }
});

test("accepts standard P1/P2 controller metadata", () => {
  assert.doesNotThrow(() => validateFm2Text(standardFm2));
  assert.doesNotThrow(() => validateBk2Metadata(standardBk2Sync, standardBk2Log));
  assert.doesNotThrow(() => validateBk2Metadata(
    '{"o":{"$type":"SubNESHawkSyncSettings"}}',
    "LogKey:#Reset Cycle|Power|Reset|#P1 Up|P1 Down|P1 Left|P1 Right|P1 Start|P1 Select|P1 B|P1 A|\n",
  ));
});

test("rejects every unsupported FM2 controller declaration", () => {
  const cases = [
    ["fourscore 1", /Four Score\/P3\/P4/],
    ["port0 2", /port0=2/],
    ["port1 5", /port1=5/],
    ["port2 1", /expansion-port controllers/],
    ["microphone 1", /microphone input/],
  ];
  for (const [replacement, expected] of cases) {
    const key = replacement.split(" ")[0];
    const movie = standardFm2.replace(new RegExp(`^${key} .+$`, "m"), replacement);
    assert.throws(() => validateFm2Text(movie), expected);
  }
});

test("rejects unsupported BK2 devices and controller input columns", () => {
  const arkanoidSync = standardBk2Sync.replace("ControllerNES\",\"FamicomExpPort", "ArkanoidNES\",\"FamicomExpPort");
  assert.throws(
    () => validateBk2Metadata(arkanoidSync, "LogKey:#Power|Reset|#P1 Paddle|P1 Fire|\n"),
    /NesRightPort=ArkanoidNES/,
  );
  assert.throws(
    () => validateBk2Metadata(standardBk2Sync, "LogKey:#Power|Reset|#P1 Zapper X|P1 Zapper Y|P1 Trigger|\n"),
    /P1 Zapper X/,
  );
  assert.throws(
    () => validateBk2Metadata(standardBk2Sync, "LogKey:#Power|Reset|#P3 A|\n"),
    /P3 A/,
  );
  assert.throws(
    () => validateBk2Metadata(standardBk2Sync.replace("UnpluggedFam", "PowerPadFam"), standardBk2Log),
    /FamicomExpPort=PowerPadFam/,
  );
});

test("FM2 converter rejects a Zapper before starting FCEUX", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-zapper-"));
  try {
    const moviePath = path.join(tempDir, "zapper.fm2");
    const romPath = path.join(tempDir, "zapper.nes");
    const outputPath = path.join(tempDir, "zapper.tdmask");
    const markerPath = path.join(tempDir, "fceux-started");
    const fceuxPath = path.join(tempDir, "fceux");
    await writeFile(moviePath, standardFm2.replace("port1 1", "port1 2"));
    await writeFile(romPath, Buffer.from("NES\x1a"));
    await writeFile(fceuxPath, `#!/usr/bin/env bash\ntouch "${markerPath}"\n`, { mode: 0o755 });

    await assert.rejects(
      execFileAsync(fm2ConverterPath, [moviePath, romPath, outputPath], {
        env: { ...process.env, FCEUX_BIN: fceuxPath },
      }),
      (error) => {
        assert.match(error.stderr, /Controller preflight failed: unsupported FM2 controller configuration/);
        assert.match(error.stderr, /port1=2/);
        return true;
      },
    );
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
