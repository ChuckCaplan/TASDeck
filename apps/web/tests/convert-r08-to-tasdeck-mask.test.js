const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/convert-r08-to-tasdeck-mask.sh");
const td2pHeader = Buffer.from([0x54, 0x44, 0x32, 0x50, 0x01, 0x02, 0x0d, 0x0a]);

test("converts an R08 byte stream to a versioned two-port TDMASK", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-r08-"));
  try {
    const r08Path = path.join(tempDir, "movie.r08");
    const romPath = path.join(tempDir, "game.nes");
    const outputPath = path.join(tempDir, "movie.tdmask");
    const payload = Buffer.from([0x01, 0x00, 0x82, 0x08]);
    await writeFile(r08Path, payload);
    await writeFile(romPath, Buffer.from("NES\x1a"));

    const { stdout } = await execFileAsync(scriptPath, [r08Path, romPath, outputPath]);

    assert.deepEqual(await readFile(outputPath), Buffer.concat([td2pHeader, payload]));
    assert.equal(
      await readFile(`${outputPath}.trace.csv`, "utf8"),
      "frame_index,source_frame,mask1_hex,mask2_hex,source_format\n" +
        "0,0,01,00,r08\n" +
        "1,1,82,08,r08\n",
    );
    assert.match(stdout, /Wrote 12 byte\(s\), 2 polled frame\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects an R08 stream with an incomplete controller pair", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-r08-"));
  try {
    const r08Path = path.join(tempDir, "movie.r08");
    const romPath = path.join(tempDir, "game.nes");
    await writeFile(r08Path, Buffer.from([0x01]));
    await writeFile(romPath, Buffer.from("NES\x1a"));

    await assert.rejects(
      execFileAsync(scriptPath, [r08Path, romPath]),
      /R08 input has an incomplete two-controller frame/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
