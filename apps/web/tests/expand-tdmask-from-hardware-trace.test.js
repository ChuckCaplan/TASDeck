const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");

test("expands a tdmask when hardware polls through an emulator no-poll gap", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tasdeck-expand-mask-"));
  const tdmaskPath = path.join(tempDir, "movie.tdmask");
  const tracePath = `${tdmaskPath}.trace.csv`;
  const fm2Path = path.join(tempDir, "movie.fm2");
  const streamPath = path.join(tempDir, "movie.stream.csv");
  const outputPath = path.join(tempDir, "movie.expanded.tdmask");
  const scriptPath = path.resolve(
    path.dirname(module.filename),
    "../../../scripts/expand-tdmask-from-hardware-trace.js",
  );

  try {
    await fsp.writeFile(tdmaskPath, Buffer.from([0x00, 0x10, 0x20]));
    await fsp.writeFile(
      tracePath,
      [
        "poll_index,movie_frame,strobe_index,mask_hex,observed_hex,observed_valid,mismatch,incomplete_reads,ignored_reads,total_mismatches",
        "0,0,1,00,00,1,0,0,0,0",
        "1,3,2,10,10,1,0,0,0,0",
        "2,4,3,20,20,1,0,0,0,0",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      fm2Path,
      [
        "version 3",
        "|0|........|||",
        "|0|.......A|||",
        "|0|......B.|||",
        "|0|...U....|||",
        "|0|..D.....|||",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      streamPath,
      [
        "# tasdeck trace stream v1",
        "sequence,timestampMicros,tasFrame,latchCount,clockCount,clocksSinceLatch,polledMask,nextMask,latchedMask,shiftIndex,result,clockedMask,diag",
        "0,100000,0,1,8,8,00,00,00,8,ok,00,02",
        "1,116600,1,2,16,8,10,10,10,8,ok,10,02",
        "2,133200,2,3,24,8,20,20,20,8,ok,20,02",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [scriptPath, tdmaskPath, streamPath, "--fm2", fm2Path, "--output", outputPath, "--start-frame", "0"],
      { encoding: "utf8" },
    );

    assert.match(stdout, /before tdmask frame 1: insert 2 FM2 frame\(s\) 1-2/);
    assert.deepEqual(Array.from(fs.readFileSync(outputPath)), [0x00, 0x01, 0x02, 0x10, 0x20]);
    assert.match(fs.readFileSync(`${outputPath}.trace.csv`, "utf8"), /^1,1,2,01,01,1,0,0,0,0$/m);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
