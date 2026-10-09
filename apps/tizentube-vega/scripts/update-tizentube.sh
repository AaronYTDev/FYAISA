#!/usr/bin/env bash
# Updates the vendored TizenTube userscript from upstream (reisxd/TizenTube).
#
# Usage:
#   scripts/update-tizentube.sh            # latest main
#   scripts/update-tizentube.sh <ref>      # specific tag/branch/commit
#
# Builds mods/ -> dist/userScript.js upstream and vendors it into
# src/injection/userScript.js, then regenerates the injection bundle.
set -euo pipefail

REF="${1:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Cloning reisxd/TizenTube @ ${REF}"
git clone --depth 1 ${REF:+"--branch" "$REF"} https://github.com/reisxd/TizenTube "$WORK/TizenTube" 2>/dev/null \
  || git clone https://github.com/reisxd/TizenTube "$WORK/TizenTube" && git -C "$WORK/TizenTube" checkout "$REF"

COMMIT="$(git -C "$WORK/TizenTube" rev-parse HEAD)"
VERSION="$(node -p "require('$WORK/TizenTube/package.json').version")"
echo "==> Building userscript (TizenTube v${VERSION} @ ${COMMIT})"

cd "$WORK/TizenTube/mods"
npm ci --no-audit --no-fund
npm run build

test -s "$WORK/TizenTube/dist/userScript.js" || { echo "ERROR: upstream build produced no userScript.js" >&2; exit 1; }

cp "$WORK/TizenTube/dist/userScript.js" "$ROOT/src/injection/userScript.js"
node -e "
const fs = require('fs');
fs.writeFileSync('$ROOT/.tizentube.json', JSON.stringify({
  repository: 'https://github.com/reisxd/TizenTube',
  version: '$VERSION',
  commit: '$COMMIT',
  updated: new Date().toISOString()
}, null, 2) + '\n');
"

cd "$ROOT"
npm run build:injection
echo "==> Done. Commit the vendored files to ship TizenTube v${VERSION}."
