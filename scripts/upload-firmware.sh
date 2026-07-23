#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if [ "${1:-}" = "--diagnostic" ]; then
  TASDECK_DIAGNOSTIC_FORCE_A=1
  TASDECK_ISR_DEBUG_PIN=9
  shift
fi

PORT="${ARDUINO_PORT:-}"

if [ "${1:-}" = "--port" ]; then
  if [ $# -lt 2 ]; then
    echo "Usage: npm run upload:firmware -- --port <serial-port>" >&2
    exit 2
  fi
  PORT="$2"
elif [ $# -gt 0 ]; then
  PORT="$1"
fi

if [ -z "$PORT" ]; then
  echo "Missing Arduino port." >&2
  echo "Find it with: arduino-cli board list" >&2
  echo "Then run: npm run upload:firmware -- --port <serial-port>" >&2
  echo "Or set ARDUINO_PORT to the serial port before running npm run upload:firmware." >&2
  exit 2
fi

EXTRA_FLAGS="${ARDUINO_EXTRA_FLAGS:-}"

append_extra_flag() {
  EXTRA_FLAGS="${EXTRA_FLAGS}${EXTRA_FLAGS:+ }$1"
}

if [ "${TASDECK_DIAGNOSTIC_FORCE_A:-0}" != "0" ]; then
  append_extra_flag "-DTASDECK_DIAGNOSTIC_FORCED_MASK=0x01"
fi

if [ -n "${TASDECK_ISR_DEBUG_PIN:-}" ]; then
  append_extra_flag "-DTASDECK_ISR_DEBUG_PIN=${TASDECK_ISR_DEBUG_PIN}"
fi

set -- \
  --fqbn arduino:renesas_uno:unor4wifi \
  --port "$PORT" \
  --upload

if [ -n "$EXTRA_FLAGS" ]; then
  echo "Arduino extra flags: $EXTRA_FLAGS"
  set -- "$@" --build-property "compiler.cpp.extra_flags=$EXTRA_FLAGS"
fi

arduino-cli compile "$@" firmware/uno_r4_wifi
