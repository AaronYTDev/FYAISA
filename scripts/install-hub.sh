#!/usr/bin/env bash
#
# install-hub: build the FYAISA hub app and install it on a Fire TV.
#
#   ./scripts/install-hub.sh            armv7 Release (Fire TV Stick HD and most sticks)
#   ./scripts/install-hub.sh aarch64    aarch64 Release
#
# Needs the Vega CLI on PATH (source ~/vega/env) and a device that answers
# `vega device list`. Always clean-builds: incremental builds reuse stale
# staging and can drop the launcher icon from the package (see
# docs/HOMEBREW.md).
set -euo pipefail

ARCH="${1:-armv7}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_DIR/installer"
PKG="$APP_DIR/build/${ARCH}-release/fyaisa-app_${ARCH}.vpkg"

command -v vega >/dev/null 2>&1 || {
  echo "error: vega CLI not found. Run: source ~/vega/env" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "error: npm not found (Node.js 20+ required)" >&2
  exit 1
}

cd "$APP_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund
rm -rf build buildinfo.json
npm run build:release

# vega device commands need a live vda link, and the link drops whenever the
# stick sleeps: reconnect to the last-known device when none is visible.
if ! vega device list 2>/dev/null | grep -qE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]+'; then
  saved="$(cat "$HOME/.fyaisa/last-device" 2>/dev/null || true)"
  if [ -n "$saved" ]; then
    vega exec vda connect "$saved" >/dev/null 2>&1 || true
  fi
fi

[ -f "$PKG" ] || {
  echo "error: expected package at $PKG" >&2
  exit 1
}

vega device install-app -p "$PKG"
echo "hub installed: app.fyaisa.hub.main"
