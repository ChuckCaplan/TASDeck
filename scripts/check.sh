#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run TASDeck checks." >&2
  exit 1
fi

# Keep this test aligned with package.json's "^22.13.0 || >=24" engine range.
NODE_VERSION=$(node -p 'process.versions.node')
NODE_MAJOR=${NODE_VERSION%%.*}
NODE_REMAINDER=${NODE_VERSION#*.}
NODE_MINOR=${NODE_REMAINDER%%.*}
REQUIRED_NODE=$(node -p 'require(process.argv[1]).engines.node' "$ROOT_DIR/package.json")

NODE_SUPPORTED=0
if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; then
  NODE_SUPPORTED=1
elif [ "$NODE_MAJOR" -ge 24 ]; then
  NODE_SUPPORTED=1
fi

if [ "$NODE_SUPPORTED" -ne 1 ]; then
  echo "Unsupported Node.js $NODE_VERSION; TASDeck requires $REQUIRED_NODE." >&2
  exit 1
fi

npm --prefix "$ROOT_DIR" run lint
sh "$SCRIPT_DIR/test.sh"
sh "$SCRIPT_DIR/compile-firmware.sh"
sh "$SCRIPT_DIR/compile-firmware.sh" --diagnostic
