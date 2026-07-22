const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/convert-bk2-to-tasdeck-mask.sh");
const td2pHeader = Buffer.from([
  0x54, 0x44, 0x32, 0x50, 0x02, 0x02, 0x0d, 0x0a,
  // Big-endian source movie frame count (1).
  0x00, 0x00, 0x00, 0x01,
]);

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
    localHeader.writeUInt32LE(0, 6);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(0, 8);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt32LE(0, 34);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const entryCount = Object.keys(entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(0, 4);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function bk2Fixture(controls, logKey) {
  return storedZip({
    "SyncSettings.json": JSON.stringify({ o: { Controls: controls } }),
    "Input Log.txt": `[Input]\nLogKey:${logKey}\n|..|........|........|\n[/Input]\n`,
  });
}

test("runs EmuHawk from PATH and validates its exported BK2 mask stream", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-bk2-"));
  try {
    const moviePath = path.join(tempDir, "test movie.bk2");
    const romPath = path.join(tempDir, "test game.nes");
    const outputPath = path.join(tempDir, "test output.tdmask");
    const emuHawkPath = path.join(tempDir, "EmuHawk.exe");

    await writeFile(moviePath, bk2Fixture(
      {
        Famicom: false,
        NesLeftPort: "ControllerNES",
        NesRightPort: "ControllerNES",
        FamicomExpPort: "UnpluggedFam",
      },
      "#Power|Reset|#P1 Up|P1 Down|P1 Left|P1 Right|P1 Start|P1 Select|P1 B|P1 A|#P2 Up|P2 Down|P2 Left|P2 Right|P2 Start|P2 Select|P2 B|P2 A|",
    ));
    await writeFile(romPath, Buffer.from("NES\x1a"));
    await writeFile(
      emuHawkPath,
      `#!/usr/bin/env bash
printf '\\124\\104\\062\\120\\002\\002\\015\\012\\000\\000\\000\\001\\001\\002' > "$TASDECK_MASK_OUTPUT"
printf 'frame_index,source_frame,mask1_hex,mask2_hex,source_format\\n0,0,01,02,bk2\\n' > "$TASDECK_MASK_TRACE_OUTPUT"
printf 'complete frames=1 movie_frames=1 lag_frames=0 reset_frames=0 power_frames=0\\n' > "$TASDECK_MASK_COMPLETION_OUTPUT"
`,
      { mode: 0o755 },
    );

    const { stdout } = await execFileAsync(scriptPath, [moviePath, romPath, outputPath], {
      env: { ...process.env, BIZHAWK_BIN: "", PATH: `${tempDir}${path.delimiter}${process.env.PATH}` },
    });

    assert.deepEqual(
      await readFile(outputPath),
      Buffer.concat([td2pHeader, Buffer.from([0x01, 0x02])]),
    );
    assert.match(stdout, /BizHawk: .*EmuHawk\.exe/);
    assert.match(stdout, /Controller preflight passed: BK2 uses only standard NES controllers/);
    assert.match(stdout, /Wrote 14 byte\(s\), 1 polled frame\(s\), 1 source movie frame\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects an Arkanoid controller before starting EmuHawk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-bk2-arkanoid-"));
  try {
    const moviePath = path.join(tempDir, "arkanoid.bk2");
    const romPath = path.join(tempDir, "arkanoid.nes");
    const outputPath = path.join(tempDir, "arkanoid.tdmask");
    const markerPath = path.join(tempDir, "emuhawk-started");
    const emuHawkPath = path.join(tempDir, "EmuHawk.exe");

    await writeFile(moviePath, bk2Fixture(
      {
        Famicom: false,
        NesLeftPort: "UnpluggedNES",
        NesRightPort: "ArkanoidNES",
        FamicomExpPort: "UnpluggedFam",
      },
      "#Power|Reset|#P1 Paddle|P1 Fire|",
    ));
    await writeFile(romPath, Buffer.from("NES\x1a"));
    await writeFile(emuHawkPath, `#!/usr/bin/env bash\ntouch "${markerPath}"\n`, { mode: 0o755 });

    await assert.rejects(
      execFileAsync(scriptPath, [moviePath, romPath, outputPath], {
        env: { ...process.env, BIZHAWK_BIN: emuHawkPath },
      }),
      (error) => {
        assert.match(error.stderr, /Controller preflight failed: unsupported BK2 controller configuration/);
        assert.match(error.stderr, /NesRightPort=ArkanoidNES/);
        assert.match(error.stderr, /input column "P1 Paddle"/);
        return true;
      },
    );
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("documents the BizHawk override in help output", async () => {
  const { stderr } = await execFileAsync(scriptPath, ["--help"]);
  assert.match(stderr, /BIZHAWK_BIN=\/path\/to\/EmuHawk\.exe/);
});
