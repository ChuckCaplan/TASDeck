#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

npm --prefix "$ROOT_DIR" run lint
sh "$SCRIPT_DIR/test.sh"
sh "$SCRIPT_DIR/compile-firmware.sh"
