#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/convert-bk2-to-tasdeck-mask.sh <movie.bk2> <rom.nes> [output.tdmask]
  scripts/convert-bk2-to-tasdeck-mask.sh <rom.nes> <movie.bk2> [output.tdmask]

Environment:
  BIZHAWK_BIN=/path/to/EmuHawk.exe              Override the BizHawk executable.
  TASDECK_MASK_TRACE_OUTPUT=/path/to/trace.csv  Override the trace CSV path.

Output:
  Defaults to the current working directory, with the BK2 base name and a
  .tdmask extension.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

first=$1
second=$2
output_path=${3:-}
first_extension=${first##*.}
second_extension=${second##*.}

if [[ "$first_extension" == [Bb][Kk]2 ]]; then
  movie_path=$first
  rom_path=$second
elif [[ "$second_extension" == [Bb][Kk]2 ]]; then
  movie_path=$second
  rom_path=$first
else
  echo "One input must be a .bk2 file and the other must be a .nes ROM." >&2
  usage
  exit 2
fi

if [[ ! -f "$movie_path" ]]; then
  echo "Movie file not found: $movie_path" >&2
  exit 1
fi

if [[ ! -f "$rom_path" ]]; then
  echo "ROM file not found: $rom_path" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
controller_validator="$script_dir/validate-tasdeck-movie-inputs.js"

if [[ ! -f "$controller_validator" ]]; then
  echo "Controller preflight not found: $controller_validator" >&2
  exit 1
fi

node "$controller_validator" "$movie_path"

if [[ -z "$output_path" ]]; then
  movie_name=${movie_path##*/}
  output_path="$PWD/${movie_name%.*}.tdmask"
fi

trace_output_path=${TASDECK_MASK_TRACE_OUTPUT:-"$output_path.trace.csv"}

if [[ "$output_path" == "$movie_path" || "$output_path" == "$rom_path" ]]; then
  echo "Output path must not overwrite the movie or ROM file." >&2
  exit 1
fi

if [[ "$trace_output_path" == "$movie_path" || "$trace_output_path" == "$rom_path" || "$trace_output_path" == "$output_path" ]]; then
  echo "Trace path must not overwrite an input or the .tdmask output." >&2
  exit 1
fi

if [[ -n "${BIZHAWK_BIN:-}" ]]; then
  bizhawk_bin=$BIZHAWK_BIN
elif command -v EmuHawk.exe >/dev/null 2>&1; then
  bizhawk_bin=$(command -v EmuHawk.exe)
elif command -v EmuHawk >/dev/null 2>&1; then
  bizhawk_bin=$(command -v EmuHawk)
else
  echo "Could not find EmuHawk.exe on PATH. Set BIZHAWK_BIN=/path/to/EmuHawk.exe." >&2
  exit 1
fi

lua_path="$script_dir/bizhawk-export-tasdeck-mask.lua"

if [[ ! -f "$lua_path" ]]; then
  echo "BizHawk Lua exporter not found: $lua_path" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_path")"
mkdir -p -- "$(dirname -- "$trace_output_path")"
rm -f -- "$output_path" "$trace_output_path"

completion_path="${TMPDIR:-/tmp}/tasdeck-mask-complete-$$"
trap 'rm -f -- "$completion_path"' EXIT
rm -f -- "$completion_path"

# Native Windows programs do not reliably translate custom environment-variable
# paths from Git Bash. Convert every path that BizHawk or its Lua script sees.
native_path() {
  case "${OSTYPE:-}" in
    cygwin*|msys*|mingw*) cygpath -aw -- "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

native_movie_path=$(native_path "$movie_path")
native_rom_path=$(native_path "$rom_path")
native_output_path=$(native_path "$output_path")
native_trace_output_path=$(native_path "$trace_output_path")
native_completion_path=$(native_path "$completion_path")
native_lua_path=$(native_path "$lua_path")

echo "Movie:   $movie_path"
echo "ROM:     $rom_path"
echo "Output:  $output_path"
echo "Trace:   $trace_output_path"
echo "BizHawk: $bizhawk_bin"

bizhawk_status=0
TASDECK_MASK_OUTPUT="$native_output_path" \
TASDECK_MASK_TRACE_OUTPUT="$native_trace_output_path" \
TASDECK_MASK_COMPLETION_OUTPUT="$native_completion_path" \
  "$bizhawk_bin" \
    "--lua=$native_lua_path" \
    "--movie=$native_movie_path" \
    "$native_rom_path" || bizhawk_status=$?

if [[ ! -s "$completion_path" ]]; then
  echo "BizHawk did not report a completed TASDeck export (exit $bizhawk_status)." >&2
  exit 1
fi

completion=$(tr -d '\r\n' < "$completion_path")
if [[ "$completion" != complete\ * ]]; then
  echo "BizHawk exporter failed: $completion" >&2
  exit 1
fi

if (( bizhawk_status != 0 )); then
  echo "Warning: BizHawk exited with status $bizhawk_status after completing the export; validating outputs." >&2
fi

if [[ "$completion" =~ (reset_frames|power_frames)=[1-9][0-9]* ]]; then
  echo "Warning: The BK2 contains Reset or Power commands. TD2P stores controller masks only; reproduce those console actions separately on hardware." >&2
fi
echo "$completion"

if [[ ! -s "$output_path" ]]; then
  echo "Conversion did not create a non-empty output file: $output_path" >&2
  exit 1
fi

bytes=$(wc -c < "$output_path" | tr -d '[:space:]')
# TD2P v2: 8-byte header then a big-endian uint32 source movie frame count.
header=$(od -An -tx1 -N8 "$output_path" | tr -d '[:space:]')
if [[ "$header" != "5444325002020d0a" ]]; then
  echo "Output does not contain a supported TD2P v2 header: $output_path" >&2
  exit 1
fi
if (( bytes < 12 || (bytes - 12) % 2 != 0 )); then
  echo "Output has an incomplete two-controller frame: $output_path" >&2
  exit 1
fi
movie_frames=$((16#$(od -An -tx1 -j8 -N4 "$output_path" | tr -d '[:space:]')))
if (( movie_frames == 0 )); then
  echo "Warning: exporter could not record the source movie frame count; TASDeck will estimate the run time." >&2
fi

frames=$(((bytes - 12) / 2))
echo "Wrote $bytes byte(s), $frames polled frame(s), $movie_frames source movie frame(s): $output_path"
if [[ -f "$trace_output_path" ]]; then
  trace_rows=$(wc -l < "$trace_output_path" | tr -d '[:space:]')
  echo "Wrote trace CSV with $trace_rows line(s): $trace_output_path"
fi
