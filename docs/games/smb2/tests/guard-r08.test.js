const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { promisify } = require("node:util");
const { guardSettledReads } = require("../tools/guard-r08.js");

const execFileAsync = promisify(execFile);
const script = path.resolve(path.dirname(module.filename), "../tools/guard-r08.js");

function r08(pairs) {
  return Buffer.from(pairs.flat());
}

test("keeps the settled read of each frame, then copies the per-strobe records", () => {
  const input = r08([
    [0x10, 0x01], [0x10, 0x02], // frame 0 settles on its second read
    [0x80, 0x00], [0x00, 0x00], [0x00, 0x03], // frame 1 needs a third read
    [0x40, 0x00], [0x40, 0x04], // frame 2
    [0x80, 0x00], [0x00, 0x00], // payload: one record per strobe
  ]);

  const { records, guardUntil } = guardSettledReads(input, 7);
  assert.equal(guardUntil, 3);
  assert.deepEqual([...records], [0x10, 0x02, 0x00, 0x03, 0x40, 0x04, 0x80, 0x00, 0x00, 0x00]);
});

test("refuses a boundary that splits a frame or an odd-length file", () => {
  const input = r08([[0x10, 0x00], [0x20, 0x00], [0x20, 0x00], [0x00, 0x00]]);
  assert.throws(() => guardSettledReads(input, 2), /does not settle before record 2/);
  assert.throws(() => guardSettledReads(input, 9), /Boundary/);
  assert.throws(() => guardSettledReads(Buffer.from([1, 2, 3]), 1), /two bytes per record/);
});

test("writes a new file and never replaces an existing one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-r08-"));
  try {
    const input = path.join(dir, "in.r08");
    const output = path.join(dir, "out.r08");
    await writeFile(input, r08([[0x10, 0x00], [0x10, 0x00], [0x80, 0x00]]));

    const { stdout } = await execFileAsync(process.execPath, [script, input, "2", output]);
    assert.match(stdout, /BRIDGE_TAS_GUARD_UNTIL=1/);
    assert.deepEqual([...await readFile(output)], [0x10, 0x00, 0x80, 0x00]);

    await assert.rejects(execFileAsync(process.execPath, [script, input, "2", output]), /EEXIST/);
    await assert.rejects(execFileAsync(process.execPath, [script, input, "2", input]), /overwrite the input/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
