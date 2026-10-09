/**
 * VegaTube for Vega OS (formerly TizenTube Vega)
 * ---------------------------------------------
 * A minimal React Native for Vega shell that loads the official YouTube for
 * TVs web app (https://www.youtube.com/tv) in a Vega WebView and injects the
 * upstream TizenTube userscript (ad block, SponsorBlock, DeArrow, speed
 * controls, theming) at document-start via a small native-bridge shim.
 *
 * VegaTube is the FYAISA example app: it demonstrates how a homebrew Vega app
 * uses the FYAISA bridge (`fyaisa connect`) — the startup menu checks the hub
 * for new versions and can rebuild + reinstall itself on the Fire TV through
 * the paired PC. See src/fyaisaClient.ts and docs/HOMEBREW.md §6.
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
import {KeplerFileSystem} from '@amazon-devices/kepler-file-system';
import {Fyaisa, FyaisaError} from './fyaisaClient';
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
 * so we present as the official YouTube for Android TV app — the exact same
 * UA string TizenTube Cobalt uses (see mods/features/userAgentSpoofing.js
 * upstream, including its `com.google.android.youtube.tv` aux field).
 */
const TV_USER_AGENT =
  'Mozilla/5.0 (Linux arm64-v8a; Android 10) Cobalt/25.lts.30.1034958-gold ' +
  '(unlike Gecko) v8/8.8.278.17-jit gles Starboard/15, ' +
  'Google_ATV_sabrina_2020/UTTC.250917.004 (google, Chromecast) ' +
  'com.google.android.youtube.tv/5.30.301';

const YOUTUBE_TV_URL = 'https://www.youtube.com/tv';

// --- FYAISA integration (see docs/HOMEBREW.md §6) ---------------------------
const BRIDGE_PORT = 47821;
/** Our hub id — the bridge rebuilds + reinstalls this app from the catalog. */
const VEGATUBE_APP_ID = 'app.vegatube.main';
/** Published catalog; used for the update check (no pairing required). */
const HUB_CATALOG_URL =
  'https://raw.githubusercontent.com/AaronYTDev/FYAISA/main/catalog.json';
/** Pairing persistence in this app's private sandbox (/data is per-app). */
const STORE_PATH = '/data/bridge.json';

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
 * The Vega WebView bridge silently DROPS oversized injectJavaScript payloads.
 * Verified on a real Fire TV Stick HD (OS 2.0): a ~150 byte probe round-tripped
 * through postMessage, while the 630 KB TizenTube bundle was accepted without
 * error and then never executed — which is why no ad block and no settings
 * category ever appeared.
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
 * YouTube's page defends against injected script in two independent ways, both
 * confirmed on-device:
 *   1. Trusted Types — `eval('...')` throws
 *      "Evaluating a string as JavaScript violates this document's Trusted Type
 *       assignment requirements."
 *   2. CSP `script-src-elem` — inserting an inline <script> fires a
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
 * cases) — so YouTube closes overlays/menus/players through its normal path.
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
    // No URL reported — treat as a main-frame failure.
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

// --- FYAISA pairing persistence (KeplerFileSystem; /data is per-app) --------
type SavedPair = {host: string; token: string};

const savePair = async (p: SavedPair) => {
  try {
    await KeplerFileSystem.writeStringToFile(STORE_PATH, JSON.stringify(p), 'UTF-8');
    console.info(`[VegaTube] FYAISA pairing saved (${p.host})`);
  } catch (e: any) {
    console.error(`[VegaTube] could not save pairing: ${e?.message || e}`);
  }
};

const loadPair = async (): Promise<SavedPair | null> => {
  try {
    if (!(await KeplerFileSystem.exists(STORE_PATH))) {
      return null;
    }
    const p = JSON.parse(await KeplerFileSystem.readFileAsString(STORE_PATH, 'UTF-8'));
    return p && p.host && p.token ? (p as SavedPair) : null;
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

/** D-pad keypad for typing the PC address (dots and backspace included). */
const HOST_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

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

  // FYAISA panel (startup menu): hub status, update check, PC pairing.
  const [menu, setMenu] = useState<'hidden' | 'menu' | 'pair'>('menu');
  const [pair, setPair] = useState<SavedPair | null>(null);
  const [pairHost, setPairHost] = useState('');
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState('Checking the FYAISA hub…');
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [job, setJob] = useState<{status: string; log: string[]} | null>(null);
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // FYAISA panel: load saved pairing + check the hub for a new VegaTube
  // version. The update check runs against the published catalog (no pairing
  // needed); installing the update requires the paired PC bridge.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(HUB_CATALOG_URL);
        const cat = await res.json();
        if (cancelled) {
          return;
        }
        const entry = (cat.apps || []).find((a: any) => a.id === VEGATUBE_APP_ID);
        const hubVersion = entry?.version;
        console.info(
          `[VegaTube] hub check: ${(cat.apps || []).length} app(s), catalog VegaTube ${
            hubVersion ? `v${hubVersion}` : 'not listed'
          }`,
        );
        setHubStatus(
          `FYAISA hub: ${(cat.apps || []).length} app(s) · VegaTube ${
            hubVersion ? `v${hubVersion}` : 'listed'
          }`,
        );
        if (hubVersion && hubVersion !== APP_VERSION) {
          setUpdateVersion(hubVersion);
          console.info(`[VegaTube] update available: v${APP_VERSION} -> v${hubVersion}`);
        }
      } catch {
        if (!cancelled) {
          setHubStatus('FYAISA hub unreachable (offline?)');
        }
      }

      const saved = await loadPair();
      if (cancelled || !saved) {
        return;
      }
      setPair(saved);
      try {
        await Fyaisa.from(saved).catalog(); // token check: 401 => stale
        console.info(`[VegaTube] FYAISA bridge reachable at ${saved.host}`);
      } catch (e: any) {
        if (e instanceof FyaisaError && e.status === 401) {
          await clearPair();
          if (!cancelled) {
            setPair(null);
          }
          console.warn('[VegaTube] FYAISA pairing expired — re-pair from the menu');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The menu is a startup convenience, not a lockout — it steps aside on its
  // own so YouTube is one press (or zero) away.
  useEffect(() => {
    if (menu !== 'menu') {
      return;
    }
    menuTimerRef.current = setTimeout(() => setMenu('hidden'), 20000);
    return () => {
      if (menuTimerRef.current) {
        clearTimeout(menuTimerRef.current);
      }
    };
  }, [menu]);

  // While the FYAISA menu is open, Back closes it instead of talking to
  // YouTube. Declared after the YouTube Back effect so it runs first (LIFO).
  useEffect(() => {
    if (menu === 'hidden') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMenu('hidden');
      return true;
    });
    return () => sub.remove();
  }, [menu]);

  /**
   * Receive diagnostics from the injected prelude (window.ReactNativeWebView).
   * These are the only in-page signals that reach native logs — the WebView's
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
   * types but is NOT implemented natively on OS 2.0 — verified on a real Fire
   * TV Stick HD: the page loaded and played fine, yet nothing the script
   * defined ever existed (no h5vcc bridge, no ad block, no settings category).
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
   * Only ever call this for MAIN-FRAME failures — see onError.
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

  // --- FYAISA panel actions -------------------------------------------------

  const dismissMenu = useCallback(() => setMenu('hidden'), []);

  /** Get a pairing code from the bridge, show it, wait for `fyaisa approve`. */
  const startPair = useCallback(async () => {
    const host = pairHost.trim();
    if (!host) {
      setHubStatus('Enter your PC address first (shown by fyaisa connect)');
      return;
    }
    try {
      setHubStatus('Requesting a pairing code…');
      const {code} = await Fyaisa.requestCode(host, BRIDGE_PORT);
      setPairCode(code);
      setHubStatus(`On the PC:  fyaisa approve ${code}`);
      const p = await Fyaisa.waitForApproval(host, code, BRIDGE_PORT);
      await savePair(p);
      setPair(p);
      setPairCode(null);
      setHubStatus('Paired — updates install through your PC');
      setMenu('menu');
      console.info('[VegaTube] paired with FYAISA bridge');
    } catch (e: any) {
      setPairCode(null);
      setHubStatus(`Pairing failed: ${e?.message || e}`);
    }
  }, [pairHost]);

  const forget = useCallback(async () => {
    await clearPair();
    setPair(null);
    setHubStatus('PC forgotten');
  }, []);

  /** Queue a rebuild + reinstall of VegaTube on the PC; stream the log. */
  const updateViaPc = useCallback(async () => {
    if (!pair) {
      return;
    }
    try {
      const fy = Fyaisa.from(pair);
      const {jobId} = await fy.install(VEGATUBE_APP_ID);
      setJob({status: 'queued', log: []});
      console.info(`[VegaTube] update job queued: ${jobId}`);
      const iv = setInterval(async () => {
        try {
          const j = await fy.job(jobId);
          setJob({status: j.status, log: (j.log || []).slice(-8)});
          if (j.status === 'done' || j.status === 'error') {
            clearInterval(iv);
            console.info(`[VegaTube] update job ${j.status}`);
          }
        } catch {
          clearInterval(iv);
          setJob(prev => ({status: 'error', log: [...(prev?.log || []), 'bridge unreachable']}));
        }
      }, 2500);
    } catch (e: any) {
      setJob({status: 'error', log: [String(e?.message || e)]});
    }
  }, [pair]);

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
        // only to the page and drops Back on the floor — verified on a real
        // Fire TV Stick HD: 163 arrow presses and 15 Enters reached the page,
        // zero Back presses did, across repeated attempts. Arrows/Enter still
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

      {menu !== 'hidden' && (
        <View style={styles.menuOverlay}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>VegaTube v{APP_VERSION}</Text>
            <Text style={styles.menuCredit}>A FYAISA example app</Text>
            <Text style={styles.menuStatus}>{hubStatus}</Text>
            {pair ? (
              <Text style={styles.menuPaired}>Paired with {pair.host}</Text>
            ) : null}

            {menu === 'pair' ? (
              <>
                <Text style={styles.menuHint}>
                  Enter your PC’s address, then Get pairing code. On the PC: fyaisa
                  approve &lt;code&gt;
                </Text>
                <View style={styles.keypad}>
                  {HOST_KEYS.map(k => (
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
                <KeplerPressable hasTVPreferredFocus style={focusRing} onPress={startPair}>
                  <View style={styles.menuBtn}>
                    <Text style={styles.menuBtnText}>
                      {pairCode ? 'Waiting for approval…' : 'Get pairing code'}
                    </Text>
                  </View>
                </KeplerPressable>
                <KeplerPressable style={focusRing} onPress={() => setMenu('menu')}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>Back</Text>
                  </View>
                </KeplerPressable>
              </>
            ) : (
              <>
                {updateVersion ? (
                  <KeplerPressable hasTVPreferredFocus style={focusRing} onPress={updateViaPc}>
                    <View style={styles.menuBtn}>
                      <Text style={styles.menuBtnText}>
                        Update to v{updateVersion} via PC
                      </Text>
                    </View>
                  </KeplerPressable>
                ) : null}
                <KeplerPressable
                  hasTVPreferredFocus={!updateVersion}
                  style={focusRing}
                  onPress={() => setMenu('pair')}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>
                      {pair ? 'Pair a different PC' : 'Pair with PC'}
                    </Text>
                  </View>
                </KeplerPressable>
                {pair ? (
                  <KeplerPressable style={focusRing} onPress={forget}>
                    <View style={styles.menuBtnGhost}>
                      <Text style={styles.menuBtnText}>Forget PC</Text>
                    </View>
                  </KeplerPressable>
                ) : null}
                <KeplerPressable style={focusRing} onPress={dismissMenu}>
                  <View style={styles.menuBtnGhost}>
                    <Text style={styles.menuBtnText}>Continue to YouTube</Text>
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
              Powered by FYAISA — run “fyaisa connect” on your PC
            </Text>
          </View>
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
    marginTop: 16,
    alignSelf: 'flex-start',
  },
  menuBtnGhost: {
    backgroundColor: '#1e1e28',
    borderRadius: 6,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  menuBtnText: {color: '#ffffff', fontSize: 18},
  menuFooter: {color: '#5c5c6b', fontSize: 13, marginTop: 24},
  menuJobStatus: {color: '#7ee787', fontSize: 15, marginTop: 14},
  menuJobLine: {
    color: '#8b8b99',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  /** Transparent base border so the focus ring never shifts layout. */
  focusBase: {borderWidth: 3, borderColor: 'transparent', borderRadius: 8},
  focusedRing: {
    borderColor: '#ffb02e',
    shadowColor: '#ffb02e',
    shadowOpacity: 0.85,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
});
