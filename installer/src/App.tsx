/**
 * FYAISA: homebrew hub for Amazon Vega OS Fire TV devices.
 *
 * Fetches the hub catalog from GitHub and renders it as a 10-foot-friendly app
 * browser. Apps can't install packages on Vega OS, so installs get handed back
 * to the `fyaisa` CLI in this repository (see apps/README.md).
 */
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Pressable} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';
import {Fyaisa, FyaisaError} from './fyaisaClient';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';

const CATALOG_URL = 'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json';
const HUB_URL = 'https://github.com/AaronYTDev/FYAISA';

/**
 * Row icons: the same artwork the launcher tiles use, bundled with the hub
 * so the list shows them with no network. Catalog ids without an entry here
 * render their row the old way, without an icon.
 */
const APP_ICONS: Record<string, any> = {
  'app.snake.main': require('../assets/image/snake.png'),
  'app.doom.main': require('../assets/image/doom.png'),
  'app.smb.main': require('../assets/image/smb.png'),
  'app.vegatube.main': require('../assets/image/vegatube.png'),
  'app.fyaisa.files.main': require('../assets/image/fileexplorer.png'),
  'app.cinevega.main': require('../assets/image/cinevega.png'),
  'app.fyaisa.hub.main': require('../assets/image/fyaisa.png'),
};

type HubApp = {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  license?: string;
  author?: string;
  homepage?: string;
  /** Repo-relative app directory, e.g. "apps/snake" (the hub itself: "installer"). */
  path?: string;
  /** Optional explicit row-icon URL; otherwise it's derived from `path`. */
  icon?: string;
  /** Version a fresh install would give; compared against the installed one. */
  version?: string;
  minOsVersion?: string;
  architectures?: string[];
  tags?: string[];
  containsAds?: boolean;
  status?: string;
  updated?: string;
  notes?: string[];
};

type Catalog = { hub?: {name?: string; tagline?: string}; apps?: HubApp[] };

/* ---------------------------------------------------------------------------
 * Bridge pairing.
 *
 * This app is a client for the ElevSH bridge (`fyaisa connect`) running on the
 * user's computer: the TV can't install packages, so the PC does it. ElevSH is
 * also where other apps' pairing requests show up to Allow/Deny.
 * ------------------------------------------------------------------------- */
const BRIDGE_PORT = 47821;
const PAIR_POLL_MS = 2000;
/** This app's id, sent as X-FYAISA-App; the bridge treats us as the owner. */
const HUB_APP_ID = 'app.fyaisa.hub.main';
/**
 * Persisted pairing, so the TV doesn't forget its ElevSH host on every restart.
 *
 * Storage notes:
 *  - AsyncStorage is NOT available on Vega OS: installing it succeeds at
 *    build time, but at runtime the JS bridge reports
 *      [AutoLinkService] Library 'RNAsyncStorage' not found in any source
 *    and every call silently no-ops. Use Amazon's KeplerFileSystem
 *    TurboModule instead.
 *  - The app runs sandboxed: its writable, reboot-persistent directory is
 *    /data (per-app, not shared; the KeplerFileSystem README documents the
 *    full sandbox layout: /pkg read-only, /data persistent, /tmp volatile).
 *    It is not the /data that `vega device run-cmd` sees.
 *  - The encoding argument must be 'UTF-8' (uppercase); 'utf-8' makes the
 *    native side throw com.amazon.kepler.io.IoError.
 */
type SavedPair = {host: string; token: string};

const STORE_PATH = '/data/bridge.json';

const savePair = async (p: SavedPair) => {
  try {
    // writeStringToFile fails with AlreadyExistsError if the file is there,
    // so remove first (the pairing file is tiny; atomicity doesn't matter).
    await KeplerFileSystem.removeFile(STORE_PATH).catch(() => {});
    await KeplerFileSystem.writeStringToFile(STORE_PATH, JSON.stringify(p), 'UTF-8');
    console.info(`[FYAISA] pairing saved to ${STORE_PATH}`);
  } catch (e: any) {
    console.error(`[FYAISA] could not save pairing: ${e?.message || e}`);
  }
};

const loadPair = async (): Promise<SavedPair | null> => {
  try {
    if (!(await KeplerFileSystem.exists(STORE_PATH))) {
      return null;
    }
    const raw = await KeplerFileSystem.readFileAsString(STORE_PATH, 'UTF-8');
    const p = JSON.parse(raw);
    if (p && p.host && p.token) {
      console.info(`[FYAISA] pairing restored from ${STORE_PATH}`);
      return p as SavedPair;
    }
    return null;
  } catch (e: any) {
    console.error(`[FYAISA] could not read saved pairing: ${e?.message || e}`);
    return null;
  }
};

const clearPair = async () => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH);
    console.info(`[FYAISA] pairing cleared (${STORE_PATH})`);
  } catch {
    // Missing file is fine; nothing to forget.
  }
};

type PairState = {
  host: string | null;
  token: string | null;
  code: string | null;
  status: 'idle' | 'requesting' | 'awaiting' | 'paired' | 'error';
  message: string;
  job?: {id: string; status: string; log: string[]};
};

const FALLBACK_CATALOG: Catalog = {
  hub: {name: 'FYAISA', tagline: 'Catalog unavailable — showing built-in list'},
  apps: [
    {
      id: 'app.vegatube.main',
      name: 'VegaTube',
      summary: 'Ad-free, sponsor-free YouTube for Vega OS Fire TV Sticks.',
      license: 'GPL-3.0-only',
      tags: ['youtube', 'adblock', 'sponsorblock'],
      status: 'stable',
    },
    {
      id: 'app.fyaisa.files.main',
      name: 'ElevSH Files',
      summary: 'D-pad file explorer for your Fire TV, driven over the ElevSH bridge.',
      license: 'GPL-3.0-only',
      tags: ['files', 'explorer', 'elevsh'],
      status: 'stable',
    },
    {
      id: 'app.snake.main',
      name: 'Google Snake',
      summary: "Google's snake arcade game in a TV app. Needs internet, no account.",
      license: 'GPL-3.0-only',
      tags: ['game', 'snake'],
      status: 'stable',
    },
    {
      id: 'app.doom.main',
      name: 'DOOM (Shareware)',
      summary:
        "id Software's DOOM Episode One, compiled to WebAssembly, running fully offline on your Fire TV.",
      license: 'GPL-3.0-only',
      tags: ['game', 'doom', 'wasm', 'offline'],
      status: 'stable',
    },
  ],
};

// D-pad-friendly keypad for typing a dotted IPv4 address / hostname.
const HOST_KEYS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  '.', '⌫',
];

// The search keyboard: letters, digits and the two punctuation marks worth
// searching with. Backspace/Clear/Done sit in a second row under the grid.
const SEARCH_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-. '.split('');
/** Query length cap — long enough for any app name, short enough to fix typos. */
const SEARCH_MAX = 32;

/**
 * The Power-tools terminal keyboard. These are exactly the characters the
 * bridge's /vega allowlist accepts — no quotes, pipes or globs — so anything
 * you can type here is something ElevSH will actually run. Lowercase only,
 * because commands are case-sensitive and `ls` is what you'll want to type.
 */
const CMD_KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ' ', '.', '/', '_', '-', ':', '=', ',', '@', '+',
];
const CMD_MAX = 80;
/** One-tap starting points for the terminal. */
const CMD_PRESETS = ['ls /data', 'ls -la /data', 'ls /'];

/** Render a /vega result as the text the output panels show. */
const vegaText = (r: any): string => {
  const out = [r?.stdout, r?.stderr]
    .filter((s: any) => typeof s === 'string' && s.trim())
    .join('\n')
    .trim();
  return out || `(no output — exit ${r?.exitCode ?? '?'})`;
};

/** Power-tools screens that hang off the ElevSH screen (Back returns there). */
const TOOL_SCREENS = new Set(['__systemapps__', '__runningapps__', '__terminal__']);

const statusColor = (s?: string) =>
  s === 'stable' ? '#4caf50' : s === 'beta' ? '#ffb300' : '#9e9e9e';

/**
 * Ask ElevSH what it can do: CLI version + how many Fire TVs it sees.
 * This goes through the bridge's /vega endpoint, which runs allowlisted `vega`
 * commands on the PC on our behalf.
 */
const describePc = async (fy: Fyaisa): Promise<string> => {
  try {
    const [ver, devs] = await Promise.all([
      fy.vega(['--version'], 15000),
      fy.vega(['device', 'list'], 25000),
    ]);
    const m = /Vega CLI Version:\s*([\d.]+)/.exec(ver.stdout);
    const n = (devs.stdout.match(/\d+\.\d+\.\d+\.\d+:\d+/g) || []).length;
    return `Vega CLI ${m ? m[1] : 'ok'} · ${n} device${n === 1 ? '' : 's'} connected`;
  } catch (e: any) {
    return `ElevSH reachable, but the Vega CLI failed (${e?.message || e})`;
  }
};

/**
 * Wrap a base style so a Pressable renders the TV focus ring (styles.focused)
 * when D-pad focused. Every focusable in the app goes through this, so focus
 * is actually visible from the couch.
 */
const focusable = (base: any) => ({focused}: {focused: boolean}) =>
  [base, focused && styles.focused];

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Apps menu search: the query string, plus whether the on-screen keyboard is
  // up (a TV has no system keyboard; typing is a grid of keys you D-pad over).
  const [query, setQuery] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [pair, setPair] = useState<PairState>({
    host: null,
    token: null,
    code: null,
    status: 'idle',
    message: 'Not connected',
  });
  /** One-line summary of what the paired PC can do (via /vega). */
  const [pcInfo, setPcInfo] = useState<string | null>(null);
  // ElevSH access screen: apps that asked for access + their decisions.
  const [access, setAccess] = useState<{appId: string; status: string}[] | null>(null);
  const [pairReqs, setPairReqs] = useState<{code: string; appId: string; expiresIn: number}[] | null>(null);
  // What is installed on the stick right now, learned over ElevSH (the bridge
  // runs `vega device installed-apps` on the PC). Empty until the first poll,
  // so everything looks "not installed" for a moment on a cold start.
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  // Installed version per catalog id, read over ElevSH (`vpm info <id>
  // --package`). The catalog's own `version` is what a fresh install would
  // give, so comparing the two is how a row knows it's already current. A
  // missing entry means "unknown" (bridge offline, or not on the device yet),
  // which we treat as "an update might exist".
  const [versions, setVersions] = useState<Record<string, string>>({});
  /** Bumped to force a version re-read (after installs and on a slow timer). */
  const [versionsTick, setVersionsTick] = useState(0);
  /** Update-all progress; null while no update-all run is going on. */
  const [updateAll, setUpdateAll] = useState<{done: number; total: number; current: string} | null>(null);
  // Power tools (ElevSH → poke at the device): the last action's output, the
  // installed/running app lists those screens render, and the terminal's
  // command + result. All of it flows over the same paired bridge.
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [toolOut, setToolOut] = useState<{title: string; text: string; ok: boolean} | null>(null);
  const [sysApps, setSysApps] = useState<string[] | null>(null);
  const [sysRunning, setSysRunning] = useState<Set<string>>(new Set());
  const [runningApps, setRunningApps] = useState<string[] | null>(null);
  /** Reboot is one tap to arm, a second to fire (D-pad slips happen). */
  const [rebootArmed, setRebootArmed] = useState(false);
  const [cmdText, setCmdText] = useState(CMD_PRESETS[0]);
  const [cmdOut, setCmdOut] = useState<string | null>(null);
  const [cmdBusy, setCmdBusy] = useState(false);

  const base = pair.host ? `http://${pair.host}:${BRIDGE_PORT}` : null;

  const apps = useMemo(() => {
    const all = (catalog?.apps ?? []).filter(a => a.id !== 'app.cinevega.main');
    // FYAISA updates last: updating it closes the hub, so anything after it
    // would never get updated by "Update All".
    return [...all].sort((a, b) => {
      if (a.id === 'app.fyaisa.hub.main') return 1;
      if (b.id === 'app.fyaisa.hub.main') return -1;
      return 0;
    });
  }, [catalog]);
  const selected = useMemo(
    () => apps.find(a => a.id === selectedId) ?? null,
    [apps, selectedId],
  );

  // What the Apps menu lists: everything when the search box is empty,
  // otherwise a case-insensitive match over the fields you'd actually type.
  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return apps;
    }
    return apps.filter(
      a =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        (a.summary ?? '').toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (a.tags ?? []).some(t => t.toLowerCase().includes(q)),
    );
  }, [apps, query]);

  /**
   * What a row should offer: install it (not on the device), update it (on the
   * device but a different version than the catalog publishes), or nothing at
   * all — it's already current. When the installed version can't be read we
   * assume an update may exist, so buttons never point users at nothing.
   */
  const appState = useCallback(
    (a: HubApp): 'install' | 'update' | 'current' => {
      if (!installed.has(a.id)) {
        return 'install';
      }
      const v = versions[a.id];
      return v !== undefined && v === a.version ? 'current' : 'update';
    },
    [installed, versions],
  );
  const updatable = useMemo(() => apps.filter(a => appState(a) === 'update'), [apps, appState]);

  // Restore a previous pairing on launch; React state alone is lost on every
  // app restart.
  //
  // Verify the saved token against the bridge: GET /catalog requires
  // X-FYAISA-Token, so a 401 means the bridge regenerated its token (e.g.
  // ~/.fyaisa/bridge.json was deleted) and we must re-pair. A network error
  // just means ElevSH is offline; keep the pairing, it works again when the
  // computer is back on the same network.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadPair();
      if (cancelled) return;
      if (!saved) {
        console.info('[FYAISA] no saved pairing');
        return;
      }
      console.info('[FYAISA] restoring saved pairing');
      setPair(p => ({
        ...p,
        host: saved.host,
        token: saved.token,
        status: 'paired',
        message: 'Connected',
      }));
      try {
        const fy = new Fyaisa(saved.host, saved.token, BRIDGE_PORT, HUB_APP_ID);
        await fy.catalog(); // token validation: 401 => stale pairing
        if (!cancelled) {
          setPcInfo(await describePc(fy));
        }
      } catch (e: any) {
        if (e instanceof FyaisaError && e.status === 401) {
          console.warn('[FYAISA] saved token rejected by bridge — clearing pairing');
          await clearPair();
          if (!cancelled) {
            setPair(p => ({
              ...p,
              token: null,
              status: 'idle',
              message: 'Pairing expired — pair again',
            }));
          }
        } else {
          // ElevSH unreachable right now; stay paired, it may come back when
          // the computer is on the same network again.
          console.info('[FYAISA] bridge unreachable during restore check (ElevSH offline?)');
          if (!cancelled) {
            setPcInfo('ElevSH offline right now');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bridgeFetch = useCallback(
    async (p: string, opts: RequestInit = {}) => {
      if (!base) throw new Error('no bridge host');
      const res = await fetch(`${base}${p}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(pair.token ? {'X-FYAISA-Token': pair.token} : {}),
          'X-FYAISA-App': HUB_APP_ID,
          ...(opts.headers || {}),
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return body;
    },
    [base, pair.token],
  );

  // ElevSH access screen data: pairing requests + allow/deny decisions.
  useEffect(() => {
    if (pair.status !== 'paired') {
      setAccess(null);
      setPairReqs(null);
      return;
    }
    let dead = false;
    const refresh = async () => {
      try {
        const [a, pr] = await Promise.all([bridgeFetch('/access'), bridgeFetch('/pair/pending')]);
        if (!dead) {
          setAccess(a.apps || []);
          setPairReqs(pr.pairings || []);
        }
      } catch {
        // Bridge offline; keep the last snapshot, the status line says so.
      }
    };
    refresh();
    const iv = setInterval(refresh, 6000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [pair.status, bridgeFetch]);

  /**
   * Ask the PC what is installed, through the bridge's allowlisted /vega
   * (`vega device installed-apps`). Polled on a slow timer and refreshed
   * after every install/remove job; the buttons and badges read this.
   */
  const refreshInstalled = useCallback(async () => {
    if (pair.status !== 'paired') {
      return;
    }
    try {
      const r = await bridgeFetch('/vega', {
        method: 'POST',
        body: JSON.stringify({args: ['device', 'installed-apps'], timeoutMs: 30000}),
      });
      const out = String(r.stdout || '').trim();
      if (!r.ok || !out) {
        return; // vda link down; keep the last snapshot
      }
      setInstalled(
        new Set(
          out
            .split('\n')
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0),
        ),
      );
    } catch {
      // Bridge offline; the status strip says so, buttons keep the last state.
    }
  }, [pair.status, bridgeFetch]);

  useEffect(() => {
    if (pair.status !== 'paired') {
      return;
    }
    refreshInstalled();
    const iv = setInterval(refreshInstalled, 30000);
    return () => clearInterval(iv);
  }, [pair.status, refreshInstalled]);

  /**
   * Read the installed version of each installed catalog app, over the bridge
   * (`vega device run-cmd --command 'vpm info <id> --package'`, a command that
   * prints `version: x.y.z` for a package). Batched three at a time, leaving
   * one of the bridge's four slots for the installed-apps poll; a failed read
   * just leaves that app's version unknown.
   */
  const refreshVersions = useCallback(
    async (ids: string[]) => {
      if (pair.status !== 'paired' || !ids.length) {
        return;
      }
      const found: Record<string, string> = {};
      for (let i = 0; i < ids.length; i += 3) {
        const batch = ids.slice(i, i + 3);
        const got = await Promise.all(
          batch.map(async (id): Promise<[string, string | null]> => {
            try {
              const r = await bridgeFetch('/vega', {
                method: 'POST',
                body: JSON.stringify({
                  args: ['device', 'run-cmd', '--command', `vpm info ${id} --package`],
                  timeoutMs: 30000,
                }),
              });
              const m = /^\s*version:\s*(\S+)/m.exec(`${r.stdout || ''}\n${r.stderr || ''}`);
              return [id, m ? m[1] : null];
            } catch {
              return [id, null];
            }
          }),
        );
        for (const [id, v] of got) {
          if (v) {
            found[id] = v;
          }
        }
      }
      setVersions(prev => {
        const next = {...prev};
        for (const id of ids) {
          delete next[id]; // a version we couldn't read is "unknown", not old
        }
        return {...next, ...found};
      });
    },
    [pair.status, bridgeFetch],
  );

  // Catalog apps currently on the device, as one stable key: whenever that set
  // (or the catalog) changes, re-read the versions behind it.
  const installedKey = useMemo(
    () => apps.filter(a => installed.has(a.id)).map(a => a.id).join(','),
    [apps, installed],
  );
  useEffect(() => {
    if (pair.status !== 'paired' || !installedKey) {
      setVersions({});
      return;
    }
    refreshVersions(installedKey.split(','));
    // versionsTick is a deliberate trigger: it re-reads after an install, and a
    // slow timer catches updates made outside the hub.
  }, [installedKey, versionsTick, pair.status, refreshVersions]);

  useEffect(() => {
    const iv = setInterval(() => setVersionsTick(t => t + 1), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  /** Ask the bridge for a code, then poll until the user approves it on the PC. */
  const startPairing = useCallback(async () => {
    if (!base) {
      setPair(p => ({...p, status: 'error', message: 'Enter your computer’s address first'}));
      return;
    }
    try {
      setPair(p => ({...p, status: 'requesting', message: 'Requesting code…'}));
      // Reachability check: GET /ping, which is tokenless. /catalog would 401
      // here since no valid token exists yet, so pairing could never start.
      // /pair/request and /pair/approve are tokenless too, and /pair/approve
      // hands back the bridge's current token, so a stale token heals itself.
      try {
        const res = await fetch(`${base}/ping`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (e: any) {
        setPair(p => ({
          ...p,
          status: 'error',
          message: `ElevSH unreachable at ${base} (${e?.message || e}). Start \`fyaisa connect --lan\` on the PC.`,
        }));
        return;
      }
      const {code} = await bridgeFetch('/pair/request', {method: 'POST'});
      setPair(p => ({...p, code, status: 'awaiting', message: `On the PC: fyaisa approve ${code}`}));
      // Poll for approval; the bridge approves once the user types the code.
      const iv = setInterval(async () => {
        try {
          const st = await bridgeFetch(`/pair/status?code=${code}`);
          if (st.approved) {
            clearInterval(iv);
            const ok = await bridgeFetch('/pair/approve', {
              method: 'POST',
              body: JSON.stringify({code, device: 'fyaisa-app'}),
            });
            setPair(p => {
              // Persist from inside the updater so we read the latest host
              // rather than a stale closure value.
              if (p.host) {
                savePair({host: p.host, token: ok.token});
              }
              return {
                ...p,
                token: ok.token,
                status: 'paired',
                message: 'Connected',
              };
            });
            console.info('[FYAISA] paired with bridge');
            if (pair.host) {
              setPcInfo(await describePc(new Fyaisa(pair.host, ok.token, BRIDGE_PORT, HUB_APP_ID)));
            }
          }
        } catch (e: any) {
          clearInterval(iv);
          setPair(p => ({...p, status: 'error', message: e.message}));
        }
      }, PAIR_POLL_MS);
    } catch (e: any) {
      setPair(p => ({...p, status: 'error', message: e.message}));
    }
  }, [base, bridgeFetch]);

  /**
   * Queue a build+install over ElevSH and poll the job.
   */
  const requestInstall = useCallback(
    async (appId: string) => {
      try {
        const {jobId} = await bridgeFetch('/install', {
          method: 'POST',
          body: JSON.stringify({appId}),
        });
        setPair(p => ({
          ...p,
          job: {id: jobId, status: 'queued', log: []},
          message: `Installing ${appId}…`,
        }));
        const iv = setInterval(async () => {
          try {
            const job = await bridgeFetch(`/job?id=${jobId}`);
            setPair(p => ({...p, job}));
            if (['done', 'error'].includes(job.status)) {
              clearInterval(iv);
              if (job.status === 'done') {
                refreshInstalled();
                setVersionsTick(t => t + 1);
              }
            }
          } catch (e: any) {
            clearInterval(iv);
            setPair(p => ({...p, status: 'error', message: e.message}));
          }
        }, PAIR_POLL_MS);
      } catch (e: any) {
        setPair(p => ({...p, status: 'error', message: e.message}));
      }
    },
    [bridgeFetch, refreshInstalled],
  );

  /**
   * Rebuild and reinstall every installed app, one bridge job at a time.
   * Update = install (reinstalls the latest version from the catalog).
   */
  const runUpdateAll = useCallback(async () => {
    if (pair.status !== 'paired') {
      setPair(p => ({
        ...p,
        status: 'error',
        message: 'Not paired with ElevSH — set it up in FYAISA → ElevSH first',
      }));
      return;
    }
    if (updateAll || !updatable.length) {
      return;
    }
    setUpdateAll({done: 0, total: updatable.length, current: ''});
    try {
      for (let i = 0; i < updatable.length; i++) {
        const a = updatable[i];
        setUpdateAll({done: i, total: updatable.length, current: a.name});
        const {jobId} = await bridgeFetch('/install', {
          method: 'POST',
          body: JSON.stringify({appId: a.id}),
        });
        setPair(p => ({
          ...p,
          job: {id: jobId, status: 'queued', log: []},
          message: `Updating ${a.name}…`,
        }));
        for (;;) {
          await new Promise<void>(r => setTimeout(r, PAIR_POLL_MS));
          const job = await bridgeFetch(`/job?id=${jobId}`);
          setPair(p => ({...p, job}));
          if (job.status === 'done') {
            break;
          }
          if (job.status === 'error') {
            setPair(p => ({
              ...p,
              status: 'error',
              message: `Update failed for ${a.name} (continuing with the rest)`,
            }));
            break;
          }
        }
      }
      setUpdateAll({done: updatable.length, total: updatable.length, current: ''});
    } catch (e: any) {
      setPair(p => ({...p, status: 'error', message: e.message}));
    } finally {
      setTimeout(() => setUpdateAll(null), 4000);
      refreshInstalled();
      setVersionsTick(t => t + 1);
    }
  }, [pair.status, updatable, bridgeFetch, refreshInstalled, updateAll]);

  /** Allow / deny / revoke an app's ElevSH access from the TV. */
  const decideAccess = useCallback(
    async (appId: string, decision: 'allow' | 'deny' | 'revoke') => {
      try {
        await bridgeFetch('/access', {
          method: 'POST',
          body: JSON.stringify({appId, decision}),
        });
        console.info(`[FYAISA] ElevSH access ${decision}: ${appId}`);
      } catch (e: any) {
        console.error(`[FYAISA] access update failed: ${e.message}`);
      }
    },
    [bridgeFetch],
  );

  /** Approve an app's pending pairing (this also allows its access). */
  const approvePairing = useCallback(
    async (code: string) => {
      try {
        await bridgeFetch('/pair/approve', {
          method: 'POST',
          body: JSON.stringify({code, device: 'fyaisa-app'}),
        });
        console.info('[FYAISA] ElevSH pairing approved from the TV');
      } catch (e: any) {
        console.error(`[FYAISA] approve failed: ${e.message}`);
      }
    },
    [bridgeFetch],
  );

  // ---- Power tools: run allowlisted `vega` commands over ElevSH -------------

  /** Run one allowlisted `vega` command through the bridge. */
  const runVega = useCallback(
    (args: string[], timeoutMs: number = 30000) =>
      bridgeFetch('/vega', {method: 'POST', body: JSON.stringify({args, timeoutMs})}),
    [bridgeFetch],
  );

  /** Device info: dump the JSON the CLI prints into the output panel. */
  const showDeviceInfo = useCallback(async () => {
    setToolBusy('Reading device info…');
    try {
      const r = await runVega(['device', 'info']);
      setToolOut({title: 'Device info', text: vegaText(r), ok: !!r.ok});
    } catch (e: any) {
      setToolOut({title: 'Device info', text: e?.message || String(e), ok: false});
    } finally {
      setToolBusy(null);
    }
  }, [runVega]);

  /** Reboot: arm on the first tap, fire on the second. */
  const rebootDevice = useCallback(async () => {
    if (!rebootArmed) {
      setRebootArmed(true);
      setToolOut({
        title: 'Reboot',
        text: 'Tap “Reboot Fire TV” once more to confirm. The stick drops off for a minute or so.',
        ok: true,
      });
      return;
    }
    setRebootArmed(false);
    setToolBusy('Rebooting…');
    try {
      const r = await runVega(['device', 'reboot'], 20000);
      setToolOut({title: 'Reboot', text: vegaText(r), ok: !!r.ok});
    } catch (e: any) {
      // A reboot usually kills the link before `vega` can answer; that's a win.
      setToolOut({
        title: 'Reboot',
        text: `Sent. The Fire TV is restarting (${e?.message || e}).`,
        ok: true,
      });
    } finally {
      setToolBusy(null);
    }
  }, [rebootArmed, runVega]);

  /** List every installed app, plus which of them are running right now. */
  const loadSystemApps = useCallback(async () => {
    setSysApps(null);
    setSysRunning(new Set());
    setToolBusy('Reading installed apps…');
    try {
      const [inst, run] = await Promise.all([
        runVega(['device', 'installed-apps']),
        runVega(['device', 'running-apps']).catch(() => null),
      ]);
      const ids = (s: string) =>
        String(s || '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .sort();
      setSysApps(ids(inst.stdout));
      if (run) setSysRunning(new Set(ids(run.stdout)));
    } catch (e: any) {
      setSysApps([]);
      setToolOut({title: 'Installed apps', text: e?.message || String(e), ok: false});
    } finally {
      setToolBusy(null);
    }
  }, [runVega]);

  const launchApp = useCallback(
    async (appId: string) => {
      setToolBusy(`Opening ${appId}…`);
      try {
        const r = await runVega(['device', 'launch-app', '--appName', appId]);
        setToolOut({title: `Open ${appId}`, text: vegaText(r), ok: !!r.ok});
        if (r.ok) setSysRunning(prev => new Set(prev).add(appId));
      } catch (e: any) {
        setToolOut({title: `Open ${appId}`, text: e?.message || String(e), ok: false});
      } finally {
        setToolBusy(null);
      }
    },
    [runVega],
  );

  const loadRunningApps = useCallback(async () => {
    setRunningApps(null);
    setToolBusy('Reading running apps…');
    try {
      const r = await runVega(['device', 'running-apps']);
      setRunningApps(
        String(r.stdout || '')
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
          .sort(),
      );
    } catch (e: any) {
      setRunningApps([]);
      setToolOut({title: 'Running apps', text: e?.message || String(e), ok: false});
    } finally {
      setToolBusy(null);
    }
  }, [runVega]);

  const terminateApp = useCallback(
    async (appId: string) => {
      setToolBusy(`Stopping ${appId}…`);
      try {
        const r = await runVega(['device', 'terminate-app', '--appName', appId]);
        setToolOut({title: `Stop ${appId}`, text: vegaText(r), ok: !!r.ok});
        if (r.ok) setRunningApps(prev => (prev ? prev.filter(a => a !== appId) : prev));
      } catch (e: any) {
        setToolOut({title: `Stop ${appId}`, text: e?.message || String(e), ok: false});
      } finally {
        setToolBusy(null);
      }
    },
    [runVega],
  );

  /** Terminal: one `vega device run-cmd` with the typed command. */
  const runTerminal = useCallback(async () => {
    const cmd = cmdText.trim();
    if (!cmd) return;
    setCmdBusy(true);
    setCmdOut(null);
    try {
      const r = await runVega(['device', 'run-cmd', '--command', cmd]);
      setCmdOut(vegaText(r));
    } catch (e: any) {
      setCmdOut(e?.message || String(e));
    } finally {
      setCmdBusy(false);
    }
  }, [cmdText, runVega]);

  // Load a Power-tools list when its screen opens (each fetch is over ElevSH).
  useEffect(() => {
    if (selectedId === '__systemapps__') loadSystemApps();
    else if (selectedId === '__runningapps__') loadRunningApps();
    else if (selectedId === '__terminal__') setCmdOut(null);
  }, [selectedId, loadSystemApps, loadRunningApps]);

  // The splash screen is dismissed exactly once, by the first fetch; loadCatalog
  // is also re-run by the manual Refresh button and must not touch it again.
  const splashHiddenRef = useRef(false);

  const loadCatalog = useCallback(
    async (quiet = false) => {
      // A quiet pass is the background one: no spinner, and a failed fetch
      // keeps whatever we're showing instead of dropping to the built-in list.
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(CATALOG_URL, {signal: controller.signal});
        clearTimeout(timer);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as Catalog;
        if (!data || !Array.isArray(data.apps)) {
          throw new Error('malformed catalog');
        }
        setCatalog(data);
        setError(null);
        console.info(`[FYAISA] catalog loaded: ${data.apps.length} app(s)`);
      } catch (e: any) {
        const msg = (e && e.message) || String(e);
        console.error(`[FYAISA] catalog fetch failed: ${msg}`);
        if (!quiet) {
          setError(msg);
          setCatalog(FALLBACK_CATALOG);
        }
      } finally {
        if (!quiet) {
          setLoading(false);
        }
        if (!splashHiddenRef.current) {
          splashHiddenRef.current = true;
          hideSplashScreenCallback();
        }
      }
    },
    [hideSplashScreenCallback],
  );

  useEffect(() => {
    loadCatalog();
    // Re-read the catalog on its own so apps added to (or removed from) the
    // repo show up here without a hub update or a manual Refresh.
    const iv = setInterval(() => loadCatalog(true), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [loadCatalog]);

  // Remote navigation is handled natively: Pressable rows take D-pad focus
  // (the first row seeded with hasTVPreferredFocus), and Back is caught through
  // BackHandler. document/window don't exist here; this is a native React
  // Native for Vega app, not a WebView (touching them crashes with
  // "ReferenceError: Property 'document' doesn't exist").
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (keyboardOpen) {
        setKeyboardOpen(false); // close the keyboard first, keep the screen under it
        return true;
      }
      if (selectedId === null) return false; // main menu → let the OS close us
      if (TOOL_SCREENS.has(selectedId)) {
        setSelectedId('__connect__'); // a Power-tools screen → back to ElevSH
      } else if (selectedId.startsWith('__')) {
        setSelectedId(null); // any submenu → main menu
      } else {
        setSelectedId('__apps__'); // app detail → the Apps list
      }
      return true;
    });
    return () => sub.remove();
  }, [selectedId, keyboardOpen]);

  // Main menu: submenus (Apps / ElevSH) hang off this screen.
  if (selectedId === null) {
    const submenus = [
      {
        id: '__apps__',
        title: 'Apps',
        summary: `Browse the catalog — ${apps.length} app${apps.length === 1 ? '' : 's'}${loading ? ' (loading…)' : ''}`,
      },
      {
        id: '__connect__',
        title: 'ElevSH',
        summary:
          pair.status === 'paired'
            ? `Connected to ${pair.host} — pairing, access & installs`
            : `Pair this TV with your PC — ${pair.message}`,
      },
    ];
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>{catalog?.hub?.name ?? 'FYAISA'}</Text>
          {catalog?.hub?.tagline ? <Text style={styles.tagline}>{catalog.hub.tagline}</Text> : null}
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {submenus.map((m, i) => (
            <Pressable
              key={m.id}
              hasTVPreferredFocus={i === 0}
              focusable
              style={({focused}) => [styles.row, focused && styles.rowFocused, focused && styles.focused]}
              onPress={() => setSelectedId(m.id)}>
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle}>{m.title}</Text>
                <Text style={styles.rowSummary} numberOfLines={2}>
                  {m.summary}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  // Connect screen.
  if (selectedId === '__connect__') {
    return (
      <View style={styles.wrap}>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.brand}>ElevSH</Text>
          <Text style={styles.tagline}>
            ElevSH pairs this Fire TV with your computer. Pair once here, then
            allow apps from this screen — they connect automatically.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 1 — on your computer</Text>
            <Text style={styles.code}>fyaisa connect --lan</Text>
            <Text style={styles.howtoBody}>
              Leave that window open. It prints a 6-digit pairing code.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 2 — computer address</Text>
            <Text style={styles.howtoBody}>
              Find it under Fire TV → Developer options, or type it below.
            </Text>
            <Text style={styles.code}>
              {pair.host ? `http://${pair.host}:${BRIDGE_PORT}` : 'not set'}
            </Text>

            <View style={styles.keypad}>
              {HOST_KEYS.map((k, i) => (
                <Pressable
                  key={i}
                  style={({focused}) => [styles.key, focused && styles.keyFocused, focused && styles.focused]}
                  onPress={() => {
                    if (k === '⌫') {
                      setPair(p => ({...p, host: (p.host || '').slice(0, -1)}));
                    } else {
                      setPair(p => ({...p, host: (p.host || '') + k}));
                    }
                  }}>
                  <Text style={styles.keyText}>{k}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 3 — pair</Text>
            <Text style={styles.statusLine}>
              Status: {pair.status} — {pair.message}
            </Text>
            {pcInfo ? <Text style={styles.pcInfo}>{pcInfo}</Text> : null}
            {pair.code ? <Text style={styles.code}>Code: {pair.code}</Text> : null}
            <Pressable
              hasTVPreferredFocus
              style={focusable(styles.installBtn)}
              onPress={startPairing}>
              <Text style={styles.backText}>
                {pair.status === 'paired' ? 'Re-pair' : 'Get pairing code'}
              </Text>
            </Pressable>

            {pair.status === 'paired' ? (
              <Pressable
                style={focusable(styles.forgetBtn)}
                onPress={() => {
                  clearPair();
                  setPcInfo(null);
                  setPair(p => ({...p, token: null, code: null, status: 'idle', message: 'Pairing forgotten'}));
                  console.info('[FYAISA] pairing cleared');
                }}>
                <Text style={styles.forgetText}>Forget ElevSH pairing</Text>
              </Pressable>
            ) : null}
          </View>

          {pair.status === 'paired' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>ElevSH access</Text>
              <Text style={styles.howtoBody}>
                Apps that asked to reach your computer through ElevSH. Allow lets
                them pair automatically from this Fire TV; Deny blocks them.
              </Text>

              {(pairReqs || []).map(r => (
                <View key={r.code} style={styles.accessRow}>
                  <View style={styles.accessMain}>
                    <Text style={styles.accessApp}>{r.appId}</Text>
                    <Text style={styles.accessMeta}>
                      wants to pair · code {r.code} · {r.expiresIn}s left
                    </Text>
                  </View>
                  <Pressable
                    style={focusable(styles.allowBtn)}
                    onPress={() => approvePairing(r.code)}>
                    <Text style={styles.accessBtnText}>Allow</Text>
                  </Pressable>
                </View>
              ))}

              {(access || [])
                .filter(
                  a =>
                    !(
                      a.status === 'pending' &&
                      (pairReqs || []).some(r => r.appId === a.appId)
                    ),
                )
                .map(a => (
                  <View key={a.appId} style={styles.accessRow}>
                    <View style={styles.accessMain}>
                      <Text style={styles.accessApp}>{a.appId}</Text>
                      <Text
                        style={[
                          styles.accessMeta,
                          a.status === 'allow' && {color: '#7ee787'},
                          a.status === 'deny' && {color: '#e57373'},
                        ]}>
                        {a.status === 'allow'
                          ? 'allowed — pairs automatically'
                          : a.status === 'deny'
                            ? 'denied'
                            : 'waiting for a decision'}
                      </Text>
                    </View>
                    {a.status === 'allow' ? (
                      <Pressable
                        style={focusable(styles.denyBtn)}
                        onPress={() => decideAccess(a.appId, 'deny')}>
                        <Text style={styles.accessBtnText}>Deny</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        style={focusable(styles.allowBtn)}
                        onPress={() => decideAccess(a.appId, 'allow')}>
                        <Text style={styles.accessBtnText}>Allow</Text>
                      </Pressable>
                    )}
                    {a.status !== 'allow' ? (
                      <Pressable
                        style={focusable(styles.denyBtn)}
                        onPress={() => decideAccess(a.appId, 'deny')}>
                        <Text style={styles.accessBtnText}>Deny</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}

              {!(pairReqs || []).length && !(access || []).length ? (
                <Text style={styles.dim}>No apps have asked for ElevSH access yet.</Text>
              ) : null}
            </View>
          ) : null}

          {pair.status === 'paired' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Power tools</Text>
              <Text style={styles.howtoBody}>
                Poke at the Fire TV over ElevSH: open hidden and system apps, see
                what's running, run a command on the stick, or reboot it. These
                ride the same paired link as installs.
              </Text>

              <ToolRow
                title="Open any app"
                summary={`Everything installed${
                  sysApps ? ` (${sysApps.length})` : ''
                } — system and hidden apps included`}
                action="Open"
                onPress={() => setSelectedId('__systemapps__')}
              />
              <ToolRow
                title="Running apps"
                summary="See what's live right now, and stop an app"
                action="Open"
                onPress={() => setSelectedId('__runningapps__')}
              />
              <ToolRow
                title="Run a command"
                summary="A tiny terminal — `vega device run-cmd` on the stick"
                action="Open"
                onPress={() => setSelectedId('__terminal__')}
              />
              <ToolRow
                title="Device info"
                summary="Model, OS build, hostname, developer mode"
                action="Run"
                onPress={showDeviceInfo}
              />
              <ToolRow
                title={rebootArmed ? 'Reboot Fire TV — tap again to confirm' : 'Reboot Fire TV'}
                summary="Restart the stick; it drops off for a minute or so"
                action="Reboot"
                danger
                onPress={rebootDevice}
              />

              {toolBusy ? <Text style={styles.pcInfo}>{toolBusy}</Text> : null}
              {toolOut ? (
                <View style={styles.toolOut}>
                  <Text style={styles.toolOutTitle}>
                    {toolOut.title}
                    {toolOut.ok ? '' : ' — failed'}
                  </Text>
                  <Text style={styles.toolOutText} numberOfLines={12}>
                    {toolOut.text}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <Pressable hasTVPreferredFocus style={focusable(styles.backBtn)} onPress={() => setSelectedId(null)}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Power tools → "Open any app": every installed component, system and
  // hidden ones included (that's the whole point — the launcher hides them).
  if (selectedId === '__systemapps__') {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>Open any app</Text>
          <Text style={styles.tagline}>
            Everything installed on this Fire TV, straight from ElevSH. Most of
            these are background services and will refuse to start — the ones
            that open are the hidden apps.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {toolBusy ? <Text style={styles.pcInfo}>{toolBusy}</Text> : null}
          {sysApps == null ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : sysApps.length === 0 ? (
            <Text style={styles.dim}>Nothing to show.</Text>
          ) : (
            sysApps.map((id, i) => (
              <Pressable
                key={id}
                hasTVPreferredFocus={i === 0}
                focusable
                style={({focused}) => [
                  styles.toolRow,
                  focused && styles.rowFocused,
                  focused && styles.focused,
                ]}
                onPress={() => launchApp(id)}>
                <View style={styles.toolMain}>
                  <Text style={styles.toolTitle}>{id}</Text>
                  <Text style={styles.toolSummary}>
                    {APP_ICONS[id] ? 'FYAISA app' : 'system / hidden'}
                    {sysRunning.has(id) ? ' · running' : ''}
                  </Text>
                </View>
                <Text style={styles.toolOpen}>Open ›</Text>
              </Pressable>
            ))
          )}
          {toolOut ? (
            <View style={styles.toolOut}>
              <Text style={styles.toolOutTitle}>
                {toolOut.title}
                {toolOut.ok ? '' : ' — failed'}
              </Text>
              <Text style={styles.toolOutText} numberOfLines={8}>
                {toolOut.text}
              </Text>
            </View>
          ) : null}
          <Pressable style={focusable(styles.backBtn)} onPress={() => setSelectedId('__connect__')}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Power tools → "Running apps": what's live, with tap-to-stop.
  if (selectedId === '__runningapps__') {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>Running apps</Text>
          <Text style={styles.tagline}>Live on the stick right now. Select one to stop it.</Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {toolBusy ? <Text style={styles.pcInfo}>{toolBusy}</Text> : null}
          {runningApps == null ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : runningApps.length === 0 ? (
            <Text style={styles.dim}>Nothing is running.</Text>
          ) : (
            runningApps.map((id, i) => (
              <Pressable
                key={id}
                hasTVPreferredFocus={i === 0}
                focusable
                style={({focused}) => [
                  styles.toolRow,
                  focused && styles.rowFocused,
                  focused && styles.focused,
                ]}
                onPress={() => terminateApp(id)}>
                <View style={styles.toolMain}>
                  <Text style={styles.toolTitle}>{id}</Text>
                </View>
                <Text style={styles.toolOpen}>Stop</Text>
              </Pressable>
            ))
          )}
          {toolOut ? (
            <View style={styles.toolOut}>
              <Text style={styles.toolOutTitle}>
                {toolOut.title}
                {toolOut.ok ? '' : ' — failed'}
              </Text>
              <Text style={styles.toolOutText} numberOfLines={6}>
                {toolOut.text}
              </Text>
            </View>
          ) : null}
          <Pressable style={focusable(styles.backBtn)} onPress={() => setSelectedId('__connect__')}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Power tools → "Run a command": D-pad terminal for `vega device run-cmd`.
  if (selectedId === '__terminal__') {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>Run a command</Text>
          <Text style={styles.tagline}>
            Runs as `vega device run-cmd` over ElevSH. Letters, digits and the
            punctuation on the keypad only — no quotes, pipes or globs.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.code}>{cmdText || ' '}</Text>

          <View style={styles.keypad}>
            {CMD_PRESETS.map(p => (
              <Pressable
                key={p}
                focusable
                style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused, focused && styles.focused]}
                onPress={() => setCmdText(p)}>
                <Text style={styles.ctrlKeyText}>{p}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.keypad}>
            {CMD_KEYS.map((k, i) => (
              <Pressable
                key={`${k}-${i}`}
                hasTVPreferredFocus={i === 0}
                focusable
                style={({focused}) => [styles.key, focused && styles.keyFocused]}
                onPress={() => setCmdText(c => (c.length >= CMD_MAX ? c : c + k))}>
                <Text style={styles.keyText}>{k === ' ' ? '␣' : k}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.keypad}>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused]}
              onPress={() => setCmdText(c => c.slice(0, -1))}>
              <Text style={styles.ctrlKeyText}>⌫ Delete</Text>
            </Pressable>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused]}
              onPress={() => setCmdText('')}>
              <Text style={styles.ctrlKeyText}>Clear</Text>
            </Pressable>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused, focused && styles.focused]}
              onPress={runTerminal}>
              <Text style={styles.ctrlKeyText}>{cmdBusy ? 'Running…' : '▶ Run'}</Text>
            </Pressable>
          </View>

          {cmdOut != null ? (
            <View style={styles.toolOut}>
              <Text style={styles.toolOutTitle}>{cmdText}</Text>
              <Text style={styles.toolOutText} numberOfLines={16}>
                {cmdOut}
              </Text>
            </View>
          ) : null}

          <Pressable style={focusable(styles.backBtn)} onPress={() => setSelectedId('__connect__')}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Detail view.
  if (selected) {
    return (
      <View style={styles.detailWrap}>
        <ScrollView contentContainerStyle={styles.detail}>
          <AppIcon app={selected} style={styles.detailIcon} />
          <Text style={styles.detailTitle}>{selected.name}</Text>
          <Text style={styles.detailId}>{selected.id}</Text>
          {selected.summary ? (
            <Text style={styles.detailSummary}>{selected.summary}</Text>
          ) : null}
          {selected.description ? (
            <Text style={styles.detailBody}>{selected.description}</Text>
          ) : null}

          <View style={styles.badges}>
            {selected.status ? (
              <Badge label={selected.status} color={statusColor(selected.status)} />
            ) : null}
            {installed.has(selected.id) ? <Badge label="installed" color="#4caf50" /> : null}
            {selected.license ? <Badge label={selected.license} color="#64b5f6" /> : null}
            {selected.containsAds === false ? <Badge label="no ads" color="#4caf50" /> : null}
            {selected.minOsVersion ? (
              <Badge label={`OS ${selected.minOsVersion}+`} color="#b39ddb" />
            ) : null}
          </View>

          {selected.tags?.length ? (
            <Text style={styles.meta}>Tags: {selected.tags.join(', ')}</Text>
          ) : null}
          {selected.architectures?.length ? (
            <Text style={styles.meta}>Architectures: {selected.architectures.join(', ')}</Text>
          ) : null}
          {selected.author ? (
            <Text style={styles.meta}>Author: {selected.author}</Text>
          ) : null}
          {selected.version ? (
            <Text style={styles.meta}>
              Version: {selected.version}
              {installed.has(selected.id) && versions[selected.id]
                ? ` (installed ${versions[selected.id]})`
                : ''}
            </Text>
          ) : null}
          {selected.updated ? <Text style={styles.meta}>Updated: {selected.updated}</Text> : null}

          {selected.notes?.length ? (
            <View style={styles.notes}>
              {selected.notes.map((n, i) => (
                      <Text key={i} style={styles.note}>
                  • {n}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={styles.howto}>
            <Text style={styles.howtoTitle}>How to install</Text>
            <Text style={styles.howtoBody}>
              Vega OS apps cannot install packages themselves. Either run this on
              the computer connected to your Fire TV:
            </Text>
            <Text style={styles.code}>fyaisa install {selected.id}</Text>
            {pair.status === 'paired' && pair.host ? (
              <>
                <Text style={styles.howtoBody}>
                  …or install from right here over ElevSH ({pair.host}):
                </Text>
                {appState(selected) === 'current' ? (
                  <Text style={styles.upToDate}>
                    Installed and up to date — nothing to update.
                  </Text>
                ) : (
                  <Pressable
                    hasTVPreferredFocus
                    style={focusable(styles.installBtn)}
                    onPress={() => requestInstall(selected.id)}>
                    <Text style={styles.backText}>
                      {appState(selected) === 'update' ? 'Update' : 'Install'} via ElevSH ({pair.host})
                    </Text>
                  </Pressable>
                )}
                {pair.job ? (
                  <View style={styles.job}>
                    <Text style={styles.jobStatus}>
                      Job {pair.job.status}
                    </Text>
                    {pair.job.log.slice(-4).map((l, i) => (
                      <Text key={i} style={styles.jobLine} numberOfLines={2}>
                        {l}
                      </Text>
                    ))}
                  </View>
                ) : null}
                
              </>
            ) : (
              <>
                <Text style={styles.howtoBody}>
                  Set up ElevSH (FYAISA → ElevSH) to install from the couch.
                </Text>
                {installed.has(selected.id) ? (
                  <Text style={styles.code}>fyaisa uninstall {selected.id}</Text>
                ) : null}
              </>
            )}
            <Text style={styles.howtoBody}>Hub: {HUB_URL}</Text>
          </View>

          <Pressable hasTVPreferredFocus style={focusable(styles.backBtn)} onPress={() => setSelectedId('__apps__')}>
            <Text style={styles.backText}>Back to catalog</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Search keyboard, shown instead of the list while it's open (Back closes
  // it again — see the BackHandler above).
  if (selectedId === '__apps__' && keyboardOpen) {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>Search apps</Text>
          <Text style={styles.searchQuery}>{query || ' '}</Text>
          <Text style={styles.searchCount}>
            {filteredApps.length} of {apps.length} app{apps.length === 1 ? '' : 's'} match
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.keypad}>
            {SEARCH_KEYS.map((k, i) => (
              <Pressable
                key={k}
                hasTVPreferredFocus={i === 0}
                focusable
                style={({focused}) => [styles.key, focused && styles.keyFocused]}
                onPress={() => setQuery(q => (q.length >= SEARCH_MAX ? q : q + k))}>
                <Text style={styles.keyText}>{k === ' ' ? '␣' : k}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.keypad}>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused]}
              onPress={() => setQuery(q => q.slice(0, -1))}>
              <Text style={styles.ctrlKeyText}>⌫ Delete</Text>
            </Pressable>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused]}
              onPress={() => setQuery('')}>
              <Text style={styles.ctrlKeyText}>Clear</Text>
            </Pressable>
            <Pressable
              focusable
              style={({focused}) => [styles.ctrlKey, focused && styles.keyFocused]}
              onPress={() => setKeyboardOpen(false)}>
              <Text style={styles.ctrlKeyText}>Done</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // Apps submenu (fall-through: every other view returns above). Search and
  // Refresh live in a toolbar pinned above the list, not inside it: nothing
  // scrolls them out of view and the loading spinner doesn't swap them out,
  // so they're on screen whenever the Apps menu is.
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.brand}>{catalog?.hub?.name ?? 'FYAISA'}</Text>
        {catalog?.hub?.tagline ? <Text style={styles.tagline}>{catalog.hub.tagline}</Text> : null}
      </View>

      <View style={styles.toolbar}>
        <Pressable
          focusable
          style={({focused}) => [styles.searchBox, focused && styles.focused]}
          onPress={() => setKeyboardOpen(true)}>
          <Text style={[styles.searchText, !query && styles.searchPlaceholder]} numberOfLines={1}>
            {query ? `"${query}"` : 'Search apps'}
          </Text>
        </Pressable>
        {/* Update all: only shows when something actually needs it, and only
            rebuilds those apps — the same bridge jobs the per-row buttons
            queue, one at a time. */}
        {updatable.length > 0 || updateAll ? (
          <Pressable
            focusable
            style={({focused}) => [styles.updateAllBtn, focused && styles.focused]}
            onPress={runUpdateAll}>
            <Text style={styles.refreshText}>
              {updateAll
                ? `Updating ${updateAll.done}/${updateAll.total}…`
                : `Update all (${updatable.length})`}
            </Text>
          </Pressable>
        ) : null}
        {/* Refresh: re-runs the exact fetch the app does on launch (the live
            catalog from the repo, same source `fyaisa` prints on the PC),
            falling back to the built-in list if GitHub is unreachable. */}
        <Pressable
          focusable
          style={({focused}) => [styles.refreshBtn, focused && styles.focused]}
          onPress={() => loadCatalog()}>
          <Text style={styles.refreshText}>{loading ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {/* Job/progress strip: what an install, update-all or remove is doing
          right now, plus bridge errors that have nowhere else to surface. */}
      {updateAll ? (
        <Text style={styles.jobStrip}>
          {updateAll.current
            ? `Updating ${updateAll.current} (${updateAll.done + 1} of ${updateAll.total})`
            : `Update all: ${updateAll.done} of ${updateAll.total} done`}
        </Text>
      ) : pair.job &&
        ['queued', 'building', 'installing'].includes(pair.job.status) ? (
        <Text style={styles.jobStrip}>
          {pair.job.status}: {pair.job.log.slice(-1)[0] ?? ''}
        </Text>
      ) : pair.status === 'error' && pair.message ? (
        <Text style={styles.jobStripWarn}>{pair.message}</Text>
      ) : null}

      {catalog == null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.dim}>Loading catalog…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {error ? (
            <Text style={styles.warn}>
              Could not reach GitHub ({error}). Showing the built-in list.
            </Text>
          ) : null}
          {loading ? <Text style={styles.dim}>Refreshing catalog…</Text> : null}

          {apps.length === 0 ? (
            <Text style={styles.dim}>No apps in the catalog yet.</Text>
          ) : filteredApps.length === 0 ? (
            <View>
              <Text style={styles.dim}>No apps match "{query}".</Text>
              <Pressable
                focusable
                style={({focused}) => [styles.refreshBtn, focused && styles.focused]}
                onPress={() => setQuery('')}>
                <Text style={styles.refreshText}>Clear search</Text>
              </Pressable>
            </View>
          ) : null}

          {filteredApps.map((a, i) => {
            const state = appState(a);
            return (
              <View key={a.id} style={styles.rowCard}>
                <Pressable
                  hasTVPreferredFocus={i === 0}
                  focusable
                  style={({focused}) => [styles.rowBody, focused && styles.rowFocused, focused && styles.focused]}
                  onPress={() => setSelectedId(a.id)}>
                  <AppIcon app={a} style={styles.rowIcon} />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>{a.name}</Text>
                    <Text style={styles.rowId}>{a.id}</Text>
                    {a.summary ? (
                      <Text style={styles.rowSummary} numberOfLines={2}>
                        {a.summary}
                      </Text>
                    ) : null}
                  </View>
                  <View style={[styles.dot, {backgroundColor: statusColor(a.status)}]} />
                </Pressable>
                {/* Sibling of the row body, not a child: a nested focusable
                    inside the row Pressable confuses D-pad focus. A current
                    app gets a plain label, not a button — there's nothing to
                    update, so it shouldn't take a D-pad step. */}
                {state === 'current' ? (
                  <View style={[styles.rowActionBtn, styles.rowActionCurrent]}>
                    <Text style={[styles.rowActionText, styles.rowActionMutedText]}>Up to date</Text>
                  </View>
                ) : (
                  <Pressable
                    focusable
                    style={({focused}) => [styles.rowActionBtn, focused && styles.focused]}
                    onPress={() => {
                      if (pair.status !== 'paired') {
                        setPair(p => ({
                          ...p,
                          status: 'error',
                          message: 'Not paired with ElevSH — set it up in FYAISA → ElevSH first',
                        }));
                        return;
                      }
                      requestInstall(a.id);
                    }}>
                    <Text style={styles.rowActionText}>{state === 'update' ? 'Update' : 'Install'}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
};

/**
 * Where an app's row art lives, derived from its catalog `path` the same way
 * the scaffolder and the docs lay it out: `<path>/assets/image/<dir>.png`
 * (apps/snake → apps/snake/assets/image/snake.png). A catalog `icon` URL, if
 * present, overrides that. Either way, adding an app to the repo needs nothing
 * from the hub: no bundled file, no APP_ICONS entry, no hub update.
 */
const RAW_BASE = 'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main';
const remoteIcon = (app: HubApp): {uri: string} | null => {
  if (app.icon) {
    return {uri: app.icon};
  }
  const p = (app.path ?? '').replace(/\/+$/, '');
  const dir = p.split('/').pop();
  return p && dir ? {uri: `${RAW_BASE}/${p}/assets/image/${dir}.png`} : null;
};

/**
 * An app's icon in the list and detail views. A bundled copy wins when we ship
 * one (instant, and it still shows with no network); otherwise the app's own
 * art is loaded from the repo, which is what lets a brand-new app show its tile
 * with no hub rebuild. A remote miss renders nothing rather than a broken box.
 */
const AppIcon = ({app, style}: {app: HubApp; style: any}) => {
  const [failed, setFailed] = useState(false);
  const remote = remoteIcon(app);
  const source = APP_ICONS[app.id] ?? (!failed ? remote : null);
  if (!source) {
    return null;
  }
  return <Image style={style} source={source} onError={() => setFailed(true)} />;
};

const Badge = ({label, color}: {label: string; color: string}) => (
  <View style={[styles.badge, {borderColor: color}]}>
    <Text style={[styles.badgeText, {color}]}>{label}</Text>
  </View>
);

/**
 * One action in the ElevSH Power-tools card: a title, a one-line explanation
 * and a right-hand verb ("Open"/"Run"/"Reboot"). Focus ring comes from the
 * shared `focused` style, like every other control here.
 */
const ToolRow = ({
  title,
  summary,
  action,
  danger,
  onPress,
}: {
  title: string;
  summary: string;
  action: string;
  danger?: boolean;
  onPress: () => void;
}) => (
  <Pressable
    focusable
    style={({focused}) => [styles.toolRow, focused && styles.rowFocused, focused && styles.focused]}
    onPress={onPress}>
    <View style={styles.toolMain}>
      <Text style={[styles.toolTitle, danger && styles.toolDanger]}>{title}</Text>
      <Text style={styles.toolSummary}>{summary}</Text>
    </View>
    <Text style={styles.toolOpen}>{action}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: '#0b0b0f'},
  header: {paddingHorizontal: 40, paddingTop: 36, paddingBottom: 18},
  brand: {color: '#fff', fontSize: 40, fontWeight: '700'},
  tagline: {color: '#8b8b99', fontSize: 17, marginTop: 4},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  dim: {color: '#77778a', fontSize: 16, marginTop: 12},
  warn: {color: '#ffb300', fontSize: 15, marginBottom: 12},
  list: {paddingHorizontal: 40, paddingBottom: 40},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    padding: 18,
    marginBottom: 12,
  },
  rowFocused: {backgroundColor: '#1e1e28'},
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    padding: 18,
    marginBottom: 12,
  },
  rowBody: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  rowIcon: {width: 76, height: 76, borderRadius: 14, marginRight: 18},
  detailIcon: {width: 96, height: 96, borderRadius: 18, marginBottom: 14},
  rowMain: {flex: 1, paddingRight: 16},
  rowTitle: {color: '#fff', fontSize: 22, fontWeight: '600'},
  rowId: {color: '#6f6f80', fontSize: 13, marginTop: 2},
  rowSummary: {color: '#b9b9c6', fontSize: 15, marginTop: 6},
  rowActionBtn: {
    backgroundColor: '#165a8c',
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 20,
    paddingVertical: 11,
    marginLeft: 8,
  },
  rowActionText: {color: '#fff', fontSize: 16, fontWeight: '600'},
  rowActionCurrent: {backgroundColor: '#23232d'},
  rowActionMutedText: {color: '#8b8b99'},
  dot: {width: 12, height: 12, borderRadius: 6},
  chevron: {color: '#6f6f80', fontSize: 30, fontWeight: '600'},
  detailWrap: {flex: 1, backgroundColor: '#0b0b0f'},
  detail: {padding: 40, paddingBottom: 60},
  detailTitle: {color: '#fff', fontSize: 38, fontWeight: '700'},
  detailId: {color: '#6f6f80', fontSize: 15, marginTop: 4},
  detailSummary: {color: '#e6e6ef', fontSize: 20, marginTop: 16},
  detailBody: {color: '#a9a9b8', fontSize: 16, marginTop: 14, lineHeight: 23},
  badges: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 20},
  badge: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 4,
    marginRight: 8,
    marginBottom: 8,
  },
  badgeText: {fontSize: 13},
  meta: {color: '#8b8b99', fontSize: 15, marginTop: 6},
  notes: {marginTop: 18},
  note: {color: '#9d9dae', fontSize: 15, marginBottom: 6, lineHeight: 21},
  howto: {
    marginTop: 26,
    backgroundColor: '#16161d',
    borderRadius: 10,
    padding: 18,
  },
  howtoTitle: {color: '#fff', fontSize: 19, fontWeight: '600', marginBottom: 8},
  howtoBody: {color: '#a9a9b8', fontSize: 15, lineHeight: 21},
  code: {
    color: '#7ee787',
    fontSize: 17,
    marginVertical: 12,
    fontFamily: 'monospace',
  },
  upToDate: {color: '#4caf50', fontSize: 16, marginTop: 16},
  backBtn: {
    marginTop: 28,
    alignSelf: 'flex-start',
    backgroundColor: '#e50914',
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  backText: {color: '#fff', fontSize: 18},
  card: {
    backgroundColor: '#16161d',
    borderRadius: 10,
    padding: 18,
    marginTop: 18,
  },
  cardTitle: {color: '#fff', fontSize: 19, fontWeight: '600', marginBottom: 10},
  statusLine: {color: '#b9b9c6', fontSize: 15, marginBottom: 10},
  pcInfo: {color: '#7fd18c', fontSize: 14, marginBottom: 10},
  keypad: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12},
  key: {
    width: 68,
    height: 58,
    margin: 4,
    borderRadius: 8,
    backgroundColor: '#23232d',
    borderWidth: 4,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyFocused: {backgroundColor: '#e50914'},
  keyText: {color: '#fff', fontSize: 24},
  installBtn: {
    marginTop: 16,
    alignSelf: 'flex-start',
    backgroundColor: '#1c7d32',
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  forgetBtn: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: '#3a2020',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  forgetText: {color: '#e57373', fontSize: 16},
  accessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a23',
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#2a2a38',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 10,
  },
  accessMain: {flex: 1, paddingRight: 12},
  accessApp: {color: '#fff', fontSize: 16, fontWeight: '600'},
  accessMeta: {color: '#8b8b99', fontSize: 13, marginTop: 2},
  allowBtn: {
    backgroundColor: '#1c7d32',
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginLeft: 8,
  },
  denyBtn: {
    backgroundColor: '#3a2020',
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginLeft: 8,
  },
  accessBtnText: {color: '#fff', fontSize: 15, fontWeight: '600'},
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingBottom: 16,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginRight: 12,
  },
  searchText: {color: '#fff', fontSize: 18},
  searchPlaceholder: {color: '#6f6f80'},
  refreshBtn: {
    backgroundColor: '#16161d',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 26,
    paddingVertical: 14,
    alignSelf: 'flex-start',
  },
  refreshText: {color: '#fff', fontSize: 18, fontWeight: '600'},
  updateAllBtn: {
    backgroundColor: '#165a8c',
    borderRadius: 10,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 22,
    paddingVertical: 14,
    marginRight: 12,
    alignSelf: 'flex-start',
  },
  jobStrip: {color: '#8fb8d8', fontSize: 15, paddingHorizontal: 40, paddingBottom: 12},
  jobStripWarn: {color: '#ffb300', fontSize: 15, paddingHorizontal: 40, paddingBottom: 12},
  searchQuery: {color: '#fff', fontSize: 26, fontWeight: '600', marginTop: 8},
  searchCount: {color: '#77778a', fontSize: 15, marginTop: 4},
  ctrlKey: {
    minWidth: 130,
    height: 58,
    margin: 4,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#23232d',
    borderWidth: 4,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlKeyText: {color: '#fff', fontSize: 20},
  // Power tools: action rows, the output panel, and the red danger label.
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a23',
    borderRadius: 8,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 10,
  },
  toolMain: {flex: 1, paddingRight: 12},
  toolTitle: {color: '#fff', fontSize: 18, fontWeight: '600'},
  toolSummary: {color: '#8b8b99', fontSize: 14, marginTop: 2},
  toolDanger: {color: '#e57373'},
  toolOpen: {color: '#8fb8d8', fontSize: 15, fontWeight: '600'},
  toolOut: {
    marginTop: 14,
    backgroundColor: '#101018',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a38',
    padding: 14,
  },
  toolOutTitle: {color: '#7ee787', fontSize: 14, fontWeight: '600', marginBottom: 8},
  toolOutText: {color: '#c9c9d6', fontSize: 13, fontFamily: 'monospace', lineHeight: 19},
  /**
   * The TV focus ring: a thick amber border plus a glow, appended by every
   * focusable when focused (without it the selected control is hard to see on
   * this dark UI). Bases above carry a transparent 4px border so focusing
   * never shifts layout.
   */
  focused: {
    borderColor: '#ffb02e',
    shadowColor: '#ffb02e',
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
  job: {marginTop: 14},
  jobStatus: {color: '#7ee787', fontSize: 15, marginBottom: 6},
  jobLine: {color: '#8b8b99', fontSize: 12, fontFamily: 'monospace'},
});

export default App;
