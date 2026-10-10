/**
 * Super Mario Bros for Vega OS.
 *
 * A NES emulator shell: jsnes runs inside a Vega WebView (file:///pkg/assets
 * is the WebView's default file access) and draws to a canvas. The shell page
 * ships as an app asset; the ROM is not bundled. On first launch the app
 * downloads the ROM from an external host, caches it on the device as base64,
 * and hands it to the shell in 16 KB order-independent chunks: the bridge
 * drops oversized injectJavaScript payloads, so the page stores each slice
 * under its index and boots when the set is complete (the DOOM/VegaTube
 * pattern).
 *
 * Remote mapping, split the way the OS 2.0 WebView likes it:
 * - D-Pad        = NES D-Pad      (the page's own key events)
 * - OK/Enter     = A, held        (the page's own key events, so Mario runs)
 * - Menu         = Start          (system key, forwarded from here)
 * - Back         = Select         (system key, caught with BackHandler)
 * - Fast-forward = A              (system key, forwarded from here)
 * - Play/Pause   = B              (system key, forwarded from here)
 *
 * Back would otherwise leave the app, so it is consumed and becomes Select;
 * Home still exits. Every unmapped TV event is logged so a new button shows
 * up in logcat.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  Pressable,
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';

const SHELL_URI = 'file:///pkg/assets/smb/index.html';

/** ROM host (not bundled): archive.org's complete US NES set, first launch only. */
const ROM_URL =
  'https://archive.org/download/US-NES-Rom-Complete/Super%20Mario%20Bros.%20%28USA%29.nes';

/** Per-app storage: the ROM is cached as base64 so it downloads once. */
const ROM_CACHE_PATH = '/data/smb-rom.b64';

/** Bridge-safe payload size: what VegaTube and DOOM ship their bundles in. */
const CHUNK_SIZE = 16 * 1024;

/** base64 of "NES\x1a", the iNES magic every ROM starts with. */
const ROM_MAGIC_B64 = 'TkVT';

/** If a forwarded hold never gets its release, drop it rather than stick. */
const HOLD_SAFETY_MS = 4000;

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of raw bytes (Hermes has no reliable btoa). */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64[b2 & 63] : '=';
  }
  return out;
};

/** Momentary button tap in the page (Start/Select/B). */
const tapScript = (button: string): string =>
  `window.__smbTap&&window.__smbTap('${button}');true;`;

/** Source-tracked hold in the page (A, from a system-held button). */
const holdScript = (button: string, down: boolean): string =>
  `window.__smbHold&&window.__smbHold('${button}','tv',${down});true;`;

/** D-pad goes straight to the page; do not log those.
 *  (const object because TS lacks a clean string-literal set here) */
const NAV: Record<string, boolean> = {
  up: true,
  down: true,
  left: true,
  right: true,
};

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();
  const webRef = useRef<any>(null);
  const startedRef = useRef(false);
  const ffReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Preparing Super Mario Bros...');
  const [error, setError] = useState<string | null>(null);
  const [shellKey, setShellKey] = useState(0);

  const inject = useCallback((js: string) => {
    const web = webRef.current as any;
    if (web?.injectJavaScript) {
      web.injectJavaScript(js);
    }
  }, []);

  const clearFfTimer = useCallback(() => {
    if (ffReleaseTimer.current) {
      clearTimeout(ffReleaseTimer.current);
      ffReleaseTimer.current = null;
    }
  }, []);

  const loadRom = useCallback(async () => {
    try {
      setError(null);
      setStatus('Checking for the ROM...');

      let base64: string | null = null;
      const cached = await KeplerFileSystem.exists(ROM_CACHE_PATH).catch(
        () => false,
      );
      if (cached) {
        base64 = await KeplerFileSystem.readFileAsString(
          ROM_CACHE_PATH,
          'UTF-8',
        ).catch(() => null);
        // A truncated or corrupt cache is worse than no cache: drop it.
        if (base64 && !base64.startsWith(ROM_MAGIC_B64)) {
          console.warn('[smb] cached ROM failed its magic check, refetching');
          base64 = null;
        }
        if (!base64) {
          await KeplerFileSystem.removeFile(ROM_CACHE_PATH).catch(() => {});
        }
      }

      if (!base64) {
        setStatus('Downloading Super Mario Bros (one time)...');
        const res = await fetch(ROM_URL);
        if (!res.ok) {
          throw new Error(`the ROM host returned HTTP ${res.status}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length < 16) {
          throw new Error('the ROM download came back empty');
        }
        base64 = bytesToBase64(bytes);
        await KeplerFileSystem.removeFile(ROM_CACHE_PATH).catch(() => {});
        await KeplerFileSystem.writeStringToFile(
          ROM_CACHE_PATH,
          base64,
          'UTF-8',
        ).catch(() => {});
      }

      setStatus('Starting the emulator...');
      const total = Math.ceil(base64.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const part = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        inject(
          `window.__smbPush&&window.__smbPush(${i},${total},${JSON.stringify(part)});`,
        );
      }
      console.info(`[smb] sent ${total} ROM chunks`);
    } catch (e: any) {
      console.error('[smb] ROM load failed:', e);
      setError(e?.message || String(e));
    }
  }, [inject]);

  const onLoad = useCallback(() => {
    console.info('[smb] shell loaded');
    hideSplashScreenCallback();
    if (!startedRef.current) {
      startedRef.current = true;
      void loadRom();
    }
  }, [hideSplashScreenCallback, loadRom]);

  const onError = useCallback(
    (event: any) => {
      const description = event?.nativeEvent?.description || 'unknown error';
      console.error(`[smb] WebView error: ${description}`);
      hideSplashScreenCallback();
      setError(description);
    },
    [hideSplashScreenCallback],
  );

  const onMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'SMB_LOG') {
        return;
      }
      console.info(`[smb] ${msg.message}`);
      if (msg.message === 'running') {
        setReady(true);
      } else if (String(msg.message).indexOf('boot failed') === 0) {
        setError(String(msg.message).replace('boot failed: ', ''));
      }
    } catch {
      // Not our JSON.
    }
  }, []);

  // Menu, the media transport keys, and Back are system buttons the WebView
  // does not pass through; forward the ones that matter and log the rest.
  // Fast-forward is a hold (so Mario runs), the others are taps.
  useTVEventHandler(
    useCallback(
      (event: HWEvent) => {
        if (error) {
          return;
        }
        const type = event.eventType;
        const action = event.eventKeyAction;
        if (type === 'forward' || type === 'ff' || type === 'skip_forward') {
          if (action === 1) {
            clearFfTimer();
            inject(holdScript('a', false));
          } else {
            inject(holdScript('a', true));
            clearFfTimer();
            ffReleaseTimer.current = setTimeout(() => {
              console.warn('[smb] fast-forward never released, dropping hold');
              inject(holdScript('a', false));
            }, HOLD_SAFETY_MS);
          }
          return;
        }
        if (action === 1) {
          return; // key release, we act on the press
        }
        if (type === 'menu') {
          inject(tapScript('start'));
        } else if (type === 'playpause' || type === 'pause') {
          inject(tapScript('b'));
        } else if (type === 'rewind') {
          inject(tapScript('select'));
        } else if (type === 'select') {
          // OK is normally the page's Enter; this covers a press Enter misses.
          inject(tapScript('a'));
        } else if (!NAV[type]) {
          console.info(`[smb] tv ${type} a${action ?? '?'}`);
        }
      },
      [clearFfTimer, error, inject],
    ),
  );

  // The WebView swallows Back, so the page never sees it: use it as Select.
  // Once the shell failed there is nothing to talk to, so Back exits instead.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!error) {
        inject(tapScript('select'));
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [error, inject]);

  useEffect(() => () => clearFfTimer(), [clearFfTimer]);

  const retry = useCallback(() => {
    clearFfTimer();
    setError(null);
    setReady(false);
    startedRef.current = false;
    setStatus('Preparing Super Mario Bros...');
    setShellKey(k => k + 1); // remount the shell; onLoad reloads the ROM
  }, [clearFfTimer]);

  return (
    <View style={styles.container}>
      <WebView
        key={shellKey}
        ref={webRef}
        style={styles.webview}
        source={{uri: SHELL_URI}}
        // Focus immediately so the remote drives the game.
        hasTVPreferredFocus={!error}
        javaScriptEnabled
        domStorageEnabled
        // Off so Back reaches the native BackHandler; arrows and Enter still
        // arrive at the page (same setting as VegaTube and Snake).
        allowSystemKeyEvents={false}
        mediaPlaybackRequiresUserAction={false}
        onLoad={onLoad}
        onError={onError}
        onMessage={onMessage}
      />

      {error ? (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Couldn&apos;t start Super Mario Bros</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>
            Check the Fire TV&apos;s network connection, then try again.
          </Text>
          <Pressable
            hasTVPreferredFocus
            style={({focused}: {focused: boolean}) => [
              styles.retryButton,
              focused && styles.focusedRing,
            ]}
            onPress={retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : !ready ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.statusText}>{status}</Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  statusText: {
    color: '#c6c6c6',
    fontSize: 18,
    marginTop: 16,
  },
  errorTitle: {
    color: '#fff',
    fontSize: 24,
    marginBottom: 12,
    textAlign: 'center',
  },
  errorText: {
    color: '#ccc',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorHint: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 28,
  },
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: '#e50914',
    borderRadius: 4,
  },
  retryText: {
    color: '#fff',
    fontSize: 18,
  },
  focusedRing: {
    borderColor: '#ffb02e',
    shadowColor: '#ffb02e',
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
});

export default App;
