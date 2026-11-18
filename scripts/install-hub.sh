#!/usr/bin/env bash
#
# install-hub: build the FYAISA hub app and install it on a Fire TV.
#
#   ./scripts/install-hub.sh                     armv7 Release, any visible device
#   ./scripts/install-hub.sh aarch64             aarch64 Release
#   ./scripts/install-hub.sh x86_64 --device <ip:port>
#
# Needs the Vega CLI on PATH (source ~/vega/env) and Node.js 20+. Always
# clean-builds: incremental builds reuse stale staging and can drop the
# launcher icon from the package (see docs/HOMEBREW.md).
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-hub.sh [armv7|aarch64|x86_64] [--device <ip:port>]
EOF
}

ARCH="armv7"
DEVICE=""
POSITIONAL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --device)
      [ "$#" -ge 2 ] || { echo "error: --device needs a value" >&2; usage; exit 1; }
      DEVICE="$2"
      shift 2
      ;;
    --device=*)
      DEVICE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      [ "$POSITIONAL" -eq 0 ] || { echo "error: too many arguments" >&2; usage; exit 1; }
      ARCH="$1"
      POSITIONAL=1
      shift
      ;;
  esac
done

case "$ARCH" in
  armv7|aarch64|x86_64) ;;
  *)
    echo "error: unsupported architecture: $ARCH (use armv7, aarch64 or x86_64)" >&2
    exit 1
    ;;
esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_DIR/installer"

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
rm -rf build buildinfo.json dist
npm run build:release -- --target "$ARCH"

# vega device commands need a live vda link, and the link drops whenever the
# stick sleeps: reconnect to the requested or last-known device when no device
# is visible. install-app resolves the Release package from --dir itself, so
# there is no vpkg filename to guess here.
if ! vega device list 2>/dev/null | grep -qE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]+'; then
  saved="$DEVICE"
  [ -n "$saved" ] || saved="$(cat "$HOME/.fyaisa/last-device" 2>/dev/null || true)"
  if [ -n "$saved" ]; then
    vega exec vda connect "$saved" >/dev/null 2>&1 || true
  fi
fi

install_args=(device install-app --dir . -b Release)
if [ -n "$DEVICE" ]; then
  install_args+=(--device "$DEVICE")
fi
vega "${install_args[@]}"
echo "hub installed: app.fyaisa.hub.main ($ARCH)"
