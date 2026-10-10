# FYAISA
## (Pronounced Fie-eye-sha, and stands for "Fuck You Amazon, I'm Sideloading Anyways")
The one-stop homebrew shop for Vega OS devices.

With a CLI for installing, and an on-device app.
Designed by **aaronYTDev**.

---

Amazon blocks APK sideloading on the newer sticks (Fire TV Stick 4K Select,
Fire TV Stick HD, Fire TV Stick 4K) and offers no app store for sideloaded
code. Vega does have a real SDK and an official Developer Mode though, and
FYAISA uses that: a catalog of Vega homebrew you can build and install on
your own Fire TV.

```
FYAISA/
├── catalog.json              # the hub index, every app registers here
├── fyaisa                    # host CLI: list / search / build / install / connect / approve
├── apps/
│   ├── README.md             # the app format (contract for contributors)
│   ├── doom/                 # DOOM shareware, compiled to WebAssembly
│   ├── fileexplorer/          # ElevSH Files, a D-pad file browser over ElevSH
│   ├── snake/                 # Google Snake, Google's snake arcade game in a WebView
│   └── vegatube/              # reference app: VegaTube (ad-free YouTube)
├── bridge/
│   ├── bridge.js             # ElevSH bridge: pairing + installs + access gate
│   └── README.md             # bridge API + security model
├── docs/
│   └── HOMEBREW.md           # developer guide: Vega CLI, pairing, platform gotchas
└── installer/                # the FYAISA app (on-device catalog browser)
```

## Quick start

```bash
git clone https://github.com/AaronYTDev/FYAISA
cd FYAISA
./fyaisa list                      # what's available
./fyaisa devices                   # Fire TVs visible to the Vega CLI
./fyaisa install app.vegatube.main
```

Prerequisites: the [Vega SDK](https://developer.amazon.com/docs/vega/latest/install-vega-sdk.html)
(Node 20+), and Developer Mode enabled on your Fire TV.

## How installing works

A Vega OS app cannot install other `.vpkg` packages. Package management is
host-side only (`vega device install-app`), and there's no third-party
install API for apps in the SDK.

So the project is split in two:

| Piece | Where | What it does |
| --- | --- | --- |
| `fyaisa` CLI | your computer | Fetches the catalog, builds the app from source, installs it on the stick |
| FYAISA app | your Fire TV | Browses the catalog, shows details, and pairs with your PC to request installs |

The on-device app can't do the install itself, so `fyaisa connect` lets it
ask your PC to do it: browse on the couch, install with the remote.

## Pairing with your PC (`fyaisa connect`)

You can install apps from the couch. Run the bridge on the computer that's
on the same network as your Fire TV, pair once, and the FYAISA app on the TV
grows an **Install** button.

```bash
fyaisa connect --lan
```

```
  FYAISA bridge listening
    bind      0.0.0.0:47821
    reachable http://192.168.12.102:47821
```

Stop the bridge from any terminal when you're done:

```bash
fyaisa disconnect
```

It asks the bridge to shut down over HTTP first (`POST /shutdown`) and falls
back to stopping the local process directly if that fails (add `--port N` if
the bridge isn't on the default port).

Then on the TV: **FYAISA → Connect** → type the PC address with the D-pad
keypad (`192`, `.`, …) → **Get pairing code**. The 6-digit code appears on
the TV and in the bridge's terminal; approve it on the PC:

```bash
fyaisa approve 126147
```

The TV picks up its pairing token automatically and the app is paired.
Pairing is remembered on the TV across restarts and reboots, so it's a
one-time step per PC.

Any app's detail screen then shows **Install via ElevSH**, which queues a real
build + `vega device install-app` on your machine and streams the build log
back to the TV.

### How it works

```
Fire TV (FYAISA app)  ──HTTP──▶  bridge on your PC  ──▶  npm build + vega install
        ▲                              │
        └──── polls job status ────────┘
```

The bridge does the building and installing; the TV just drives it. Paired
apps can also run allowlisted `vega` CLI commands on the PC over the same
connection (device list, launch, `exec vda connect`, …). See §6 of
[`docs/HOMEBREW.md`](docs/HOMEBREW.md) and the vendored
[`bridge/client/fyaisaClient.ts`](bridge/client/fyaisaClient.ts).

### Security

- Binds to `127.0.0.1` unless you pass `--lan`.
- Nothing is accepted until you approve a 6-digit code (expires in 10
  minutes). After that, every request must carry the token from
  `~/.fyaisa/bridge.json` (mode `0600`, never logged).
- Bad requests get `401`; concurrent jobs get `429`.

### Internet access

Plain LAN is the intended mode. `--tunnel` prints the commands to wrap the
port (cloudflared/ngrok) if you want it reachable from the internet:

```bash
fyaisa connect --lan --tunnel
```

Only do that on networks you trust; anyone who knows the pairing code and
token can queue builds on your machine. Prefer LAN.


## Add your own app

Apps are ordinary Vega projects. The format is documented in
[`apps/README.md`](apps/README.md), and `apps/vegatube` is the reference
implementation: copy it, change `manifest.toml` + `package.json`, register
the entry in `catalog.json`, open a PR.

For building homebrew on Vega OS (Vega CLI setup, pairing the TV app, and
the platform gotchas around AsyncStorage, the app sandbox, TV focus and
log-stream quirks), see [`docs/HOMEBREW.md`](docs/HOMEBREW.md).

## Why builds happen on your machine

`.vpkg` binaries are not hosted for most apps. `fyaisa install` clones and
builds the source with the Vega SDK, so you run code you could have
compiled yourself. Prebuilt packages can still be published on the repo's
Releases page; the catalog's `install` block describes how to get one.

## Status

| Component | State |
| --- | --- |
| `fyaisa` CLI | list / search / info / install / update / uninstall / devices / connect / approve |
| `fyaisa connect` bridge (ElevSH) | pairing (PC or FYAISA approval), token auth, per-app allow/deny, installs, `POST /vega`, `fyaisa disconnect` |
| Catalog | `catalog.json` schema v1, served from this repo |
| FYAISA app | works on a Fire TV Stick HD: live catalog with search, persistent pairing, Install via ElevSH, ElevSH allow/deny screen |
| Apps | 4: `app.vegatube.main` (VegaTube), `app.fyaisa.files.main` (ElevSH Files, the file explorer), `app.snake.main` (Google Snake, streams from Google), `app.doom.main` (DOOM shareware, offline) |

## Not affiliated with Amazon or Google

FYAISA is a community project using Amazon's official developer tools. Installing
software onto your own device is your call. Respect Amazon's and Google's terms,
and the licenses of the apps you install.
