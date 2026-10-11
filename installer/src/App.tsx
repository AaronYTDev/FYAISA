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
import {Backdrop} from './Backdrop';
import {Intro} from './Intro';
import {
  ACCENT_SWATCHES,
  BACKGROUNDS,
  BG_SWATCHES,
  BUTTON_EFFECTS,
  ENERGIES,
  FOCUS_SWATCHES,
  PRESET_LIST,
  RAINBOW,
  ResolvedTheme,
  SURFACE_SWATCHES,
  Theme,
  ThemeProvider,
  useAppTheme,
} from './theme';
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

// Home LANs are almost always 192.168.x.y, so the address box opens with that
// much already typed and you only punch in the last octets. It's ordinary text
// once there — backspace clears it if your LAN lives somewhere else.
const HOST_PREFIX = '192.168.';
/** True once the box holds a full dotted address. */
const hostFilled = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h.trim());

// D-pad-friendly keypad for typing a dotted IPv4 address.
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
const TOOL_SCREENS = new Set([
  '__systemapps__',
  '__runningapps__',
  '__terminal__',
  '__debloat__',
]);

/**
 * The built-in de-bloat preset. Everything here ships on a stock Vega OS Fire
 * TV and is safe to drop: the streaming apps are reinstallable from the
 * Appstore, and the rest are Amazon's ad, recommendation and telemetry
 * services. Ids are as `vega device installed-apps` lists them — removing one
 * takes its whole package with it.
 */
const DEBLOAT_PRESET: {id: string; name: string}[] = [
  // Preinstalled streaming apps — reinstallable from the Appstore.
  {id: 'com.netflix.kepler.main', name: 'Netflix'},
  {id: 'com.disney.disneyplus.main', name: 'Disney+'},
  {id: 'com.cbs.ott.main', name: 'CBS / Paramount+'},
  {id: 'com.skill.spotify.main', name: 'Spotify'},
  {id: 'com.amazon.music.kepler.main', name: 'Amazon Music'},
  // Amazon ad, recommendation and telemetry services.
  {id: 'com.amazon.recommendation.service.main', name: 'Recommendations'},
  {id: 'com.amazon.admanager.service.main', name: 'Ad manager'},
  {id: 'com.amazon.adep.analyzer', name: 'Ad platform (adep)'},
  {id: 'com.amazon.minerva', name: 'Minerva telemetry'},
  {id: 'com.amazon.mediametrics.service', name: 'Media metrics'},
];
const DEBLOAT_PRESET_MAP = new Map(DEBLOAT_PRESET.map(e => [e.id, e.name]));

/** Packages the de-bloater never offers: removing them breaks the stick. */
const DEBLOAT_KEEP = new Set([
  'app.fyaisa.hub.main', // the app you're holding
  'com.amazon.smplighthouse.launcher.main', // the Fire TV home screen
  'com.amazon.vegatvsettings.main', // Settings
  'com.amazon.dev.shell.service', // starts every app
  'com.amazon.vegaoobe.main', // out-of-box setup
]);

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
 * is actually visible from the couch. It is bound to the active theme, so the
 * ring and glow pick up the theme's focus colour.
 */
const useFocusable = () => {
  const {styles} = useAppTheme();
  return useCallback(
    (base: any) => ({focused}: {focused: boolean}) => [base, focused && styles.focused],
    [styles],
  );
};

const Hub = () => {
  const {styles, theme, applyPreset, patch, resetTheme} = useAppTheme();
  const focusable = useFocusable();
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The launch intro owns the screen first; true for the rest of the session
  // once it has finished or been skipped.
  const [introDone, setIntroDone] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Apps menu search: the query string, plus whether the on-screen keyboard is
  // up (a TV has no system keyboard; typing is a grid of keys you D-pad over).
  const [query, setQuery] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [pair, setPair] = useState<PairState>({
    host: HOST_PREFIX,
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
  // Whether the installed list, and then the versions behind it, have been read
  // since the current pairing. Until both land the rows can't tell install from
  // update, so their buttons say "Syncing…" rather than guess.
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
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
  // De-bloat: which installed apps are ticked, whether the full list or just
  // the preset is on screen, and whether Remove is armed for a second tap.
  const [debloatSel, setDebloatSel] = useState<Set<string>>(new Set());
  const [debloatShowAll, setDebloatShowAll] = useState(false);
  const [debloatArmed, setDebloatArmed] = useState(false);
  const [debloatBusy, setDebloatBusy] = useState(false);

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
  /**
   * While ElevSH is still reading what's installed and at what version, the
   * install/update buttons say "Syncing…" instead of guessing between the two.
   */
  const syncing = pair.status === 'paired' && !statusKnown;

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
        // `fyaisa connect --lan` sets up a reverse tunnel, so the bridge is
        // reachable on the Fire TV's own loopback. Offer that host so the
        // user never has to type an address on the D-pad.
        try {
          const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/ping`);
          if (res.ok && !cancelled) {
            console.info('[FYAISA] discovered ElevSH on 127.0.0.1');
            setPair(p => ({...p, host: '127.0.0.1', message: 'ElevSH found on this PC — press Pair'}));
          }
        } catch {
          // No tunnel; the manual address box is the fallback.
        }
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
    } finally {
      // Either way this attempt is over. A read that failed still ends the
      // "Syncing…" state — better to show the last known status than to hide
      // every button behind a spinner that never clears.
      setInstalledLoaded(true);
    }
  }, [pair.status, bridgeFetch]);

  useEffect(() => {
    // A fresh pairing (or a reconnect) has read nothing yet, so hold the buttons
    // on "Syncing…" until the installed list and versions come back.
    setInstalledLoaded(false);
    setStatusKnown(false);
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
    if (pair.status !== 'paired') {
      setVersions({});
      setStatusKnown(false);
      return;
    }
    if (!installedLoaded) {
      return; // still finding the installed list; buttons stay on "Syncing…"
    }
    if (!installedKey) {
      setVersions({});
      setStatusKnown(true); // nothing installed, so there's nothing left to read
      return;
    }
    let cancelled = false;
    refreshVersions(installedKey.split(',')).finally(() => {
      if (!cancelled) {
        setStatusKnown(true);
      }
    });
    return () => {
      cancelled = true;
    };
    // versionsTick is a deliberate trigger: it re-reads after an install, and a
    // slow timer catches updates made outside the hub.
  }, [installedKey, versionsTick, pair.status, installedLoaded, refreshVersions]);

  useEffect(() => {
    const iv = setInterval(() => setVersionsTick(t => t + 1), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  /**
   * Pairing fetch against a specific host. Like bridgeFetch, but the host is
   * passed in rather than read from state, so Discover can pair with the
   * address it just found before that address lands in state.
   */
  const pairFetch = useCallback(
    async (host: string, p: string, opts: RequestInit = {}) => {
      const res = await fetch(`http://${host}:${BRIDGE_PORT}${p}`, {
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
    [pair.token],
  );

  /**
   * Ask the bridge at `host` for a code, then poll until the user approves it
   * on the PC. Shared by the manual address box and the Discover button.
   */
  const pairWithHost = useCallback(
    async (host: string) => {
      if (!hostFilled(host)) {
        setPair(p => ({...p, status: 'error', message: 'Enter your computer’s address first'}));
        return;
      }
      const url = `http://${host}:${BRIDGE_PORT}`;
      try {
        setPair(p => ({...p, host, status: 'requesting', message: 'Requesting code…'}));
        // Reachability check: GET /ping, which is tokenless. /catalog would 401
        // here since no valid token exists yet, so pairing could never start.
        // /pair/request and /pair/approve are tokenless too, and /pair/approve
        // hands back the bridge's current token, so a stale token heals itself.
        try {
          const res = await fetch(`${url}/ping`);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
        } catch (e: any) {
          setPair(p => ({
            ...p,
            status: 'error',
            message: `ElevSH unreachable at ${url} (${e?.message || e}). Start \`fyaisa connect --lan\` on the PC.`,
          }));
          return;
        }
        const {code} = await pairFetch(host, '/pair/request', {method: 'POST'});
        setPair(p => ({...p, host, code, status: 'awaiting', message: `On the PC: fyaisa approve ${code}`}));
        // Poll for approval; the bridge approves once the user types the code.
        const iv = setInterval(async () => {
          try {
            const st = await pairFetch(host, `/pair/status?code=${code}`);
            if (st.approved) {
              clearInterval(iv);
              const ok = await pairFetch(host, '/pair/approve', {
                method: 'POST',
                body: JSON.stringify({code, device: 'fyaisa-app'}),
              });
              savePair({host, token: ok.token});
              setPair(p => ({
                ...p,
                host,
                token: ok.token,
                status: 'paired',
                message: 'Connected',
              }));
              console.info('[FYAISA] paired with bridge');
              setPcInfo(await describePc(new Fyaisa(host, ok.token, BRIDGE_PORT, HUB_APP_ID)));
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
    [pairFetch],
  );

  /** Pair with the address in the manual box. */
  const startPairing = useCallback(
    () => pairWithHost(pair.host || ''),
    [pairWithHost, pair.host],
  );

  /**
   * Look for the bridge on the Fire TV's own loopback — the reverse tunnel
   * `fyaisa connect --lan` opens — and pair with it if it answers. No address
   * to type on the D-pad.
   */
  const discoverBridge = useCallback(async () => {
    const host = '127.0.0.1';
    try {
      setPair(p => ({...p, status: 'requesting', message: 'Looking for ElevSH…'}));
      const res = await fetch(`http://${host}:${BRIDGE_PORT}/ping`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      setPair(p => ({
        ...p,
        status: 'error',
        message: 'No ElevSH found on this PC — make sure `fyaisa connect --lan` is running, or type the address below.',
      }));
      return;
    }
    console.info('[FYAISA] discovered ElevSH on 127.0.0.1');
    await pairWithHost(host);
  }, [pairWithHost]);

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
                // Re-read the status; the buttons go back to "Syncing…" while
                // that happens so nobody taps an install the job just changed.
                setStatusKnown(false);
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
      setStatusKnown(false);
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

  /**
   * De-bloat: read the installed list, and (on first open) tick everything the
   * preset covers so the screen opens with a sensible, editable selection.
   */
  const loadDebloat = useCallback(
    async (selectPreset = false) => {
      setSysApps(null);
      setToolBusy('Reading installed apps…');
      try {
        const r = await runVega(['device', 'installed-apps']);
        const ids = String(r.stdout || '')
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
          .sort();
        setSysApps(ids);
        if (selectPreset) {
          const present = new Set(ids);
          setDebloatSel(
            new Set(DEBLOAT_PRESET.filter(p => present.has(p.id)).map(p => p.id)),
          );
        }
      } catch (e: any) {
        setSysApps([]);
        setToolOut({title: 'Installed apps', text: e?.message || String(e), ok: false});
      } finally {
        setToolBusy(null);
      }
    },
    [runVega],
  );

  const toggleDebloat = useCallback((id: string) => {
    setDebloatArmed(false);
    setDebloatSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyDebloatPreset = useCallback(() => {
    setDebloatArmed(false);
    const present = new Set(sysApps ?? []);
    setDebloatSel(new Set(DEBLOAT_PRESET.filter(p => present.has(p.id)).map(p => p.id)));
  }, [sysApps]);

  const clearDebloat = useCallback(() => {
    setDebloatArmed(false);
    setDebloatSel(new Set());
  }, []);

  /** Remove every ticked app, one bridge /uninstall at a time. Two taps to fire. */
  const removeDebloatSelected = useCallback(async () => {
    if (debloatBusy) return;
    const ids = [...debloatSel];
    if (!ids.length) return;
    if (!debloatArmed) {
      setDebloatArmed(true);
      setToolOut({
        title: 'De-bloat',
        text:
          `Tap “Remove” again to uninstall ${ids.length} ` +
          `app${ids.length === 1 ? '' : 's'}. The stick keeps working, and ` +
          `anything here can be reinstalled from the Appstore.`,
        ok: true,
      });
      return;
    }
    setDebloatArmed(false);
    setDebloatBusy(true);
    const removed: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      setToolBusy(`Removing ${DEBLOAT_PRESET_MAP.get(id) || id}…`);
      try {
        const r = await bridgeFetch('/uninstall', {
          method: 'POST',
          body: JSON.stringify({appId: id}),
        });
        (r.ok ? removed : failed).push(id);
      } catch {
        failed.push(id);
      }
    }
    setToolBusy(null);
    setDebloatBusy(false);
    setToolOut({
      title: 'De-bloat',
      text:
        `Removed ${removed.length} app${removed.length === 1 ? '' : 's'}` +
        (failed.length
          ? ` · ${failed.length} still there: ${failed.join(', ')}`
          : '.'),
      ok: failed.length === 0,
    });
    await loadDebloat(false);
    setDebloatSel(new Set(failed)); // leave the failures ticked to retry
    refreshInstalled(); // keep the Apps list's badges honest
    setVersionsTick(t => t + 1);
  }, [debloatBusy, debloatSel, debloatArmed, bridgeFetch, loadDebloat, refreshInstalled]);

  // Load a Power-tools list when its screen opens (each fetch is over ElevSH).
  useEffect(() => {
    if (selectedId === '__systemapps__') loadSystemApps();
    else if (selectedId === '__runningapps__') loadRunningApps();
    else if (selectedId === '__debloat__') loadDebloat(true);
    else if (selectedId === '__terminal__') setCmdOut(null);
  }, [selectedId, loadSystemApps, loadRunningApps, loadDebloat]);

  // The splash screen is dismissed exactly once: the intro drops it as soon as
  // it has painted, and loadCatalog keeps the same guard as a backstop in case
  // the intro never mounts.
  const splashHiddenRef = useRef(false);
  const hideSplash = useCallback(() => {
    if (splashHiddenRef.current) {
      return;
    }
    splashHiddenRef.current = true;
    hideSplashScreenCallback();
  }, [hideSplashScreenCallback]);

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
        hideSplash();
      }
    },
    [hideSplash],
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
      if (!introDone) {
        setIntroDone(true); // first Back skips the intro, it doesn't close us
        return true;
      }
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
  }, [selectedId, keyboardOpen, introDone]);

  // The intro plays first and owns the whole screen; the menus below don't
  // mount until it's gone, so nothing behind it can steal D-pad focus.
  if (!introDone) {
    return <Intro onFirstFrame={hideSplash} onDone={() => setIntroDone(true)} />;
  }

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
      {
        id: '__themes__',
        title: 'Themes',
        summary: `${theme.name} — ${
          theme.background === 'none' ? 'static' : `${theme.background} background`
        }, ${theme.buttonEffect} buttons`,
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
            <Pressable style={focusable(styles.installBtn)} onPress={discoverBridge}>
              <Text style={styles.backText}>Discover ElevSH on this PC</Text>
            </Pressable>
            <Text style={styles.howtoBody}>
              With fyaisa connect --lan running on the computer, Discover finds it
              through the tunnel — no address to type. Or enter the PC's address
              manually below.
            </Text>
            <Text style={styles.code}>
              {hostFilled(pair.host || '')
                ? `http://${pair.host}:${BRIDGE_PORT}`
                : pair.host || 'not set'}
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
                          a.status === 'allow' && styles.accessAllow,
                          a.status === 'deny' && styles.accessDeny,
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
                        <Text style={[styles.accessBtnText, styles.denyBtnText]}>Deny</Text>
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
                        <Text style={[styles.accessBtnText, styles.denyBtnText]}>Deny</Text>
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
                title="De-bloat"
                summary="Tick preinstalled apps and remove them — preset included"
                action="Open"
                onPress={() => setSelectedId('__debloat__')}
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

  // Power tools → "De-bloat": tick installed apps and remove them over ElevSH.
  if (selectedId === '__debloat__') {
    const removable = (sysApps ?? []).filter(id => !DEBLOAT_KEEP.has(id));
    const shown = debloatShowAll
      ? removable
      : removable.filter(id => DEBLOAT_PRESET_MAP.has(id));
    const selCount = debloatSel.size;
    const disabled = !selCount || debloatBusy;
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>De-bloat</Text>
          <Text style={styles.tagline}>
            Remove preinstalled apps you never use. The preset ticks the usual
            suspects: streaming apps that ship on the stick, plus Amazon's ad,
            recommendation and telemetry services. Everything here can come
            back from the Appstore, so nothing is permanent.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {toolBusy ? <Text style={styles.pcInfo}>{toolBusy}</Text> : null}

          <View style={styles.bar}>
            <Pressable
              style={focusable([styles.refreshBtn, styles.barBtn])}
              onPress={applyDebloatPreset}>
              <Text style={styles.refreshText}>Use preset</Text>
            </Pressable>
            <Pressable
              style={focusable([styles.refreshBtn, styles.barBtn])}
              onPress={clearDebloat}>
              <Text style={styles.refreshText}>Clear</Text>
            </Pressable>
            <Pressable
              style={focusable([styles.refreshBtn, styles.barBtn])}
              onPress={() => setDebloatShowAll(v => !v)}>
              <Text style={styles.refreshText}>
                {debloatShowAll ? 'Preset only' : 'Show all apps'}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.dim}>
            {selCount} selected · {shown.length} shown
            {debloatShowAll ? '' : ' (the preset)'}
          </Text>

          {sysApps == null ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={theme.palette.text} />
            </View>
          ) : shown.length === 0 ? (
            <Text style={styles.dim}>Nothing to remove here.</Text>
          ) : (
            shown.map((id, i) => {
              const name = DEBLOAT_PRESET_MAP.get(id);
              return (
                <DebloatRow
                  key={id}
                  first={i === 0}
                  checked={debloatSel.has(id)}
                  title={name || id}
                  subtitle={name ? id : undefined}
                  onPress={() => toggleDebloat(id)}
                />
              );
            })
          )}

          <Pressable
            disabled={disabled}
            style={focusable([styles.removeBtn, disabled && styles.idleBtn])}
            onPress={removeDebloatSelected}>
            <Text style={[styles.removeBtnText, disabled && styles.idleText]}>
              {debloatBusy
                ? 'Removing…'
                : debloatArmed
                ? `Tap again to remove ${selCount}`
                : `Remove selected (${selCount})`}
            </Text>
          </Pressable>

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

          <Pressable style={focusable(styles.backBtn)} onPress={() => setSelectedId('__connect__')}>
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
              <ActivityIndicator size="large" color={theme.palette.text} />
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
              <ActivityIndicator size="large" color={theme.palette.text} />
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

  // Themes: presets, plus per-setting customisation (colours, button style,
  // background effect). App logos and tile art are never restyled.
  if (selectedId === '__themes__') {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.brand}>Themes</Text>
          <Text style={styles.tagline}>
            Make the hub yours: pick a preset, or dial in your own colours and
            effects. App logos are never restyled.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.sectionTitle}>Presets</Text>
          <View style={styles.presetGrid}>
            {PRESET_LIST.map((p, i) => (
              <Pressable
                key={p.preset}
                hasTVPreferredFocus={i === 0}
                focusable
                style={({focused}) => [
                  styles.presetCard,
                  theme.preset === p.preset && styles.presetCardOn,
                  focused && styles.focused,
                ]}
                onPress={() => applyPreset(p.preset)}>
                <View style={styles.presetSwatches}>
                  <View style={[styles.presetDot, {backgroundColor: p.palette.bg}]} />
                  <View style={[styles.presetDot, {backgroundColor: p.palette.surface}]} />
                  <View style={[styles.presetDot, {backgroundColor: p.palette.accent}]} />
                  <View style={[styles.presetDot, {backgroundColor: p.palette.focus}]} />
                </View>
                <Text style={styles.presetName}>{p.name}</Text>
                <Text style={styles.presetState}>
                  {theme.preset === p.preset ? 'Active' : 'Select'} · {p.background} ·{' '}
                  {p.buttonEffect}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionTitle}>Accent color</Text>
          <Text style={styles.sectionHint}>Buttons and highlights.</Text>
          <SwatchGrid
            colors={ACCENT_SWATCHES}
            value={theme.palette.accent}
            onPick={c => patch({palette: {accent: c}})}
          />

          <Text style={styles.sectionTitle}>Background color</Text>
          <SwatchGrid
            colors={BG_SWATCHES}
            value={theme.palette.bg}
            onPick={c => patch({palette: {bg: c}})}
          />

          <Text style={styles.sectionTitle}>Panel color</Text>
          <Text style={styles.sectionHint}>Cards, rows and the search box.</Text>
          <SwatchGrid
            colors={SURFACE_SWATCHES}
            value={theme.palette.surface}
            onPick={c => patch({palette: {surface: c}})}
          />

          <Text style={styles.sectionTitle}>Ring color</Text>
          <Text style={styles.sectionHint}>Focus ring around the selected control.</Text>
          <SwatchGrid
            colors={FOCUS_SWATCHES}
            value={theme.palette.focus}
            onPick={c => patch({palette: {focus: c}})}
          />

          <Text style={styles.sectionTitle}>Button style</Text>
          <View style={styles.chipRow}>
            {BUTTON_EFFECTS.map(e => (
              <Pressable
                key={e.id}
                focusable
                style={({focused}) => [
                  styles.chip,
                  theme.buttonEffect === e.id && styles.chipOn,
                  focused && styles.focused,
                ]}
                onPress={() => patch({buttonEffect: e.id})}>
                <Text
                  style={[styles.chipText, theme.buttonEffect === e.id && styles.chipOnText]}>
                  {e.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionTitle}>Background effect</Text>
          <View style={styles.chipRow}>
            {BACKGROUNDS.map(b => (
              <Pressable
                key={b.id}
                focusable
                style={({focused}) => [
                  styles.chip,
                  theme.background === b.id && styles.chipOn,
                  focused && styles.focused,
                ]}
                onPress={() => patch({background: b.id})}>
                <Text
                  style={[styles.chipText, theme.background === b.id && styles.chipOnText]}>
                  {b.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {theme.background !== 'none' ? (
            <>
              <Text style={styles.sectionTitle}>Motion</Text>
              <View style={styles.chipRow}>
                {ENERGIES.map(e => (
                  <Pressable
                    key={e.id}
                    focusable
                    style={({focused}) => [
                      styles.chip,
                      theme.energy === e.id && styles.chipOn,
                      focused && styles.focused,
                    ]}
                    onPress={() => patch({energy: e.id})}>
                    <Text
                      style={[styles.chipText, theme.energy === e.id && styles.chipOnText]}>
                      {e.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <View style={styles.themeActions}>
            <Pressable style={focusable(styles.forgetBtn)} onPress={resetTheme}>
              <Text style={styles.forgetText}>Reset to Classic</Text>
            </Pressable>
            <Pressable style={focusable(styles.backBtn)} onPress={() => setSelectedId(null)}>
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          </View>
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
                {syncing ? (
                  <Pressable disabled style={[styles.installBtn, styles.idleBtn]}>
                    <Text style={[styles.backText, styles.idleText]}>Syncing…</Text>
                  </Pressable>
                ) : appState(selected) === 'current' ? (
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
        {syncing || updatable.length > 0 || updateAll ? (
          <Pressable
            focusable={!syncing}
            disabled={syncing}
            style={({focused}) => [styles.updateAllBtn, syncing && styles.idleBtn, focused && styles.focused]}
            onPress={runUpdateAll}>
            <Text style={[styles.refreshText, syncing && styles.idleText]}>
              {syncing
                ? 'Syncing…'
                : updateAll
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
          <ActivityIndicator size="large" color={theme.palette.text} />
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
                {syncing ? (
                  <Pressable disabled style={[styles.rowActionBtn, styles.idleBtn]}>
                    <Text style={[styles.rowActionText, styles.idleText]}>Syncing…</Text>
                  </Pressable>
                ) : state === 'current' ? (
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

const Badge = ({label, color}: {label: string; color: string}) => {
  const {styles} = useAppTheme();
  return (
    <View style={[styles.badge, {borderColor: color}]}>
      <Text style={[styles.badgeText, {color}]}>{label}</Text>
    </View>
  );
};

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
}) => {
  const {styles} = useAppTheme();
  return (
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
};

/**
 * A tick row on the De-bloat screen: a checkbox, the app's name (or its id when
 * the preset has no friendly one), and the id underneath for preset entries.
 */
const DebloatRow = ({
  title,
  subtitle,
  checked,
  first,
  onPress,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  first: boolean;
  onPress: () => void;
}) => {
  const {styles} = useAppTheme();
  return (
    <Pressable
      hasTVPreferredFocus={first}
      focusable
      style={({focused}) => [styles.toolRow, focused && styles.rowFocused, focused && styles.focused]}
      onPress={onPress}>
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <View style={styles.toolMain}>
        <Text style={styles.toolTitle}>{title}</Text>
        {subtitle ? <Text style={styles.toolSummary}>{subtitle}</Text> : null}
      </View>
      <Text style={styles.toolOpen}>{checked ? 'Remove' : 'Keep'}</Text>
    </Pressable>
  );
};

/**
 * A row of colour choices on the Themes screen. The active one gets a focus
 * -coloured ring; focus (not selection) comes from the shared `focused` style.
 */
const SwatchGrid = ({
  colors,
  value,
  onPick,
}: {
  colors: string[];
  value: string;
  onPick: (color: string) => void;
}) => {
  const {styles, rainbowHex} = useAppTheme();
  const active = String(value).toLowerCase();
  return (
    <View style={styles.swatchGrid}>
      {colors.map(c => {
        const on = c.toLowerCase() === active;
        return (
          <Pressable
            key={c}
            focusable
            style={({focused}) => [
              styles.swatch,
              {backgroundColor: c === RAINBOW ? rainbowHex : c},
              on && styles.swatchOn,
              focused && styles.focused,
            ]}
            onPress={() => onPick(c)}>
            {on ? <View style={styles.swatchCheck} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
};

const makeStyles = (t: ResolvedTheme) => {
  // A button's resting border, so "Outline" reads as outlined and the others
  // stay flush with the surface (a transparent 4px border keeps layout stable
  // when the focus ring appears).
  const buttonBase =
    t.buttonEffect === 'outline'
      ? {borderWidth: 2, borderColor: t.border}
      : {borderWidth: 4, borderColor: 'transparent'};

  return StyleSheet.create({
  root: {flex: 1, backgroundColor: t.bg},
  wrap: {flex: 1},
  header: {paddingHorizontal: 40, paddingTop: 36, paddingBottom: 18},
  brand: {color: t.text, fontSize: 40, fontWeight: '700'},
  tagline: {color: t.textDim, fontSize: 17, marginTop: 4},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  dim: {color: t.textMuted, fontSize: 16, marginTop: 12},
  warn: {color: t.warn, fontSize: 15, marginBottom: 12},
  list: {paddingHorizontal: 40, paddingBottom: 40},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.surface,
    borderRadius: 10,
    ...buttonBase,
    padding: 18,
    marginBottom: 12,
  },
  rowFocused: {backgroundColor: t.surfaceAlt},
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.surface,
    borderRadius: 10,
    ...buttonBase,
    padding: 18,
    marginBottom: 12,
  },
  rowBody: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  rowIcon: {width: 76, height: 76, borderRadius: 14, marginRight: 18},
  detailIcon: {width: 96, height: 96, borderRadius: 18, marginBottom: 14},
  rowMain: {flex: 1, paddingRight: 16},
  rowTitle: {color: t.text, fontSize: 22, fontWeight: '600'},
  rowId: {color: t.textMuted, fontSize: 13, marginTop: 2},
  rowSummary: {color: t.textSoft, fontSize: 15, marginTop: 6},
  rowActionBtn: {
    backgroundColor: t.accent,
    borderRadius: 6,
    ...buttonBase,
    paddingHorizontal: 20,
    paddingVertical: 11,
    marginLeft: 8,
  },
  rowActionText: {color: t.accentText, fontSize: 16, fontWeight: '600'},
  rowActionCurrent: {backgroundColor: t.surfaceKey},
  rowActionMutedText: {color: t.textDim},
  // "Syncing…" buttons: the real button shape, muted, and disabled so they take
  // no press and no D-pad step while ElevSH is still reading the device.
  idleBtn: {backgroundColor: t.surfaceKey},
  idleText: {color: t.textDim},
  dot: {width: 12, height: 12, borderRadius: 6},
  chevron: {color: t.textMuted, fontSize: 30, fontWeight: '600'},
  detailWrap: {flex: 1},
  detail: {padding: 40, paddingBottom: 60},
  detailTitle: {color: t.text, fontSize: 38, fontWeight: '700'},
  detailId: {color: t.textMuted, fontSize: 15, marginTop: 4},
  detailSummary: {color: t.textStrong, fontSize: 20, marginTop: 16},
  detailBody: {color: t.textBody, fontSize: 16, marginTop: 14, lineHeight: 23},
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
  meta: {color: t.textDim, fontSize: 15, marginTop: 6},
  notes: {marginTop: 18},
  note: {color: t.textBody, fontSize: 15, marginBottom: 6, lineHeight: 21},
  howto: {
    marginTop: 26,
    backgroundColor: t.surface,
    borderRadius: 10,
    padding: 18,
  },
  howtoTitle: {color: t.text, fontSize: 19, fontWeight: '600', marginBottom: 8},
  howtoBody: {color: t.textBody, fontSize: 15, lineHeight: 21},
  code: {
    color: t.code,
    fontSize: 17,
    marginVertical: 12,
    fontFamily: 'monospace',
  },
  upToDate: {color: t.success, fontSize: 16, marginTop: 16},
  backBtn: {
    marginTop: 28,
    alignSelf: 'flex-start',
    backgroundColor: t.danger,
    ...buttonBase,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 6,
  },
  backText: {color: '#ffffff', fontSize: 18},
  card: {
    backgroundColor: t.surface,
    borderRadius: 10,
    padding: 18,
    marginTop: 18,
  },
  cardTitle: {color: t.text, fontSize: 19, fontWeight: '600', marginBottom: 10},
  statusLine: {color: t.textSoft, fontSize: 15, marginBottom: 10},
  pcInfo: {color: t.code, fontSize: 14, marginBottom: 10},
  keypad: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12},
  key: {
    width: 68,
    height: 58,
    margin: 4,
    borderRadius: 8,
    backgroundColor: t.surfaceKey,
    ...buttonBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyFocused: {backgroundColor: t.accent},
  keyText: {color: t.text, fontSize: 24},
  installBtn: {
    marginTop: 16,
    alignSelf: 'flex-start',
    backgroundColor: t.success,
    ...buttonBase,
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 6,
  },
  forgetBtn: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: t.dangerSoft,
    ...buttonBase,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 6,
  },
  forgetText: {color: t.dangerChipText, fontSize: 16},
  accessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.surfaceAlt,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: t.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 10,
  },
  accessMain: {flex: 1, paddingRight: 12},
  accessApp: {color: t.text, fontSize: 16, fontWeight: '600'},
  accessMeta: {color: t.textDim, fontSize: 13, marginTop: 2},
  accessAllow: {color: t.code},
  accessDeny: {color: t.dangerText},
  allowBtn: {
    backgroundColor: t.success,
    borderRadius: 6,
    ...buttonBase,
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginLeft: 8,
  },
  denyBtn: {
    backgroundColor: t.dangerSoft,
    borderRadius: 6,
    ...buttonBase,
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginLeft: 8,
  },
  accessBtnText: {color: '#ffffff', fontSize: 15, fontWeight: '600'},
  denyBtnText: {color: t.dangerChipText, fontSize: 15, fontWeight: '600'},
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
    backgroundColor: t.surface,
    borderRadius: 10,
    ...buttonBase,
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginRight: 12,
  },
  searchText: {color: t.text, fontSize: 18},
  searchPlaceholder: {color: t.textMuted},
  refreshBtn: {
    backgroundColor: t.surface,
    borderRadius: 10,
    ...buttonBase,
    paddingHorizontal: 26,
    paddingVertical: 14,
    alignSelf: 'flex-start',
  },
  refreshText: {color: t.text, fontSize: 18, fontWeight: '600'},
  updateAllBtn: {
    backgroundColor: t.accent,
    borderRadius: 10,
    ...buttonBase,
    paddingHorizontal: 22,
    paddingVertical: 14,
    marginRight: 12,
    alignSelf: 'flex-start',
  },
  jobStrip: {color: t.link, fontSize: 15, paddingHorizontal: 40, paddingBottom: 12},
  jobStripWarn: {color: t.warn, fontSize: 15, paddingHorizontal: 40, paddingBottom: 12},
  searchQuery: {color: t.text, fontSize: 26, fontWeight: '600', marginTop: 8},
  searchCount: {color: t.textMuted, fontSize: 15, marginTop: 4},
  ctrlKey: {
    minWidth: 130,
    height: 58,
    margin: 4,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: t.surfaceKey,
    ...buttonBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlKeyText: {color: t.text, fontSize: 20},
  // Power tools: action rows, the output panel, and the red danger label.
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.surfaceAlt,
    borderRadius: 8,
    ...buttonBase,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 10,
  },
  toolMain: {flex: 1, paddingRight: 12},
  toolTitle: {color: t.text, fontSize: 18, fontWeight: '600'},
  toolSummary: {color: t.textDim, fontSize: 14, marginTop: 2},
  toolDanger: {color: t.dangerText},
  toolOpen: {color: t.link, fontSize: 15, fontWeight: '600'},
  // De-bloat: tick boxes, the control bar, and the red remove button.
  checkBox: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: t.border,
    marginRight: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: {backgroundColor: t.accent, borderColor: t.accent},
  checkMark: {color: t.accentText, fontSize: 20, fontWeight: '700'},
  bar: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 10},
  barBtn: {marginRight: 12, marginBottom: 8},
  removeBtn: {
    backgroundColor: t.dangerSoft,
    borderRadius: 10,
    ...buttonBase,
    paddingHorizontal: 24,
    paddingVertical: 14,
    alignSelf: 'flex-start',
    marginTop: 16,
  },
  removeBtnText: {color: t.dangerText, fontSize: 18, fontWeight: '600'},
  toolOut: {
    marginTop: 14,
    backgroundColor: t.surfaceDeep,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border,
    padding: 14,
  },
  toolOutTitle: {color: t.code, fontSize: 14, fontWeight: '600', marginBottom: 8},
  toolOutText: {color: t.textBody, fontSize: 13, fontFamily: 'monospace', lineHeight: 19},
  focused: {
    borderWidth: 4,
    borderColor: t.focus,
    // "Flat" keeps a crisp ring; "glow" and "outline" add the halo.
    ...(t.buttonEffect === 'flat'
      ? {}
      : {
          shadowColor: t.focus,
          shadowOpacity: 0.85,
          shadowRadius: 10,
          shadowOffset: {width: 0, height: 0},
          elevation: 10,
        }),
  },
  job: {marginTop: 14},
  jobStatus: {color: t.code, fontSize: 15, marginBottom: 6},
  jobLine: {color: t.textDim, fontSize: 12, fontFamily: 'monospace'},
  // Themes screen.
  sectionTitle: {color: t.text, fontSize: 20, fontWeight: '600', marginTop: 24, marginBottom: 6},
  sectionHint: {color: t.textDim, fontSize: 14, marginBottom: 10},
  presetGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  presetCard: {
    width: 260,
    backgroundColor: t.surface,
    borderRadius: 10,
    ...buttonBase,
    padding: 14,
    marginRight: 12,
    marginBottom: 12,
  },
  presetCardOn: {borderWidth: 4, borderColor: t.focus},
  presetSwatches: {flexDirection: 'row', marginBottom: 12},
  presetDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    marginRight: 8,
    borderWidth: 1,
    borderColor: t.border,
  },
  presetName: {color: t.text, fontSize: 16, fontWeight: '600'},
  presetState: {color: t.textDim, fontSize: 13, marginTop: 4},
  swatchGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  swatch: {
    width: 54,
    height: 54,
    borderRadius: 12,
    marginRight: 12,
    marginBottom: 12,
    ...buttonBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchOn: {borderWidth: 4, borderColor: t.focus},
  swatchCheck: {width: 16, height: 16, borderRadius: 8, backgroundColor: t.focus},
  chipRow: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {
    backgroundColor: t.surface,
    borderRadius: 8,
    ...buttonBase,
    paddingHorizontal: 22,
    paddingVertical: 12,
    marginRight: 12,
    marginBottom: 12,
    alignSelf: 'flex-start',
  },
  chipOn: {backgroundColor: t.accent},
  chipText: {color: t.text, fontSize: 16, fontWeight: '600'},
  chipOnText: {color: t.accentText},
  themeActions: {flexDirection: 'row', alignItems: 'center', marginTop: 8},
});
};

/**
 * The backdrops (animated background) always sit one layer below the current
 * screen, so an effect never covers content or grabs D-pad focus from a row.
 */
const Shell = () => {
  const {styles} = useAppTheme();
  return (
    <View style={styles.root}>
      <Backdrop />
      <Hub />
    </View>
  );
};

export const App = () => (
  <ThemeProvider makeStyles={makeStyles}>
    <Shell />
  </ThemeProvider>
);

export default App;
