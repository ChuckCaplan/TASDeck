const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/convert-fm2-to-tasdeck-mask.sh");
const luaPath = path.resolve("scripts/fceux-export-tasdeck-mask.lua");
const td2pHeader = Buffer.from([
  0x54, 0x44, 0x32, 0x50, 0x02, 0x02, 0x0d, 0x0a,
  // Big-endian source movie frame count (1).
  0x00, 0x00, 0x00, 0x01,
]);

const standardFm2 = `version 3
fourscore 0
microphone 0
port0 1
port1 1
port2 0
|0|........|........||
`;

function resolveBashExecutable() {
  const names = process.platform === "win32" ? ["bash.exe", "bash"] : ["bash"];
  for (const directoryEntry of (process.env.PATH || "").split(path.delimiter)) {
    const directory = directoryEntry.replace(/^"(.*)"$/, "$1");
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (directory && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "bash";
}

const bashExecutable = resolveBashExecutable();

function execBash(script, args = [], options = {}) {
  return execFileAsync(bashExecutable, [script, ...args], options);
}

test("uses native FCEUX arguments and paths from Windows Git Bash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasdeck-fm2-windows-"));
  try {
    const moviePath = path.join(tempDir, "test movie.fm2");
    const romPath = path.join(tempDir, "test game.nes");
    const outputPath = path.join(tempDir, "test output.tdmask");
    const argumentLogPath = path.join(tempDir, "fceux-arguments.txt");
    const fceuxPath = path.join(tempDir, "fceux64.exe");
    const cygpathPath = path.join(tempDir, "cygpath");

    await writeFile(moviePath, standardFm2);
    await writeFile(romPath, Buffer.from("NES\x1a"));
    await writeFile(
      cygpathPath,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-aw" ]]
shift
if [[ "\${1:-}" == "--" ]]; then
  shift
fi
printf 'WIN:%s\\n' "$1"
`,
      { mode: 0o755 },
    );
    await writeFile(
      fceuxPath,
      `#!/usr/bin/env bash
set -euo pipefail
for native_path in \\
  "$TASDECK_MASK_OUTPUT" \\
  "$TASDECK_MASK_TRACE_OUTPUT" \\
  "$TASDECK_MASK_COMPLETION_OUTPUT"; do
  [[ "$native_path" == WIN:* ]]
done
printf '%s\\n' "$@" > "$FCEUX_ARGUMENT_LOG"
output_path=\${TASDECK_MASK_OUTPUT#WIN:}
trace_path=\${TASDECK_MASK_TRACE_OUTPUT#WIN:}
completion_path=\${TASDECK_MASK_COMPLETION_OUTPUT#WIN:}
printf '\\124\\104\\062\\120\\002\\002\\015\\012\\000\\000\\000\\001\\001\\002' > "$output_path"
printf 'poll_index,movie_frame,mask1_hex,mask2_hex\\n0,0,01,02\\n' > "$trace_path"
printf 'complete frames=1 polls=1 reason=movie_length\\n' > "$completion_path"
`,
      { mode: 0o755 },
    );

    const commandPath = [
      tempDir,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter);
    const { stdout } = await execBash(scriptPath, [moviePath, romPath, outputPath], {
      env: {
        ...process.env,
        FCEUX_BIN: "",
        FCEUX_ARGUMENT_LOG: argumentLogPath,
        MSYSTEM: "UCRT64",
        PATH: commandPath,
      },
    });

    assert.deepEqual(
      await readFile(outputPath),
      Buffer.concat([td2pHeader, Buffer.from([0x01, 0x02])]),
    );
    assert.deepEqual(
      (await readFile(argumentLogPath, "utf8")).trim().split("\n"),
      [
        "-readonly",
        "1",
        "-playmovie",
        `WIN:${moviePath}`,
        "-lua",
        `WIN:${luaPath}`,
        `WIN:${romPath}`,
      ],
    );
    assert.match(stdout, /FCEUX:\s+.*fceux64\.exe/);
    assert.match(stdout, /Wrote 14 byte\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("documents the FCEUX Windows executable override in help output", async () => {
  const { stderr } = await execBash(scriptPath, ["--help"]);
  assert.match(stderr, /FCEUX_BIN=\/path\/to\/fceux/);
  assert.match(stderr, /\/c\/FCEUX\/fceux64\.exe/);
});
