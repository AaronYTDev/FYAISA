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
 *   - POST /shutdown stops the bridge (token + explicit hub header); this is
 *     what `fyaisa disconnect` calls.
 *   - Apps that identify themselves with `X-FYAISA-App: <app-id>` are gated:
 *     FYAISA (the owner app) allows or denies each app id from the ElevSH
 *     screen; unknown ids get a pending 403 until approved. Requests without
 *     an app header (host tools, curl) are token-only, but hub-only routes
 *     (/shutdown, /uninstall, /pair/pending, /access) require the hub header.
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
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = parseInt(flag('--port', '47821'), 10);
const HOST_DIR = flag('--hub-dir', process.env.FYAISA_DIR || path.join(os.homedir(), 'FYAISA'));
const REPO_URL = flag('--repo', 'https://github.com/AaronYTDev/FYAISA');
const BIND = has('--lan') ? '0.0.0.0' : '127.0.0.1';
const PAIR_TTL_MS = 10 * 60 * 1000;
// How long the recorded Fire TV address stays fresh for auto-approvals.
const TVIP_TTL_MS = 72 * 60 * 60 * 1000;
const STATE_DIR = path.join(os.homedir(), '.fyaisa');
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');

// Bounded surfaces: request bodies, pairing attempts and logs all have hard
// ceilings. The bridge is long-lived, so none of them may grow without one.
const MAX_BODY_BYTES = 1_000_000;
const BODY_TIMEOUT_MS = 15_000;
const MAX_JOB_LOG_LINES = 200;
const MAX_JOB_LOG_BYTES = 64 * 1024;
const MAX_JOB_LINE_CHARS = 8 * 1024;
const MAX_BRIDGE_LOG_BYTES = 256 * 1024;
const MAX_PAIRINGS = 100;
const MAX_PAIR_ATTEMPTS = 5;
const PAIR_RATE_WINDOW_MS = 60 * 1000;
const MAX_PAIR_REQUESTS = 10;
const MAX_PAIR_APPROVES = 10;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function loadState() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    s = {};
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  if (typeof s.token !== 'string' || !/^[0-9a-f]{48}$/.test(s.token)) {
    s.token = crypto.randomBytes(24).toString('hex');
  }
  if (!s.pairedDevices || typeof s.pairedDevices !== 'object' || Array.isArray(s.pairedDevices)) {
    s.pairedDevices = {};
  }
  return s;
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
    fs.chmodSync(STATE_FILE, 0o600);
  } catch {}
}
let STATE = loadState();
// ElevSH access decisions: appId -> 'allow' | 'deny' | 'pending'.
if (!STATE.access || typeof STATE.access !== 'object' || Array.isArray(STATE.access)) {
  STATE.access = {};
}
// Last known Fire TV address (from FYAISA's own requests) + when we set it.
STATE.tvIp = typeof STATE.tvIp === 'string' ? STATE.tvIp : null;
STATE.tvIpAt = Number.isFinite(STATE.tvIpAt) ? STATE.tvIpAt : 0;

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

const pairings = new Map(); // code -> {expires, approved, consumed, attempts, appId, ip}
const jobs = new Map(); // id -> {id, appId, status, log, createdAt}
const rateWindows = new Map(); // key -> {count, resetAt}
const boundedBytes = new WeakMap(); // array/job log -> tracked byte count
let deviceOpBusy = false; // uninstall/etc. hold the device while they run

// Job TTL: completed/errored jobs are kept for 30 minutes so the TV can poll
// the build log, then reaped so the Map doesn't grow unbounded.
const JOB_TTL_MS = 30 * 60 * 1000;
function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (
      (job.status === 'done' || job.status === 'error') &&
      now - job.createdAt > JOB_TTL_MS
    ) {
      jobs.delete(id);
    }
  }
}

// Pairing codes expire after PAIR_TTL_MS; clean them aggressively so expired
// codes don't linger in the Map until the next /pair/status poll.
function cleanupPairings() {
  const now = Date.now();
  for (const [code, entry] of pairings) {
    if (now > entry.expires) pairings.delete(code);
  }
}

function cleanupRateWindows() {
  const now = Date.now();
  for (const [key, window] of rateWindows) {
    if (now >= window.resetAt) rateWindows.delete(key);
  }
}

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let window = rateWindows.get(key);
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + windowMs };
    rateWindows.set(key, window);
  }
  window.count += 1;
  return window.count > limit;
}

function appendBoundedArray(arr, line, maxLines = MAX_JOB_LOG_LINES, maxBytes = MAX_JOB_LOG_BYTES) {
  const text = String(line).slice(0, MAX_JOB_LINE_CHARS);
  arr.push(text);
  let bytes = (boundedBytes.get(arr) || 0) + Buffer.byteLength(text) + 1;
  boundedBytes.set(arr, bytes);
  while (arr.length > maxLines || bytes > maxBytes) {
    const removed = arr.shift();
    if (removed === undefined) {
      bytes = 0;
      break;
    }
    bytes -= Buffer.byteLength(removed) + 1;
  }
  boundedBytes.set(arr, Math.max(0, bytes));
}

function appendJobLog(job, line) {
  if (job && Array.isArray(job.log)) appendBoundedArray(job.log, line);
}

function activeJob() {
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'building' || job.status === 'installing') {
      return job;
    }
  }
  return null;
}

for (const [fn, ms] of [[cleanupJobs, 5 * 60 * 1000], [cleanupPairings, 60 * 1000], [cleanupRateWindows, 60 * 1000]]) {
  const timer = setInterval(fn, ms);
  if (timer.unref) timer.unref();
}

function appendBridgeLog(line) {
  const text = String(line).slice(0, MAX_JOB_LINE_CHARS);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    let previous = '';
    try {
      previous = fs.readFileSync(LOG_FILE, 'utf8');
    } catch {}
    let out = previous + text + '\n';
    if (Buffer.byteLength(out) > MAX_BRIDGE_LOG_BYTES) {
      const tail = out.slice(-Math.floor(MAX_BRIDGE_LOG_BYTES / 2));
      const firstNewline = tail.indexOf('\n');
      out = (firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail).slice(-MAX_BRIDGE_LOG_BYTES);
    }
    fs.writeFileSync(LOG_FILE, out, { mode: 0o600 });
    try {
      fs.chmodSync(LOG_FILE, 0o600);
    } catch {}
  } catch {}
}

function log(...a) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[bridge ${ts}] ${a.map((v) => (typeof v === 'string' ? v : String(v))).join(' ')}`;
  console.log(line);
  appendBridgeLog(line);
}

// Kill the whole process tree, not just the direct child: npm scripts and vega
// wrappers spawn grandchildren that would otherwise keep building after a
// timeout. POSIX gets a detached process group; Windows gets taskkill /T.
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
function readCatalog() {
  const file = path.join(HOST_DIR, 'catalog.json');
  if (!fs.existsSync(file)) {
    log(`catalog not found at ${file}; bridge will serve an empty catalog`);
    return { apps: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`catalog parse failed at ${file}: ${e.message}; serving empty catalog`);
    return { apps: [] };
  }
}

// Fetch the catalog from the configured repo (fallback when local is stale).
const CATALOG_TTL_MS = 60_000;
const CATALOG_FAIL_TTL_MS = 60_000;
let catalogCache = {at: 0, failAt: 0, data: null, inflight: null};

function remoteCatalogUrl() {
  const base = String(REPO_URL || '').replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/catalog.json`;
}

async function fetchRemoteCatalog() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(remoteCatalogUrl(), {signal: controller.signal});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    log('remote catalog fetch failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The catalog the hub works from: the repository's, so merged PRs show up
// without waiting for the local checkout. Cache it briefly and coalesce
// concurrent reads: the hub can ask for it on every screen, and an offline PC
// used to stall each call for the full 15-second fetch timeout.
async function currentCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  if (now - catalogCache.failAt < CATALOG_FAIL_TTL_MS) {
    return catalogCache.data || readCatalog();
  }
  if (catalogCache.inflight) return catalogCache.inflight;
  catalogCache.inflight = (async () => {
    const remote = await fetchRemoteCatalog();
    if (remote && Array.isArray(remote.apps)) {
      catalogCache = {at: Date.now(), failAt: 0, data: remote, inflight: catalogCache.inflight};
      return remote;
    }
    catalogCache.failAt = Date.now();
    return catalogCache.data || readCatalog();
  })();
  try {
    return await catalogCache.inflight;
  } finally {
    catalogCache.inflight = null;
  }
}

// The version an app's local checkout declares (its manifest.toml). null when
// the app isn't there or has no version line.
function readLocalVersion(dir) {
  try {
    const manifest = fs.readFileSync(path.join(dir, 'manifest.toml'), 'utf8');
    const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(manifest);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Semver-ish compare: -1, 0 or 1. Numeric identifiers compare as numbers,
// prerelease sorts below the release, and numeric ids sort below text ids.
function compareVersions(a, b) {
  const parse = (value) => {
    const raw = String(value == null ? '' : value).trim().replace(/^[vV]/, '').split('+')[0];
    const dash = raw.indexOf('-');
    const core = dash >= 0 ? raw.slice(0, dash) : raw;
    let pre = dash >= 0 ? raw.slice(dash + 1) : '';
    const parts = core.split('.').map((part) => {
      const m = /^(\d+)(.*)$/.exec(part);
      if (!m) return '0';
      if (m[2]) pre = `${m[2].replace(/^[-.]/, '')}${pre ? `.${pre}` : ''}`;
      return m[1] || '0';
    });
    return { parts, pre: pre.replace(/^\.+|\.+$/g, '') };
  };
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.parts.length, bv.parts.length);
  for (let i = 0; i < len; i++) {
    const x = BigInt(av.parts[i] || '0');
    const y = BigInt(bv.parts[i] || '0');
    if (x < y) return -1;
    if (x > y) return 1;
  }
  if (!av.pre && !bv.pre) return 0;
  if (!av.pre) return 1;
  if (!bv.pre) return -1;
  const ap = av.pre.split('.');
  const bp = bv.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (i >= ap.length) return -1;
    if (i >= bp.length) return 1;
    const x = ap[i];
    const y = bp[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = BigInt(x);
      const ny = BigInt(y);
      if (nx < ny) return -1;
      if (nx > ny) return 1;
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (x < y) {
      return -1;
    } else if (x > y) {
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Install pipeline (delegates to the same steps as `fyaisa install`)
// ---------------------------------------------------------------------------
function run(cmd, args, cwd, onLog, timeoutMs = 0) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    onLog(`$ ${cmd} ${args.join(' ')}`);
    const capture = (buf) => {
      onLog(buf.toString().trimEnd());
    };
    p.stdout.on('data', capture);
    p.stderr.on('data', capture);
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        onLog(`timeout after ${timeoutMs}ms — killing process tree for ${cmd}`);
        killTree(p);
      }, timeoutMs);
    }
    p.on('error', (e) => {
      if (timer) clearTimeout(timer);
      onLog(`spawn error: ${e.message}`);
      resolve(127);
    });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      killTree(p); // grandchildren may outlive the direct child on success too
      resolve(timedOut ? 124 : code === null ? 1 : code);
    });
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
  if (
    !relPath ||
    path.isAbsolute(relPath) ||
    relPath.includes('\0') ||
    relPath.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`unsafe app path in catalog: ${relPath}`);
  }
  const cacheDir = path.join(REMOTE_CACHE_DIR, relPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fyaisa-remote-'));

  try {
    // Download tarball
    const tarball = path.join(tmp, 'repo.tar.gz');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res;
    try {
      res = await fetch(REMOTE_TARBALL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tarball, buf);
    } finally {
      clearTimeout(timer);
    }

    // Extract just the app directory
    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    const trc = await run(
      'tar',
      ['-xzf', tarball, '-C', extractDir, '--wildcards', `FYAISA-main/${relPath}/*`],
      tmp,
      () => {},
      60_000,
    );
    if (trc !== 0) throw new Error(`tar extraction failed (exit ${trc})`);

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
  const catalog = await currentCatalog();
  const app = (catalog.apps || []).find((a) => a.id === appId);
  if (!app) {
    job.status = 'error';
    appendJobLog(job,`Unknown app id: ${appId}`);
    return;
  }
  if (
    !app.path ||
    path.isAbsolute(app.path) ||
    app.path.includes('\0') ||
    app.path.split(/[\\/]/).includes('..')
  ) {
    job.status = 'error';
    appendJobLog(job,`Catalog entry ${appId} has no safe path; cannot build it.`);
    return;
  }

  // Build from your local checkout so you can install work in progress, but
  // only while it is not behind the version the catalog publishes — a stale
  // clone would otherwise rebuild the very version the hub offered to replace.
  const localDir = path.join(HOST_DIR, app.path);
  const localVersion = readLocalVersion(localDir);
  const behind =
    !!localVersion && !!app.version && compareVersions(localVersion, app.version) < 0;
  let dir = localDir;
  if (!fs.existsSync(localDir) || behind) {
    appendJobLog(job,
      behind
        ? `Local ${app.path} is ${localVersion}, catalog has ${app.version} — fetching from GitHub…`
        : `App source not found locally, fetching from GitHub…`,
    );
    try {
      dir = await fetchRemoteApp(app.path);
      appendJobLog(job,`Fetched ${app.path} from GitHub`);
    } catch (e) {
      job.status = 'error';
      appendJobLog(job,`Failed to fetch app source: ${e.message}`);
      return;
    }
  }

  // ---- reconnect vda ---------------------------------------------------------
  // The TV is talking to us, so it is on the network — but the PC-side vda
  // link goes stale whenever the stick sleeps, and without it every
  // `vega device …` below dies with "device offline". Connect to the
  // requesting TV first; best-effort, since the link may already be up.
  if (opts.deviceIp) {
    appendJobLog(job,`Ensuring vda is connected to ${opts.deviceIp}:5555…`);
    await run(
      'vega',
      ['exec', 'vda', 'connect', `${opts.deviceIp}:5555`],
      HOST_DIR,
      (l) => appendJobLog(job,l),
      30000, // 30 s — vda connect should be quick
    );
  }

  // Pre-flight: confirm the device is actually visible to `vega device list`
  // before we spend time building. Failing here is fast; failing after a long
  // npm build is frustrating.
  if (opts.deviceIp) {
    const seen = [];
    const rc = await run(
      'vega',
      ['device', 'list'],
      HOST_DIR,
      (l) => {
        if (seen.length < 10 && l.includes(opts.deviceIp)) seen.push(l);
        appendJobLog(job,l);
      },
    );
    if (rc !== 0 || seen.length === 0) {
      job.status = 'error';
      appendJobLog(job,
        `Device ${opts.deviceIp} not visible to vega device list — is the Fire TV awake and in Developer Mode?`,
      );
      return;
    }
    appendJobLog(job,`Device ${opts.deviceIp} confirmed online.`);
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
      appendJobLog(job,`Catalog entry ${appId} has no valid patch.for — cannot patch-install.`);
      return;
    }
    const patchName = String(p.name || app.name);
    if (patchName.includes('"') || patchName.includes('\n') || patchName.length > 64) {
      job.status = 'error';
      appendJobLog(job,`patch.name must be ≤64 chars without quotes.`);
      return;
    }
    const origPkg = appId.endsWith('.main') ? appId.slice(0, -5) : appId;
    const newPkg = p.for.endsWith('.main') ? p.for.slice(0, -5) : p.for;
    patch = { id: p.for, name: patchName, pkg: newPkg };

    buildDir = path.join(STATE_DIR, 'patch-build', appId.replace(/[^A-Za-z0-9._-]/g, '_'));
    appendJobLog(job,`Patch install: ${appId} → ${patch.id} ("${patchName}", version 99.99.99)`);
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
    appendJobLog(job,`Identity rewritten (${origPkg} → ${newPkg}); building…`);
  }

  job.status = 'building';
  if (!patch) appendJobLog(job,`Building ${app.name} (${appId})…`);
  if (!fs.existsSync(path.join(buildDir, 'node_modules'))) {
    if (patch) appendJobLog(job,'Installing dependencies in the patch build dir…');
    const rc = await run(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      buildDir,
      (l) => appendJobLog(job,l),
      300000, // 5 min — dependency install can be slow on first run
    );
    if (rc !== 0) {
      job.status = 'error';
      appendJobLog(job,'npm install failed');
      return;
    }
  }
  const brc = await run(
    'npm',
    ['run', 'build:release'],
    buildDir,
    (l) => appendJobLog(job,l),
    600000, // 10 min — Vega builds can be slow on larger apps
  );
  if (brc !== 0) {
    job.status = 'error';
    appendJobLog(job,patch ? 'patch build failed' : 'build failed');
    return;
  }

  job.status = 'installing';
  if (patch) {
    // Build first, touch the device second: if the rewrite doesn't compile
    // the original is still there. Uninstalling is best-effort; a
    // system-protected original may refuse, in which case we install over it.
    appendJobLog(job,`Removing the original ${patch.id}…`);
    const urc = await run(
      'vega',
      ['device', 'uninstall-app', '--appName', patch.id],
      HOST_DIR,
      (l) => appendJobLog(job,l),
      60000, // 1 min — uninstall should be quick
    );
    if (urc !== 0) {
      appendJobLog(job,`Note: could not remove the original (exit ${urc}) — it may be system-protected; installing over it.`);
    } else {
      appendJobLog(job,`Removed the original ${patch.id}.`);
    }
  }
  appendJobLog(job,'Installing on the connected Fire TV…');
  const irc = await run(
    'vega',
    ['device', 'install-app', '--dir', '.', '-b', 'Release'],
    buildDir,
    (l) => appendJobLog(job,l),
    120000, // 2 min — package install should be quick once built
  );
  if (irc !== 0) {
    job.status = 'error';
    appendJobLog(job,
      patch
        ? `install failed — the original ${patch.id} was already removed; retry or reinstall it.`
        : 'install failed — is a Fire TV connected? (vega device list)',
    );
    return;
  }
  job.status = 'done';
  appendJobLog(job,
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
const VEGA_MAX_ARG_LEN = 512;
let vegaInFlight = 0;

function vegaArgsAllowed(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 12) return false;
  if (!argv.every((a) => typeof a === 'string' && a.length <= VEGA_MAX_ARG_LEN && VEGA_ARG_RE.test(a))) return false;
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
      code: 'vega_args_not_allowed',
    });
  }
  if (vegaInFlight >= VEGA_MAX_CONCURRENT) {
    return json(res, 429, { error: 'too many concurrent vega calls', code: 'vega_busy' });
  }
  vegaInFlight += 1;

  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30000, 1000), 120000);
  const started = Date.now();
  log(`vega ${argv.join(' ')}`);
  const child = spawn('vega', argv, {
    env: process.env,
    detached: process.platform !== 'win32',
  }); // no shell
  let out = '';
  let err = '';
  let truncated = false;
  let timedOut = false;
  let done = false;
  let timer = null;

  const finish = (payload) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    killTree(child);
    vegaInFlight -= 1;
    json(res, payload.code, payload.body);
  };

  timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const capture = (field) => (d) => {
    const chunk = d.toString();
    let sink = field === 'out' ? out : err;
    if (sink.length < VEGA_MAX_OUTPUT) {
      sink += chunk.slice(0, VEGA_MAX_OUTPUT - sink.length);
      if (field === 'out') out = sink;
      else err = sink;
    }
    if (chunk.length > VEGA_MAX_OUTPUT - sink.length) truncated = true;
  };
  child.stdout.on('data', capture('out'));
  child.stderr.on('data', capture('err'));
  child.on('error', (e) => {
    finish({
      code: 500,
      body: { error: `could not run vega on this PC: ${e.message}`, code: 'vega_spawn_error' },
    });
  });
  child.on('close', (code) => {
    const durationMs = Date.now() - started;
    if (timedOut) {
      finish({
        code: 504,
        body: {
          error: `timed out after ${timeoutMs}ms`,
          code: 'vega_timeout',
          killed: true,
          stdout: out,
          stderr: err,
          truncated,
          durationMs,
        },
      });
    } else {
      finish({
        code: 200,
        body: { ok: code === 0, exitCode: code, stdout: out, stderr: err, truncated, durationMs },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    // The hub runs in a WebView; permissive CORS keeps tokenless /ping and
    // the pairing endpoints reachable from any origin the shell uses.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-FYAISA-Token, X-FYAISA-App',
  });
  res.end(payload);
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    let timer = null;

    const fail = (status, code, message) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      // Answer first, then close the socket. Destroying immediately drops the
      // 413/400 response and the client only sees ECONNRESET.
      try {
        json(res, status, { error: message, code });
      } catch {}
      if (!req.destroyed) {
        if (res && res.writableEnded) req.destroy();
        else if (res) res.once('finish', () => { if (!req.destroyed) req.destroy(); });
        else req.destroy();
      }
      reject(new RequestError(status, code, message));
    };
    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(413, 'body_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      if (req.destroyed) {
        reject(new RequestError(400, 'request_aborted', 'request closed before completion'));
        return;
      }
      let parsed = {};
      if (chunks.length) {
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new RequestError(400, 'bad_json', 'malformed JSON body'));
          return;
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new RequestError(400, 'bad_json', 'JSON body must be an object'));
        return;
      }
      resolve(parsed);
    };
    const onError = (e) => fail(400, 'request_error', `request error: ${e && e.message ? e.message : e}`);
    const onAborted = () => fail(400, 'request_aborted', 'request aborted by client');
    const onClose = () => fail(400, 'request_aborted', 'request closed before completion');

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    timer = setTimeout(
      () => fail(408, 'request_timeout', `request body timed out after ${BODY_TIMEOUT_MS}ms`),
      BODY_TIMEOUT_MS,
    );

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(413, 'body_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
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

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const path_ = url.pathname;

  // CORS preflight from a WebView-based client. Never carries a token.
  if (req.method === 'OPTIONS') return json(res, 200, {});

  // liveness (unauthenticated, no secrets)
  if (path_ === '/ping') return json(res, 200, { ok: true, service: 'fyaisa-bridge' });

  // pairing: TV asks for a code; approve on the PC (`fyaisa approve`) or in
  // FYAISA → ElevSH on the TV. Apps send X-FYAISA-App, which is what makes
  // automatic setup work: if the user has allowed that app in FYAISA and the
  // request comes from the Fire TV's own address, it is approved instantly.
  if (path_ === '/pair/request' && req.method === 'POST') {
    cleanupPairings();
    const ip = clientIp(req) || String(req.socket.remoteAddress || 'unknown');
    if (rateLimited(`pair:request:${ip}`, MAX_PAIR_REQUESTS, PAIR_RATE_WINDOW_MS)) {
      return json(res, 429, { error: 'too many pairing requests', code: 'rate_limited' });
    }
    if (pairings.size >= MAX_PAIRINGS) {
      return json(res, 429, { error: 'too many pending pairings', code: 'pairings_full' });
    }

    const rawApp = req.headers['x-fyaisa-app'];
    let appId = null;
    if (rawApp !== undefined) {
      if (typeof rawApp !== 'string' || !APP_ID_RE.test(rawApp)) {
        return json(res, 400, { error: 'malformed X-FYAISA-App header', code: 'bad_app_id' });
      }
      appId = rawApp;
    }
    // CSPRNG, not Math.random: a predictable code defeats the pairing gate.
    const code = String(crypto.randomInt(100000, 1000000));
    const entry = {
      expires: Date.now() + PAIR_TTL_MS,
      approved: false,
      consumed: false,
      attempts: 0,
      appId,
      ip,
    };
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
    cleanupPairings();
    const code = url.searchParams.get('code') || '';
    if (!/^\d{6}$/.test(code)) {
      return json(res, 400, { approved: false, error: 'bad pairing code', code: 'bad_code' });
    }
    const p = pairings.get(code);
    if (!p) return json(res, 404, { approved: false, error: 'unknown code', code: 'unknown_code' });
    if (Date.now() > p.expires) {
      pairings.delete(code);
      return json(res, 410, { approved: false, error: 'code expired', code: 'code_expired' });
    }
    return json(res, 200, { approved: p.approved });
  }

  if (path_ === '/pair/approve' && req.method === 'POST') {
    const ip = clientIp(req) || String(req.socket.remoteAddress || 'unknown');
    if (rateLimited(`pair:approve:${ip}`, MAX_PAIR_APPROVES, PAIR_RATE_WINDOW_MS)) {
      return json(res, 429, { ok: false, error: 'too many pairing attempts', code: 'rate_limited' });
    }
    cleanupPairings();
    const rawApp = req.headers['x-fyaisa-app'];
    const appId = typeof rawApp === 'string' ? rawApp : null;
    if (appId !== null && !APP_ID_RE.test(appId)) {
      return json(res, 400, { ok: false, error: 'malformed X-FYAISA-App header', code: 'bad_app_id' });
    }
    const body = await readBody(req, res);
    const code = String(body.code || '');
    if (!/^\d{6}$/.test(code)) {
      return json(res, 400, { ok: false, error: 'bad pairing code', code: 'bad_code' });
    }
    const p = pairings.get(code);
    if (!p || Date.now() > p.expires) {
      if (p) pairings.delete(code);
      return json(res, 404, { ok: false, error: 'unknown/expired code', code: 'unknown_code' });
    }
    // Approving and exchanging share this endpoint, but they are different
    // privileges. Only the host CLI or the authenticated hub may flip a
    // pending decision; only the device that requested the code may exchange
    // it for the bridge token. Previously two unauthenticated POSTs with a
    // guessed 6-digit code handed out the global token.
    const hostApprover = body.device === 'fyaisa-cli';
    const hubApprover = authorized(req) && appId === OWNER_APP;
    if (!p.approved) {
      if (!hostApprover && !hubApprover) {
        return json(res, 403, {
          ok: false,
          error: 'approve this code on the PC or in FYAISA first',
          code: 'approval_required',
        });
      }
      p.approved = true;
      if (p.appId && p.appId !== OWNER_APP) {
        STATE.access[p.appId] = 'allow';
        log(`ElevSH access allow for ${p.appId} (via pairing approval)`);
      }
      saveState(STATE);
      log('pairing approved for', String(body.device || 'device').slice(0, 64));
      return json(res, 200, { ok: true, approved: true });
    }
    if (p.consumed) {
      p.attempts += 1;
      if (p.attempts >= MAX_PAIR_ATTEMPTS) pairings.delete(code);
      return json(res, 404, { ok: false, error: 'pairing code already used', code: 'code_consumed' });
    }
    const tokenRequester = body.device === 'fyaisa-client' || body.device === 'fyaisa-app';
    if (ip !== p.ip || appId !== p.appId || (!tokenRequester && !hubApprover)) {
      return json(res, 403, {
        ok: false,
        error: 'pairing code belongs to a different device or app',
        code: 'pair_mismatch',
      });
    }
    p.consumed = true;
    p.attempts += 1;
    if (p.attempts >= MAX_PAIR_ATTEMPTS) pairings.delete(code);
    saveState(STATE); // ensure token file exists on disk
    log('pairing token issued', String(body.device || 'device').slice(0, 64));
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
  // everyone, so the hub header is required here.
  if (path_ === '/shutdown' && req.method === 'POST') {
    const h = req.headers['x-fyaisa-app'];
    if (h !== OWNER_APP) {
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
    if (h !== OWNER_APP) {
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
    return json(res, 200, await currentCatalog());
  }

  if (path_ === '/install' && req.method === 'POST') {
    const body = await readBody(req, res);
    const appId = String(body.appId || '');
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    const wantPatch = body.patch === true;
    if (wantPatch) {
      // Patch installs rewrite the app's identity, so the target comes from
      // the catalog (which the hub owner controls), never from the request.
      const entry = ((await currentCatalog()).apps || []).find((a) => a.id === appId);
      if (!entry || !entry.patch || !APP_ID_RE.test(String(entry.patch.for || ''))) {
        return json(res, 400, { error: 'this app has no patch metadata in the catalog', code: 'no_patch' });
      }
    }
    // Queued counts as busy: the old guard only saw building/installing, so a
    // burst of installs could create a pile of jobs before the first started.
    const busy = activeJob();
    if (busy || deviceOpBusy) {
      return json(res, 429, {
        error: 'a job is already queued or running',
        code: 'job_busy',
        jobId: busy ? busy.id : undefined,
      });
    }
    if ([...jobs.values()].some((j) => j.appId === appId && (j.status === 'queued' || j.status === 'building' || j.status === 'installing'))) {
      return json(res, 409, { error: 'a job for this app is already queued or running', code: 'job_duplicate' });
    }
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, appId, patch: wantPatch, status: 'queued', log: [], createdAt: Date.now() };
    jobs.set(id, job);
    installApp(appId, job, { patch: wantPatch, deviceIp: clientIpOf(req) })
      .catch((e) => {
        job.status = 'error';
        appendJobLog(job, `internal error: ${e && e.message ? e.message : e}`);
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
    if (h !== OWNER_APP) {
      return json(res, 403, { error: 'only the hub may uninstall apps', code: 'access_denied' });
    }
    const body = await readBody(req, res);
    const appId = String(body.appId || '');
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    const busy = activeJob();
    if (busy || deviceOpBusy) {
      return json(res, 429, {
        error: 'a job is already queued or running',
        code: 'job_busy',
        jobId: busy ? busy.id : undefined,
      });
    }
    deviceOpBusy = true;
    try {
      const ip = clientIpOf(req);
      if (ip) {
        await run('vega', ['exec', 'vda', 'connect', `${ip}:5555`], HOST_DIR, () => {}, 30_000);
      }
      const out = [];
      // Stop the app first: uninstall-app can bounce on a running app.
      await run('vega', ['device', 'terminate-app', '--appName', appId], HOST_DIR, () => {}, 60_000);
      const rc = await run(
        'vega',
        ['device', 'uninstall-app', '--appName', appId],
        HOST_DIR,
        (l) => appendBoundedArray(out, l),
        120_000,
      );
      log(`uninstall ${appId} -> ${rc === 0 ? 'ok' : `exit ${rc}`}`);
      return json(res, rc === 0 ? 200 : 500, { ok: rc === 0, exitCode: rc, log: out });
    } finally {
      deviceOpBusy = false;
    }
  }

  if (path_ === '/jobs' && req.method === 'GET') {
    return json(res, 200, { jobs: [...jobs.values()] });
  }

  // ---- ElevSH access management: allow / deny / revoke app ids ----
  if (path_ === '/access' && req.method === 'GET') {
    const h = req.headers['x-fyaisa-app'];
    if (h !== OWNER_APP) {
      return json(res, 403, { error: 'only FYAISA manages ElevSH access', code: 'access_denied' });
    }
    return json(res, 200, {
      apps: Object.entries(STATE.access).map(([appId, status]) => ({ appId, status })),
    });
  }

  if (path_ === '/access' && req.method === 'POST') {
    const h = req.headers['x-fyaisa-app'];
    if (h !== OWNER_APP) {
      return json(res, 403, { error: 'only FYAISA manages ElevSH access', code: 'access_denied' });
    }
    const body = await readBody(req, res);
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
    const body = await readBody(req, res);
    const appId = String(body.appId || '');
    if (!APP_ID_RE.test(appId)) return json(res, 400, { error: 'bad appId', code: 'bad_app_id' });
    const out = [];
    const rc = await run(
      'vega',
      ['device', 'launch-app', '--appName', appId],
      HOST_DIR,
      (l) => appendBoundedArray(out, l),
      60_000,
    );
    log(`launch ${appId} -> ${rc === 0 ? 'ok' : `exit ${rc}`}`);
    return json(res, rc === 0 ? 200 : 500, { ok: rc === 0, exitCode: rc, log: out });
  }

  if (path_ === '/vega' && req.method === 'POST') {
    const body = await readBody(req, res);
    return handleVegaExec(res, body);
  }

  return json(res, 404, { error: 'not found', code: 'not_found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    const known = e instanceof RequestError;
    const status = known ? e.status : 500;
    const code = known ? e.code : 'internal_error';
    if (!known) log(`request failed: ${e && e.stack ? e.stack : e}`);
    json(res, status, { error: e && e.message ? e.message : 'internal error', code });
  });
});
server.requestTimeout = BODY_TIMEOUT_MS + 5_000;
server.headersTimeout = 10_000;

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  ElevSH bridge is already listening on ${BIND}:${PORT}.`);
    console.error(`  Stop it with: fyaisa disconnect --port ${PORT}`);
    console.error('  Or pair with the running bridge; no second bridge is needed.\n');
    process.exit(1);
  }
  console.error(`\n  ElevSH bridge could not listen on ${BIND}:${PORT}: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
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
