#!/usr/bin/env node

// Build a separate experimental ROM; never modify the supplied ROM.
// Assembly and cycle counts: rom-patches/battletoads-open-bus-preload.s
const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const sourceSha1 = "5c3a497a82be60704dedf45248b6ad9b32c855ab";
const preloadStub = Buffer.from("a2bca00720cbffa900852d60", "hex");
const preloadCode = Buffer.from(
  "a0008400a96085019100c8d0fbe601a50110f3a9758501a0bfa96f9100c8d0fbe601a601e07fd0f3" +
  "9100c8c0ebd0f9a2e1a03388d0fdcad0f8ea60",
  "hex",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildPatchedRom(source) {
  if (createHash("sha1").update(source).digest("hex") !== sourceSha1) {
    throw new Error(`Unsupported ROM: expected USA ROM SHA1 ${sourceSha1}`);
  }
  const rom = Buffer.from(source);
  const patches = [];
  function replace(offset, before, after, location) {
    if (before.length !== after.length || !rom.subarray(offset, offset + before.length).equals(before)) {
      throw new Error(`Unexpected original bytes at ${location}`);
    }
    after.copy(rom, offset);
  }
  function edit(bank, address, before, after, reason) {
    const offset = 16 + bank * 32768 + address - 0x8000;
    replace(offset, before, after, `bank ${bank}, $${address.toString(16)}`);
    patches.push({ bank, address, offset, before: before.toString("hex"), after: after.toString("hex"), reason });
  }
  // NES 2.0 header declaring 8 KiB battery-backed work RAM and 8 KiB CHR RAM, with the battery flag.
  // The EverDrive N8 Pro's RAM probe passes with the original iNES 1.0 header too, but only this
  // header reached the animated ending on hardware; volatile 8 KiB work RAM froze on the last screen.
  replace(0, Buffer.from("4e45531a1000700000000000", "hex"), Buffer.from("4e45531a1000720800007007", "hex"), "iNES header");
  patches.push({
    offset: 0,
    before: "4e45531a1000700000000000",
    after: "4e45531a1000720800007007",
    reason: "NES 2.0 header: battery flag, 8 KiB PRG-NVRAM (byte 10) and 8 KiB CHR-RAM (byte 11)",
  });
  edit(0, 0x82c4, Buffer.from("a900a217", "hex"), Buffer.from("208580ea", "hex"),
    "Reset hook; original A=0 and X=23 setup is restored by the trampoline");
  edit(0, 0x8085, Buffer.from("a93f8d0620a2008e0620a90f8d0720e8", "hex"),
    Buffer.from("a9808514a22aa00620cbffa900a21760", "hex"),
    "Bank-call trampoline in the disassembly's unused palette routine");
  edit(6, 0x802a, Buffer.from("4c89ae", "hex"), Buffer.from("4c3dff", "hex"),
    "Unused jump-table entry jumps to the preload stub");
  edit(6, 0xff3d, Buffer.alloc(preloadStub.length, 0xff), preloadStub,
    "Calls the bank 7 preload and restores bank 0's return bank");
  edit(7, 0x80bc, Buffer.alloc(preloadCode.length, 0xff), preloadCode,
    "Fills $6000-7FFF with the open-bus bytes these movies read, padded to exactly 6 frames");
  return {
    rom,
    manifest: {
      patch: "battletoads-open-bus-preload-v2",
      status: "Experimental NTSC patch for EverDrive N8 Pro; hardware verification pending",
      sourceSha1,
      sourceSha256: sha256(source),
      outputSha256: sha256(rom),
      patches,
    },
  };
}

function main(args) {
  if (args.length !== 2) {
    throw new Error('Usage: node scripts/patch-battletoads-startup.js "source.nes" "new-output.nes"');
  }
  const [input, output] = args.map((name) => path.resolve(name));
  if (input === output) {
    throw new Error("Output must be a separate file");
  }
  const { rom, manifest } = buildPatchedRom(readFileSync(input));
  writeFileSync(output, rom, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ...manifest, output }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildPatchedRom };
