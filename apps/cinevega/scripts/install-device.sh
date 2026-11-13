#!/usr/bin/env bash
# Builds and installs Cinevega on the connected Fire TV.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
rm -rf build buildinfo.json
npm run build:release
vega device install-app --dir . -b Release
