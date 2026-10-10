# Homebrew on Vega OS: PC setup, the Vega CLI, and FYAISA commands

This guide is for homebrew developers who want a PC talking to a Vega OS Fire TV
Stick: enough to build, install, debug and ship apps. Everything here was
tested on a Fire TV Stick HD (OS 2.0, armv7l).

```
your PC                                    your Fire TV
───────                                    ────────────
Vega CLI (vega …)  ──TCP 5555──────────▶  Developer Mode (ADB-style bridge)
fyaisa (CLI)       ──builds + installs─▶  vega device install-app
fyaisa connect    ◀──HTTP 47821────────  FYAISA app (pairing + install requests)
                                          other homebrew apps: same pairing,
                                          allowlisted `vega` CLI access (§6)
```

## 1. Prerequisites

- Node.js 20+
- Vega SDK: Amazon's official SDK, installed per
  [Amazon's docs](https://developer.amazon.com/docs/vega/latest/install-vega-sdk.html).
  The installer drops everything into `~/vega`.
- The FYAISA repo (contains the CLI, the bridge, and the reference app):

  ```bash
  git clone https://github.com/AaronYTDev/FYAISA
  cd FYAISA
  ```

## 2. Put the Vega CLI on your PATH

```bash
source ~/vega/env          # adds ~/vega/bin to PATH for this shell
vega --version             # e.g. Vega CLI Version: 1.4.4
```

`~/vega/env` is a plain sh snippet; add `source ~/vega/env` to `~/.bashrc` to
make it permanent. It provides `vega`, `kepler`, and `vvman`.

## 3. Enable Developer Mode on the stick

On the Fire TV:

1. **Settings → My Fire TV → Developer options → ADB debugging** → ON.
2. Note the stick's IP: **Settings → Network → (your network) → IP Address**.

Then from the PC:

```bash
vega exec vda connect <stick-ip>:5555     # e.g. 192.168.12.197:5555
vega device list                          # should show the stick
fyaisa devices                            # same check, via the hub CLI
```

If `vega device list` comes back empty after a while, the connection dropped;
just run the `connect` line again. Fire TVs sleep their network, so expect to
reconnect occasionally.

## 4. Build and install an app

The hub CLI does dependency install, build and install in one go:

```bash
fyaisa list                    # catalog
fyaisa search youtube
fyaisa info app.vegatube.main
fyaisa install app.vegatube.main
```

The manual equivalent, for any Vega project (this is all `fyaisa install` does):

```bash
cd apps/vegatube
npm install
npm run build:release          # produces a .vpkg under build/
vega device install-app --dir . -b Release
```

The hub app itself builds the same way; `./scripts/install-hub.sh` does the
clean build and the install in one step (pass `aarch64` as the first
argument for other sticks).

Managing what's on the device:

```bash
vega device launch-app  --appName app.vegatube.main
vega device terminate-app --appName app.vegatube.main
vega device is-app-running --appName app.vegatube.main
vega device start-log-stream              # follow device logs (see gotcha #8)
vega device run-cmd --command 'ls /data'  # shell on the device (as app_user)
```

Uninstall: `fyaisa uninstall <app-id>`.

### App icon

The launcher tile is declared in the manifest and the art ships inside the
package:

```toml
[package]
# ...
icon = "@image/app.png"
```

The name must match `^@image/([^\s/]+)$` and the file must exist at
`assets/image/<name>` in the project (the packaging tool checks and prints
`Icon file not found: manifest declares icon '@image/app.png'` when it is
missing). Without an `icon` field the system default tile is used and the
pack warns `Icon is not defined in the manifest`. A square 512x512 PNG
works; the launcher crops to a rounded tile, so keep key art away from the
corners. The hub's app list shows the same artwork offline: copies live
under `installer/assets/image/` with the catalog ids mapped in
`APP_ICONS` in `installer/src/App.tsx`.

Incremental builds do not reliably re-stage the manifest or `assets/`:
after changing either, delete `build/` and `buildinfo.json` before
rebuilding, otherwise the pack silently reuses the previous staging and the
vpkg ships without the icon (no warning, exit 0).

## 5. Install from the couch: pairing the TV app with your PC (ElevSH)

A Vega app cannot install packages itself (no third-party install API exists in
the SDK), so the FYAISA app on the TV *asks your PC* to do it. That PC
connection is called **ElevSH**:

```bash
fyaisa connect --lan          # run on the PC; --lan so the TV can reach it
fyaisa disconnect             # stop the bridge again when you're done
```

The bridge prints:

```
  Pairing code: 126147
  Approve on this PC with:

    fyaisa approve 126147

  or open FYAISA → ElevSH on the Fire TV and choose Allow.
```

Full walkthrough:

1. **On the TV:** open **FYAISA → ElevSH** → enter the PC's IP with the D-pad
   keypad → **Get pairing code**. The TV requests a code from the bridge and
   displays it.
2. **On the PC:** the same code is printed by the bridge. Approve it:

   ```bash
   fyaisa approve 126147
   ```

3. The TV polls, receives its pairing token, and the **Install** button appears
   in the app. Pairing persists on the TV across app restarts, reboots and even
   reinstalls of the app (it lives in the app's private `/data`), so you only
   do this once per PC.

Useful flags: `--port N` (change 47821), `--tunnel` (prints cloudflared/ngrok
commands for internet access, though LAN is the intended mode), `--hub-dir <path>`.
If the token ever goes stale (e.g. you deleted `~/.fyaisa/bridge.json`), the
app detects the 401 on its next launch and asks you to re-pair; the **Forget
ElevSH pairing** button clears it manually.

### Letting other apps use ElevSH (allow/deny in FYAISA)

ElevSH also handles consent for the other homebrew apps:

1. An app using the vendored client sends `X-FYAISA-App: <app-id>` when it
   requests a pairing code. The bridge records it as *pending*.
2. **FYAISA → ElevSH** shows it live: "app.vegatube.main wants to pair". One
   **Allow** tap on the TV approves the pairing *and* marks the app allowed;
   **Deny** blocks it. No PC keyboard needed.
3. Once allowed, every future pairing by that app on this TV is
   auto-approved by the bridge (pinned to the Fire TV's own network
   address). The app only ever types the host once; after that, setup is
   automatic.

The allow/deny list persists in `~/.fyaisa/bridge.json` (`access`) and can be
changed any time from the FYAISA ElevSH screen. Until an app is allowed, its
token-authenticated requests fail with `403` and `code: 'access_required'`;
after a Deny, `code: 'access_denied'`.

### Patch installs (`POST /install` with `patch: true`)

A catalog entry can declare that it's a patched build of another app:

```json
"patch": {"for": "com.amazon.firetv.youtube.main", "name": "YouTube"}
```

Calling `POST /install` with `{"patch": true}` makes the bridge rebuild the
app *under the original app's identity*:

1. The project is copied to a scratch dir (`~/.fyaisa/patch-build/<id>`) with
   `node_modules` and build artifacts left behind, so the working tree stays
   untouched, and dependencies are installed fresh in the copy (Metro won't
   resolve modules through a symlinked `node_modules`).
2. `manifest.toml`, `app.json` and `package.json` are rewritten: package id,
   component id and app name become `patch.for`, the display name/title become
   `patch.name`, and the version is forced to `99.99.99`, always.
3. The patch is built, then the original app is uninstalled, then the patch is
   installed under the original's id.

That last bit is the point of the 99.99.99: the shell (and the remote's
shortcut button for the original app) then launches the patched build, it
*looks* like the original app in the launcher, and no store update can
silently replace the patch, since nothing official outranks 99.99.99. The
original is gone though; installing a patch means living with the patched
build.

Two details to note:

- The target comes from the catalog, never from the request. The bridge
  validates `patch.for` against `catalog.json`, so only whoever controls the
  repo can choose which app id a patch takes over.
- Build first, uninstall second: if the rewrite doesn't compile, the original
  is still there; a system-protected original that refuses `uninstall-app` is
  logged and the patch installs over it instead.

## 6. Access the Vega CLI from an app (`/vega`)

Homebrew apps don't have to stop at pairing for installs: the bridge can also
run the Vega CLI on the PC on your app's behalf. Pair once (§5), then:

```ts
import {Fyaisa} from './fyaisaClient'; // vendored copy, see below

const fy = Fyaisa.from({host: '192.168.12.102', token, appId: 'app.vegatube.main'});

const cli  = await fy.vega(['--version']);              // "Vega CLI Version: 1.4.4"
const devs = await fy.vega(['device', 'list']);         // connected Fire TVs
await fy.vega(['device', 'launch-app',  '--appName', 'app.vegatube.main']);
await fy.vega(['device', 'terminate-app', '--appName', 'app.vegatube.main']);
await fy.vega(['exec', 'vda', 'connect', '192.168.12.197:5555']);
await fy.vega(['device', 'run-cmd', '--command', 'ls /data']); // shell on the stick
```

Every call resolves to `{ok, exitCode, stdout, stderr, truncated, durationMs}`.
The FYAISA app itself uses this: its ElevSH screen shows the computer's CLI
version and how many Fire TVs it sees.

To get the client, copy
[`bridge/client/fyaisaClient.ts`](../bridge/client/fyaisaClient.ts) into your
app's `src/`. It's a single dependency-free file (it uses the global `fetch`,
so it works in React Native as-is), and it ships the unauthenticated pairing
helpers, so your app can run the whole code → approve → token flow itself.

Pass your `appId` and every request carries `X-FYAISA-App`; the bridge then
applies the ElevSH allow/deny list the user manages in FYAISA (see §5). A 403
with `code: 'access_required'` means the user hasn't allowed your app yet;
`access_denied` means they said no.

`POST /vega` is not a general shell: only `vega` is spawned (argument array),
the leading args must be on the allowlist (`--version`, `device …`,
`platform …`, `exec vda …`, `virtual-device …`), and every argument must
match `[A-Za-z0-9 ._/:=,@+-]+`. Output is capped, concurrency is limited, and
slow commands are killed at the timeout. Anything else is a `403`; see
[`bridge/README.md`](../bridge/README.md) for the full rules.

## 7. Ship your own app to the hub

1. Copy the reference app: `cp -r apps/vegatube apps/my-app`, then change
   `manifest.toml` (app id, name), `package.json` (name, `vega` config) and the
   source.
2. Register it in `catalog.json` (one entry per app; see the schema fields on
   the existing entry).
3. Open a PR. After it merges, `fyaisa list` and the TV app show it.

The full contract (naming, licensing, catalog fields) is in
[`apps/README.md`](../apps/README.md).

## 8. Vega OS gotchas

1. RN UI components come from `@amazon-devices/react-native-kepler`, not
   `react-native`. Its `Pressable` types take a `{focused}` prop for TV
   focus styling.
2. It is a native React Native app, not a web page: no `document`, no
   `window`. Back navigation goes through `BackHandler.addEventListener(
   'hardwareBackPress', …)`.
3. `@react-native-async-storage/async-storage` does not work on Vega. It
   installs and builds fine, but at runtime every call silently no-ops and the
   log shows
   `[AutoLinkService] Library 'RNAsyncStorage' not found in any source`.
   Use `@amazon-devices/kepler-file-system` instead.
4. `KeplerFileSystem` is a *named* export (`import {KeplerFileSystem} from
   '@amazon-devices/kepler-file-system'`), and its encoding argument must be
   `'UTF-8'`, uppercase. `'utf-8'` makes the native side throw
   `com.amazon.kepler.io.IoError` on every write.
5. The app sandbox layout (per the KeplerFileSystem README):

   | Path | Writable | Survives | Notes |
   | --- | --- | --- | --- |
   | `/pkg` | no | — | the installed package (code + assets) |
   | `/data` | yes | reboots **and app upgrades** | per-app, private; cleared on uninstall |
   | `/tmp` | yes | nothing | per-app; gone on reboot |

   The app's `/data` is not the `/data` that `vega device run-cmd` sees:
   each app gets its own private view, so you cannot seed files via adb-style
   shell commands.
6. Native modules need a `[[needs.module]]` declaration in `manifest.toml`
   (the build tooling usually adds it; check it got committed, or
   AutoLinkService will skip the library at runtime).
7. `vega project install <pkg>` resolves OS-version-managed *scoped*
   packages (`@amazon-devices/…`); unscoped npm packages are installed with
   plain `npm install`.
8. `vega device start-log-stream` is lossy under load: the OS floods the
   stream and early lines get dropped. A missing log line does *not* mean your
   code didn't run; repeat important logs, or surface state in the UI.
9. Right after a sideload the first launch can fail once on some OS
   versions. If an app comes up blank, terminate and launch it again (see the
   cold-start recovery comment in `apps/vegatube/src/App.tsx`).
10. D-pad *focus* (Pressable) covers menus, but a game that moves on a timer
    needs raw key events: import `useTVEventHandler` from
    `@amazon-devices/react-native-kepler` (Amazon's own addition; it is not in
    npm `react-native`). The callback gets `eventType` values like `'up'`,
    `'down'`, `'left'`, `'right'` and `'select'`. A remote can fire the same
    key twice (keydown + keyup), so make repeats harmless: filter on
    `eventKeyAction` and single-flight anything the page might also see, as
    `apps/doom/src/App.tsx` does.
11. Vega WebView apps: `source` only accepts `uri` (the `html` object from
    react-native-webview is not in Amazon's supported API), so local pages
    live in an `assets/` folder at the project root and load as
    `file:///pkg/assets/page.html` with no `allowFileAccess` needed. The
    bridge also silently drops oversized `injectJavaScript` payloads: ship
    big scripts in 16 KB order-independent chunks that the page reassembles,
    as VegaTube does. With `allowSystemKeyEvents` on, every key reaches the
    page but Back reaches nobody; off, arrows and Enter still reach the page
    and Back arrives at `BackHandler`. System buttons (Menu, Play/Pause)
    reach neither side when it is off; forward them from `useTVEventHandler`,
    whose `menu` and `playpause` events arrive through the UserInputManager
    whatever the WebView is doing (confirmed on the stick, full list in
    `Libraries/TV/TVTypes.d.ts`). `apps/doom` uses all of it: asset page,
    chunked payload, Back forwarded as the Use key, Menu forwarded from the
    TV hook as Escape.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `vega device list` empty | Developer Mode + ADB debugging ON; re-run `vega exec vda connect <ip>:5555` |
| FYAISA app shows the fallback catalog | It couldn't fetch `catalog.json` from GitHub; check the stick's internet access |
| Bridge says "unauthorized — pair first" | A token-protected route was called without a token; pair first (`fyaisa approve <code>`). The FYAISA app probes tokenless `/ping`, so its pairing bootstraps itself |
| Stop the bridge | `fyaisa disconnect`: graceful `POST /shutdown`, falling back to killing the local process |
| `fyaisa approve` can't connect | The bridge binds localhost by default; run `fyaisa connect --lan`, or pass `--host 127.0.0.1` |
| App builds but native calls do nothing | Check the log for `Library '…' not found in any source`; the module isn't declared in `manifest.toml` |

## See also

- [`apps/README.md`](../apps/README.md), the app format contract for hub contributors
- [`bridge/README.md`](../bridge/README.md), the bridge HTTP API + security model
- [Vega SDK docs](https://developer.amazon.com/docs/vega/latest/install-vega-sdk.html)
