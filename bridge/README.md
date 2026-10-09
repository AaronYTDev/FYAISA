# fyaisa-bridge

The PC side of `fyaisa connect`. Lets the **FYAISA app on your Fire TV** queue
builds and installs on your computer.

## Why it exists

A Vega OS app cannot install other `.vpkg` packages — package management is
host-side only (`vega device install-app`), and no third-party install API is
exposed to apps. But a Vega app *can* make outbound HTTP requests.

So the direction of control is inverted:

```
Fire TV (FYAISA app)  ──HTTP──▶  bridge on your PC  ──▶  npm build + vega install
        ▲                              │
        └──── polls job status ────────┘
```

The bridge holds the device connection and the build/install powers. The TV app
is a remote control for it.

## Run it

```bash
fyaisa connect --lan          # from the repo root
# or directly:
node bridge/bridge.js --lan --hub-dir ~/FYAISA
```

When the TV app requests a pairing code, approve it on the PC with:

```bash
fyaisa approve <6-digit-code>
```

Options:

| Flag | Meaning |
| --- | --- |
| `--port N` | listen port (default `47821`) |
| `--lan` | bind `0.0.0.0` so the Fire TV can reach it (default: localhost only) |
| `--hub-dir` | FYAISA checkout to build apps from |
| `--tunnel` | print cloudflared/ngrok commands for internet access |

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/ping` | no | liveness |
| `POST` | `/pair/request` | no | get a 6-digit pairing code (10 min TTL) |
| `GET` | `/pair/status?code=` | no | has the code been approved on the PC? |
| `POST` | `/pair/approve` | no | exchange code → token |
| `GET` | `/catalog` | token | current catalog |
| `POST` | `/install` | token | `{appId}` → `{jobId}`, builds + installs |
| `GET` | `/job?id=` | token | job status + build log |
| `GET` | `/jobs` | token | all jobs |
| `POST` | `/launch` | token | `{appId}` launch an app on the device |

Auth is `X-FYAISA-Token: <token>` compared with `crypto.timingSafeEqual`.

## Security notes

- Default bind is **localhost**; `--lan` is required for the TV to connect.
- Nothing is accepted before a pairing code is approved on the PC.
- Token lives in `~/.fyaisa/bridge.json` (mode `0600`) and is never logged.
- One job at a time; concurrent requests get `429`.
- The bridge shells out to `npm` and `vega` with **no extra sandboxing** — treat
  it like any dev tool and don't expose it to the open internet unless you
  understand the risk. LAN use is the intended mode.

## Requirements

Node 18+, the Vega CLI on `PATH`, and a FYAISA checkout containing
`catalog.json` and `apps/`.
