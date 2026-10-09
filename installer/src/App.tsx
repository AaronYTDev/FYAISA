/**
 * FYAISA — homebrew hub for Amazon Vega OS Fire TV devices.
 *
 * Fetches the hub catalog from GitHub and renders it as a 10-foot-friendly app
 * browser.
 *
 * IMPORTANT PLATFORM CONSTRAINT: a Vega OS app cannot install other .vpkg
 * packages. Package management is host-side only (`vega device install-app`) and
 * no third-party install API is exposed to apps. This app therefore browses the
 * catalog and hands the actual install back to the host `fyaisa` CLI, which
 * ships in the same repository. That is a platform limitation, not a missing
 * feature — see apps/README.md.
 */
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
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

type HubApp = {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  license?: string;
  author?: string;
  homepage?: string;
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
 * A Vega OS app cannot install packages, so control is inverted: this app is a
 * client for the `fyaisa connect` bridge running on the user's PC. It can make
 * outbound HTTP, which is all we need.
 * ------------------------------------------------------------------------- */
const BRIDGE_PORT = 47821;
const PAIR_POLL_MS = 2000;
/**
 * Persisted pairing, so the TV doesn't forget its PC on every restart.
 *
 * Storage notes (learned the hard way):
 *  - AsyncStorage is NOT available on Vega OS: installing it succeeds at
 *    build time, but at runtime the JS bridge reports
 *      [AutoLinkService] Library 'RNAsyncStorage' not found in any source
 *    and every call silently no-ops. Use Amazon's KeplerFileSystem
 *    TurboModule instead.
 *  - The app runs sandboxed: its writable, reboot-persistent directory is
 *    /data (per-app, not shared — the KeplerFileSystem README documents the
 *    full sandbox layout: /pkg read-only, /data persistent, /tmp volatile).
 *    It is NOT the /data that `vega device run-cmd` sees.
 *  - The encoding argument must be 'UTF-8' (uppercase); 'utf-8' makes the
 *    native side throw com.amazon.kepler.io.IoError.
 */
type SavedPair = {host: string; token: string};

const STORE_PATH = '/data/bridge.json';

const savePair = async (p: SavedPair) => {
  try {
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
    // Missing file is fine — nothing to forget.
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
  ],
};

// D-pad-friendly keypad for typing a dotted IPv4 address / hostname.
const HOST_KEYS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  '.', '⌫',
];

const statusColor = (s?: string) =>
  s === 'stable' ? '#4caf50' : s === 'beta' ? '#ffb300' : '#9e9e9e';

/**
 * Ask the paired PC what it can do — CLI version + how many Fire TVs it sees.
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
    return `PC reachable, but the Vega CLI failed (${e?.message || e})`;
  }
};

/**
 * Wrap a base style so a Pressable renders the TV focus ring (styles.focused)
 * when D-pad focused. Every focusable in the app goes through this — an
 * unfocused-vs-focused difference you can actually see from the couch.
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
  const [pair, setPair] = useState<PairState>({
    host: null,
    token: null,
    code: null,
    status: 'idle',
    message: 'Not connected',
  });
  /** One-line summary of what the paired PC can do (via /vega). */
  const [pcInfo, setPcInfo] = useState<string | null>(null);

  const base = pair.host ? `http://${pair.host}:${BRIDGE_PORT}` : null;

  // Restore a previous pairing on launch. React state alone is lost on every
  // app restart, which made the Install button disappear after a reboot even
  // though the PC was still paired.
  //
  // We then verify the saved token against the bridge: GET /catalog requires
  // X-FYAISA-Token, so a 401 means the bridge regenerated its token (e.g.
  // ~/.fyaisa/bridge.json was deleted) and we must re-pair. A network error
  // just means the PC is offline — keep the pairing, it still works when the
  // PC is back on the same network.
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
        const fy = new Fyaisa(saved.host, saved.token, BRIDGE_PORT);
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
          // PC unreachable right now — stay paired; it may come back when the
          // PC is on the same network.
          console.info('[FYAISA] bridge unreachable during restore check (PC offline?)');
          if (!cancelled) {
            setPcInfo('PC offline right now');
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

  /** Ask the bridge for a code, then poll until the user approves it on the PC. */
  const startPairing = useCallback(async () => {
    if (!base) {
      setPair(p => ({...p, status: 'error', message: 'Set the PC address first'}));
      return;
    }
    try {
      setPair(p => ({...p, status: 'requesting', message: 'Requesting code…'}));
      // Check the bridge is actually reachable + our token is still accepted
      // before asking the user to fetch a code.
      try {
        await bridgeFetch('/catalog');
      } catch (e: any) {
        setPair(p => ({
          ...p,
          status: 'error',
          message: `Bridge unreachable or pairing stale (${e.message}). Start \`fyaisa connect --lan\` on the PC, or re-pair.`,
        }));
        return;
      }
      const {code} = await bridgeFetch('/pair/request', {method: 'POST'});
      setPair(p => ({...p, code, status: 'awaiting', message: `Enter code ${code} on your PC`}));
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
              setPcInfo(await describePc(new Fyaisa(pair.host, ok.token, BRIDGE_PORT)));
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

  /** Queue a build+install on the PC and poll the job. */
  const requestInstall = useCallback(
    async (appId: string) => {
      try {
        const {jobId} = await bridgeFetch('/install', {
          method: 'POST',
          body: JSON.stringify({appId}),
        });
        setPair(p => ({...p, job: {id: jobId, status: 'queued', log: []}, message: `Installing ${appId}…`}));
        const iv = setInterval(async () => {
          try {
            const job = await bridgeFetch(`/job?id=${jobId}`);
            setPair(p => ({...p, job}));
            if (['done', 'error'].includes(job.status)) {
              clearInterval(iv);
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
    [bridgeFetch],
  );

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      console.info(`[FYAISA] catalog loaded: ${data.apps.length} app(s)`);
    } catch (e: any) {
      const msg = (e && e.message) || String(e);
      console.error(`[FYAISA] catalog fetch failed: ${msg}`);
      setError(msg);
      setCatalog(FALLBACK_CATALOG);
    } finally {
      setLoading(false);
      hideSplashScreenCallback();
    }
  }, [hideSplashScreenCallback]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const apps = useMemo(() => catalog?.apps ?? [], [catalog]);
  const selected = useMemo(
    () => apps.find(a => a.id === selectedId) ?? null,
    [apps, selectedId],
  );

  // Remote navigation is handled natively: Pressable rows take D-pad focus
  // (the first row seeded with hasTVPreferredFocus), and Back is caught through
  // BackHandler. Do NOT reach for document/window here — this is a native
  // React Native for Vega app, not a WebView, so those do not exist (using them
  // crashed the app with "ReferenceError: Property 'document' doesn't exist").
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedId) {
        setSelectedId(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectedId]);

  // Connect screen.
  if (selectedId === '__connect__') {
    return (
      <View style={styles.wrap}>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.brand}>Connect to PC</Text>
          <Text style={styles.tagline}>
            Pair with `fyaisa connect` on your computer so this TV can install apps.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 1 — on your computer</Text>
            <Text style={styles.code}>fyaisa connect --lan</Text>
            <Text style={styles.howtoBody}>
              Leave that window open. It prints a 6-digit pairing code.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 2 — PC address</Text>
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
                <Text style={styles.forgetText}>Forget this PC</Text>
              </Pressable>
            ) : null}
          </View>

          <Pressable hasTVPreferredFocus style={focusable(styles.backBtn)} onPress={() => setSelectedId(null)}>
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
                  …or install from right here using the paired PC ({pair.host}):
                </Text>
                <Pressable
                  hasTVPreferredFocus
                  style={focusable(styles.installBtn)}
                  onPress={() => requestInstall(selected.id)}>
                  <Text style={styles.backText}>Install via PC ({pair.host})</Text>
                </Pressable>
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
              <Text style={styles.howtoBody}>
                Pair a PC (FYAISA → Connect) to install from the couch.
              </Text>
            )}
            <Text style={styles.howtoBody}>Hub: {HUB_URL}</Text>
          </View>

          <Pressable hasTVPreferredFocus style={focusable(styles.backBtn)} onPress={() => setSelectedId(null)}>
            <Text style={styles.backText}>Back to catalog</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // List view.
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.brand}>{catalog?.hub?.name ?? 'FYAISA'}</Text>
        {catalog?.hub?.tagline ? <Text style={styles.tagline}>{catalog.hub.tagline}</Text> : null}
      </View>

      <View style={styles.connectBar}>
        <Pressable
          hasTVPreferredFocus
          style={focusable(styles.connectBtn)}
          onPress={() => setSelectedId('__connect__')}>
          <Text style={styles.connectText}>
            {pair.status === 'paired'
              ? `PC: ${pair.host} (connected)`
              : `Connect to PC — ${pair.message}`}
          </Text>
        </Pressable>
      </View>

      {loading ? (
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

          {apps.length === 0 ? (
            <Text style={styles.dim}>No apps in the catalog yet.</Text>
          ) : null}

          {apps.map((a, i) => (
            <Pressable
              key={a.id}
              hasTVPreferredFocus={i === 0}
              focusable
              style={({focused}) => [styles.row, focused && styles.rowFocused, focused && styles.focused]}
              onPress={() => setSelectedId(a.id)}>
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
          ))}
        </ScrollView>
      )}
    </View>
  );
};

const Badge = ({label, color}: {label: string; color: string}) => (
  <View style={[styles.badge, {borderColor: color}]}>
    <Text style={[styles.badgeText, {color}]}>{label}</Text>
  </View>
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
  rowMain: {flex: 1, paddingRight: 16},
  rowTitle: {color: '#fff', fontSize: 22, fontWeight: '600'},
  rowId: {color: '#6f6f80', fontSize: 13, marginTop: 2},
  rowSummary: {color: '#b9b9c6', fontSize: 15, marginTop: 6},
  dot: {width: 12, height: 12, borderRadius: 6},
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
  connectBar: {paddingHorizontal: 40, paddingBottom: 4},
  connectBtn: {
    backgroundColor: '#1c2733',
    borderRadius: 8,
    borderWidth: 4,
    borderColor: '#2d4a63',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  connectText: {color: '#9fd0ff', fontSize: 16},
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
  /**
   * The TV focus ring. Without it the selected control is nearly invisible on
   * this dark UI — every focusable appends this when focused, giving a thick
   * amber border plus a glow. Bases above carry a transparent 4px border so
   * focusing never shifts layout.
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
