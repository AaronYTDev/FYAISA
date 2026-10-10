#!/usr/bin/env bash
# Rebuild src/doomPayload.js from source: clone the pinned doomgeneric,
# compile it with emscripten, wrap the result in the base64 module.
# Needs the emscripten SDK (emcc on PATH): https://emscripten.org
set -euo pipefail
cd "$(dirname "$0")/../wasm"

DOOMGENERIC_COMMIT=dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284

rm -rf doomgeneric
git clone https://github.com/ozkl/doomgeneric.git
git -C doomgeneric checkout "$DOOMGENERIC_COMMIT"

make clean
make doom.js
# The transport is only correct if the bundle is valid UTF-8 (the inline
# wasm rides as UTF-8 text); fail loudly if that ever stops holding.
python3 -c "import pathlib; pathlib.Path('doom.js').read_bytes().decode('utf-8')" \
  || { echo "doom.js is not valid UTF-8" >&2; exit 1; }
python3 ../scripts/make-payload.py

rm -rf doomgeneric obj
echo "payload regenerated"
