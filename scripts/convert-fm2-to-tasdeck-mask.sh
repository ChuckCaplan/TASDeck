#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/convert-fm2-to-tasdeck-mask.sh <movie.fm2> <rom.nes> [output.tdmask]
  scripts/convert-fm2-to-tasdeck-mask.sh <rom.nes> <movie.fm2> [output.tdmask]

Environment:
  FCEUX_BIN=/path/to/fceux   Override the fceux executable.

Output:
  Defaults to the current working directory, with the FM2 base name and a
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

case "${first##*.}:${second##*.}" in
  fm2:nes)
    fm2_path=$first
    rom_path=$second
    ;;
  nes:fm2)
    rom_path=$first
    fm2_path=$second
    ;;
  *)
    fm2_path=$first
    rom_path=$second
    ;;
esac

if [[ ! -f "$fm2_path" ]]; then
  echo "FM2 file not found: $fm2_path" >&2
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

node "$controller_validator" "$fm2_path"

if [[ -z "$output_path" ]]; then
  fm2_name=${fm2_path##*/}
  output_path="$PWD/${fm2_name%.*}.tdmask"
fi

trace_output_path=${TASDECK_MASK_TRACE_OUTPUT:-"$output_path.trace.csv"}
completion_path="${TMPDIR:-/tmp}/tasdeck-mask-complete-$$"
trap 'rm -f -- "$completion_path"' EXIT

if [[ "$output_path" == "$fm2_path" || "$output_path" == "$rom_path" ]]; then
  echo "Output path must not overwrite the FM2 or ROM file." >&2
  exit 1
fi

if [[ -n "${FCEUX_BIN:-}" ]]; then
  fceux_bin=$FCEUX_BIN
elif command -v fceux >/dev/null 2>&1; then
  fceux_bin=$(command -v fceux)
elif [[ -x /opt/homebrew/bin/fceux ]]; then
  fceux_bin=/opt/homebrew/bin/fceux
else
  echo "Could not find fceux. Set FCEUX_BIN=/path/to/fceux." >&2
  exit 1
fi

lua_path="$script_dir/fceux-export-tasdeck-mask.lua"

if [[ ! -f "$lua_path" ]]; then
  echo "Lua exporter not found: $lua_path" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_path")"
rm -f -- "$output_path"
rm -f -- "$trace_output_path"
rm -f -- "$completion_path"

echo "FM2:    $fm2_path"
echo "ROM:    $rom_path"
echo "Output: $output_path"
echo "Trace:  $trace_output_path"
echo "FCEUX:  $fceux_bin"

fceux_status=0
TASDECK_MASK_OUTPUT="$output_path" \
TASDECK_MASK_TRACE_OUTPUT="$trace_output_path" \
TASDECK_MASK_COMPLETION_OUTPUT="$completion_path" \
  "$fceux_bin" \
    --no-config 1 \
    --sound 0 \
    --playmov "$fm2_path" \
    --loadlua "$lua_path" \
    "$rom_path" || fceux_status=$?

if [[ ! -s "$completion_path" ]]; then
  echo "FCEUX did not report a completed TASDeck export (exit $fceux_status)." >&2
  exit 1
fi

if (( fceux_status != 0 )); then
  echo "Warning: FCEUX exited with status $fceux_status after completing the export; validating outputs." >&2
fi

if [[ ! -s "$output_path" ]]; then
  echo "FCEUX completed but did not create a non-empty output file: $output_path" >&2
  exit 1
fi

bytes=$(wc -c < "$output_path" | tr -d '[:space:]')
# TD2P v2: 8-byte header then a big-endian uint32 source movie frame count.
header=$(od -An -tx1 -N8 "$output_path" | tr -d '[:space:]')
if [[ "$header" != "5444325002020d0a" ]]; then
  echo "FCEUX output does not contain a supported TD2P v2 header: $output_path" >&2
  exit 1
fi
if (( bytes < 12 || (bytes - 12) % 2 != 0 )); then
  echo "FCEUX output has an incomplete two-controller frame: $output_path" >&2
  exit 1
fi
movie_frames=$((16#$(od -An -tx1 -j8 -N4 "$output_path" | tr -d '[:space:]')))
if (( movie_frames == 0 )); then
  echo "Warning: exporter could not record the source movie frame count; TASDeck will estimate the run time." >&2
fi

echo "Wrote $bytes byte(s): $output_path"
if [[ -s "$trace_output_path" ]]; then
  trace_rows=$(wc -l < "$trace_output_path" | tr -d '[:space:]')
  echo "Wrote trace CSV with $trace_rows line(s): $trace_output_path"
fi
