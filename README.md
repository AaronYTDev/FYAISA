# FYAISA
## (Pronounced Fee-eye-sha)
A community hub for sideloaded homebrew on Amazon's Vega OS Fire TV devices.

With a CLI for installing, and an on-device app.
Designed by **aaronYTDev**.

---

A community hub for homebrew on Amazon's **Vega OS** Fire TV devices — the
sticks that can no longer sideload Android APKs (Fire TV Stick 4K Select, Fire
TV Stick HD, Fire TV Stick 4K).

Amazon blocks APK sideloading on Vega and offers no app store for sideloaded
code. Vega *does* have a real SDK and an official Developer Mode. FYAISA uses
that: it catalogs Vega homebrew so you can build and install it on your own
Fire TV.

```
FYAISA/
├── catalog.json              # the hub index — every app registers here
├── fyaisa                    # host CLI: list / search / build / install / connect / approve
├── apps/
│   ├── README.md             # the app format (contract for contributors)
│   ├── fileexplorer/          # ElevSH Files — D-pad file browser over ElevSH
│   └── vegatube/              # reference app — VegaTube (ad-free YouTube)
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

## How installing works (read this first)

**A Vega OS app cannot install other `.vpkg` packages.** Package management is
host-side only (`vega device install-app`), and Amazon exposes no third-party
install API to apps — we checked the SDK's IDL surface and it isn't there.

So FYAISA is deliberately split:

| Piece | Where | What it does |
| --- | --- | --- |
| `fyaisa` CLI | your computer | Fetches the catalog, builds the app from source, installs it on the stick |
| **FYAISA app** | your Fire TV | Browses the catalog, shows details, and pairs with your PC to request installs |

The on-device app can't perform the install itself, so `fyaisa connect` lets it
*ask* your PC to do it — browse on the couch, install with the remote. The
split is a platform constraint, not a missing feature.

## Pairing with your PC (`fyaisa connect`)

You can install apps **from the couch**. Run the bridge on the computer that's
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
keypad (`192`, `.`, …) → **Get pairing code**. The 6-digit code appears on the
TV *and* in the bridge's terminal — approve it **on the PC**:

```bash
fyaisa approve 126147
```

The TV picks up its pairing token automatically and the app is paired. The
pairing is remembered on the TV (across restarts and reboots), so it's a
one-time step per PC.

Any app's detail screen then shows **Install via ElevSH**, which queues a real
build + `vega device install-app` on your machine and streams the build log back
to the TV.

### How it works

The TV can't install packages, so the arrow points the other way:

```
Fire TV (FYAISA app)  ──HTTP──▶  bridge on your PC  ──▶  npm build + vega install
        ▲                              │
        └──── polls job status ────────┘
```

The bridge holds the build/install powers; the TV is a remote control. Paired
apps can also run **allowlisted `vega` CLI commands** on the PC through the
same connection (device list, launch, `exec vda connect`, …) — see §6 of
[`docs/HOMEBREW.md`](docs/HOMEBREW.md) and the vendored
[`bridge/client/fyaisaClient.ts`](bridge/client/fyaisaClient.ts).

### Security

- Binds to `127.0.0.1` unless you pass `--lan`.
- **Nothing is accepted until you approve a 6-digit code** that expires in 10
  minutes. After that, every request must carry the token from
  `~/.fyaisa/bridge.json` (mode `0600`, never logged).
- Bad requests get `401`; concurrent jobs get `429`.

### Internet access

Plain LAN is the intended mode. `--tunnel` prints the commands to wrap the port
(cloudflared/ngrok) if you want it reachable from the internet:

```bash
fyaisa connect --lan --tunnel
```

Only do that on networks you trust — anyone who knows the pairing code and token
can queue builds on your machine. Prefer LAN.


## Add your own app

Apps are ordinary Vega projects — the format is documented in
[`apps/README.md`](apps/README.md), and `apps/vegatube` is the reference
implementation. In short: copy it, change `manifest.toml` + `package.json`,
register the entry in `catalog.json`, open a PR.

Building homebrew for Vega OS — setting up the Vega CLI, pairing the TV app,
and the platform gotchas that will bite you (AsyncStorage, the app sandbox,
TV focus, log-stream quirks) — is covered in
[`docs/HOMEBREW.md`](docs/HOMEBREW.md).

## Why builds happen on your machine

`.vpkg` binaries are not hosted for most apps. `fyaisa install` clones/builds the
source with the Vega SDK and installs the result, so you always run code you
could have compiled yourself. Prebuilt packages can still be published on the
repo's Releases page; the catalog's `install` block describes how to get one.

## Status

| Component | State |
| --- | --- |
| `fyaisa` CLI | Working — list / search / info / install / update / uninstall / devices / connect / approve |
| `fyaisa connect` bridge (ElevSH) | Working — pairing (PC or FYAISA approval, auto-approve for allowed apps), token auth, per-app allow/deny managed from FYAISA, real end-to-end installs, `POST /vega` (allowlisted CLI access for homebrew apps), and `fyaisa disconnect` to stop it, all verified on a Fire TV Stick HD |
| Catalog | `catalog.json` schema v1, served from this repo |
| FYAISA app | Working on a Fire TV Stick HD — live catalog fetch, pairing that persists across restarts/reboots/upgrades, Install via ElevSH (build log streams back to the TV), and an ElevSH screen that allows/denies other apps |
| Apps | 2 (`app.vegatube.main` — VegaTube; `app.fyaisa.files.main` — ElevSH Files, the file explorer) |

## Not affiliated with Amazon or Google

FYAISA is a community project using Amazon's official developer tools. Installing
software onto your own device is your call. Respect Amazon's and Google's terms,
and the licenses of the apps you install.
