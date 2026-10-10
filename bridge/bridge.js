#!/usr/bin/env node
/**
 * fyaisa-bridge: the PC side of `fyaisa connect` (the ElevSH bridge).
 *
 * A Vega OS app cannot install packages (no install API), so the Fire TV
 * cannot push .vpkg files to itself; it can make outbound HTTP requests
 * though, so control runs the other way:
 *
 *      Fire TV (FYAISA app)  --HTTP-->  this bridge on your PC  --> vega CLI
 *
 * The bridge holds the device connection and does the building and
 * installing. The TV app polls it for a pairing code and for jobs, and posts
 * "install this app" requests. Every request needs the shared token, so a
 * random device on the same Wi-Fi cannot install anything.
 *
 * Security model:
 *   - Binds to LAN (127.0.0.1 by default; 0.0.0.0 with --lan).
 *   - A 6-digit pairing code must be exchanged before any job is accepted.
 *   - After pairing, every request needs `X-FYAISA-Token`.
 *   - Tokens are random, stored in the state file, and never logged.
 *   - POST /shutdown stops the bridge (token + hub/host tools only); this is
 *     what `fyaisa disconnect` calls.
 *   - Apps that identify themselves with `X-FYAISA-App: <app-id>` are gated:
 *     FYAISA (the owner app) allows or denies each app id from the ElevSH
 *     screen; unknown ids get a pending 403 until approved. Requests without
 *     an app header (host tools, curl) are token-only, as before.
 *
 * Plain HTTP, because this is a short-lived LAN tool. Use `fyaisa connect
 * --tunnel` to wrap it in a public HTTPS tunnel if you need internet access
 * (see the script for caveats).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = parseInt(flag('--port', '47821'), 10);
const HOST_DIR = flag('--hub-dir', process.env.FYAISA_DIR || path.join(os.homedir(), 'FYAISA'));
const BIND = has('--lan') ? '0.0.0.0' : '127.0.0.1';
const PAIR_TTL_MS = 10 * 60 * 1000;
// How long the recorded Fire TV address stays fresh for auto-approvals.
const TVIP_TTL_MS = 72 * 60 * 60 * 1000;
const STATE_DIR = path.join(os.homedir(), '.fyaisa');
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { token: crypto.randomBytes(24).toString('hex'), pairedDevices: {} };
  }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, { mode: 0o600 }, null, 2));
}
let STATE = loadState();
// ElevSH access decisions: appId -> 'allow' | 'deny' | 'pending'.
STATE.access = STATE.access || {};
// Last known Fire TV address (from FYAISA's own requests) + when we set it.
STATE.tvIp = STATE.tvIp || null;
STATE.tvIpAt = STATE.tvIpAt || 0;

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

const pairings = new Map(); // code -> {expires, approved}
const jobs = new Map(); // id -> {id, appId, status, log, createdAt}

function log(...a) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[bridge ${ts}]`, ...a);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
function readCatalog() {
  const file = path.join(HOST_DIR, 'catalog.json');
  if (!fs.existsSync(file)) return { apps: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('catalog parse failed:', e.message);
    return { apps: [] };
  }
}

// Fetch the catalog from GitHub (fallback when local is stale/missing)
async function fetchRemoteCatalog() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    log('remote catalog fetch failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install pipeline (delegates to the same steps as `fyaisa install`)
// ---------------------------------------------------------------------------
function run(cmd, args, cwd, onLog) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    onLog(`$ ${cmd} ${args.join(' ')}`);
    const capture = (buf) => {
      const s = buf.toString();
      onLog(s.trimEnd());
    };
    p.stdout.on('data', capture);
    p.stderr.on('data', capture);
    p.on('error', (e) => {
      onLog(`spawn error: ${e.message}`);
      resolve(127);
    });
    p.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

// The TV that made a request, as a plain IPv4: the host `vega exec vda
// connect` needs for device commands to reach it. Loopback and anything
// that isn't IPv4 means we don't know the TV (e.g. a PC-side curl), so
// callers just skip the reconnect.
function clientIpOf(req) {
  const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return '';
  if (raw.startsWith('127.') || raw === '0.0.0.0') return '';
  return raw;
}

// --- Remote app source -------------------------------------------------------
// Downloads app source from GitHub so the bridge doesn't need a local clone.
const REMOTE_REPO = 'https://github.com/AaronYTDev/FYAISA';
const REMOTE_TARBALL = 'https://github.com/AaronYTDev/FYAISA/archive/refs/heads/main.tar.gz';
const REMOTE_CACHE_DIR = path.join(os.homedir(), '.fyaisa', 'app-cache');

async function fetchRemoteApp(relPath) {
  const cacheDir = path.join(REMOTE_CACHE_DIR, relPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fyaisa-remote-'));

  try {
    // Download tarball
    const tarball = path.join(tmp, 'repo.tar.gz');
    const res = await fetch(REMOTE_TARBALL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tarball, buf);

    // Extract just the app directory
    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    await run('tar', ['-xzf', tarball, '-C', extractDir, '--wildcards', `FYAISA-main/${relPath}/*`], tmp, () => {});

    // Copy to cache
    const srcDir = path.join(extractDir, 'FYAISA-main', relPath);
    if (!fs.existsSync(srcDir)) {
      throw new Error(`App directory not found in tarball: ${relPath}`);
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.cpSync(srcDir, cacheDir, { recursive: true });

    return cacheDir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installApp(appId, job, opts = {}) {
  const catalog = readCatalog();
  const app = (catalog.apps || []).find((a) => a.id === appId);
  if (!app) {
    job.status = 'error';
    job.log.push(`Unknown app id: ${appId}`);
    return;
  }

  // Resolve app source: local if available, otherwise fetch from GitHub
  let dir = path.join(HOST_DIR, app.path || '');
  if (!fs.existsSync(dir)) {
    job.log.push(`App source not found locally, fetching from GitHub…`);
    try {
      dir = await fetchRemoteApp(app.path || '');
      job.log.push(`Fetched ${app.path} from GitHub`);
    } catch (e) {
      job.status = 'error';
      job.log.push(`Failed to fetch app source: ${e.message}`);
      return;
    }
  }

  // ---- reconnect vda ---------------------------------------------------------
  // The TV is talking to us, so it is on the network — but the PC-side vda
  // link goes stale whenever the stick sleeps, and without it every
  // `vega device …` below dies with "device offline". Connect to the
  // requesting TV first; best-effort, since the link may already be up.
  if (opts.deviceIp) {
    job.log.push(`Ensuring vda is connected to ${opts.deviceIp}:5555…`);
    await run('vega', ['exec', 'vda', 'connect', `${opts.deviceIp}:5555`], HOST_DIR, (l) =>
      job.log.push(l),
    );
  }

  // ---- patch install ------------------------------------------------------
  // A catalog entry with `patch: {for, name}` describes a patched version of
  // another app. Instead of building itself, the patch is rebuilt under the
  // ORIGINAL app's identity:
  //   - app id       → patch.for, so the shell (and the remote's shortcut
  //                     button) launches the patched app in its place;
  //   - display name → patch.name, so it shows up as the original app;
  //   - version      → forced to 99.99.99, always, so an official update can
  //                     never look newer and override the patch.
  // The original is uninstalled after a successful build and before the
  // patch is installed.
  let buildDir = dir;
  let patch = null;
  if (opts.patch) {
    const p = app.patch;
    if (!p || typeof p.for !== 'string' || !APP_ID_RE.test(p.for)) {
      job.status = 'error';
      job.log.push(`Catalog entry ${appId} has no valid patch.for — cannot patch-install.`);
      return;
    }
    const patchName = String(p.name || app.name);
    if (patchName.includes('"') || patchName.includes('\n') || patchName.length > 64) {
      job.status = 'error';
      job.log.push(`patch.name must be ≤64 chars without quotes.`);
      return;
    }
    const origPkg = appId.endsWith('.main') ? appId.slice(0, -5) : appId;
    const newPkg = p.for.endsWith('.main') ? p.for.slice(0, -5) : p.for;
    patch = { id: p.for, name: patchName, pkg: newPkg };

    buildDir = path.join(STATE_DIR, 'patch-build', appId.replace(/[^A-Za-z0-9._-]/g, '_'));
    job.log.push(`Patch install: ${appId} → ${patch.id} ("${patchName}", version 99.99.99)`);
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    // Copy the project minus node_modules/build artifacts into a scratch dir
    // (the working tree stays untouched). Dependencies are installed fresh in
    // the copy, since a symlinked node_modules does not work: Metro refuses to
    // resolve "react-native" through it ("could not be found within the
    // project"), so the patch build does its own npm install below.
    fs.cpSync(dir, buildDir, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(dir, src);
        if (rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`)) return false;
        if (rel === 'build' || rel.startsWith(`build${path.sep}`)) return false;
        if (rel === 'buildinfo.json') return false;
        return true;
      },
    });
    const rewrite = (file, fn) => {
      const fp = path.join(buildDir, file);
      fs.writeFileSync(fp, fn(fs.readFileSync(fp, 'utf8')));
    };
    rewrite('manifest.toml', (s) => {
      // Component id first (it contains the package id as a prefix), then the
      // package id; skipped if the new component id contains the old package
      // id, which would make the blanket replace corrupt the target.
      let out = s.split(appId).join(patch.id);
      if (!patch.id.includes(origPkg)) out = out.split(origPkg).join(newPkg);
      return out
        .replace(/^title = ".*"$/m, `title = "${patchName}"`)
        .replace(/^version = ".*"$/m, 'version = "99.99.99"');
    });
    rewrite('app.json', (s) => {
      const j = JSON.parse(s);
      j.name = patch.id;
      j.displayName = patchName;
      return `${JSON.stringify(j, null, 2)}\n`;
    });
    rewrite('package.json', (s) => {
      const j = JSON.parse(s);
      j.version = '99.99.99';
      return `${JSON.stringify(j, null, 2)}\n`;
    });
    job.log.push(`Identity rewritten (${origPkg} → ${newPkg}); building…`);
  }

  job.status = 'building';
  if (!patch) job.log.push(`Building ${app.name} (${appId})…`);
  if (!fs.existsSync(path.join(buildDir, 'node_modules'))) {
    if (patch) job.log.push('Installing dependencies in the patch build dir…');
    const rc = await run('npm', ['install', '--no-audit', '--no-fund'], buildDir, (l) => job.log.push(l));
    if (rc !== 0) {
      job.status = 'error';
      job.log.push('npm install failed');
      return;
    }
  }
  const brc = await run('npm', ['run', 'build:release'], buildDir, (l) => job.log.push(l));
  if (brc !== 0) {
    job.status = 'error';
    job.log.push(patch ? 'patch build failed' : 'build failed');
    return;
  }

  job.status = 'installing';
  if (patch) {
    // Build first, touch the device second: if the rewrite doesn't compile
    // the original is still there. Uninstalling is best-effort; a
    // system-protected original may refuse, in which case we install over it.
    job.log.push(`Removing the original ${patch.id}…`);
    const urc = await run('vega', ['device', 'uninstall-app', '--appName', patch.id], HOST_DIR, (l) =>
      job.log.push(l),
    );
    if (urc !== 0) {
      job.log.push(`Note: could not remove the original (exit ${urc}) — it may be system-protected; installing over it.`);
    } else {
      job.log.push(`Removed the original ${patch.id}.`);
    }
  }
  job.log.push('Installing on the connected Fire TV…');
  const irc = await run('vega', ['device', 'install-app', '--dir', '.', '-b', 'Release'], buildDir, (l) =>
    job.log.push(l),
  );
  if (irc !== 0) {
    job.status = 'error';
    job.log.push(
      patch
        ? `install failed — the original ${patch.id} was already removed; retry or reinstall it.`
        : 'install failed — is a Fire TV connected? (vega device list)',
    );
    return;
  }
  job.status = 'done';
  job.log.push(
    patch
      ? `Installed ${app.name} as ${patch.id} — the shell now shows "${patch.name}" (version 99.99.99).`
      : `Installed ${app.name}. Launch it from your Fire TV app list.`,
  );
}

// ---------------------------------------------------------------------------
// /vega: run an allowlisted `vega` CLI command on this PC on behalf of a
// paired app. Homebrew apps use this to reach the Vega CLI through the same
// pairing they already have (device list, launch, run-cmd, …).
//
// Not a generic shell:
//   - `vega` only, spawned with an args array (no shell, so no metacharacters).
//   - The leading args must match an allowlist (device/platform/exec vda/…).
//   - Every arg must match a strict character whitelist.
//   - Output is capped and the process is killed after a timeout.
// ---------------------------------------------------------------------------
const VEGA_ARG_RE = /^[A-Za-z0-9 ._/:=,@+-]+$/;
const VEGA_ROOTS = new Set(['device', 'platform', 'exec', 'virtual-device']);
const VEGA_MAX_OUTPUT = 256 * 1024;
const VEGA_MAX_CONCURRENT = 4;
let vegaInFlight = 0;

function vegaArgsAllowed(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 12) return false;
  if (!argv.every((a) => typeof a === 'string' && VEGA_ARG_RE.test(a))) return false;
  const [root, sub] = argv;
  if (root === '--version') return argv.length === 1;
  if (!VEGA_ROOTS.has(root)) return false;
  if (root === 'exec' && sub !== 'vda') return false; // `vega exec <sdk-tool>`, only vda
  return true;
}

function handleVegaExec(res, body) {
  const argv = body.args;
  if (!vegaArgsAllowed(argv)) {
    return json(res, 403, {
      error: 'args not allowed — the bridge only runs an allowlisted subset of `vega` (device/platform/exec vda/--version)',
    });
  }
  if (vegaInFlight >= VEGA_MAX_CONCURRENT) {
    return json(res, 429, { error: 'too many concurrent vega calls' });
  }
  vegaInFlight += 1;

  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30000, 1000), 120000);
  const started = Date.now();
  log(`vega ${argv.join(' ')}`);
  const child = spawn('vega', argv, { env: process.env }); // no shell
  let out = '';
  let err = '';
  let truncated = false;
  let timedOut = false;
  let done = false;

  const finish = (payload) => {
    if (done) return;
    done = true;
    vegaInFlight -= 1;
    json(res, payload.code, payload.body);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.stdout.on('data', (d) => {
    if (out.length < VEGA_MAX_OUTPUT) out += d.toString();
    else truncated = true;
  });
  child.stderr.on('data', (d) => {
    if (err.length < VEGA_MAX_OUTPUT) err += d.toString();
    else truncated = true;
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    finish({ code: 500, body: { error: `could not run vega on this PC: ${e.message}` } });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    if (timedOut) {
      finish({
        code: 504,
        body: { error: `timed out after ${timeoutMs}ms`, killed: true, stdout: out, stderr: err, truncated, durationMs },
      });
    } else {
      finish({ code: 200, body: { ok: code === 0, exitCode: code, stdout: out, stderr: err, truncated, durationMs } });
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function authorized(req) {
  const t = req.headers['x-fyaisa-token'];
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(STATE.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const OWNER_APP = 'app.fyaisa.hub.main';
const APP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * ElevSH access gate for apps that identify themselves with
 * X-FYAISA-App. FYAISA (the owner app) is always allowed; any other app id
 * needs an explicit allow decision made on the FYAISA ElevSH screen. An
 * unknown id is recorded as pending and rejected until the user decides.
 * Requests without an app header (host tools, curl) skip the gate.
 * Returns false if a response has already been sent.
 */
function appGate(req, res) {
  const raw = req.headers['x-fyaisa-app'];
  if (raw === undefined) return true;
  const appId = String(raw);
  if (!APP_ID_RE.test(appId)) {
    json(res, 400, { error: 'malformed X-FYAISA-App header', code: 'bad_app_id' });
    return false;
  }
  if (appId === OWNER_APP) {
    // FYAISA's own requests teach us the TV's address, which is what
    // auto-approvals are pinned to (a LAN client cannot claim it).
    const ip = clientIp(req);
    if (STATE.tvIp !== ip || Date.now() - (STATE.tvIpAt || 0) > 60 * 1000) {
      STATE.tvIp = ip;
      STATE.tvIpAt = Date.now();
      saveState(STATE);
      log(`ElevSH: Fire TV address ${ip} (seen via FYAISA)`);
    }
    return true;
  }
  const d = STATE.access[appId];
  if (d === 'allow') return true;
  if (d === undefined) {
    STATE.access[appId] = 'pending';
    saveState(STATE);
    log(`ElevSH access requested by ${appId} (pending user approval)`);
  }
  json(
    res,
    403,
    d === 'deny'
      ? {
          error: 'ElevSH access denied for this app — allow it in FYAISA to continue',
          code: 'access_denied',
          appId,
        }
      : {
          error: 'ElevSH access not granted yet — approve this app in FYAISA',
          code: 'access_required',
          appId,
        },
  );
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path_ = url.pathname;

  // liveness (unauthenticated, no secrets)
  if (path_ === '/ping') return json(res, 200, { ok: true, service: 'fyaisa-bridge' });

  // pairing: TV asks for a code; approve on the PC (`fyaisa approve`) or in
  // FYAISA → ElevSH on the TV. Apps send X-FYAISA-App, which is what makes
  // automatic setup work: if the user has allowed that app in FYAISA and the
  // request comes from the Fire TV's own address, it is approved instantly.
  if (path_ === '/pair/request' && req.method === 'POST') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const rawApp = req.headers['x-fyaisa-app'];
    const appId = typeof rawApp === 'string' && APP_ID_RE.test(rawApp) ? rawApp : null;
    const ip = clientIp(req);
    const entry = { expires: Date.now() + PAIR_TTL_MS, approved: false, appId, ip };
    pairings.set(code, entry);

    if (appId && appId !== OWNER_APP && STATE.access[appId] === undefined) {
      STATE.access[appId] = 'pending';
      saveState(STATE);
      log(`ElevSH access requested by ${appId} (pairing ${code})`);
    }
    const tvFresh = STATE.tvIp && Date.now() - (STATE.tvIpAt || 0) < TVIP_TTL_MS;
    let auto = false;
    if (appId && tvFresh && ip === STATE.tvIp &&
        (appId === OWNER_APP || STATE.access[appId] === 'allow')) {
      entry.approved = true;
      auto = true;
      log(`auto-approved ElevSH pairing for ${appId} (allowed, from the TV at ${ip})`);
    }
    log(`pairing requested, code ${code}${appId ? ` (app ${appId})` : ''}${auto ? ' — auto-approved' : ''} (valid 10 min)`);
    if (!auto) {
      console.log(`\n  Pairing code: ${code}${appId ? ` — requested by ${appId}` : ''}\n  Approve on this PC with:\n\n    fyaisa approve ${code}\n\n  or open FYAISA → ElevSH on the Fire TV and choose Allow.\n`);
    }
    return json(res, 200, { code, expiresIn: PAIR_TTL_MS / 1000, autoApproved: auto });
  }

  if (path_ === '/pair/status') {
    const code = url.searchParams.get('code') || '';
    const p = pairings.get(code);
    if (!p) return json(res, 404, { approved: false, error: 'unknown code' });
    if (Date.now() > p.expires) {
      pairings.delete(code);
      return json(res, 410, { approved: false, error: 'code expired' });
    }
    return json(res, 200, { approved: p.approved });
  }

  if (path_ === '/pair/approve' && req.method === 'POST') {
    const body = await readBody(req);
    const code = String(body.code || '');
    const p = pairings.get(code);
    if (!p || Date.now() > p.expires) return json(res, 404, { ok: false, error: 'unknown/expired code' });
    p.approved = true;
    if (p.appId && p.appId !== OWNER_APP) {
      // Approving a pairing and allowing the app's ElevSH access are the same thing.
      STATE.access[p.appId] = 'allow';
      log(`ElevSH access allow for ${p.appId} (via pairing approval)`);
    }
    saveState(STATE); // ensure token file exists on disk
    log('pairing approved for', body.device || 'device');
    return json(res, 200, { ok: true, token: STATE.token });
  }

  // App access status, tokenless: an app asks this before it even has a
  // pairing ("has the user allowed me yet?").
  if (path_ === '/access/status' && req.method === 'GET') {
    const appId = url.searchParams.get('appId') || '';
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    return json(res, 200, {
      appId,
      status: appId === OWNER_APP ? 'allow' : STATE.access[appId] || 'none',
    });
  }

  // ---- everything below requires the token ----
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized — pair first' });

  // Stop the bridge (`fyaisa disconnect`). Same token as every other call, but
  // a paired homebrew app must not be able to pull the bridge out from under
  // everyone, so only the hub app or a headerless host tool may use it.
  if (path_ === '/shutdown' && req.method === 'POST') {
    const h = req.headers['x-fyaisa-app'];
    if (typeof h === 'string' && h !== OWNER_APP) {
      return json(res, 403, { error: 'only the hub or host tools may stop the bridge', code: 'access_denied' });
    }
    json(res, 200, { ok: true, stopping: true });
    log('shutdown requested (fyaisa disconnect)');
    setTimeout(() => process.exit(0), 200); // let the response flush first
    return;
  }

  if (!appGate(req, res)) return;

  // Pending app pairing requests, shown on the FYAISA ElevSH screen so the
  // user can approve on the TV instead of typing codes on the PC.
  if (path_ === '/pair/pending' && req.method === 'GET') {
    const h = req.headers['x-fyaisa-app'];
    if (typeof h === 'string' && h !== OWNER_APP) {
      return json(res, 403, { error: 'only FYAISA reads pending pairings', code: 'access_denied' });
    }
    const now = Date.now();
    const pending = [];
    for (const [code, entry] of pairings) {
      if (entry.expires < now) {
        pairings.delete(code);
        continue;
      }
      if (!entry.approved && entry.appId) {
        pending.push({ code, appId: entry.appId, expiresIn: Math.round((entry.expires - now) / 1000) });
      }
    }
    return json(res, 200, { pairings: pending });
  }

  if (path_ === '/catalog' && req.method === 'GET') {
    // Prefer the remote catalog so the hub always shows the latest apps.
    const remote = await fetchRemoteCatalog();
    if (remote && Array.isArray(remote.apps)) {
      return json(res, 200, remote);
    }
    return json(res, 200, readCatalog());
  }

  if (path_ === '/install' && req.method === 'POST') {
    const body = await readBody(req);
    const appId = String(body.appId || '');
    if (!appId) return json(res, 400, { error: 'appId required' });
    const wantPatch = body.patch === true;
    if (wantPatch) {
      // Patch installs rewrite the app's identity, so the target comes from
      // the catalog (which the hub owner controls), never from the request.
      const entry = (readCatalog().apps || []).find((a) => a.id === appId);
      if (!entry || !entry.patch || !APP_ID_RE.test(String(entry.patch.for || ''))) {
        return json(res, 400, { error: 'this app has no patch metadata in the catalog', code: 'no_patch' });
      }
    }
    if ([...jobs.values()].some((j) => j.status === 'building' || j.status === 'installing')) {
      return json(res, 429, { error: 'a job is already running' });
    }
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, appId, patch: wantPatch, status: 'queued', log: [], createdAt: Date.now() };
    jobs.set(id, job);
    // keep the log bounded; these get polled by the TV
    const push = (l) => {
      job.log.push(l);
      if (job.log.length > 200) job.log.shift();
    };
    installApp(appId, job, { patch: wantPatch, deviceIp: clientIpOf(req) })
      .catch((e) => {
        job.status = 'error';
        push(`internal error: ${e.message}`);
      })
      .finally(() => log(`job ${id} -> ${job.status}`));
    return json(res, 202, { jobId: id });
  }

  if (path_ === '/job' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'unknown job' });
    return json(res, 200, job);
  }

  // Remove an installed app from the device. Hub and host tools only, like
  // /shutdown: a paired third-party app must not be able to wipe apps. The
  // one-job-at-a-time guard matches /install so two vega commands never
  // interleave against the same stick.
  if (path_ === '/uninstall' && req.method === 'POST') {
    const h = req.headers['x-fyaisa-app'];
    if (typeof h === 'string' && h !== OWNER_APP) {
      return json(res, 403, { error: 'only the hub may uninstall apps', code: 'access_denied' });
    }
    const body = await readBody(req);
    const appId = String(body.appId || '');
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    if ([...jobs.values()].some((j) => j.status === 'building' || j.status === 'installing')) {
      return json(res, 429, { error: 'a job is already running' });
    }
    const ip = clientIpOf(req);
    if (ip) {
      await run('vega', ['exec', 'vda', 'connect', `${ip}:5555`], HOST_DIR, () => {});
    }
    const out = [];
    const rc = await run('vega', ['device', 'uninstall-app', '--appName', appId], HOST_DIR, (l) =>
      out.push(l),
    );
    log(`uninstall ${appId} -> ${rc === 0 ? 'ok' : `exit ${rc}`}`);
    return json(res, rc === 0 ? 200 : 500, { ok: rc === 0, exitCode: rc, log: out });
  }

  if (path_ === '/jobs' && req.method === 'GET') {
    return json(res, 200, { jobs: [...jobs.values()] });
  }

  // ---- ElevSH access management: allow / deny / revoke app ids ----
  if (path_ === '/access' && req.method === 'GET') {
    const h = req.headers['x-fyaisa-app'];
    if (typeof h === 'string' && h !== OWNER_APP) {
      return json(res, 403, { error: 'only FYAISA manages ElevSH access', code: 'access_denied' });
    }
    return json(res, 200, {
      apps: Object.entries(STATE.access).map(([appId, status]) => ({ appId, status })),
    });
  }

  if (path_ === '/access' && req.method === 'POST') {
    const h = req.headers['x-fyaisa-app'];
    if (typeof h === 'string' && h !== OWNER_APP) {
      return json(res, 403, { error: 'only FYAISA manages ElevSH access', code: 'access_denied' });
    }
    const body = await readBody(req);
    const appId = String(body.appId || '');
    const decision = String(body.decision || '');
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    if (!['allow', 'deny', 'revoke'].includes(decision)) {
      return json(res, 400, { error: 'decision must be allow | deny | revoke' });
    }
    if (decision === 'revoke') delete STATE.access[appId];
    else STATE.access[appId] = decision;
    saveState(STATE);
    log(`ElevSH access ${decision} for ${appId}`);
    return json(res, 200, { ok: true, appId, status: STATE.access[appId] || 'none' });
  }

  if (path_ === '/launch' && req.method === 'POST') {
    const body = await readBody(req);
    const appId = String(body.appId || '');
    const rc = await run('vega', ['device', 'launch-app', '--appName', appId], HOST_DIR, (l) =>
      log(l),
    );
    return json(res, rc === 0 ? 200 : 500, { ok: rc === 0 });
  }

  if (path_ === '/vega' && req.method === 'POST') {
    const body = await readBody(req);
    return handleVegaExec(res, body);
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, BIND, () => {
  const addrs = [];
  if (BIND === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
      }
    }
  } else {
    addrs.push('127.0.0.1');
  }

  console.log('');
  console.log('  ElevSH bridge listening (FYAISA connect)');
  console.log(`    bind      ${BIND}:${PORT}`);
  for (const a of addrs) console.log(`    reachable http://${a}:${PORT}`);
  console.log('');
  console.log('  On the Fire TV: Settings → My Fire TV → Developer options,');
  console.log("  note this computer's address, then open FYAISA → ElevSH.");
  console.log('');
  if (!has('--lan')) {
    console.log('  Note: bound to localhost only. Pass --lan to accept connections');
    console.log('  from the Fire TV on your Wi-Fi.');
  }
  if (has('--tunnel')) {
    console.log('');
    console.log('  --tunnel requested. Expose this port with your own tunnel, e.g.:');
    console.log(`    cloudflared tunnel --url http://localhost:${PORT}`);
    console.log(`    ngrok http ${PORT}`);
    console.log('  Then enter the public https:// URL in the FYAISA ElevSH screen.');
    console.log('  Only do this on networks you trust: anyone who knows the');
    console.log('  pairing code and token can queue installs on your machine.');
  }
  console.log('');
});
