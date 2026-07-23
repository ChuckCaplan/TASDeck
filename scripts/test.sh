#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

node --test apps/web/tests/*.test.js
npm run test:ui

sh "$ROOT_DIR/scripts/test-firmware.sh"
