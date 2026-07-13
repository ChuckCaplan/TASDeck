#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/convert-r08-to-tasdeck-mask.sh <input.r08> <rom.nes> [output.tdmask]
  scripts/convert-r08-to-tasdeck-mask.sh <rom.nes> <input.r08> [output.tdmask]

Environment:
  TASDECK_MASK_TRACE_OUTPUT=/path/to/trace.csv   Override the trace CSV path.

Output:
  Defaults to the current working directory, with the R08 base name and a
  .tdmask extension. The ROM is checked for existence but is not opened; R08
  files do not contain ROM metadata that can be validated.
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
  r08:nes)
    r08_path=$first
    rom_path=$second
    ;;
  nes:r08)
    rom_path=$first
    r08_path=$second
    ;;
  *)
    echo "One input must be an .r08 file and the other must be a .nes ROM." >&2
    usage
    exit 2
    ;;
esac

if [[ ! -f "$r08_path" ]]; then
  echo "R08 file not found: $r08_path" >&2
  exit 1
fi

if [[ ! -f "$rom_path" ]]; then
  echo "ROM file not found: $rom_path" >&2
  exit 1
fi

if [[ -z "$output_path" ]]; then
  r08_name=${r08_path##*/}
  output_path="$PWD/${r08_name%.*}.tdmask"
fi

trace_output_path=${TASDECK_MASK_TRACE_OUTPUT:-"$output_path.trace.csv"}

if [[ "$output_path" == "$r08_path" || "$output_path" == "$rom_path" ]]; then
  echo "Output path must not overwrite the R08 or ROM file." >&2
  exit 1
fi

if [[ "$trace_output_path" == "$r08_path" || "$trace_output_path" == "$rom_path" || "$trace_output_path" == "$output_path" ]]; then
  echo "Trace path must not overwrite an input or the .tdmask output." >&2
  exit 1
fi

bytes=$(wc -c < "$r08_path" | tr -d '[:space:]')
if (( bytes == 0 )); then
  echo "R08 input is empty: $r08_path" >&2
  exit 1
fi
if (( bytes % 2 != 0 )); then
  echo "R08 input has an incomplete two-controller frame: $r08_path" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_path")"
mkdir -p -- "$(dirname -- "$trace_output_path")"

output_tmp="$output_path.tmp.$$"
trace_tmp="$trace_output_path.tmp.$$"
trap 'rm -f -- "$output_tmp" "$trace_tmp"' EXIT

printf '\124\104\062\120\001\002\015\012' > "$output_tmp"
cat -- "$r08_path" >> "$output_tmp"

printf '%s\n' 'frame_index,source_frame,mask1_hex,mask2_hex,source_format' > "$trace_tmp"
od -An -v -tu1 "$r08_path" | awk '
  {
    for (field = 1; field <= NF; field += 1) {
      if (have_port1 == 0) {
        port1 = $field
        have_port1 = 1
      } else {
        printf "%d,%d,%02X,%02X,r08\n", frame, frame, port1, $field
        frame += 1
        have_port1 = 0
      }
    }
  }
  END {
    if (have_port1 != 0) exit 1
  }
' >> "$trace_tmp"

mv -f -- "$output_tmp" "$output_path"
mv -f -- "$trace_tmp" "$trace_output_path"

output_bytes=$(wc -c < "$output_path" | tr -d '[:space:]')
header=$(od -An -tx1 -N8 "$output_path" | tr -d '[:space:]')
if [[ "$header" != "5444325001020d0a" ]]; then
  echo "Output does not contain a supported TD2P v1 header: $output_path" >&2
  exit 1
fi
if (( output_bytes < 8 || (output_bytes - 8) % 2 != 0 )); then
  echo "Output has an incomplete two-controller frame: $output_path" >&2
  exit 1
fi

frames=$((bytes / 2))
trace_rows=$(wc -l < "$trace_output_path" | tr -d '[:space:]')

echo "R08:    $r08_path"
echo "ROM:    $rom_path (existence check only)"
echo "Output: $output_path"
echo "Trace:  $trace_output_path"
echo "Wrote $output_bytes byte(s), $frames polled frame(s): $output_path"
echo "Wrote trace CSV with $trace_rows line(s): $trace_output_path"
