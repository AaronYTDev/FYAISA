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
| `POST` | `/vega` | token | run an **allowlisted** `vega` CLI command on the PC |

Auth is `X-FYAISA-Token: <token>` compared with `crypto.timingSafeEqual`.

## Running the Vega CLI from an app (`POST /vega`)

Any paired homebrew app can reach the Vega CLI on the PC — device list, launch,
terminate, `exec vda connect`, `run-cmd`, … — through the same pairing it
already has:

```bash
curl -X POST http://<pc>:47821/vega -H "X-FYAISA-Token: $TOKEN" \
     -d '{"args":["device","list"]}'
# -> {"ok":true,"exitCode":0,"stdout":"Found the following device: …","stderr":"","durationMs":1440}
```

Body: `{args: string[], timeoutMs?: number}` (default 30 s, max 120 s).
Response: `{ok, exitCode, stdout, stderr, truncated, durationMs}`.

This is **not** a generic shell, by design:

- Only `vega` is spawned, with an argument array — never through a shell.
- The leading args must match an allowlist: `--version`, `device …`,
  `platform …`, `exec vda …`, `virtual-device …`. Anything else gets `403`.
- Every argument must match `[A-Za-z0-9 ._/:=,@+-]+` — no `; | & $ ( ) < >` etc.
- Output is capped at 256 KB per stream, max 4 concurrent calls (then `429`),
  and the process is killed at the timeout (then `504` with partial output).

The easiest way to use it is the vendored client — see
[`client/fyaisaClient.ts`](client/fyaisaClient.ts) and the
“Access the Vega CLI from your app” section of [`docs/HOMEBREW.md`](../docs/HOMEBREW.md).

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
