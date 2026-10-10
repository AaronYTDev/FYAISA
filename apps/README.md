
## App format

Everything below this line documents the app format used by this hub.

Every app in `apps/` is a complete Vega OS project, the same layout as the
VegaTube app that ships here as the reference implementation. There is no
FYAISA-specific runtime, wrapper, or API: if it builds and runs with the Vega
SDK, it belongs in the hub.

```
apps/<app-dir>/
├── manifest.toml          # Vega app manifest (REQUIRED, the source of truth)
├── package.json           # name @fyaisa/<app-dir>, kepler.appName, build scripts
├── app.json               # { name: "<package-id>.main", displayName }
├── index.js               # AppRegistry entry
├── babel.config.js
├── metro.config.js
├── tsconfig.json
├── src/                   # application source (React Native for Vega)
│   └── App.tsx
├── scripts/               # optional build helpers
└── README.md
```

## Rules

1. `manifest.toml` is authoritative. The catalog's `id`, `minOsVersion` and
   `architectures` must match the manifest. `fyaisa` reads the catalog; the
   device reads the manifest. Keep them in sync.
2. `package.json` must use the name `@fyaisa/<app-dir>` and keep the `kepler`
   block (`projectType`, `appName`, `targets: ["tv"]`).
3. Keep the standard build scripts; `fyaisa install` calls
   `build:release` / `build:debug` and then `vega device install-app`:
   ```json
   "build:release": "...", "build:debug": "..."
   ```
4. No `com.amazon` package id. Amazon's tooling refuses to sideload those.
5. Target `os.version` 1.2 unless you have a reason not to; that is what the
   current SDK mints. Devices below that need an older SDK.
6. Ship only source. No `node_modules/`, `build/`, `dist/` or `*.vpkg` in
   git; `fyaisa` builds on the host. (`.gitignore` already covers this.)
7. Declare a license. GPL-3.0-only or MIT both fine; copy the upstream
   license into the app directory.
8. Be honest in `containsAds` / `requiresNetwork` / `drm`. Users are
   installing unknown binaries onto their TV.
9. Add a credits section at the top for your app, listing yourself and the
   upstream project it derives from. This section is the part contributors
   are expected to edit.

## Adding your app

```bash
git clone https://github.com/AaronYTDev/FYAISA
cd FYAISA
mkdir -p apps/my-app
# easiest: copy the reference app and replace manifest/package/app.json/src
cp -r apps/vegatube apps/my-app
$EDITOR apps/my-app/manifest.toml     # id + title
$EDITOR apps/my-app/package.json      # name -> @fyaisa/my-app
# then register it in catalog.json
fyaisa info <your-app-id>
fyaisa install <your-app-id>
```

## Why the installer isn't on the device

A Vega OS app cannot install other `.vpkg` packages: package management is a
host-side operation (`vega device install-app`), and no third-party package
install API is exposed to apps. So FYAISA is split:

- `fyaisa` (this repo, host-side): fetches the catalog, builds the app, and
  installs it on the stick.
- FYAISA app (on-device): browses the catalog, shows details and versions,
  and can request installs through `fyaisa connect`.

## See also

[`docs/HOMEBREW.md`](../docs/HOMEBREW.md) covers Vega OS platform notes for
app developers: the sandbox layout (`/data`, `/tmp`, `/pkg`), `KeplerFileSystem`
usage, TV focus/`BackHandler`, and other platform gotchas. It also covers
[`fyaisaClient.ts`](../bridge/client/fyaisaClient.ts), a vendored client that
lets your app pair with `fyaisa connect` and run allowlisted `vega` CLI
commands on the user's PC.
