/*
 * VegaTube for Vega OS: injection prelude (formerly TizenTube Vega).
 *
 * Runs at document-start inside the Vega WebView (plain Chromium), BEFORE the
 * TizenTube userscript and before any YouTube page scripts.
 *
 * Responsibilities:
 *   1. Seed TizenTube's configuration (localStorage 'ytaf-configuration') with
 *      defaults that are correct for this platform:
 *        - enableUpdater: false, always forced rather than just defaulted.
 *                                  The built-in updater targets TizenTube Cobalt
 *                                  (wrong platform packages), and its
 *                                  "update available" prompt would fire every
 *                                  launch; the only upstream gate for the
 *                                  check is the presence of h5vcc.tizentube,
 *                                  which this prelude provides. (The
 *                                  settings-menu Updater section is removed
 *                                  from the vendored script outright.)
 *        - enableFixedUI: true, upstream defaults it to true on non-Cobalt
 *                                  web engines (the flag re-enables YouTube's
 *                                  animations / long-press on capable engines).
 *      Existing user choices are always preserved (the updater being the
 *      one forced exception, see above).
 *
 *   2. Provide a minimal `window.h5vcc.tizentube` bridge, mirroring the native
 *      API that TizenTube's userscript expects on Cobalt. Every call the
 *      userscript makes is guarded upstream (`window.h5vcc && window.h5vcc.tizentube`),
 *      so anything we do not implement is simply hidden/disabled in the UI:
 *        - GetVersion()         -> implemented (diagnostics)
 *        - HasSystemFeature()   -> always false (no Android PiP / AFR on Vega)
 *        - SetUserAgent()       -> INTENTIONALLY OMITTED. UA is set natively on
 *                                  the WebView to a known-good YouTube TV string;
 *                                  the Cobalt UA-spoofing path would trigger a
 *                                  reload loop in this environment.
 *        - SetFrameRate()       -> omitted (auto-frame-rate needs a native API
 *                                  Vega does not expose to apps yet)
 *        - InstallAppFromURL()  -> omitted (see enableUpdater above)
 *
 * Everything TizenTube does in-page (ad blocking, SponsorBlock, DeArrow,
 * speed controls, themes, settings UI) requires no native API and works
 * unmodified.
 */
(function () {
  'use strict';

  var APP_VERSION = '__APP_VERSION__';
  var TIZENTUBE_VERSION = '__TIZENTUBE_VERSION__';

  /* Idempotency sentinel: the injection may be delivered more than once
     (e.g. via injectedJavaScriptBeforeContentLoaded and a load-time fallback).
     Never install the bridge/shims twice. */
  if (window.__VEGATUBE__) {
    return;
  }
  window.__VEGATUBE__ = true;

  /* ---------------------------------------------------------------- */
  /* 1. Seed TizenTube config (never clobber user settings)            */
  /* ---------------------------------------------------------------- */
  var CONFIG_KEY = 'ytaf-configuration';
  try {
    var cfg = {};
    try { cfg = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || '{}') || {}; } catch (_) { cfg = {}; }
    cfg.enableUpdater = false; /* forced every launch; see header note */
    if (typeof cfg.enableFixedUI === 'undefined') cfg.enableFixedUI = true;
    /* On Tizen/Cobalt the userscript is injected at document-start, so
       ui.js's `reloadHomeOnStartup` -> SOFT_RELOAD_PAGE is a harmless "go to
       Home" nudge. We inject after load, so that signal fires mid-session and
       yanks the guide out from under the user (observed: app dropping into
       Shorts at random). YouTube already restores the last route itself.
       Only ever defaults an unset value, so users can re-enable it. */
    if (typeof cfg.reloadHomeOnStartup === 'undefined') cfg.reloadHomeOnStartup = false;
    cfg.vegaPlatform = true;
    cfg.vegaAppVersion = APP_VERSION;
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) { /* private mode / storage disabled; userscript falls back to defaults */ }

  function post(message) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }
    } catch (_) { }
  }

  /* ---------------------------------------------------------------- */
  /* 2. Cobalt spatial-navigation stub                                  */
  /* ---------------------------------------------------------------- */
  /*
   * TizenTube's UI layer (ui/ui.js) opens with:
   *
   *     window.__spatialNavigation__.keyMode = 'NONE';
   *
   * inside execute_once_dom_loaded(). That API is a Cobalt/Tizen builtin and
   * does not exist in the Vega WebView's plain Chromium, so the assignment
   * throws a TypeError there. Everything after it in that function is skipped,
   * including TizenTube's own key handlers and its "go home on startup"
   * navigation. Symptoms: the remote's Back
   * button did nothing and the app opened on Shorts instead of Home.
   *
   * The throw is asynchronous (~250ms after DOM load), which is why it never
   * showed up as an eval failure and why an ad-blocked page still "worked":
   * the ad blocker hooks JSON.parse and runs during module init, long before
   * this UI code path.
   *
   * TizenTube only ever reads/writes `keyMode` from this object, so a minimal
   * stub is sufficient. We install it non-enumerably and remove it shortly after
   * the UI init has consumed it, leaving YouTube's own environment untouched.
   * (Injection happens after load, so YouTube has already made any decision it
   * makes about this global.)
   */
  if (!window.__spatialNavigation__) {
    try {
      var stub = {
        keyMode: 'NONE',
        registerElementForPolymer: function () {},
        deregisterElementFromPolymer: function () {},
        registerFocusableElement: function () {},
        getFocusManager: function () { return null; },
        setFocus: function () {},
        getFocusedElement: function () { return null; },
        onNavigate: function () {},
        onNavigateFocused: function () {},
        setFocusToElement: function () {}
      };
      Object.defineProperty(window, '__spatialNavigation__', {
        value: stub,
        writable: true,
        configurable: true,
        enumerable: false
      });
      post({ type: 'TT_LOG', message: '[diag] installed __spatialNavigation__ stub' });
      // Drop it once TizenTube's DOM-ready init (which runs ~250ms after load)
      // has consumed it.
      setTimeout(function () {
        try {
          delete window.__spatialNavigation__;
        } catch (_) { }
      }, 4000);
    } catch (e) {
      post({ type: 'TT_LOG', message: '[diag] spatialNav stub failed: ' + e });
    }
  } else {
    post({ type: 'TT_LOG', message: '[diag] __spatialNavigation__ already present' });
  }

  /* ---------------------------------------------------------------- */
  /* 3. Native bridge shim                                             */
  /* ---------------------------------------------------------------- */

  window.h5vcc = window.h5vcc || {};
  window.h5vcc.tizentube = {
    GetVersion: function () { return TIZENTUBE_VERSION; },
    GetPlatform: function () { return 'vega'; },
    HasSystemFeature: function () { return false; },
    Log: function (msg) { post({ type: 'TT_LOG', message: String(msg) }); }
  };

  /* Surface uncaught page errors to the native log. This matters: the Cobalt
     spatial-navigation bug above threw asynchronously inside a setTimeout and
     was completely invisible without it (only the WebView's own console would
     have shown it, and that is not forwarded to device logs). */
  window.addEventListener('error', function (e) {
    // Capture-phase also receives resource load failures (<img>, <script>,
    // XHR). Those carry no message and are not script errors; the WebView's
    // onError handler already reports network failures.
    if (e && e.target && e.target !== window) return;
    var msg = (e && (e.message || (e.error && (e.error.stack || e.error)))) || 'unknown error';
    var where = e && e.filename ? ' @ ' + e.filename + ':' + e.lineno : '';
    post({ type: 'TT_LOG', message: '[pageerror] ' + msg + where });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post({
      type: 'TT_LOG',
      message: '[unhandledrejection] ' + ((r && (r.stack || r.message)) || r || 'unknown'),
    });
  });

  var payload = {
    type: 'TT_READY',
    appVersion: APP_VERSION,
    ttVersion: TIZENTUBE_VERSION,
  };

  /* Report immediately, then again once the page has loaded. At document-start
     the ReactNativeWebView JS bridge may not exist yet, so the first post can be
     lost; the post-load report confirms the bridge is live. */
  post(payload);

  function report(phase) {
    payload.phase = phase;
    post(payload);
  }

  if (document.readyState === 'complete') {
    report('load');
  } else {
    window.addEventListener('load', function () {
      report('load');
      /* One deferred ping so it is unambiguous in native logs which of the two
         posts survived the bridge handshake. */
      setTimeout(function () { report('deferred'); }, 2000);
    });
  }

  /* Key delivery diagnostics.
     With allowSystemKeyEvents the Vega docs state system keys are delivered
     "only in web javascript and not in application code (KeplerScript)", so the
     native BackHandler never fires and the page is the only place a Back press
     can be observed. Log what actually arrives (capture phase, so handlers
     registered later by YouTube or TizenTube cannot hide it from us). */
  try {
    var seenKeys = {};
    window.addEventListener('keydown', function (e) {
      var code = e.keyCode || e.which;
      if (code === 27 || code === 461 || code === 10009) {
        seenKeys.back = (seenKeys.back || 0) + 1;
        post({ type: 'TT_LOG', message: '[diag] BACK keydown seen #' + seenKeys.back });
      }
      post({
        type: 'TT_LOG',
        message: '[diag] keydown key=' + (e.key || code) + ' code=' + code,
      });
    }, true);
  } catch (e) { /* ignore */ }

  /* Report whether the userscript's JSON.parse hook is live. The ad blocker (and
     the TizenTube settings category it injects) works by patching JSON.parse, so
     this is the cheapest reliable signal that the userscript is running. */
  try {
    var origParse = JSON.parse;
    var parseCalls = 0;
    JSON.parse = function () {
      parseCalls++;
      return origParse.apply(this, arguments);
    };
    setTimeout(function () {
      post({ type: 'TT_LOG', message: '[diag] jsonParseCalls=' + parseCalls });
    }, 5000);
  } catch (e) {
    post({ type: 'TT_LOG', message: '[diag] json parse tap failed: ' + e });
  }
})();
