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

test("runs EmuHawk from PATH and validates its exported BK2 mask stream", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-bk2-"));
  try {
    const moviePath = path.join(tempDir, "test movie.bk2");
    const romPath = path.join(tempDir, "test game.nes");
    const outputPath = path.join(tempDir, "test output.tdmask");
    const emuHawkPath = path.join(tempDir, "EmuHawk.exe");

    await writeFile(moviePath, Buffer.from("BK2"));
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
    assert.match(stdout, /Wrote 14 byte\(s\), 1 polled frame\(s\), 1 source movie frame\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("documents the BizHawk override in help output", async () => {
  const { stderr } = await execFileAsync(scriptPath, ["--help"]);
  assert.match(stderr, /BIZHAWK_BIN=\/path\/to\/EmuHawk\.exe/);
});
