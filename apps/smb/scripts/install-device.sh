#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG="build/armv7-release/$(jq -r '.name' "$APP_DIR/package.json" | tr '/' '-')_armv7.vpkg"
if [[ ! -f "$PKG" ]]; then
  echo "Package not found: $PKG"
  exit 1
fi
vega device install-app -p "$PKG"
vega device launch-app -i app.smb.main