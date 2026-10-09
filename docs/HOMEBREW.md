# Homebrew on Vega OS: PC setup, the Vega CLI, and FYAISA commands

This guide is for homebrew developers who want a PC talking to a Vega OS Fire TV
Stick — enough to build, install, debug and ship apps. Everything here was
exercised on a real **Fire TV Stick HD (OS 2.0, armv7l)**.

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

- **Node.js 20+**
- **Vega SDK** — Amazon's official SDK, installed per
  [Amazon's docs](https://developer.amazon.com/docs/vega/latest/install-vega-sdk.html).
  The installer drops everything into `~/vega`.
- The **FYAISA repo** (contains the CLI, the bridge, and the reference app):

  ```bash
  git clone https://github.com/AaronYTDev/FYAISA
  cd FYAISA
  ```

## 2. Put the Vega CLI on your PATH

```bash
source ~/vega/env          # adds ~/vega/bin to PATH for this shell
vega --version             # e.g. Vega CLI Version: 1.4.4
```

`~/vega/env` is a plain sh snippet — add `source ~/vega/env` to `~/.bashrc` to
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

If `vega device list` comes back empty after a while, the connection dropped —
just run the `connect` line again. Fire TVs sleep their network; expect to
reconnect occasionally.

## 4. Build and install an app

The fast path — the hub CLI does dependency install, build and install in one go:

```bash
fyaisa list                    # catalog
fyaisa search youtube
fyaisa info app.tizentube.vega
fyaisa install app.tizentube.vega
```

The manual equivalent, for any Vega project (this is all `fyaisa install` does):

```bash
cd apps/tizentube-vega
npm install
npm run build:release          # produces a .vpkg under build/
vega device install-app --dir . -b Release
```

Managing what's on the device:

```bash
vega device launch-app  --appName app.tizentube.vega
vega device terminate-app --appName app.tizentube.vega
vega device is-app-running --appName app.tizentube.vega
vega device start-log-stream              # follow device logs (see gotcha #8)
vega device run-cmd --command 'ls /data'  # shell on the device (as app_user)
```

Uninstall: `fyaisa uninstall <app-id>`.

## 5. Install from the couch: pairing the TV app with your PC

A Vega app cannot install packages itself (no third-party install API exists in
the SDK). So the FYAISA app on the TV *asks your PC* to do it:

```bash
fyaisa connect --lan          # run on the PC; --lan so the TV can reach it
```

The bridge prints:

```
  Pairing code: 126147
  The Fire TV shows the same code in FYAISA → Connect.
  Approve it on this PC with:

    fyaisa approve 126147
```

Full walkthrough:

1. **On the TV:** open **FYAISA → Connect** → enter the PC's IP with the D-pad
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
commands for internet access — LAN is the intended mode), `--hub-dir <path>`.
If the token ever goes stale (e.g. you deleted `~/.fyaisa/bridge.json`), the
app detects the 401 on its next launch and asks you to re-pair; the **Forget
this PC** button clears it manually.

## 6. Access the Vega CLI from your app (`/vega`)

Homebrew apps don't have to stop at pairing for installs: the bridge can also
**run the Vega CLI on the PC on your app's behalf**. Pair once (§5), then:

```ts
import {Fyaisa} from './fyaisaClient'; // vendored copy — see below

const fy = Fyaisa.from({host: '192.168.12.102', token});

const cli  = await fy.vega(['--version']);              // "Vega CLI Version: 1.4.4"
const devs = await fy.vega(['device', 'list']);         // connected Fire TVs
await fy.vega(['device', 'launch-app',  '--appName', 'app.tizentube.vega']);
await fy.vega(['device', 'terminate-app', '--appName', 'app.tizentube.vega']);
await fy.vega(['exec', 'vda', 'connect', '192.168.12.197:5555']);
await fy.vega(['device', 'run-cmd', '--command', 'ls /data']); // shell on the stick
```

Every call resolves to `{ok, exitCode, stdout, stderr, truncated, durationMs}`.
The FYAISA app itself uses this: its Connect screen shows the PC's CLI version
and how many Fire TVs it sees.

**Getting the client.** It's a single dependency-free file — copy
[`bridge/client/fyaisaClient.ts`](../bridge/client/fyaisaClient.ts) into your
app's `src/` (it uses the global `fetch`, so it works in React Native as-is).
It also ships the unauthenticated pairing helpers, so your app can run the
whole code → `fyaisa approve` → token flow itself.

**What the bridge will and won't run.** `POST /vega` is deliberately not a
shell: only `vega` is spawned (argument array, no shell), the leading args must
be on the allowlist (`--version`, `device …`, `platform …`, `exec vda …`,
`virtual-device …`), and every argument must match
`[A-Za-z0-9 ._/:=,@+-]+`. Output is capped, concurrency is limited, and slow
commands are killed at the timeout. Anything else is a `403` — see
[`bridge/README.md`](../bridge/README.md) for the full rules.

## 7. Ship your own app to the hub

1. Copy the reference app: `cp -r apps/tizentube-vega apps/my-app`, then change
   `manifest.toml` (app id, name), `package.json` (name, `vega` config) and the
   source.
2. Register it in `catalog.json` (one entry per app — see the schema fields on
   the existing entry).
3. Open a PR. After it merges, `fyaisa list` and the TV app show it.

The full contract (naming, licensing, catalog fields) is in
[`apps/README.md`](../apps/README.md).

## 8. Vega OS gotchas (all verified the hard way)

1. **RN UI components come from `@amazon-devices/react-native-kepler`**, not
   `react-native`. Its `Pressable` types take a `{focused}` prop for TV
   focus styling.
2. **It is a native React Native app, not a web page.** No `document`, no
   `window`. Back navigation: `BackHandler.addEventListener('hardwareBackPress',
   …)`.
3. **`@react-native-async-storage/async-storage` does not work on Vega.** It
   installs and builds fine, but at runtime every call silently no-ops and the
   log shows
   `[AutoLinkService] Library 'RNAsyncStorage' not found in any source`.
   Use `@amazon-devices/kepler-file-system` instead.
4. **`KeplerFileSystem` is a *named* export** (`import {KeplerFileSystem} from
   '@amazon-devices/kepler-file-system'`), and its encoding argument must be
   **`'UTF-8'` (uppercase)**. `'utf-8'` makes the native side throw
   `com.amazon.kepler.io.IoError` on every write.
5. **The app sandbox layout** (per the KeplerFileSystem README, confirmed on
   device):

   | Path | Writable | Survives | Notes |
   | --- | --- | --- | --- |
   | `/pkg` | no | — | the installed package (code + assets) |
   | `/data` | yes | reboots **and app upgrades** | per-app, private; cleared on uninstall |
   | `/tmp` | yes | nothing | per-app; gone on reboot |

   The app's `/data` is **not** the `/data` that `vega device run-cmd` sees —
   each app gets its own private view, so you cannot seed files via adb-style
   shell commands.
6. **Native modules need a `[[needs.module]]` declaration** in
   `manifest.toml` (the build tooling usually adds it — check it got committed,
   or AutoLinkService will skip the library at runtime).
7. **`vega project install <pkg>`** resolves OS-version-managed *scoped*
   packages (`@amazon-devices/…`); unscoped npm packages are installed with
   plain `npm install`.
8. **`vega device start-log-stream` is lossy under load** — the OS floods the
   stream and early lines get dropped. A missing log line does *not* mean your
   code didn't run; repeat important logs, or surface state in the UI.
9. **Right after a sideload the first launch can fail once** on some OS
   versions. If an app comes up blank, terminate and launch it again (see the
   cold-start recovery comment in `apps/tizentube-vega/src/App.tsx`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `vega device list` empty | Developer Mode + ADB debugging ON; re-run `vega exec vda connect <ip>:5555` |
| FYAISA app shows the fallback catalog | It couldn't fetch `catalog.json` from GitHub — check the stick's internet access |
| Bridge says "unauthorized — pair first" | The TV's token is stale — re-pair (§5); the app clears it automatically after a 401 |
| `fyaisa approve` can't connect | The bridge binds localhost by default — run `fyaisa connect --lan`, or pass `--host 127.0.0.1` |
| App builds but native calls do nothing | Check the log for `Library '…' not found in any source` — the module isn't declared in `manifest.toml` |

## See also

- [`apps/README.md`](../apps/README.md) — app format contract for hub contributors
- [`bridge/README.md`](../bridge/README.md) — bridge HTTP API + security model
- [Vega SDK docs](https://developer.amazon.com/docs/vega/latest/install-vega-sdk.html)
