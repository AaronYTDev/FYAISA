#!/usr/bin/env bash
# Builds and installs Aether on the connected Fire TV.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
rm -rf build buildinfo.json
npm run build:release
vega device install-app -p build/armv7-release/aether_armv7.vpkg