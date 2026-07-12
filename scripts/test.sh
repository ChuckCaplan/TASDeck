#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

node --test apps/web/tests/*.test.js
npm run test:ui

c++ -std=c++17 -Wall -Wextra -Werror \
  -Ifirmware/uno_r4_wifi/src \
  firmware/uno_r4_wifi/src/NesControllerState.cpp \
  firmware/uno_r4_wifi/src/NesDeckProtocol.cpp \
  firmware/uno_r4_wifi/src/NesTasPlayback.cpp \
  firmware/uno_r4_wifi/tests/protocol_test.cpp \
  -o /tmp/tasdeck_protocol_test

/tmp/tasdeck_protocol_test
