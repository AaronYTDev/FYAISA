# FYAISA

## Fuck You Amazon, I'm Sideloading Anyways

A hub for Vega OS Homebrew, with a CLI for installing.
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
├── fyaisa                    # host CLI: list / search / build / install / connect
├── apps/
│   ├── README.md             # the app format (contract for contributors)
│   └── tizentube-vega/       # reference app — ad-free YouTube for Vega
├── bridge/
│   ├── bridge.js             # PC-side bridge for pairing with the TV app
│   └── README.md             # bridge API + security model
└── installer/                # the FYAISA app (on-device catalog browser)
```

## Quick start

```bash
git clone https://github.com/AaronYTDev/FYAISA
cd FYAISA
./fyaisa list                      # what's available
./fyaisa devices                   # Fire TVs visible to the Vega CLI
./fyaisa install app.tizentube.vega
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

Then on the TV: **FYAISA → Connect** → type the PC address with the D-pad
keypad (`192`, `.`, …) → **Get pairing code** → type the 6-digit code the PC
printed → paired.

Any app's detail screen then shows **Install via PC**, which queues a real
build + `vega device install-app` on your machine and streams the build log back
to the TV.

### How it works

The TV can't install packages, so the arrow points the other way:

```
Fire TV (FYAISA app)  ──HTTP──▶  bridge on your PC  ──▶  npm build + vega install
        ▲                              │
        └──── polls job status ────────┘
```

The bridge holds the build/install powers; the TV is a remote control.

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



Apps are ordinary Vega projects — the format is documented in
[`apps/README.md`](apps/README.md), and `apps/tizentube-vega` is the reference
implementation. In short: copy it, change `manifest.toml` + `package.json`,
register the entry in `catalog.json`, open a PR.

## Why builds happen on your machine

`.vpkg` binaries are not hosted for most apps. `fyaisa install` clones/builds the
source with the Vega SDK and installs the result, so you always run code you
could have compiled yourself. Prebuilt packages can still be published on the
repo's Releases page; the catalog's `install` block describes how to get one.

## Status

| Component | State |
| --- | --- |
| `fyaisa` CLI | Working — list / search / info / install / update / uninstall / devices / connect |
| `fyaisa connect` bridge | Working — pairing, auth, and a real end-to-end install verified on a Fire TV Stick HD |
| Catalog | `catalog.json` schema v1 |
| FYAISA app | Builds, installs, and launches on a Fire TV Stick HD; shows the built-in fallback list until `catalog.json` is pushed. Pairing UI implemented; the TV→PC hop hasn't been exercised from the stick yet |
| Apps | 1 (`app.tizentube.vega`) |

## Not affiliated with Amazon or Google

FYAISA is a community project using Amazon's official developer tools. Installing
software onto your own device is your call. Respect Amazon's and Google's terms,
and the licenses of the apps you install.
