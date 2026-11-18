#!/usr/bin/env bash
# Build and install VegaTube on the connected Fire TV (Vega OS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_TYPE="Release"
DEVICE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b)
      BUILD_TYPE="${2:-Release}"
      shift 2
      ;;
    Release|Debug)
      BUILD_TYPE="$1"
      shift
      ;;
    *)
      DEVICE="$1"
      shift
      ;;
  esac
done

case "$BUILD_TYPE" in
  Release|Debug) ;;
  *) echo "usage: $0 [Release|Debug] [device-name]" >&2; exit 2 ;;
esac

rm -rf build buildinfo.json
npm run "build:$(printf '%s' "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')"

if [[ -n "$DEVICE" ]]; then
  vega device install-app --dir . -b "$BUILD_TYPE" --device "$DEVICE"
else
  vega device install-app --dir . -b "$BUILD_TYPE"
fi
