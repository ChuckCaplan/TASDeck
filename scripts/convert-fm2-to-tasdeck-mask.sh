#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/convert-fm2-to-tasdeck-mask.sh <movie.fm2> <rom.nes> [output.tdmask|output.r08]
  scripts/convert-fm2-to-tasdeck-mask.sh <rom.nes> <movie.fm2> [output.tdmask|output.r08]

Environment:
  FCEUX_BIN=/path/to/fceux   Override the FCEUX executable. On Windows,
                              use a Git Bash path such as /c/FCEUX/fceux64.exe.
  TASDECK_R08_OUTPUT=/path/to/movie.r08
                              Override the per-latch .r08 path.

Output:
  One FCEUX pass writes two streams, by default into the current working
  directory with the FM2 base name:
    <name>.polls.r08  one record per console latch; play in strobe mode
    <name>.tdmask     one record per polled frame; plays in poll mode
  An output path ending in .r08 names the per-latch stream, and the .tdmask
  is written beside it.
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

r08_output_path=${TASDECK_R08_OUTPUT:-}
if [[ -z "$output_path" ]]; then
  fm2_name=${fm2_path##*/}
  output_path="$PWD/${fm2_name%.*}.tdmask"
elif [[ "$output_path" == *.[Rr]08 ]]; then
  r08_output_path=${r08_output_path:-$output_path}
  output_stem=${output_path%.*}
  if [[ "$output_stem" == *.[Pp][Oo][Ll][Ll][Ss] ]]; then
    output_stem=${output_stem%.*}
  fi
  output_path="$output_stem.tdmask"
fi
if [[ -z "$r08_output_path" ]]; then
  if [[ "$output_path" == *.[Tt][Dd][Mm][Aa][Ss][Kk] ]]; then
    r08_output_path="${output_path%.*}.polls.r08"
  else
    r08_output_path="$output_path.polls.r08"
  fi
fi

trace_output_path=${TASDECK_MASK_TRACE_OUTPUT:-"$output_path.trace.csv"}
completion_path="${TMPDIR:-/tmp}/tasdeck-mask-complete-$$"
trap 'rm -f -- "$completion_path"' EXIT

# Every output is deleted before FCEUX starts, so compare files, not spellings:
# ./movie.fm2, an absolute path, a symlink, or a case-only variant on a
# case-insensitive volume can all name the FM2 or ROM.
for path in "$output_path" "$r08_output_path" "$trace_output_path"; do
  if [[ "$path" -ef "$fm2_path" || "$path" -ef "$rom_path" ]]; then
    echo "Output path must not overwrite the FM2 or ROM file: $path" >&2
    exit 1
  fi
done

# dirname and basename split the same way, including on Git Bash, where both
# also treat a backslash as a separator.
absolute_path() {
  local directory
  directory=$(CDPATH='' cd -P -- "$(dirname -- "$1")" && pwd -P) || return 1
  printf '%s/%s\n' "$directory" "$(basename -- "$1")"
}

# Outputs may not exist yet, so -ef cannot compare them with each other.
# Compare resolved paths instead, lower-cased so names that differ only by case
# still collide on case-insensitive volumes. tr rather than ${var,,}, which the
# bash 3.2 that macOS ships does not support.
canonical_path() {
  absolute_path "$1" | tr '[:upper:]' '[:lower:]'
}

if [[ -n "${FCEUX_BIN:-}" ]]; then
  fceux_bin=$FCEUX_BIN
elif command -v fceux >/dev/null 2>&1; then
  fceux_bin=$(command -v fceux)
elif command -v fceux.exe >/dev/null 2>&1; then
  fceux_bin=$(command -v fceux.exe)
elif command -v fceux64.exe >/dev/null 2>&1; then
  fceux_bin=$(command -v fceux64.exe)
elif command -v fceux32.exe >/dev/null 2>&1; then
  fceux_bin=$(command -v fceux32.exe)
elif [[ -x /opt/homebrew/bin/fceux ]]; then
  fceux_bin=/opt/homebrew/bin/fceux
else
  echo "Could not find FCEUX. Put fceux, fceux.exe, or fceux64.exe on PATH, or set FCEUX_BIN." >&2
  exit 1
fi

lua_path="$script_dir/fceux-export-tasdeck-mask.lua"

if [[ ! -f "$lua_path" ]]; then
  echo "Lua exporter not found: $lua_path" >&2
  exit 1
fi

mkdir -p -- \
  "$(dirname -- "$output_path")" \
  "$(dirname -- "$r08_output_path")" \
  "$(dirname -- "$trace_output_path")"

# FCEUX runs the Lua exporter from the exporter's own directory, so a relative
# output path would be written under scripts/. Hand it absolute paths.
output_path=$(absolute_path "$output_path")
r08_output_path=$(absolute_path "$r08_output_path")
trace_output_path=$(absolute_path "$trace_output_path")

fm2_canonical=$(canonical_path "$fm2_path")
rom_canonical=$(canonical_path "$rom_path")
for path in "$output_path" "$r08_output_path" "$trace_output_path"; do
  canonical=$(canonical_path "$path")
  if [[ "$canonical" == "$fm2_canonical" || "$canonical" == "$rom_canonical" ]]; then
    echo "Output path must not overwrite the FM2 or ROM file: $path" >&2
    exit 1
  fi
done
output_canonical=$(canonical_path "$output_path")
r08_canonical=$(canonical_path "$r08_output_path")
trace_canonical=$(canonical_path "$trace_output_path")
if [[ "$output_canonical" == "$r08_canonical" ||
      "$output_canonical" == "$trace_canonical" ||
      "$r08_canonical" == "$trace_canonical" ]]; then
  echo "The .tdmask, per-latch .r08, and trace outputs must be three different files." >&2
  exit 1
fi

# The default per-latch name is the one TASBot's dumper writes, so say when a
# conversion replaces an existing file rather than doing it silently.
if [[ -e "$r08_output_path" ]]; then
  echo "Replacing existing per-latch output: $r08_output_path" >&2
fi

rm -f -- "$output_path"
rm -f -- "$r08_output_path"
rm -f -- "$trace_output_path"
rm -f -- "$completion_path"

windows_git_bash=false
case "${OSTYPE:-}:${MSYSTEM:-}" in
  cygwin*:*|msys*:*|mingw*:*|*:MINGW*|*:MSYS*|*:UCRT*|*:CLANG*)
    windows_git_bash=true
    ;;
esac

# Native Windows programs cannot use Git Bash paths stored in custom
# environment variables. Translate every path that FCEUX or its Lua script
# receives. Command-line options also differ between the native Win32 and
# Qt/SDL frontends.
native_path() {
  if $windows_git_bash; then
    cygpath -aw -- "$1"
  else
    printf '%s\n' "$1"
  fi
}

native_fm2_path=$(native_path "$fm2_path")
native_rom_path=$(native_path "$rom_path")
native_output_path=$(native_path "$output_path")
native_trace_output_path=$(native_path "$trace_output_path")
native_r08_output_path=$(native_path "$r08_output_path")
native_completion_path=$(native_path "$completion_path")
native_lua_path=$(native_path "$lua_path")

echo "FM2:    $fm2_path"
echo "ROM:    $rom_path"
echo "Output: $output_path"
echo "R08:    $r08_output_path"
echo "Trace:  $trace_output_path"
echo "FCEUX:  $fceux_bin"

fceux_status=0
if $windows_git_bash; then
  TASDECK_MASK_OUTPUT="$native_output_path" \
  TASDECK_MASK_TRACE_OUTPUT="$native_trace_output_path" \
  TASDECK_R08_OUTPUT="$native_r08_output_path" \
  TASDECK_MASK_COMPLETION_OUTPUT="$native_completion_path" \
    "$fceux_bin" \
      -readonly 1 \
      -playmovie "$native_fm2_path" \
      -lua "$native_lua_path" \
      "$native_rom_path" || fceux_status=$?
else
  TASDECK_MASK_OUTPUT="$native_output_path" \
  TASDECK_MASK_TRACE_OUTPUT="$native_trace_output_path" \
  TASDECK_R08_OUTPUT="$native_r08_output_path" \
  TASDECK_MASK_COMPLETION_OUTPUT="$native_completion_path" \
    "$fceux_bin" \
      --no-config 1 \
      --sound 0 \
      --playmov "$native_fm2_path" \
      --loadlua "$native_lua_path" \
      "$native_rom_path" || fceux_status=$?
fi

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

completion_field() {
  sed -n "s/.* $1=\([0-9][0-9]*\).*/\1/p" "$completion_path"
}
polled_frames=$(completion_field frames)
latches=$(completion_field latches)
unread_latches=$(completion_field unread_latches)
dmc_enables=$(completion_field dmc_enables)
read_mismatches=$(completion_field mismatches)

if [[ ! -f "$r08_output_path" ]]; then
  echo "FCEUX completed but did not create the per-latch output file: $r08_output_path" >&2
  exit 1
fi
r08_bytes=$(wc -c < "$r08_output_path" | tr -d '[:space:]')
if (( r08_bytes == 0 || r08_bytes % 2 != 0 )); then
  echo "FCEUX per-latch output is empty or has an incomplete two-controller record: $r08_output_path" >&2
  exit 1
fi
if [[ -n "$latches" ]] && (( r08_bytes != latches * 2 )); then
  echo "FCEUX per-latch output holds $((r08_bytes / 2)) record(s) but the exporter counted $latches latch(es): $r08_output_path" >&2
  exit 1
fi

echo "Wrote $bytes byte(s): $output_path"
echo "Wrote $r08_bytes byte(s): $r08_output_path"
if [[ -s "$trace_output_path" ]]; then
  trace_rows=$(wc -l < "$trace_output_path" | tr -d '[:space:]')
  echo "Wrote trace CSV with $trace_rows line(s): $trace_output_path"
fi
if [[ -n "$latches" && -n "$polled_frames" ]] && (( polled_frames > 0 )); then
  # Two decimals hide a small mismatch (36128 latches over 36127 frames prints
  # 1.00), so also give the exact difference.
  latches_per_frame=$(awk -v latches="$latches" -v frames="$polled_frames" 'BEGIN { printf "%.2f", latches / frames }')
  echo "Latches: $latches over $polled_frames polled frame(s) ($latches_per_frame per frame, difference $((latches - polled_frames))), ${unread_latches:-0} with no completed read"
fi
if [[ -n "$read_mismatches" ]] && (( read_mismatches > 0 )); then
  echo "Warning: $read_mismatches controller read(s) returned input that changed after the latch. The .polls.r08 records each latch's input, so at those reads it holds different input than FCEUX delivered." >&2
fi
if [[ -n "$dmc_enables" ]] && (( dmc_enables > 0 )); then
  echo "Warning: the game wrote \$4015 with the DPCM enable bit set $dmc_enables time(s). On a console, DPCM sample DMA can corrupt a controller read, and games that guard against that strobe again; the .polls.r08 cannot predict those extra latches. Start with the .tdmask, whose poll mode absorbs a re-read." >&2
fi
