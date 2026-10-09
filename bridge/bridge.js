#!/usr/bin/env node
/**
 * fyaisa-bridge — the PC side of `fyaisa connect`.
 *
 * A Vega OS app cannot install packages (no install API), so the Fire TV cannot
 * push .vpkg files to itself. What it *can* do is make outbound HTTP requests.
 * So the direction of control is inverted:
 *
 *      Fire TV (FYAISA app)  --HTTP-->  this bridge on your PC  --> vega CLI
 *
 * The bridge holds the device connection and the build/install powers. The TV
 * app polls it for a pairing code and for jobs, and posts "install this app"
 * requests. The bridge authenticates with a shared token, so a random device on
 * the same Wi-Fi cannot install anything.
 *
 * Security model:
 *   - Binds to LAN (127.0.0.1 by default; 0.0.0.0 with --lan).
 *   - A 6-digit pairing code must be exchanged before any job is accepted.
 *   - After pairing, every request needs `X-FYAISA-Token`.
 *   - Tokens are random, stored in the state file, and never logged.
 *
 * Plain HTTP is deliberate: this is a short-lived LAN tool. Use `fyaisa connect
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

async function installApp(appId, job) {
  const catalog = readCatalog();
  const app = (catalog.apps || []).find((a) => a.id === appId);
  if (!app) {
    job.status = 'error';
    job.log.push(`Unknown app id: ${appId}`);
    return;
  }
  const dir = path.join(HOST_DIR, app.path || '');
  if (!fs.existsSync(dir)) {
    job.status = 'error';
    job.log.push(`App source missing: ${dir}`);
    return;
  }

  job.status = 'building';
  job.log.push(`Building ${app.name} (${appId})…`);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    const rc = await run('npm', ['install', '--no-audit', '--no-fund'], dir, (l) => job.log.push(l));
    if (rc !== 0) {
      job.status = 'error';
      job.log.push('npm install failed');
      return;
    }
  }
  const brc = await run('npm', ['run', 'build:release'], dir, (l) => job.log.push(l));
  if (brc !== 0) {
    job.status = 'error';
    job.log.push('build failed');
    return;
  }

  job.status = 'installing';
  job.log.push('Installing on the connected Fire TV…');
  const irc = await run('vega', ['device', 'install-app', '--dir', '.', '-b', 'Release'], dir, (l) =>
    job.log.push(l),
  );
  if (irc !== 0) {
    job.status = 'error';
    job.log.push('install failed — is a Fire TV connected? (vega device list)');
    return;
  }
  job.status = 'done';
  job.log.push(`Installed ${app.name}. Launch it from your Fire TV app list.`);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path_ = url.pathname;

  // liveness (unauthenticated, no secrets)
  if (path_ === '/ping') return json(res, 200, { ok: true, service: 'fyaisa-bridge' });

  // pairing: TV asks for a code, user approves by typing it
  if (path_ === '/pair/request' && req.method === 'POST') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pairings.set(code, { expires: Date.now() + PAIR_TTL_MS, approved: false });
    log(`pairing requested, code ${code} (valid 10 min)`);
    console.log(`\n  Pairing code: ${code}\n  The Fire TV shows the same code in FYAISA → Connect.\n  Approve it on this PC with:\n\n    fyaisa approve ${code}\n`);
    return json(res, 200, { code, expiresIn: PAIR_TTL_MS / 1000 });
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
    saveState(STATE); // ensure token file exists on disk
    log('pairing approved for', body.device || 'device');
    return json(res, 200, { ok: true, token: STATE.token });
  }

  // ---- everything below requires the token ----
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized — pair first' });

  if (path_ === '/catalog' && req.method === 'GET') {
    return json(res, 200, readCatalog());
  }

  if (path_ === '/install' && req.method === 'POST') {
    const body = await readBody(req);
    const appId = String(body.appId || '');
    if (!appId) return json(res, 400, { error: 'appId required' });
    if ([...jobs.values()].some((j) => j.status === 'building' || j.status === 'installing')) {
      return json(res, 429, { error: 'a job is already running' });
    }
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, appId, status: 'queued', log: [], createdAt: Date.now() };
    jobs.set(id, job);
    // keep the log bounded; these get polled by the TV
    const push = (l) => {
      job.log.push(l);
      if (job.log.length > 200) job.log.shift();
    };
    installApp(appId, job)
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

  if (path_ === '/jobs' && req.method === 'GET') {
    return json(res, 200, { jobs: [...jobs.values()] });
  }

  if (path_ === '/launch' && req.method === 'POST') {
    const body = await readBody(req);
    const appId = String(body.appId || '');
    const rc = await run('vega', ['device', 'launch-app', '--appName', appId], HOST_DIR, (l) =>
      log(l),
    );
    return json(res, rc === 0 ? 200 : 500, { ok: rc === 0 });
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
  console.log('  FYAISA bridge listening');
  console.log(`    bind      ${BIND}:${PORT}`);
  for (const a of addrs) console.log(`    reachable http://${a}:${PORT}`);
  console.log('');
  console.log('  On the Fire TV: Settings → My Fire TV → Developer options,');
  console.log('  note this PC address, then open FYAISA → Connect.');
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
    console.log('  Then enter the public https:// URL in the FYAISA app.');
    console.log('  Only do this on networks you trust: anyone who knows the');
    console.log('  pairing code and token can queue installs on your machine.');
  }
  console.log('');
});
