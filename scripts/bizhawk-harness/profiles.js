"use strict";

// BizHawk versions the harness can build, and the source edits each one needs. Every edit is a
// literal find-and-replace on BizHawk's own files; applyPatches fails loudly when a string is not
// where it is expected, so an unexpected upstream change never builds a half-patched core.

const REPOSITORY = "https://github.com/TASEmulators/BizHawk.git";

const SPARSE_PATHS = [
  "/src/BizHawk.Common/",
  "/src/BizHawk.BizInvoke/",
  "/src/BizHawk.Emulation.Common/",
  "/src/BizHawk.Emulation.Cores/Consoles/Nintendo/NES/",
  "/src/BizHawk.Emulation.Cores/Consoles/Nintendo/SubNESHawk/",
  "/src/BizHawk.Emulation.Cores/CPUs/MOS 6502X/",
  "/src/BizHawk.Emulation.Cores/Sound/",
  "/src/BizHawk.Emulation.Cores/CoreNames.cs",
  "/Assets/gamedb/",
];

const NES_CORE = "src/BizHawk.Emulation.Cores/Consoles/Nintendo/NES/NES.Core.cs";
const NES_CONTROLLERS = "src/BizHawk.Emulation.Cores/Consoles/Nintendo/NES/NESControllers.cs";
const NES_PPU = "src/BizHawk.Emulation.Cores/Consoles/Nintendo/NES/PPU.cs";
const SUBNES = "src/BizHawk.Emulation.Cores/Consoles/Nintendo/SubNESHawk/SubNESHawk.cs";
const SUBNES_EMULATOR = "src/BizHawk.Emulation.Cores/Consoles/Nintendo/SubNESHawk/SubNESHawk.IEmulator.cs";

// Edits shared by every supported version. The strobe hook differs and is added per profile.
const COMMON_PATCHES = [
  {
    file: NES_CORE,
    find: "\t\tprivate byte read_joyport(int addr)\n\t\t{\n\t\t\tbyte ret;\n",
    replace: "\t\tprivate byte read_joyport(int addr)\n\t\t{\n\t\t\tbyte ret;\n\t\t\tHookJoyReadPre?.Invoke(addr);\n",
  },
  {
    file: NES_CORE,
    find: "\t\tpublic void ExecFetch(ushort addr)\n",
    replace:
      "\t\tpublic static Action<byte> HookJoyWrite;\n" +
      "\t\tpublic static Action<int> HookJoyReadPre;\n" +
      "\t\tpublic static Action<ushort, byte> HookReadOdd;\n" +
      "\t\tpublic void ExecFetch(ushort addr)\n",
  },
  {
    file: NES_CORE,
    find: "\t\t\tif (MemoryCallbacks.HasReads)\n\t\t\t{\n\t\t\t\tuint flags = (uint)(MemoryCallbackFlags.CPUZero | MemoryCallbackFlags.AccessRead);",
    replace:
      "\t\t\tif (HookReadOdd != null && addr >= 0x2000 && addr < 0x8000) HookReadOdd(addr, ret);\n" +
      "\t\t\tif (MemoryCallbacks.HasReads)\n\t\t\t{\n\t\t\t\tuint flags = (uint)(MemoryCallbackFlags.CPUZero | MemoryCallbackFlags.AccessRead);",
  },
  {
    file: NES_CONTROLLERS,
    find: "\t\t\t_left = left;\n\t\t\t_right = right;\n",
    replace:
      "\t\t\t_left = left;\n\t\t\t_right = right;\n" +
      "\t\t\tif (_left is ControllerNES cl) cl.PortIndex = 0;\n" +
      "\t\t\tif (_right is ControllerNES cr) cr.PortIndex = 1;\n",
  },
  {
    file: NES_CONTROLLERS,
    find: "\tpublic class ControllerNES : INesPort\n\t{\n",
    replace:
      "\tpublic class ControllerNES : INesPort\n\t{\n" +
      "\t\t// Level for reads past the eighth clock since the latch; null keeps BizHawk's 1s.\n" +
      "\t\tpublic static System.Func<int, int> OverreadLevel;\n" +
      "\t\tpublic int PortIndex;\n" +
      "\t\tprivate int _reads;\n",
  },
  {
    file: NES_CONTROLLERS,
    after: "\tpublic class ControllerNES : INesPort\n",
    find: "\t\t\tif (s.OUT0 < s.OUT0old)\n\t\t\t\tLatch(c);\n",
    replace: "\t\t\tif (s.OUT0 < s.OUT0old)\n\t\t\t{\n\t\t\t\tLatch(c);\n\t\t\t\t_reads = 0;\n\t\t\t}\n",
  },
  {
    file: NES_CONTROLLERS,
    after: "\tpublic class ControllerNES : INesPort\n",
    find: "\t\t\tbyte ret = (byte)(_latchedValue & 1);\n",
    replace:
      "\t\t\tbyte ret = (byte)(_latchedValue & 1);\n" +
      "\t\t\tif (!_resetting && _reads >= 8 && OverreadLevel != null) ret = (byte)OverreadLevel(PortIndex);\n" +
      "\t\t\tif (!_resetting) _reads++;\n",
  },
  {
    file: NES_PPU,
    find: "\t\tprivate bool idleSynch;\n",
    replace: "\t\tpublic bool idleSynch;\n",
  },
  {
    file: SUBNES_EMULATOR,
    find: "\t\tprivate bool pass_new_input;\n\t\tprivate bool pass_a_frame;\n",
    replace: "\t\tpublic bool pass_new_input;\n\t\tpublic bool pass_a_frame;\n",
  },
  {
    file: SUBNES,
    find: "\t\tprivate readonly NES.NES _nesCore;\n",
    replace:
      "\t\tpublic readonly NES.NES _nesCore;\n" +
      "\n" +
      "\t\t// EverDrive-style launch: leave the PPU running through the reset.\n" +
      "\t\tpublic static bool SkipPpuReset;\n" +
      "\t\tpublic static System.Action AfterSoftReset;\n",
  },
  {
    file: SUBNES,
    find: "\t\t\t_nesCore.ppu.NESSoftReset();\n",
    replace: "\t\t\tif (!SkipPpuReset) _nesCore.ppu.NESSoftReset();\n\t\t\tAfterSoftReset?.Invoke();\n",
  },
];

const PROFILES = {
  "2.6.3": {
    tag: "2.6.3",
    defineConstants: [],
    langVersion: "latest",
    excludes: ["BizHawk.Emulation.Cores/Sound/CDAudio.cs"],
    usings: [],
    packages: [["Newtonsoft.Json", "13.0.1"]],
    patches: [
      ...COMMON_PATCHES,
      {
        file: NES_CORE,
        find: "\t\tprivate void write_joyport(byte value)\n\t\t{\n",
        replace: "\t\tprivate void write_joyport(byte value)\n\t\t{\n\t\t\tHookJoyWrite?.Invoke(value);\n",
      },
    ],
  },
  "2.11.1": {
    tag: "2.11.1",
    defineConstants: ["BIZHAWK_MODERN"],
    langVersion: "12.0",
    excludes: ["BizHawk.Emulation.Cores/Sound/CDAudio.cs", "BizHawk.Emulation.Cores/Sound/HuC6280PSG.cs"],
    usings: [["System", null], ["System.Object", "Lock"]],
    packages: [
      ["Newtonsoft.Json", "13.0.3"],
      ["CommunityToolkit.HighPerformance", "8.4.0"],
      ["ppy.SDL2-CS", "1.0.630-alpha", "native;contentFiles"],
      ["Google.FlatBuffers", "23.5.26"],
    ],
    patches: [
      ...COMMON_PATCHES,
      {
        // 2.11 applies a $4016 write on the CPU's next get-to-put transition.
        file: NES_CORE,
        find: "\t\tpublic void strobe_joyport()\n\t\t{\n",
        replace: "\t\tpublic void strobe_joyport()\n\t\t{\n\t\t\tHookJoyWrite?.Invoke(joypadStrobeValue);\n",
      },
    ],
  },
};

const DEFAULT_PROFILE = "2.6.3";

// Movies recorded before 2.8 run on the 2.6.3 core; later ones on 2.11.1.
function profileForMovie(emuVersion) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(emuVersion || "");
  if (!match) {
    return DEFAULT_PROFILE;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 8) ? "2.11.1" : "2.6.3";
}

// Applies one edit to a file's text, keeping the file's own line endings. `after` narrows the
// search to the first match that follows that marker.
function applyPatch(text, patch) {
  const crlf = text.includes("\r\n");
  const native = (value) => (crlf ? value.replaceAll("\n", "\r\n") : value);
  const find = native(patch.find);
  let start = 0;
  if (patch.after) {
    start = text.indexOf(native(patch.after));
    if (start < 0) {
      throw new Error(`patch anchor not found in ${patch.file}: ${JSON.stringify(patch.after)}`);
    }
  }
  const index = text.indexOf(find, start);
  if (index < 0) {
    throw new Error(`patch text not found in ${patch.file}: ${JSON.stringify(patch.find)}`);
  }
  if (!patch.after && text.indexOf(find, index + find.length) >= 0) {
    throw new Error(`patch text is not unique in ${patch.file}: ${JSON.stringify(patch.find)}`);
  }
  return text.slice(0, index) + native(patch.replace) + text.slice(index + find.length);
}

module.exports = {
  DEFAULT_PROFILE,
  PROFILES,
  REPOSITORY,
  SPARSE_PATHS,
  applyPatch,
  profileForMovie,
};
