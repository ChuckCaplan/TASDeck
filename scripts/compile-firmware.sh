#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

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

set -- --fqbn arduino:renesas_uno:unor4wifi

if [ -n "$EXTRA_FLAGS" ]; then
  echo "Arduino extra flags: $EXTRA_FLAGS"
  set -- "$@" --build-property "compiler.cpp.extra_flags=$EXTRA_FLAGS"
fi

arduino-cli compile "$@" firmware/uno_r4_wifi
