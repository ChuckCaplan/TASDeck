const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { promisify } = require("node:util");
const { buildPatchedRom } = require("../tools/patch-startup.js");

const execFileAsync = promisify(execFile);
const script = path.resolve(path.dirname(module.filename), "../tools/patch-startup.js");

test("Battletoads patch rejects unknown ROMs without changing their bytes", () => {
  const rom = Buffer.alloc(262160);
  rom.write("NES\x1a");
  const original = Buffer.from(rom);
  assert.throws(() => buildPatchedRom(rom), /Unsupported ROM/);
  assert.deepEqual(rom, original);
});

test("Battletoads CLI refuses to patch its input file in place", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "battletoads-patch-"));
  try {
    const input = path.join(directory, "original.nes");
    await writeFile(input, "original contents");
    await assert.rejects(execFileAsync(process.execPath, [script, input, input]), /separate file/);
    assert.equal(await readFile(input, "utf8"), "original contents");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Battletoads patch reproduces the validated ROM and refuses output replacement", {
  skip: !process.env.BATTLETOADS_TEST_ROM && "Set BATTLETOADS_TEST_ROM to your original USA ROM",
}, async () => {
  const original = await readFile(process.env.BATTLETOADS_TEST_ROM);
  const { rom, manifest } = buildPatchedRom(original);
  assert.equal(manifest.outputSha256, "ad7e445e19c71b6f4ffa2b126bf9884a9ca074c366f2efe5a3be6c5c9f2932a8");
  assert.equal(rom.length, original.length);
  assert.equal(rom.subarray(0, 16).toString("hex"), "4e45531a100072080000700700000000");
  for (let offset = 0; offset < rom.length; offset += 1) {
    if (rom[offset] !== original[offset]) {
      assert.ok(manifest.patches.some((patch) => offset >= patch.offset && offset < patch.offset + patch.after.length / 2));
    }
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "battletoads-build-"));
  try {
    const output = path.join(directory, "patched.nes");
    const args = [script, process.env.BATTLETOADS_TEST_ROM, output];
    const result = await execFileAsync(process.execPath, args);
    assert.equal(JSON.parse(result.stdout).outputSha256, manifest.outputSha256);
    assert.deepEqual(await readFile(output), rom);
    await assert.rejects(execFileAsync(process.execPath, args), /EEXIST/);
    assert.deepEqual(await readFile(output), rom);
    assert.equal(createHash("sha1").update(await readFile(process.env.BATTLETOADS_TEST_ROM)).digest("hex"), manifest.sourceSha1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
