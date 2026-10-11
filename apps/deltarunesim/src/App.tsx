/**
 * DELTARUNE Fight Sim for Vega OS.
 *
 * A frame around deltarunesim.com, the free fan-made DELTARUNE/UNDERTALE
 * battle simulator by puskevi. The game is a WASM/WebGL app served from the
 * site; this app only wraps it in a Vega WebView and points the remote at its
 * keyboard controls. The same shape as the Google Snake and VegaTube apps.
 *
 * The simulator is keyboard-native: the arrow keys move your SOUL, Z confirms,
 * X backs out, Tab opens the toolbox. The Fire TV remote speaks none of those,
 * so the frame does three jobs around the page:
 *
 * - Funnels confirm presses. The remote's OK lands on the page as Enter (the
 *   site also accepts Enter) and separately as the TV hook's `select`; both
 *   are routed into ONE synthetic Z keydown by a document-start script, so a
 *   double press can never double-confirm. Back is caught with BackHandler
 *   and replayed as X (cancel). Menu is a system key the page never sees, so
 *   the TV hook forwards it as Tab (the toolbox: practice, rewind, slow-mo).
 * - Serves from the device cache. LOAD_CACHE_ELSE_NETWORK keeps the heavy
 *   WASM engine, textures and audio in the WebView disk cache after the first
 *   visit, so later boots don't re-download the whole bundle over wifi while
 *   a CPU-bound stick is already drowning in setup work.
 * - Explains itself. The loading/error layers tell the truth about this page:
 *   it is a beefy WebGL game and the Fire TV's WebView is the weak link. The
 *   boot-up-then-terminate recovery from HOMEBREW.md #9 is spelled out on the
 *   error screen instead of leaving the user staring at black.
 *
 * The page never gets a mouse: everything is keyboard events, so no synthetic
 * click plumbing is needed (unlike Snake). Every key and TV event is logged
 * as [deltarunesim] ... so an unmapped button still shows up in logcat.
 *
 * Back is consumed and becomes X while the page is up. Home still exits.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  Pressable,
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';

/** The simulator itself: root app page. */
const SITE_URL = 'https://deltarunesim.com/';

/**
 * Desktop Chrome: the client the site's own help describes for keyboard play
 * ("Z confirms, X goes back, arrow keys move your SOUL"), and a user agent
 * the site certainly knows how to serve.
 */
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/** Synthetic key presses from the TV hook. */
const Z_SCRIPT = 'window.__drsTap&&window.__drsTap("z");true;';
const X_SCRIPT = 'window.__drsTap&&window.__drsTap("x");true;';
const TAB_SCRIPT = 'window.__drsTap&&window.__drsTap("tab");true;';

/**
 * Runs before any page script, putting its keydown listener first in line,
 * ahead of everything the simulator registers:
 *
 * - Enter (the remote's OK reaching the page) is swallowed and replayed as a
 *   single-flighted synthetic Z, so OK from the keypipe and OK from the TV
 *   hook can only ever press the button once.
 * - `__drsTap(btn)` is the same funnel callable from the native side: z, x
 *   and Tab become real keydown/keyup pairs inside the game.
 * - Keypresses are forwarded to logcat (arrows filtered, they flood).
 *   Unhandled page errors are forwarded too, so a WASM crash on a weak stick
 *   shows as `page error` instead of a silent black screen.
 */
const EARLY_PROBE = `
(function () {
  function tell(msg) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'LOG', message: msg}));
    } catch (e) {}
  }
  tell('early probe: ua=' + navigator.userAgent +
       ' touch=' + navigator.maxTouchPoints);

  var lastPress = 0;
  var DEBOUNCE_MS = 260;

  function emit(key, code, prevent) {
    var now = Date.now();
    if (now - lastPress < DEBOUNCE_MS) {
      return; // single-flight: Enter and the TV hook share this funnel
    }
    lastPress = now;
    var opts = {key: key, code: code, keyCode: code, which: code,
                bubbles: true, cancelable: true};
    var down, up;
    try {
      down = new KeyboardEvent('keydown', opts);
      up = new KeyboardEvent('keyup', opts);
    } catch (e) {
      down = document.createEvent('KeyboardEvent');
      up = document.createEvent('KeyboardEvent');
    }
    if (prevent) {
      try { down.preventDefault(); } catch (e) {}
    }
    window.dispatchEvent(down);
    window.dispatchEvent(up);
    tell('emit ' + key + ' ' + code);
  }

  window.__drsTap = function (btn) {
    if (btn === 'z') { emit('z', 90, false); }
    else if (btn === 'x') { emit('x', 88, true); }
    else if (btn === 'tab') { emit('Tab', 9, true); }
    else { tell('tap ?' + btn); }
  };

  // Enter is the funnel the page sees; route it into the same single Z.
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.__drsTap('z');
    }
  }, true);

  // Everything else the page receives, reported once per logical keydown.
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'Enter' || k === 'ArrowUp' || k === 'ArrowDown' ||
        k === 'ArrowLeft' || k === 'ArrowRight' || k === 'z' ||
        k === 'Z' || k === 'x' || k === 'X') {
      return; // routed or familiar; logging them would flood logcat
    }
    tell('key ' + k + ' ' + e.keyCode);
  }, true);

  window.addEventListener('error', function (e) {
    tell('page error: ' + (e.message || e.type) +
         ' @ ' + (e.filename || '?').slice(0, 120));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    tell('page rejection: ' + String(e.reason).slice(0, 160));
  });

  tell('router ready');
  true;
})();
`;

/** D-pad from the TV hook: reaches the page on its own, only log it. */
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
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shellKey, setShellKey] = useState(0);

  const inject = useCallback((js: string) => {
    const web = webRef.current as any;
    if (web?.injectJavaScript) {
      web.injectJavaScript(js);
    }
  }, []);

  // OK, Menu and media keys are decided here; everything else is logged so a
  // button that is not mapped yet still shows up in logcat.
  useTVEventHandler(
    useCallback(
      (event: HWEvent) => {
        const type = event.eventType;
        if (event.eventKeyAction === 1) {
          return; // key release, we act on the press
        }
        if (type === 'select') {
          console.info('[deltarunesim] select -> Z');
          inject(Z_SCRIPT);
        } else if (type === 'menu') {
          console.info('[deltarunesim] menu -> Tab (toolbox)');
          inject(TAB_SCRIPT);
        } else if (type === 'playpause' || type === 'pause') {
          console.info('[deltarunesim] play/pause -> Z');
          inject(Z_SCRIPT);
        } else if (type === 'rewind') {
          console.info('[deltarunesim] rewind -> X');
          inject(X_SCRIPT);
        } else if (type === 'forward' || type === 'ff' || type === 'skip_forward') {
          console.info('[deltarunesim] fast-forward -> Tab (toolbox)');
          inject(TAB_SCRIPT);
        } else if (!NAV[type]) {
          console.info(`[deltarunesim] tv ${type} a${event.eventKeyAction ?? '?'}`);
        }
      },
      [inject],
    ),
  );

  // The WebView swallows Back, so it never reaches the page: use it as the
  // simulator's cancel (X). Once the page failed there is nothing to talk
  // to, so Back exits instead.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!loadError) {
        inject(X_SCRIPT);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [loadError, inject]);

  const onLoad = useCallback(() => {
    console.info('[deltarunesim] page loaded');
    hideSplashScreenCallback();
    setLoaded(true);
  }, [hideSplashScreenCallback]);

  const onError = useCallback(
    (event: any) => {
      const description = event?.nativeEvent?.description || 'unknown error';
      console.error(`[deltarunesim] WebView error: ${description}`);
      hideSplashScreenCallback();
      setLoadError(description);
    },
    [hideSplashScreenCallback],
  );

  const onMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'LOG') {
        console.info(`[deltarunesim] ${msg.message}`);
      }
    } catch {
      // Not our JSON.
    }
  }, []);

  const retry = useCallback(() => {
    setLoadError(null);
    setLoaded(false);
    setShellKey(k => k + 1); // remount the WebView; a cold boot fixes #9
  }, []);

  return (
    <View style={styles.container}>
      <WebView
        key={shellKey}
        ref={webRef}
        style={styles.webview}
        source={{uri: SITE_URL}}
        // Focus immediately so the remote drives the game.
        hasTVPreferredFocus
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={EARLY_PROBE}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        // Same as Snake, VegaTube and DOOM: arrows and Enter still reach the
        // page, Back stays with the native BackHandler (which forwards X).
        allowSystemKeyEvents={false}
        // After the first online visit the heavy WASM bundle, textures and
        // audio load from the device's disk cache: one download, not one per
        // boot. Offline, the cached engine still boots.
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        onLoad={onLoad}
        onError={onError}
        onHttpError={(event: any) => {
          console.info(
            `[deltarunesim] http ${event.nativeEvent.statusCode} ` +
              `for ${event.nativeEvent.description || SITE_URL}`,
          );
        }}
        // Not in Amazon's props type (Snake casts it the same way): log
        // every committed navigation, redirects included.
        {...({
          onNavigationStateChange: (nav: any) => {
            if (nav?.url) {
              console.info(
                `[deltarunesim] nav ${nav.url} loading=${nav.loading}`,
              );
            }
          },
        } as any)}
        onMessage={onMessage}
      />

      {!loaded && !loadError ? (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayTitle}>Loading DELTARUNE Fight Sim...</Text>
          <Text style={styles.overlayText}>
            First boot pulls the WASM engine from deltarunesim.com.
          </Text>
          <Text style={styles.overlayHint}>
            This one is heavy: if the screen stays black for a while, exit and
            relaunch once.
          </Text>
        </View>
      ) : null}

      {loadError ? (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Couldn&apos;t load the simulator</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
          <Text style={styles.errorHint}>
            The game streams from deltarunesim.com — check the stick is
            online, and note this is a WebGL/WASM sim that weaker Fire TV
            sticks may struggle to boot.
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
    padding: 40,
  },
  overlayTitle: {
    color: '#fff',
    fontSize: 24,
    marginBottom: 8,
    textAlign: 'center',
  },
  overlayText: {
    color: '#c6c6c6',
    fontSize: 16,
    textAlign: 'center',
  },
  overlayHint: {
    color: '#8a8a8a',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
  },
  errorTitle: {
    color: '#fff',
    fontSize: 22,
    marginBottom: 10,
    textAlign: 'center',
  },
  errorDetail: {
    color: '#bbb',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorHint: {
    color: '#777',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 24,
  },
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 4,
  },
  retryText: {
    color: '#000',
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