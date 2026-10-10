# fyaisa-bridge (ElevSH)

The PC side of `fyaisa connect`, also called ElevSH. It lets the FYAISA app
on your Fire TV queue builds and installs on your computer, and it decides
which other homebrew apps may use that connection (allow/deny from the TV).

## Why it exists

A Vega OS app cannot install other `.vpkg` packages: package management is
host-side only (`vega device install-app`) and no third-party install API is
exposed to apps. A Vega app can make outbound HTTP requests though, so
control runs the other way:

```
Fire TV (FYAISA app)  ──HTTP──▶  bridge on your PC  ──▶  npm build + vega install
        ▲                              │
        └──── polls job status ────────┘
```

The bridge holds the device connection and does the building and
installing; the TV app drives it.

## Run it

```bash
fyaisa connect --lan          # from the repo root
# or directly:
node bridge/bridge.js --lan --hub-dir ~/FYAISA
```

Stop it with:

```bash
fyaisa disconnect
```

which calls `POST /shutdown` (token; hub app or headerless host tools only)
and falls back to terminating the local bridge process if HTTP fails.

When the TV app requests a pairing code, approve it either on the PC:

```bash
fyaisa approve <6-digit-code>
```

or on the TV in **FYAISA → ElevSH** (the request shows up there). Once an app
has been allowed in FYAISA, later pairings from that app on the Fire TV are
auto-approved by the bridge; see "ElevSH access control" below.

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
| `POST` | `/pair/request` | no | get a 6-digit pairing code (10 min TTL); send `X-FYAISA-App` so FYAISA can see + auto-approve it |
| `GET` | `/pair/status?code=` | no | has the code been approved? |
| `POST` | `/pair/approve` | no | exchange code → token (also allows that app's ElevSH access) |
| `GET` | `/access/status?appId=` | no | has this app been allowed/denied yet? |
| `GET` | `/catalog` | token | current catalog |
| `POST` | `/install` | token | `{appId}` → `{jobId}`, reconnects vda to the requesting TV, then builds + installs. Add `patch: true` for a patch install: the app is rebuilt under its catalog `patch.for` identity (original's app id + display name, version forced to `99.99.99`), the original app is uninstalled first; see "Patch installs" in [`docs/HOMEBREW.md`](../docs/HOMEBREW.md) |
| `GET` | `/job?id=` | token | job status + build log |
| `GET` | `/jobs` | token | all jobs |
| `GET` | `/pair/pending` | token (FYAISA) | app pairing requests waiting for a decision |
| `GET` | `/access` | token (FYAISA) | the allow/deny list: `[{appId, status}]` |
| `POST` | `/access` | token (FYAISA) | `{appId, decision: allow \| deny \| revoke}` |
| `POST` | `/launch` | token | `{appId}` launch an app on the device |
| `POST` | `/vega` | token | run an allowlisted `vega` CLI command on the PC |
| `POST` | `/shutdown` | token (hub/host tools) | stop the bridge, what `fyaisa disconnect` calls |

Auth is `X-FYAISA-Token: <token>` compared with `crypto.timingSafeEqual`.

### ElevSH access control

Requests that carry an `X-FYAISA-App: <app-id>` header are additionally gated
per app id (`app.<name>.main`-style ids):

- `app.fyaisa.hub.main` (FYAISA, the owner) is always allowed, and its
  requests teach the bridge the Fire TV's address that auto-approvals are
  pinned to.
- Any other app id needs an explicit decision on the **FYAISA → ElevSH**
  screen: unknown ids become `pending` and get `403 access_required`;
  denied ids get `403 access_denied`. All state persists in
  `~/.fyaisa/bridge.json` under `access`.
- An allowed app that pairs from the Fire TV's own address (fresh, within
  72 h) is auto-approved, so an app can finish setting itself up without the
  user touching the PC again.
- Requests without an app header (host tools, `curl`) are token-only, as
  before; the token is still the real security boundary.

## Running the Vega CLI from an app (`POST /vega`)

Any paired homebrew app can reach the Vega CLI on the PC (device list,
launch, terminate, `exec vda connect`, `run-cmd`, …) through the same
pairing it already has:

```bash
curl -X POST http://<pc>:47821/vega -H "X-FYAISA-Token: $TOKEN" \
     -d '{"args":["device","list"]}'
# -> {"ok":true,"exitCode":0,"stdout":"Found the following device: …","stderr":"","durationMs":1440}
```

Body: `{args: string[], timeoutMs?: number}` (default 30 s, max 120 s).
Response: `{ok, exitCode, stdout, stderr, truncated, durationMs}`.

This isn't a shell:

- Only `vega` is spawned, with an argument array, never through a shell.
- The leading args must match an allowlist: `--version`, `device …`,
  `platform …`, `exec vda …`, `virtual-device …`. Anything else gets `403`.
- Every argument must match `[A-Za-z0-9 ._/:=,@+-]+` (no `; | & $ ( ) < >`).
- Output is capped at 256 KB per stream, max 4 concurrent calls (then `429`),
  and the process is killed at the timeout (then `504` with partial output).

The easiest way to use it is the vendored client; see
[`client/fyaisaClient.ts`](client/fyaisaClient.ts) and the
"Access the Vega CLI from your app" section of [`docs/HOMEBREW.md`](../docs/HOMEBREW.md).

## Security notes

- Default bind is localhost; `--lan` is required for the TV to connect.
- Nothing is accepted before a pairing code is approved on the PC.
- Token lives in `~/.fyaisa/bridge.json` (mode `0600`) and is never logged.
- One job at a time; concurrent requests get `429`.
- The bridge shells out to `npm` and `vega` with no extra sandboxing, so
  treat it like any dev tool and don't expose it to the open internet unless
  you understand the risk. LAN use is the intended mode.

## Requirements

Node 18+, the Vega CLI on `PATH`, and a FYAISA checkout containing
`catalog.json` and `apps/`.
