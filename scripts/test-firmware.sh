#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

TEST_BINARY="build/tasdeck_protocol_test"
if [ "${OS:-}" = "Windows_NT" ]; then
  TEST_BINARY="${TEST_BINARY}.exe"
fi

trap 'rm -f "$TEST_BINARY"' EXIT HUP INT TERM

mkdir -p build

c++ -std=c++17 -Wall -Wextra -Werror \
  -Ifirmware/uno_r4_wifi/src \
  firmware/uno_r4_wifi/src/NesControllerState.cpp \
  firmware/uno_r4_wifi/src/NesDeckProtocol.cpp \
  firmware/uno_r4_wifi/src/NesTasPlayback.cpp \
  firmware/uno_r4_wifi/tests/protocol_test.cpp \
  -o "$TEST_BINARY"

"./$TEST_BINARY"
