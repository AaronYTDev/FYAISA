/**
 * VegaTube for Vega OS (formerly TizenTube Vega)
 * ---------------------------------------------
 * A minimal React Native for Vega shell that loads the official YouTube for
 * TVs web app (https://www.youtube.com/tv) in a Vega WebView and injects the
 * upstream TizenTube userscript (ad block, SponsorBlock, DeArrow, speed
 * controls, theming) at document-start via a small native-bridge shim.
 *
 * VegaTube is the FYAISA example app: it proved out the Vega OS WebView
 * injection technique the hub is built on. It deliberately does not ship the
 * FYAISA (ElevSH) pairing client — ElevSH Files (apps/fileexplorer) is the
 * reference app for that. See docs/HOMEBREW.md.
 *
 * This mirrors how TizenTube Standalone works on Samsung Tizen (a bare app
 * container around youtube.com/tv + script injection) and how TizenTube
 * Cobalt embeds the same userscript in Google's Cobalt runtime.
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
import {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewNavigationEvent,
} from '@amazon-devices/webview/dist/types/WebViewTypes';

import {
  APP_VERSION,
  INJECTION_JS,
  TIZENTUBE_COMMIT,
  TIZENTUBE_VERSION,
} from './injection/injectionBundle.generated';

/**
 * YouTube for TVs decides between its mobile/desktop/TV experiences from the
 * User-Agent. The Vega WebView's stock Chromium UA would get the wrong client,
 * so we present as the official YouTube for Android TV app, the exact same
 * UA string TizenTube Cobalt uses (see mods/features/userAgentSpoofing.js
 * upstream, including its `com.google.android.youtube.tv` aux field).
 */
const TV_USER_AGENT =
  'Mozilla/5.0 (Linux arm64-v8a; Android 10) Cobalt/25.lts.30.1034958-gold ' +
  '(unlike Gecko) v8/8.8.278.17-jit gles Starboard/15, ' +
  'Google_ATV_sabrina_2020/UTTC.250917.004 (google, Chromecast) ' +
  'com.google.android.youtube.tv/5.30.301';

const YOUTUBE_TV_URL = 'https://www.youtube.com/tv';

// Cold-start retry policy (see handleFailure).
const MAX_AUTO_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1500;

/**
 * True if the failing URL is the top-level document rather than a subresource.
 *
 * Vega's WebView onError does not distinguish frames, so we classify by URL:
 * main-frame navigations are to the YouTube app shell itself. Subresource
 * requests (InnerTube API, /api/lounge/*, googlevideo segments, trackers) all
 * live under deeper paths and are non-fatal.
 */
const MAIN_FRAME_PATHS = ['/', '/tv'];

/**
 * The Vega WebView bridge silently drops oversized injectJavaScript payloads:
 * a ~150 byte probe round-tripped through postMessage, while the 630 KB
 * TizenTube bundle was accepted without error and then never executed, which
 * is why no ad block and no settings category ever appeared.
 *
 * So we ship the script in small chunks that the page reassembles itself. Each
 * chunk is self-contained and order-independent: it stores its slice under an
 * index, bumps a counter, and the final chunk to land triggers the eval. That
 * avoids relying on IPC ordering.
 */
const INJECTION_CHUNK_SIZE = 16 * 1024;

const INJECTION_CHUNKS: string[] = (() => {
  const chunks: string[] = [];
  for (let i = 0; i < INJECTION_JS.length; i += INJECTION_CHUNK_SIZE) {
    chunks.push(
      INJECTION_JS.slice(i, i + INJECTION_CHUNK_SIZE),
    );
  }
  return chunks;
})();

const INJECTION_CHUNK_COUNT = INJECTION_CHUNKS.length;

/**
 * Stores one slice of the bundle. Order-independent: each chunk writes its
 * index and bumps a counter; a separate trigger script waits for the full set.
 */
const buildChunkScript = (index: number): string =>
  'window.__TTV__=window.__TTV__||{n:0};' +
  `window.__TTV__[${index}]=${JSON.stringify(INJECTION_CHUNKS[index])};` +
  'window.__TTV__.n++;';

/**
 * Assembles the stored slices and executes them, trying every viable strategy.
 *
 * YouTube's page defends against injected script in two independent ways:
 *   1. Trusted Types: `eval('...')` throws
 *      "Evaluating a string as JavaScript violates this document's Trusted Type
 *       assignment requirements."
 *   2. CSP `script-src-elem`: inserting an inline <script> fires a
 *      `securitypolicyviolation` and never executes.
 *
 * The gap between them is that Chrome accepts a *TrustedScript* in eval() when
 * it comes from a policy we create ourselves, and that call is not a CSP sink.
 * So: TT-aware eval first, then plain eval (for pages without TT, e.g. the Vega
 * Virtual Device), then an inline script (for pages without CSP).
 *
 * The trigger polls for the last chunk so a dropped/late chunk still resolves,
 * rather than leaving the bundle half-injected forever.
 */
const buildTriggerScript = (total: number): string => `
(function () {
  var P = function (m) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({type: 'TT_LOG', message: m}));
      }
    } catch (_) {}
  };

  var run = function () {
    var T = window.__TTV__;
    if (!T) { P('[diag] trigger: nothing stored'); return; }
    var s = '';
    for (var k = 0; k < ${total}; k++) { s += T[k]; }
    delete window.__TTV__;
    P('[diag] assembled len=' + s.length + ' TT=' + (!!window.trustedTypes));

    var ran = false;
    var pol = null;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        pol = window.trustedTypes.createPolicy('vegatube_' + Date.now(), {
          createScript: function (x) { return x; },
          createScriptURL: function (u) { return u; }
        });
      } catch (_) {}
    }

    // 1. Trusted Types-aware eval: not a CSP sink, so it survives both defenses.
    if (!ran && pol) {
      try {
        (0, eval)(pol.createScript(s));
        ran = true;
        P('[diag] ran via TT-aware eval');
      } catch (e) { P('[diag] TT eval failed: ' + e); }
    }
    // 2. Plain eval, for pages that do not enforce Trusted Types.
    if (!ran) {
      try {
        (0, eval)(s);
        ran = true;
        P('[diag] ran via plain eval');
      } catch (e) { P('[diag] plain eval failed: ' + e); }
    }
    // 3. Inline <script>, for pages without CSP.
    if (!ran) {
      try {
        var sc = document.createElement('script');
        sc.textContent = pol ? pol.createScript(s) : s;
        (document.head || document.documentElement).appendChild(sc);
        ran = true;
        P('[diag] ran via inline script');
      } catch (e) { P('[diag] inline script failed: ' + e); }
    }
    P('[diag] execution done ran=' + ran +
      ' sentinel=' + (!!window.__VEGATUBE__));
  };

  var tries = 0;
  var iv = setInterval(function () {
    if (window.__TTV__ && window.__TTV__.n >= ${total}) {
      clearInterval(iv);
      run();
    } else if (++tries > 40) {
      clearInterval(iv);
      P('[diag] trigger timed out waiting for chunks (' +
        (window.__TTV__ ? window.__TTV__.n : 0) + '/' + ${total} + ')');
    }
  }, 250);
})();
`;

/**
 * Synthesized Back press, injected natively because the WebView drops Back.
 *
 * Primary path asks YouTube's own command executor to run POPUP_BACK, which is
 * exactly how TizenTube itself navigates back (resolveCommand's signalAction
 * cases), so YouTube closes overlays/menus/players through its normal path.
 * If the executor is not reachable we dispatch a bubbling Escape keydown,
 * which YouTube TV also treats as Back.
 */
const BACK_SCRIPT = `
(function () {
  var sent = 0;
  function escape() {
    try {
      for (var i = 0; i < 2; i++) {
        var ev = new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true
        });
        document.dispatchEvent(ev);
        sent++;
      }
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'TT_LOG', message: '[diag] back via Escape (' + sent + ' events)'}));
    } catch (e) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'TT_LOG', message: '[diag] back escape failed: ' + e}));
    }
  }
  try {
    var cmd = document.querySelector('ytm-') && window.ytPage && null;
    var executor = null;
    // YouTube TV exposes its command executor on the app element / polymer.
    var app = document.querySelector('ytm-app, #app, ytd-app, [id="app"]');
    if (app && app.commandExecutor) { executor = app.commandExecutor; }
    if (!executor) {
      // TizenTube patches the same accessor; reuse it if present.
      var proto = Object.getPrototypeOf(app || {});
      if (proto && proto.commandExecutor) { executor = proto.commandExecutor; }
    }
    if (executor && typeof executor.executeCommandAction === 'function') {
      executor.executeCommandAction({ signalAction: { signal: 'POPUP_BACK' } });
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'TT_LOG', message: '[diag] back via POPUP_BACK'}));
      // YouTube ignores POPUP_BACK when nothing is open; follow with Escape so
      // route-level back (e.g. Shorts -> guide) still happens.
      escape();
      return;
    }
  } catch (e) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
      JSON.stringify({type: 'TT_LOG', message: '[diag] back command failed: ' + e}));
  }
  escape();
})();
`;

const isMainFrameUrl = (url?: string): boolean => {
  if (!url) {
    // No URL reported; treat as a main-frame failure.
    return true;
  }
  try {
    const {pathname} = new URL(url) as any;
    return MAIN_FRAME_PATHS.includes(pathname);
  } catch {
    // Unparseable URL: be conservative and treat it as main-frame.
    return true;
  }
};

/**
 * TV focus ring, same treatment as the FYAISA app: a thick amber border plus
 * a glow so the selected control is obvious from the couch. focusBase keeps a
 * transparent border so focusing never shifts layout.
 */
const focusRing = ({focused}: {focused: boolean}) =>
  [styles.focusBase, focused && styles.focusedRing];

export const App = () => {
  const webRef = useRef(null);
  // Keep the splash screen up until YouTube has loaded (or errored).
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);

  // Cold-start recovery. Right after a sideload the first launch can fail with
  // net::ERR_FAILED while the app's network/renderer stack is still warming up
  // (observed on a real Fire TV Stick HD). Retry the load a few times before
  // giving up and showing the error screen.
  const autoRetryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backDeliveredRef = useRef(true);

  useEffect(() => {
    console.info(
      `[VegaTube] v${APP_VERSION} (TizenTube v${TIZENTUBE_VERSION} @ ${TIZENTUBE_COMMIT.slice(0, 12)})`,
    );
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  /**
   * Back handling.
   *
   * With `allowSystemKeyEvents` the Vega WebView delivers system keys ONLY to
   * the web page and never to KeplerScript, which makes the native BackHandler
   * unreachable. Worse, on OS 2.0 the WebView does not forward Back to the page
   * either: instrumenting every keydown on a real Fire TV Stick HD logged 163
   * arrow presses and 15 Enters but ZERO Back/ESC events across repeated
   * presses, so Back was simply lost.
   *
   * So we run with allowSystemKeyEvents disabled (arrows/Enter still reach the
   * page normally), catch Back natively, and synthesize the key events YouTube
   * TV actually listens for: a 'POPUP_BACK' customAction via YouTube's own
   * command executor, with a bubbling Escape keydown as the fallback.
   *
   * Returning false lets the system handle it, which exits to the launcher.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const web = webRef.current as any;
      if (!web?.injectJavaScript) {
        return false;
      }
      if (!backDeliveredRef.current) {
        // A page reload resets our knowledge of whether YouTube can still go back.
        backDeliveredRef.current = true;
      }
      web.injectJavaScript(BACK_SCRIPT);
      console.info('[VegaTube] Back -> POPUP_BACK (+ Escape)');
      // Always consume: at the root of the guide YouTube closes nothing, and
      // letting it fall through would exit the app on every stray Back press.
      return true;
    });
    return () => sub.remove();
  }, []);

  /**
   * Receive diagnostics from the injected prelude (window.ReactNativeWebView).
   * These are the only in-page signals that reach native logs; the WebView's
   * own console output is not forwarded to the device log, so this bridge is
   * the sole way to confirm the injection actually executed.
   */
  const onMessage = useCallback((event: any) => {
    const raw = event?.nativeEvent?.data;
    if (!raw) {
      return;
    }
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'TT_READY':
          console.info(
            `[VegaTube] injection ready (app v${msg.appVersion}, ` +
              `TizenTube v${msg.ttVersion}, phase=${msg.phase ?? 'start'})`,
          );
          break;
        case 'TT_LOG':
          console.log(`[TizenTubeVega:web] ${msg.message}`);
          break;
        default:
          break;
      }
    } catch (_) {
      // Non-JSON payload from the page; ignore.
    }
  }, []);

  /**
   * Inject the TizenTube prelude + userscript into the loaded page.
   *
   * `injectedJavaScriptBeforeContentLoaded` is declared by the Vega WebView
   * types but is not implemented natively on OS 2.0: the page loaded and
   * played fine, yet nothing the script defined ever existed (no h5vcc
   * bridge, no ad block, no settings category).
   * The supported API is the imperative `injectJavaScript`, so we use that on
   * every page load. The prelude sets a `window.__VEGATUBE__` sentinel,
   * so re-running it (and the before-content-loaded prop, if a future OS
   * implements it) can never double-install the patches.
   */
  const injectTizenTube = useCallback(() => {
    const web = webRef.current as any;
    if (!web?.injectJavaScript) {
      console.warn('[VegaTube] injectJavaScript unavailable on this WebView');
      return;
    }
    try {
      // Tiny probe first: proves the page->native bridge round-trips.
      web.injectJavaScript(
        'try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(' +
          'JSON.stringify({type:"TT_LOG",message:"[diag] probe ok"}))}catch(e){}',
      );

      // Ship the script in bridge-safe chunks; the page reassembles and runs it.
      INJECTION_CHUNKS.forEach((_, index) => {
        web.injectJavaScript(buildChunkScript(index));
      });
      // Sent last: waits for every chunk to land, then executes.
      web.injectJavaScript(buildTriggerScript(INJECTION_CHUNK_COUNT));

      console.info(
        `[VegaTube] injected ${(INJECTION_JS.length / 1024).toFixed(0)} KB ` +
          `of TizenTube script in ${INJECTION_CHUNK_COUNT} chunks ` +
          `(${INJECTION_CHUNK_SIZE / 1024} KB each)`,
      );
    } catch (err) {
      console.error('[VegaTube] injectJavaScript failed:', err);
    }
  }, []);

  const onLoad = useCallback(
    (_event: WebViewNavigationEvent) => {
      console.info('[VegaTube] Page loading completed');
      // A successful load resets the cold-start retry budget.
      autoRetryRef.current = 0;
      setLoadError(null);
      setPageLoaded(true);
      hideSplashScreenCallback();
      injectTizenTube();
    },
    [hideSplashScreenCallback],
  );

  const onLoadStart = useCallback((_event: WebViewNavigationEvent) => {
    console.info('[VegaTube] Page loading started');
    setPageLoaded(false);
  }, []);

  /**
   * Shared failure handler: auto-reload with a short backoff while we still
   * have retries left, otherwise surface the manual error screen.
   *
   * Only ever call this for MAIN-FRAME failures; see onError.
   */
  const handleFailure = useCallback(
    (reason: string) => {
      console.error(`[VegaTube] ${reason}`);
      // Never leave the splash screen up on failure.
      hideSplashScreenCallback();

      if (autoRetryRef.current < MAX_AUTO_RETRIES) {
        const attempt = autoRetryRef.current + 1;
        const delay = RETRY_BASE_DELAY_MS * attempt;
        console.info(
          `[VegaTube] load failed (${reason}); auto-retry ${attempt}/${MAX_AUTO_RETRIES} in ${delay}ms`,
        );
        autoRetryRef.current = attempt;
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
        }
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
    ({nativeEvent: {code, url, description}}: WebViewErrorEvent) => {
      // Vega's onError also fires for failed SUBRESOURCE requests (XHR/fetch),
      // not just the main frame. YouTube's lounge-screen probe
      // (/api/lounge/bc/test) reliably fails on this platform; treating it as
      // a page failure caused an endless reload loop of a perfectly healthy
      // page. Only react when the document itself failed to load.
      if (!isMainFrameUrl(url)) {
        console.warn(
          `[VegaTube] ignoring non-fatal subresource error (${code}: ${description})`,
        );
        return;
      }
      handleFailure(`onError: (${code}: ${url}) ${description}`);
    },
    [handleFailure],
  );

  const onHttpError = useCallback(
    ({
      nativeEvent: {url, statusCode: code, description, isMainFrame},
    }: WebViewHttpErrorEvent) => {
      // Non-fatal for subresources; only surface main-frame failures.
      if (isMainFrame) {
        handleFailure(`onHttpError: (${code}: ${url}) ${description}`);
      }
    },
    [handleFailure],
  );

  const retry = useCallback(() => {
    // Manual retry restores the full auto-retry budget.
    autoRetryRef.current = 0;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
    }
    setLoadError(null);
    setPageLoaded(false);
    (webRef.current as any)?.reload();
  }, []);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        source={{uri: YOUTUBE_TV_URL}}
        // Give the WebView focus immediately so the remote drives YouTube.
        hasTVPreferredFocus
        // Inject the TizenTube shim + userscript before any page scripts run,
        // equivalent to CDP's Page.addScriptToEvaluateOnNewDocument used by
        // TizenTube Standalone on Tizen.
        injectedJavaScriptBeforeContentLoaded={INJECTION_JS}
        userAgent={TV_USER_AGENT}
        javaScriptEnabled
        domStorageEnabled
        // Intentionally OFF. With it enabled the OS 2.0 WebView delivers keys
        // only to the page and drops Back entirely: 163 arrow presses and 15
        // Enters reached the page, zero Back presses did, across repeated
        // attempts. Arrows/Enter still
        // arrive with it off; Back is caught natively and forwarded via
        // BACK_SCRIPT. See the BackHandler effect above.
        allowSystemKeyEvents={false}
        allowsDefaultMediaControl
        mixedContentMode="compatibility"
        // Allow the TV UI's autoplaying previews and normal playback.
        mediaPlaybackRequiresUserAction={false}
        // Keep Google sign-in cookies working.
        thirdPartyCookiesEnabled
        onLoad={onLoad}
        onLoadStart={onLoadStart}
        onError={onError}
        onHttpError={onHttpError}
        onMessage={onMessage}
        // YouTube TV is a single-page app: in-app navigation does not fire
        // onLoad, so re-arm injection whenever a navigation is committed. The
        // prelude sentinel makes this a no-op when the page is unchanged.
        {...({
          onNavigationStateChange: (nav: any) => {
            if (nav?.loading === false && nav?.url) {
              injectTizenTube();
            }
          },
        } as any)}
      />

      {loadError && (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Couldn’t load YouTube</Text>
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
          <Text style={styles.loadingText}>Loading VegaTube…</Text>
        </View>
      )}

    </View>
  );
};

// Styles for layout, which are necessary for proper focus behavior
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
    backgroundColor: '#cc0000',
    borderRadius: 4,
  },
  retryText: {
    color: '#ffffff',
    fontSize: 18,
  },

  /** Transparent base border so the focus ring never shifts layout.
   *  alignSelf keeps the pressable (and thus the ring) tight around the
   *  inner button. */
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
