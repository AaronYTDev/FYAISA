#!/usr/bin/env bash
# Installs the built TizenTube vpkg on a connected Fire TV (Vega OS) device.
#
# Prereqs:
#   - Developer Mode enabled on the Fire TV (see README)
#   - `vega device list` shows your device
#   - `npm run build:release` (or build:debug) has produced build/**/*.vpkg
#
# Usage:
#   scripts/install-device.sh                # auto-pick the .vpkg, Release build
#   scripts/install-device.sh <device-name>  # target a specific device
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "-b" ]]; then
  BUILD_TYPE="$2"; shift 2
else
  BUILD_TYPE="Release"
fi

echo "==> Connected devices:"
vega device list || true

echo "==> Building app (injection bundle + vpkg, ${BUILD_TYPE})..."
npm run "build:$(echo "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')"

echo "==> Installing on device..."
if [[ -n "${1:-}" ]]; then
  vega device install-app --dir . -b "$BUILD_TYPE" --device "$1"
else
  vega device install-app --dir . -b "$BUILD_TYPE"
fi

echo "==> Done. Launch 'TizenTube' from your Fire TV app list."
