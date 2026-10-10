/**
 * ElevSH Files — a D-pad file explorer for Vega OS Fire TV devices.
 *
 * The app itself is sandboxed: KeplerFileSystem only exposes /data, /tmp,
 * /pkg and /proc of THIS app (see the KeplerFileSystem README), which makes a
 * useless "explorer". The real device filesystem is reached over ElevSH: the
 * app runs `vega device run-cmd` commands on the paired PC through the
 * bridge's /vega endpoint (allowlisted `vega` subset, no shell on the PC,
 * output capped, timeout enforced).
 *
 * Security note: the bridge's per-argument whitelist
 * (/^[A-Za-z0-9 ._/:=,@+-]+$/) is also our sanitizer — the command string we
 * build from directory listings can only contain that character set, so no
 * shell metacharacters ever reach the device shell. Filenames with spaces or
 * exotic characters simply fail with a clear error (listing still works: ls
 * output is parsed field-wise).
 *
 * Pairing: same model as every FYAISA hub app — host keypad → requestCode
 * with our appId → the bridge auto-approves when FYAISA has allowed us and
 * the request comes from this TV; otherwise the user approves in FYAISA →
 * ElevSH (or `fyaisa approve <code>` on the PC). Pairing persists in
 * /data/bridge.json.
 */
import * as React from 'react';
import {useCallback, useEffect, useMemo, useState} from 'react';
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

const BRIDGE_PORT = 47821;
const APP_ID = 'app.fyaisa.files.main';
/** Where the pairing is persisted (this app's sandboxed, reboot-persistent /data). */
const STORE_PATH = '/data/bridge.json';
/** How much of a file to fetch for the preview (the bridge caps output anyway). */
const PREVIEW_BYTES = 65536;
/** How much of the preview we hand to Text (more janks the TV). */
const PREVIEW_CHARS = 20000;
/** Upper bound on rendered rows — /proc-style directories can be huge. */
const MAX_ROWS = 400;

type SavedPair = {host: string; token: string};

const savePair = async (p: SavedPair) => {
  try {
    // writeStringToFile fails with AlreadyExistsError if the file is there —
    // remove first (the pairing file is tiny; atomicity doesn't matter).
    await KeplerFileSystem.removeFile(STORE_PATH).catch(() => {});
    await KeplerFileSystem.writeStringToFile(STORE_PATH, JSON.stringify(p), 'UTF-8');
    console.info(`[Files] pairing saved to ${STORE_PATH}`);
  } catch (e: any) {
    console.error(`[Files] could not save pairing: ${e?.message || e}`);
  }
};

const loadPair = async (): Promise<SavedPair | null> => {
  try {
    if (!(await KeplerFileSystem.exists(STORE_PATH))) return null;
    const p = JSON.parse(await KeplerFileSystem.readFileAsString(STORE_PATH, 'UTF-8'));
    if (p && p.host && p.token) {
      console.info(`[Files] pairing restored from ${STORE_PATH}`);
      return p as SavedPair;
    }
    return null;
  } catch (e: any) {
    console.error(`[Files] could not read saved pairing: ${e?.message || e}`);
    return null;
  }
};

const clearPair = async () => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH);
    console.info('[Files] pairing cleared');
  } catch {
    // Missing file is fine — nothing to forget.
  }
};

type Entry = {name: string; dir: boolean; size: number | null};
type Viewer = {
  name: string;
  full: string;
  size: number | null;
  loading: boolean;
  content: string | null;
  binary: boolean;
  truncated: boolean;
  error: string | null;
};

/** Control characters other than tab/LF/CR ⇒ treat the preview as binary. */
const looksBinary = (s: string): boolean => {
  const n = Math.min(s.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
};

/**
 * Parse `ls -la <dir>` output from the device.
 *
 * Device format (verified on a Fire TV Stick HD):
 *   -rw-rw-rw-  1 app_user app_user 500660 2026-10-10 00:59 name...
 *   d?????????  ? ?        ?             ?                ? name...   (not stat-able)
 * i.e. seven whitespace-separated fields then the name — the date is ISO
 * (YYYY-MM-DD HH:MM); GNU "Oct 9 10:00" style shifts the name to field 8.
 * For symlinks we list the link itself, not its target.
 */
const parseLs = (out: string): Entry[] => {
  const res: Entry[] = [];
  for (const line of out.split('\n')) {
    if (!line || /^total\s/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const perms = parts[0];
    if (!/^[bcdlps-]/.test(perms)) continue;
    const nameAt = /^[A-Za-z]{3}/.test(parts[5]) ? 8 : 7; // month-name vs ISO date
    if (parts.length <= nameAt) continue;
    let name = parts.slice(nameAt).join(' ');
    if (perms[0] === 'l') name = name.split(' -> ')[0];
    if (!name || name === '.' || name === '..') continue;
    res.push({
      name,
      dir: perms[0] === 'd',
      size: /^\d+$/.test(parts[4]) ? Number(parts[4]) : null,
    });
  }
  res.sort((a, b) =>
    a.dir === b.dir ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.dir ? -1 : 1,
  );
  return res;
};

const joinPath = (base: string, name: string) => (base === '/' ? `/${name}` : `${base}/${name}`);
const parentPath = (p: string) => {
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

const humanSize = (n: number | null): string => {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};

// D-pad-friendly keypad for typing a dotted IPv4 address / hostname.
const HOST_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.', '⌫'];

/** Wrap a base style so a Pressable renders the TV focus ring when focused. */
const focusable = (base: any) => ({focused}: {focused: boolean}) =>
  [base, focused && styles.focused];

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [pair, setPair] = useState<SavedPair | null>(null);
  const [phase, setPhase] = useState<'setup' | 'browse'>('setup');
  const [host, setHost] = useState('');
  const [status, setStatus] = useState('Not connected');
  const [busy, setBusy] = useState(false);
  /** Live ElevSH access verdict for this app (shown while on setup). */
  const [accessLine, setAccessLine] = useState<string | null>(null);

  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const fy = useMemo(
    () => (pair ? Fyaisa.from({host: pair.host, token: pair.token, appId: APP_ID}) : null),
    [pair],
  );

  /** Run a single command string on the device via the bridge's /vega. */
  const runCmd = useCallback(
    async (cmd: string, timeoutMs: number = 30000): Promise<string> => {
      if (!fy) throw new Error('not paired with a PC yet');
      const r = await fy.vega(['device', 'run-cmd', '--command', cmd], timeoutMs);
      if (!r.ok && !r.stdout) {
        const lines = (r.stderr || '').split('\n').map(s => s.trim()).filter(Boolean);
        throw new Error(lines[lines.length - 1] || `command failed (exit ${r.exitCode})`);
      }
      return r.stdout;
    },
    [fy],
  );

  const loadDir = useCallback(
    async (dir: string) => {
      if (!fy) return;
      setListBusy(true);
      setListErr(null);
      try {
        const out = await runCmd(`ls -la ${dir}`);
        setEntries(parseLs(out));
        setPath(dir);
        console.info(`[Files] listed ${dir}`);
      } catch (e: any) {
        if (e instanceof FyaisaError && e.status === 401) {
          // Stale pairing — heal like the other hub apps do.
          await clearPair();
          setPair(null);
          setPhase('setup');
          setStatus('Pairing expired — pair again');
          setEntries(null);
        }
        setListErr(e?.message || String(e));
        console.warn(`[Files] ls ${dir} failed: ${e?.message || e}`);
      } finally {
        setListBusy(false);
      }
    },
    [fy, runCmd],
  );

  // Restore a previous pairing on launch; 401 clears it, other errors just
  // mean the PC is offline (stay on setup with the saved address prefilled).
  useEffect(() => {
    let dead = false;
    (async () => {
      const saved = await loadPair();
      if (dead) return;
      if (!saved) {
        hideSplashScreenCallback();
        return;
      }
      setHost(saved.host);
      try {
        await Fyaisa.from({host: saved.host, token: saved.token, appId: APP_ID}).catalog();
        if (!dead) {
          setPair(saved);
          setPhase('browse');
          setStatus('Connected');
        }
      } catch (e: any) {
        if (e instanceof FyaisaError && e.status === 401) {
          await clearPair();
          if (!dead) {
            setStatus('Pairing expired — pair again');
          }
        } else if (
          e instanceof FyaisaError &&
          (e.code === 'access_denied' || e.code === 'access_required')
        ) {
          if (!dead) {
            setStatus(
              e.code === 'access_denied'
                ? 'ElevSH access denied for this app — allow it in FYAISA → ElevSH'
                : 'ElevSH access not granted yet — allow this app in FYAISA → ElevSH',
            );
          }
        } else if (!dead) {
          setStatus(`Saved pairing for ${saved.host} — the PC looks offline right now`);
        }
      } finally {
        if (!dead) {
          hideSplashScreenCallback();
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [hideSplashScreenCallback]);

  // List the first directory once we enter browse.
  useEffect(() => {
    if (phase === 'browse' && fy && entries === null && !listBusy) {
      loadDir('/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fy]);

  // Setup screen: keep showing whether FYAISA has allowed this app yet, so
  // the user knows if Connect will auto-pair or ask for approval first.
  useEffect(() => {
    if (phase !== 'setup') return;
    const h = host.trim();
    if (!h) {
      setAccessLine(null);
      return;
    }
    let dead = false;
    const check = async () => {
      try {
        const st = await Fyaisa.accessStatus(h, APP_ID, BRIDGE_PORT);
        if (dead) return;
        setAccessLine(
          st.status === 'allow'
            ? 'ElevSH access: allowed — Connect pairs automatically.'
            : st.status === 'deny'
              ? 'ElevSH access: DENIED — allow this app in FYAISA → ElevSH.'
              : st.status === 'pending'
                ? `ElevSH access: pending — allow "${APP_ID}" in FYAISA → ElevSH.`
                : 'ElevSH access: not requested yet — Connect once, then allow this app in FYAISA → ElevSH.',
        );
      } catch {
        if (!dead) {
          setAccessLine(null); // bridge offline — the status line says so
        }
      }
    };
    check();
    const iv = setInterval(check, 5000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [phase, host]);

  /** Pair (or re-pair) with the PC whose address is in the keypad. */
  const connect = useCallback(async () => {
    const h = host.trim();
    if (!h) {
      setStatus('Enter your computer’s address first');
      return;
    }
    setBusy(true);
    setStatus('Requesting pairing…');
    try {
      const {code, autoApproved} = await Fyaisa.requestCode(h, BRIDGE_PORT, APP_ID);
      setStatus(
        autoApproved
          ? 'ElevSH access already allowed — connecting…'
          : `Allow this app in FYAISA → ElevSH, or run on the PC: fyaisa approve ${code}`,
      );
      const p = await Fyaisa.waitForApproval(h, code, BRIDGE_PORT, 2000, 600000, {
        appId: APP_ID,
      });
      await savePair(p);
      setPair(p);
      setStatus('Connected');
      console.info('[Files] paired with bridge');
    } catch (e: any) {
      setStatus(e?.message || String(e));
      console.warn(`[Files] pairing failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [host]);

  const openEntry = useCallback(
    async (e: Entry) => {
      if (e.dir) {
        await loadDir(joinPath(path, e.name));
        return;
      }
      const full = joinPath(path, e.name);
      setViewer({
        name: e.name,
        full,
        size: e.size,
        loading: true,
        content: null,
        binary: false,
        truncated: false,
        error: null,
      });
      try {
        const out = await runCmd(`head -c ${PREVIEW_BYTES} ${full}`);
        const binary = looksBinary(out);
        setViewer(v =>
          v
            ? {
                ...v,
                loading: false,
                content: out,
                binary,
                truncated: (e.size ?? 0) > PREVIEW_BYTES,
              }
            : v,
        );
      } catch (err: any) {
        if (err instanceof FyaisaError && err.status === 401) {
          await clearPair();
          setPair(null);
          setPhase('setup');
          setStatus('Pairing expired — pair again');
        }
        setViewer(v => (v ? {...v, loading: false, error: err?.message || String(err)} : v));
      }
    },
    [path, loadDir, runCmd],
  );

  // Remote Back: viewer → listing, directory → parent, root → exit (setup → exit).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'setup') return false;
      if (viewer) {
        setViewer(null);
        return true;
      }
      if (path !== '/') {
        loadDir(parentPath(path));
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [phase, viewer, path, loadDir]);

  // -------------------------------------------------------------------------
  // Setup screen
  // -------------------------------------------------------------------------
  if (phase === 'setup') {
    return (
      <View style={styles.wrap}>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.brand}>ElevSH Files</Text>
          <Text style={styles.tagline}>
            Browse this Fire TV's filesystem from the couch. The app talks to
            your computer over ElevSH — the same pairing FYAISA uses.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 1 — on your computer</Text>
            <Text style={styles.code}>fyaisa connect --lan</Text>
            <Text style={styles.howtoBody}>Leave that window open.</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 2 — computer address</Text>
            <Text style={styles.code}>{host || 'not set'}</Text>
            <View style={styles.keypad}>
              {HOST_KEYS.map((k, i) => (
                <Pressable
                  key={i}
                  hasTVPreferredFocus={i === 0}
                  style={({focused}) => [
                    styles.key,
                    focused && styles.keyFocused,
                    focused && styles.focused,
                  ]}
                  onPress={() => {
                    if (k === '⌫') {
                      setHost(h => h.slice(0, -1));
                    } else {
                      setHost(h => h + k);
                    }
                  }}>
                  <Text style={styles.keyText}>{k}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Step 3 — connect</Text>
            <Text style={styles.statusLine}>Status: {status}</Text>
            {accessLine ? <Text style={styles.accessLine}>{accessLine}</Text> : null}
            {busy ? (
              <ActivityIndicator size="large" color="#fff" style={{marginTop: 12}} />
            ) : null}
            <Pressable style={focusable(styles.connectBtn)} onPress={connect} disabled={busy}>
              <Text style={styles.backText}>{busy ? 'Working…' : 'Connect'}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // File viewer
  // -------------------------------------------------------------------------
  if (viewer) {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.viewerTitle} numberOfLines={1}>
            {viewer.name}
          </Text>
          <Text style={styles.viewerMeta}>
            {viewer.full} · {humanSize(viewer.size)}
            {viewer.truncated ? ` · showing first ${humanSize(PREVIEW_BYTES)}` : ''}
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {viewer.loading ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.dim}>Reading file…</Text>
            </View>
          ) : viewer.error ? (
            <Text style={styles.warn}>{viewer.error}</Text>
          ) : viewer.binary ? (
            <Text style={styles.warn}>
              Binary file — no text preview. ({humanSize(viewer.size)})
            </Text>
          ) : (
            <Text style={styles.mono}>
              {(viewer.content || '').slice(0, PREVIEW_CHARS)}
              {(viewer.content || '').length > PREVIEW_CHARS ? '\n… (display truncated)' : ''}
            </Text>
          )}
          <Pressable
            hasTVPreferredFocus
            style={focusable(styles.backBtn)}
            onPress={() => setViewer(null)}>
            <Text style={styles.backText}>Back to listing</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Browse
  // -------------------------------------------------------------------------
  const shown = (entries || []).slice(0, MAX_ROWS);
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.brandSmall}>ElevSH Files</Text>
        <Text style={styles.path}>{path}</Text>
        {pair ? <Text style={styles.hostLine}>via {pair.host}</Text> : null}
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {path !== '/' ? (
          <Pressable
            hasTVPreferredFocus
            focusable
            style={({focused}) => [
              styles.row,
              focused && styles.rowFocused,
              focused && styles.focused,
            ]}
            onPress={() => loadDir(parentPath(path))}>
            <Text style={[styles.rowName, styles.rowDir]}>..</Text>
          </Pressable>
        ) : null}

        {listBusy && !entries ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.dim}>Listing {path}…</Text>
          </View>
        ) : null}

        {listErr && !listBusy ? <Text style={styles.warn}>{listErr}</Text> : null}

        {entries && entries.length === 0 && !listBusy && !listErr ? (
          <Text style={styles.dim}>Empty directory.</Text>
        ) : null}

        {shown.map((e, i) => (
          <Pressable
            key={`${i}-${e.name}`}
            hasTVPreferredFocus={path === '/' && i === 0}
            focusable
            style={({focused}) => [
              styles.row,
              focused && styles.rowFocused,
              focused && styles.focused,
            ]}
            onPress={() => openEntry(e)}>
            <Text style={[styles.rowName, e.dir && styles.rowDir]} numberOfLines={1}>
              {e.dir ? `${e.name}/` : e.name}
            </Text>
            <Text style={styles.rowSize}>{e.dir ? '' : humanSize(e.size)}</Text>
          </Pressable>
        ))}

        {(entries || []).length > MAX_ROWS ? (
          <Text style={styles.dim}>
            …showing the first {MAX_ROWS} of {entries!.length} entries.
          </Text>
        ) : null}

        <Pressable
          focusable
          style={({focused}) => [
            styles.row,
            focused && styles.rowFocused,
            focused && styles.focused,
          ]}
          onPress={() => loadDir(path)}>
          <Text style={[styles.rowName, styles.rowRefresh]}>Refresh</Text>
        </Pressable>

        {listBusy && entries ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.dim}>Reloading…</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: '#0b0b0f'},
  header: {paddingHorizontal: 40, paddingTop: 32, paddingBottom: 14},
  brand: {color: '#fff', fontSize: 40, fontWeight: '700'},
  brandSmall: {color: '#fff', fontSize: 26, fontWeight: '700'},
  tagline: {color: '#8b8b99', fontSize: 17, marginTop: 6},
  path: {color: '#7ee787', fontSize: 18, fontFamily: 'monospace', marginTop: 8},
  hostLine: {color: '#6f6f80', fontSize: 14, marginTop: 3},
  dim: {color: '#77778a', fontSize: 16, marginTop: 12},
  warn: {color: '#ffb300', fontSize: 15, marginTop: 6, lineHeight: 21},
  list: {paddingHorizontal: 40, paddingBottom: 40},
  loadingBlock: {alignItems: 'center', paddingVertical: 24},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161d',
    borderRadius: 8,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  rowFocused: {backgroundColor: '#1e1e28'},
  rowName: {flex: 1, color: '#b9b9c6', fontSize: 19, fontFamily: 'monospace'},
  rowDir: {color: '#fff', fontWeight: '600'},
  rowRefresh: {color: '#9fd0ff'},
  rowSize: {color: '#6f6f80', fontSize: 14, marginLeft: 12, fontFamily: 'monospace'},
  viewerTitle: {color: '#fff', fontSize: 30, fontWeight: '700'},
  viewerMeta: {color: '#6f6f80', fontSize: 14, marginTop: 4, fontFamily: 'monospace'},
  mono: {color: '#c9c9d6', fontSize: 15, lineHeight: 21, fontFamily: 'monospace'},
  card: {
    backgroundColor: '#16161d',
    borderRadius: 10,
    padding: 18,
    marginTop: 18,
  },
  cardTitle: {color: '#fff', fontSize: 19, fontWeight: '600', marginBottom: 10},
  howtoBody: {color: '#a9a9b8', fontSize: 15, lineHeight: 21},
  code: {
    color: '#7ee787',
    fontSize: 17,
    marginVertical: 12,
    fontFamily: 'monospace',
  },
  statusLine: {color: '#b9b9c6', fontSize: 15, marginBottom: 8},
  accessLine: {color: '#7fd18c', fontSize: 14, marginBottom: 4},
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
  connectBtn: {
    marginTop: 16,
    alignSelf: 'flex-start',
    backgroundColor: '#1c7d32',
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  backBtn: {
    marginTop: 24,
    alignSelf: 'flex-start',
    backgroundColor: '#e50914',
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 4,
    borderColor: 'transparent',
  },
  backText: {color: '#fff', fontSize: 18},
  /**
   * The TV focus ring — every focusable appends this when focused. Bases
   * carry a transparent 4px border so focusing never shifts layout.
   */
  focused: {
    borderColor: '#ffb02e',
    shadowColor: '#ffb02e',
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
});

export default App;
