/**
 * Aether for Vega OS
 * ------------------
 * A minimal React Native for Vega shell that loads the Aether streaming
 * web app (https://aether.ist) in a Vega WebView.
 *
 * Aether is an open-source P-Stream fork with no popup ads, no captchas,
 * and no sign-up required. It supports Movies / TV / Anime / 4K / Auto-Next.
 *
 * This app is a FYAISA hub app: it uses the FYAISA bridge for updates.
 */
import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  Pressable as KeplerPressable,
} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';
import {Fyaisa, FyaisaError} from './fyaisaClient';

const AETHER_URL = 'https://aether.ist';

// --- FYAISA integration ------------------------------------------------------
const BRIDGE_PORT = 47821;
const AETHER_APP_ID = 'app.aether.main';
const HUB_CATALOG_URL =
  'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json';
const STORE_PATH = '/data/bridge.json';

const APP_VERSION = '1.0.0';

// Cold-start retry policy
const MAX_AUTO_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1500;

// --- ElevSH pairing persistence ----------------------------------------------
type SavedPair = {host: string; token?: string};

const savePair = async (p: SavedPair) => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH).catch(() => {});
    await KeplerFileSystem.writeStringToFile(STORE_PATH, JSON.stringify(p), 'UTF-8');
    console.info(`[Aether] ElevSH pairing saved (${p.host}${p.token ? '' : ', host only'})`);
  } catch (e: any) {
    console.error(`[Aether] could not save pairing: ${e?.message || e}`);
  }
};

const loadPair = async (): Promise<SavedPair | null> => {
  try {
    if (!(await KeplerFileSystem.exists(STORE_PATH))) {
      return null;
    }
    const p = JSON.parse(await KeplerFileSystem.readFileAsString(STORE_PATH, 'UTF-8'));
    return p && p.host ? (p as SavedPair) : null;
  } catch {
    return null;
  }
};

const clearPair = async () => {
  try {
    await KeplerFileSystem.removeFile(STORE_PATH);
  } catch {
    // Nothing to forget.
  }
};

// --- TV focus ring -----------------------------------------------------------
const focusRing = ({focused}: {focused: boolean}) =>
  [styles.focusBase, focused && styles.focusedRing];
const menuFocus = ({focused}: {focused: boolean}) =>
  [styles.menuBtnWrap, focusRing({focused})];

export const App = () => {
  const webRef = useRef(null);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);

  const autoRetryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // FYAISA panel
  const [menu, setMenu] = useState<'hidden' | 'menu' | 'pair'>('menu');
  const [pair, setPair] = useState<SavedPair | null>(null);
  const [pairHost, setPairHost] = useState('');
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState('Checking the FYAISA hub…');
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [job, setJob] = useState<{status: string; log: string[]} | null>(null);
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    console.info(`[Aether] v${APP_VERSION}`);
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // Back handling: forward to the web page
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const web = webRef.current as any;
      if (!web?.injectJavaScript) {
        return false;
      }
      web.injectJavaScript(
        'window.history.back();',
      );
      return true;
    });
    return () => sub.remove();
  }, []);

  // FYAISA panel: load saved pairing + check hub for updates
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(HUB_CATALOG_URL);
        const cat = await res.json();
        if (cancelled) return;
        const entry = (cat.apps || []).find((a: any) => a.id === AETHER_APP_ID);
        const hubVersion = entry?.version;
        console.info(
          `[Aether] hub check: ${(cat.apps || []).length} app(s), catalog Aether ${
            hubVersion ? `v${hubVersion}` : 'not listed'
          }`,
        );
        setHubStatus(
          `FYAISA hub: ${(cat.apps || []).length} app(s) · Aether ${
            hubVersion ? `v${hubVersion}` : 'listed'
          }`,
        );
        if (hubVersion && hubVersion !== APP_VERSION) {
          setUpdateVersion(hubVersion);
          console.info(`[Aether] update available: v${APP_VERSION} -> v${hubVersion}`);
        }
      } catch {
        if (!cancelled) {
          setHubStatus('FYAISA hub unreachable (offline?)');
        }
      }

      const saved = await loadPair();
      if (cancelled || !saved) return;
      if (saved.token) {
        setPair(saved);
        verifyPair(saved);
        return;
      }
      setPairHost(saved.host);
      console.info('[Aether] host saved, no token — auto-pairing with ElevSH');
      startPair(saved.host);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-dismiss menu
  useEffect(() => {
    if (menu !== 'menu' || pairCode) return;
    menuTimerRef.current = setTimeout(() => setMenu('hidden'), 20000);
    return () => {
      if (menuTimerRef.current) clearTimeout(menuTimerRef.current);
    };
  }, [menu, pairCode]);

  // Back closes menu first
  useEffect(() => {
    if (menu === 'hidden') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMenu('hidden');
      return true;
    });
    return () => sub.remove();
  }, [menu]);

  const onLoad = useCallback(
    (_event: any) => {
      console.info('[Aether] Page loading completed');
      autoRetryRef.current = 0;
      setLoadError(null);
      setPageLoaded(true);
      hideSplashScreenCallback();
    },
    [hideSplashScreenCallback],
  );

  const onLoadStart = useCallback((_event: any) => {
    console.info('[Aether] Page loading started');
    setPageLoaded(false);
  }, []);

  const handleFailure = useCallback(
    (reason: string) => {
      console.error(`[Aether] ${reason}`);
      hideSplashScreenCallback();
      if (autoRetryRef.current < MAX_AUTO_RETRIES) {
        const attempt = autoRetryRef.current + 1;
        const delay = RETRY_BASE_DELAY_MS * attempt;
        console.info(
          `[Aether] load failed (${reason}); auto-retry ${attempt}/${MAX_AUTO_RETRIES} in ${delay}ms`,
        );
        autoRetryRef.current = attempt;
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          (webRef.current as any)?.reload();
        }, delay);
        return;
      }
      setLoadError(reason);
    },
    [hideSplashScreenCallback],
  );

  const onError = useCallback(
    ({nativeEvent: {code, url, description}}: any) => {
      console.warn(`[Aether] onError: (${code}: ${url}) ${description}`);
      handleFailure(`onError: (${code}: ${url}) ${description}`);
    },
    [handleFailure],
  );

  const onHttpError = useCallback(
    ({nativeEvent: {url, statusCode, description, isMainFrame}}: any) => {
      if (isMainFrame) {
        handleFailure(`onHttpError: (${statusCode}: ${url}) ${description}`);
      }
    },
    [handleFailure],
  );

  const retry = useCallback(() => {
    autoRetryRef.current = 0;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    setLoadError(null);
    setPageLoaded(false);
    (webRef.current as any)?.reload();
  }, []);

  // --- ElevSH panel actions -------------------------------------------------
  const dismissMenu = useCallback(() => setMenu('hidden'), []);

  const accessRetryRef = useRef(0);

  const verifyPair = useCallback(async (sp: SavedPair) => {
    if (!sp.token) return;
    try {
      await Fyaisa.from({host: sp.host, token: sp.token, appId: AETHER_APP_ID}).catalog();
      console.info(`[Aether] ElevSH bridge reachable at ${sp.host}`);
      accessRetryRef.current = 0;
      setHubStatus(prev => (prev && prev.startsWith('Allow') ? 'ElevSH connected' : prev));
    } catch (e: any) {
      if (e instanceof FyaisaError && e.status === 401) {
        await clearPair();
        setPair(null);
        setPairHost('');
        console.warn('[Aether] pairing expired — pair from the menu');
        setHubStatus('ElevSH pairing expired — pair again from the menu');
      } else if (e instanceof FyaisaError && e.code === 'access_denied') {
        console.warn('[Aether] ElevSH access denied in FYAISA');
        setHubStatus('ElevSH access denied for Aether — allow it in FYAISA');
      } else if (e instanceof FyaisaError && e.code === 'access_required') {
        console.info('[Aether] waiting for ElevSH access approval in FYAISA');
        setHubStatus('Allow Aether in FYAISA → ElevSH');
        if (accessRetryRef.current < 18) {
          accessRetryRef.current += 1;
          setTimeout(() => verifyPair(sp), 8000);
        }
      } else {
        console.info('[Aether] ElevSH offline during restore check');
        setHubStatus('ElevSH offline right now');
      }
    }
  }, []);

  const startPair = useCallback(
    async (hostArg?: string) => {
      const host = (hostArg ?? pairHost).trim();
      if (!host) {
        setHubStatus('Enter your computer’s address first (shown by fyaisa connect)');
        return;
      }
      try {
        setHubStatus('Requesting ElevSH pairing…');
        const {code, autoApproved} = await Fyaisa.requestCode(host, BRIDGE_PORT, AETHER_APP_ID);
        setPairCode(code);
        await savePair({host});
        setHubStatus(
          autoApproved
            ? 'ElevSH access already allowed — connecting…'
            : `Allow Aether in FYAISA → ElevSH (code ${code})`,
        );
        const p = await Fyaisa.waitForApproval(host, code, BRIDGE_PORT, 2000, 600000, {
          appId: AETHER_APP_ID,
        });
        await savePair(p);
        setPair(p);
        setPairCode(null);
        setHubStatus('ElevSH connected — updates install through it');
        setMenu('menu');
        console.info('[Aether] paired with ElevSH bridge');
        verifyPair(p);
      } catch (e: any) {
        setPairCode(null);
        setHubStatus(
          e instanceof FyaisaError && e.code === 'access_denied'
            ? 'ElevSH access denied for Aether — allow it in FYAISA'
            : `Pairing failed: ${e?.message || e}`,
        );
      }
    },
    [pairHost, verifyPair],
  );

  const forget = useCallback(async () => {
    await clearPair();
    setPair(null);
    setPairHost('');
    setHubStatus('ElevSH pairing forgotten');
  }, []);

  const updateViaPc = useCallback(async () => {
    const token = pair?.token;
    if (!pair || !token) return;
    const accessMsg = (e: any) =>
      e instanceof FyaisaError && e.code === 'access_required'
        ? 'Allow Aether in FYAISA → ElevSH first'
        : e instanceof FyaisaError && e.code === 'access_denied'
          ? 'ElevSH access denied in FYAISA'
          : null;
    try {
      const fy = Fyaisa.from({host: pair.host, token, appId: AETHER_APP_ID});
      const {jobId} = await fy.install(AETHER_APP_ID);
      setJob({status: 'queued', log: []});
      console.info(`[Aether] update job queued: ${jobId}`);
      const iv = setInterval(async () => {
        try {
          const j = await fy.job(jobId);
          setJob({status: j.status, log: (j.log || []).slice(-8)});
          if (j.status === 'done' || j.status === 'error') {
            clearInterval(iv);
            console.info(`[Aether] update job ${j.status}`);
          }
        } catch (e: any) {
          clearInterval(iv);
          setJob(prev => ({
            status: 'error',
            log: [...(prev?.log || []), accessMsg(e) || 'bridge unreachable'],
          }));
        }
      }, 2500);
    } catch (e: any) {
      setJob({status: 'error', log: [accessMsg(e) || String(e?.message || e)]});
    }
  }, [pair]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        source={{uri: AETHER_URL}}
        hasTVPreferredFocus
        javaScriptEnabled
        domStorageEnabled
        allowSystemKeyEvents={false}
        allowsDefaultMediaControl
        mixedContentMode="compatibility"
        mediaPlaybackRequiresUserAction={false}
        thirdPartyCookiesEnabled
        onLoad={onLoad}
        onLoadStart={onLoadStart}
        onError={onError}
        onHttpError={onHttpError}
      />

      {loadError && (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Couldn’t load Aether</Text>
          <Text style={styles.errorText}>{loadError}</Text>
          <Text style={styles.errorHint}>
            Check the Fire TV’s network connection, then retry.
          </Text>
          <KeplerPressable
            hasTVPreferredFocus
            onPress={retry}
            style={state => [styles.retryButton, focusRing(state)]}>
            <Text style={styles.retryText}>Retry</Text>
          </KeplerPressable>
        </View>
      )}

      {!loadError && !pageLoaded && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.loadingText}>Loading Aether…</Text>
        </View>
      )}

      {menu !== 'hidden' && (
        <View style={styles.menuOverlay}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Aether v{APP_VERSION}</Text>
            <Text style={styles.menuCredit}>A FYAISA hub app</Text>
            <Text style={styles.menuStatus}>{hubStatus}</Text>
            {pair ? (
              <Text style={styles.menuPaired}>Paired with {pair.host}</Text>
            ) : null}

            {menu === 'pair' ? (
              <>
                <Text style={styles.menuHint}>
                  Enter your computer’s address, then Get pairing code. Approve in
                  FYAISA → ElevSH, or on the PC: fyaisa approve &lt;code&gt;
                </Text>
                <View style={styles.keypad}>
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => (
                    <KeplerPressable
                      key={k}
                      style={focusRing}
                      onPress={() =>
                        setPairHost(h => (k === '⌫' ? h.slice(0, -1) : h + k))
                      }>
                      <View style={styles.key}>
                        <Text style={styles.keyText}>{k}</Text>
                      </View>
                    </KeplerPressable>
                  ))}
                </View>
                <Text style={styles.menuHost}>{pairHost || '…'}</Text>
                {pairCode ? (
                  <Text style={styles.menuCode}>Code: {pairCode}</Text>
                ) : null}
                <KeplerPressable hasTVPreferredFocus style={menuFocus} onPress={() => startPair()}>
                  <View style={styles.menuBtn}>
                    <Text style={styles.menuBtnText}>
                      {pairCode ? 'Waiting for approval…' : 'Get pairing code'}
                    </Text>
                  </View>
                </KeplerPressable>
                <KeplerPressable style={menuFocus} onPress={() => setMenu('menu')}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>Back</Text>
                  </View>
                </KeplerPressable>
              </>
            ) : (
              <>
                {updateVersion ? (
                  <KeplerPressable hasTVPreferredFocus style={menuFocus} onPress={updateViaPc}>
                    <View style={styles.menuBtn}>
                      <Text style={styles.menuBtnText}>
                        Update to v{updateVersion} via ElevSH
                      </Text>
                    </View>
                  </KeplerPressable>
                ) : null}
                <KeplerPressable
                  hasTVPreferredFocus={!updateVersion}
                  style={menuFocus}
                  onPress={() => setMenu('pair')}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>
                      {pair ? 'Change ElevSH host' : 'Pair with ElevSH'}
                    </Text>
                  </View>
                </KeplerPressable>
                {pair ? (
                  <KeplerPressable style={menuFocus} onPress={forget}>
                    <View style={styles.menuBtnGhost}>
                      <Text style={styles.menuBtnText}>Forget ElevSH</Text>
                    </View>
                  </KeplerPressable>
                ) : null}
                <KeplerPressable style={menuFocus} onPress={dismissMenu}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>Continue to Aether</Text>
                  </View>
                </KeplerPressable>
                {job ? (
                  <>
                    <Text style={styles.menuJobStatus}>Update: {job.status}</Text>
                    {job.log.map((l, i) => (
                      <Text key={i} style={styles.menuJobLine} numberOfLines={2}>
                        {l}
                      </Text>
                    ))}
                  </>
                ) : null}
              </>
            )}
            <Text style={styles.menuFooter}>
              Powered by FYAISA — ElevSH runs via “fyaisa connect” on your computer
            </Text>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000000'},
  webview: {flex: 1, backgroundColor: '#000000'},
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 16,
    color: '#aaaaaa',
    fontSize: 18,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  errorTitle: {
    color: '#ffffff',
    fontSize: 24,
    marginBottom: 12,
  },
  errorText: {
    color: '#cccccc',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorHint: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: '#1c7d32',
    borderRadius: 4,
  },
  retryText: {
    color: '#ffffff',
    fontSize: 18,
  },

  // --- FYAISA startup menu -------------------------------------------------
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6,6,10,0.94)',
    padding: 56,
    justifyContent: 'center',
  },
  menuCard: {maxWidth: 940},
  menuTitle: {color: '#ffffff', fontSize: 40, fontWeight: '700'},
  menuCredit: {color: '#8b8b99', fontSize: 16, marginTop: 4},
  menuStatus: {color: '#7ee787', fontSize: 17, marginTop: 14},
  menuPaired: {color: '#9fd0ff', fontSize: 15, marginTop: 4},
  menuHint: {color: '#a9a9b8', fontSize: 15, marginTop: 12, lineHeight: 21},
  menuHost: {color: '#ffffff', fontSize: 26, fontFamily: 'monospace', marginTop: 10},
  menuCode: {color: '#ffb02e', fontSize: 24, fontWeight: '700', marginTop: 8},
  keypad: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, maxWidth: 456},
  key: {
    width: 64,
    height: 54,
    margin: 4,
    borderRadius: 8,
    backgroundColor: '#23232d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {color: '#ffffff', fontSize: 22},
  menuBtn: {
    backgroundColor: '#1c7d32',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignSelf: 'flex-start',
  },
  menuBtnGhost: {
    backgroundColor: '#1e1e28',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignSelf: 'flex-start',
  },
  menuBtnWrap: {marginTop: 16},
  menuBtnText: {color: '#ffffff', fontSize: 18},
  menuFooter: {color: '#5c5c6b', fontSize: 13, marginTop: 24},
  menuJobStatus: {color: '#7ee787', fontSize: 15, marginTop: 14},
  menuJobLine: {
    color: '#8b8b99',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  focusBase: {
    alignSelf: 'flex-start',
    borderWidth: 3,
    borderColor: 'transparent',
    borderRadius: 8,
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