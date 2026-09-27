#!/usr/bin/env node

// Collapse the frame-granular front of a per-strobe .r08 into one record per
// console frame, for playback with BRIDGE_TAS_GUARD_UNTIL. Super Mario Bros. 2
// strobes and reads the controllers until two consecutive port-1 reads agree,
// so each frame spends records j..k, where k is the first record whose port-1
// byte equals the record before it, and the game keeps record k. Records from
// the boundary on are copied unchanged. Writes a new file; never modifies the
// input.
const { Buffer } = require("node:buffer");
const { readFileSync, writeFileSync } = require("node:fs");
const process = require("node:process");

function guardSettledReads(bytes, boundary) {
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new Error("An .r08 holds two bytes per record");
  }
  const count = bytes.length / 2;
  if (!Number.isSafeInteger(boundary) || boundary <= 0 || boundary > count) {
    throw new Error(`Boundary must be a record index between 1 and ${count}`);
  }

  const port1 = (index) => bytes[index * 2];
  const frames = [];
  let first = 0;
  while (first < boundary) {
    let settled = first + 1;
    while (settled < count && port1(settled) !== port1(settled - 1)) {
      settled += 1;
    }
    if (settled >= boundary) {
      throw new Error(`The frame starting at record ${first} does not settle before record ${boundary}`);
    }
    frames.push(bytes.subarray(settled * 2, settled * 2 + 2));
    first = settled + 1;
  }

  return {
    records: Buffer.concat([...frames, bytes.subarray(boundary * 2)]),
    guardUntil: frames.length,
  };
}

function main(argv) {
  if (argv.length !== 3) {
    console.error("Usage: guard-r08.js <input.r08> <first per-strobe record> <output.r08>");
    return 2;
  }
  const [input, boundaryText, output] = argv;
  if (output === input) {
    console.error("Refusing to overwrite the input file");
    return 2;
  }
  const { records, guardUntil } = guardSettledReads(readFileSync(input), Number(boundaryText));
  writeFileSync(output, records, { flag: "wx" });
  console.log(`Wrote ${output}: ${records.length / 2} records.`);
  console.log(`Play it in strobe mode with BRIDGE_TAS_GUARD_UNTIL=${guardUntil}.`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { guardSettledReads };
