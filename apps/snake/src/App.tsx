/**
 * Google Snake for Vega OS.
 *
 * Google's snake arcade game (the doodle build Google serves for a snake
 * search) lives on google.com. This app is only a frame around it: a Vega
 * WebView pointed at the game URL. The frame does five jobs around the page:
 *
 * - Presents desktop Chrome. The stock Vega user agent got an empty black
 *   container from Google's fbx shell, while the desktop build is also the
 *   variant that drives on arrow keys.
 * - Fits the game to the TV. Google draws its game in a fixed panel far
 *   smaller than a 1080p screen, so the injected control script scales the
 *   game's centered wrapper to the viewport, measuring the layout size and
 *   re-checking after every key and click (the game re-measures itself
 *   after start).
 * - Clicks for the remote. OK never becomes a mouse click on a TV, so the
 *   page binds Enter and the TV hook forwards select; both funnel into one
 *   single-flighted click on the play button or the screen center.
 * - Gives the remote a pointer. Menu is a system key the page never sees,
 *   so the TV hook toggles a cursor mode. The document-start key handler
 *   runs before any of Google's listeners, so in cursor mode it can take
 *   the arrows outright, slide a drawn pointer across the screen, and OK
 *   clicks where the pointer stands. Menu again hands the D-pad back to
 *   the game.
 * - Plays offline after the first visit. Google's files stay Google's code
 *   and never enter this repo: the WebView keeps what the first launch
 *   downloaded in its disk cache (LOAD_CACHE_ELSE_NETWORK) and a warm-up
 *   pass fetches every remaining asset while still online.
 *
 * Two probes report to logcat: one at document start (the user agent we
 * sent, early page errors, the key router) and one at load plus three
 * seconds later (URL, center element, canvases buffered and shown, Google's
 * globals, resources).
 *
 * Back falls through to the system and leaves the app, Home exits.
 */
import React, {useCallback, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';

/** Google's full-screen snake arcade game. */
const GAME_URL = 'https://www.google.com/fbx?fbx=snake_arcade';

/**
 * Desktop Chrome: the client Google's own docs describe for this game
 * ("use the arrow keys") and a user agent Google certainly knows.
 */
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/** OK from the TV hook: the page single-flights the click itself. */
const CLICK_SCRIPT = 'window.__snakeClick&&window.__snakeClick();true;';

/** Menu from the TV hook: flip between steering and cursor mode. */
const CURSOR_TOGGLE_SCRIPT =
  'window.__snakeToggleCursor&&window.__snakeToggleCursor();true;';

/**
 * Runs before any page script, which puts its keydown listener first in
 * line, ahead of everything Google registers. Forwards the user agent we
 * actually sent, forwards early page errors and unhandled rejections, and
 * routes keys by mode: in cursor mode the arrows move the drawn pointer
 * and stop here (stopImmediatePropagation, so Google's listeners never see
 * them); in game mode they are logged and passed through to the snake.
 * Enter always becomes the page's click.
 */
const EARLY_PROBE = `
(function () {
  var MODE = 'game';
  var CUR = {x: -1, y: -1};
  var cursorEl = null;
  var toastEl = null;
  var toastTimer = 0;
  var lastMoveAt = 0;
  var fastCount = 0;

  function tell(msg) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'LOG', message: msg}));
    } catch (e) {}
  }
  tell('early probe: ua=' + navigator.userAgent +
       ' touch=' + navigator.maxTouchPoints);
  window.addEventListener('error', function (e) {
    tell('page error: ' + (e.message || e.type) +
         ' @ ' + (e.filename || '?').slice(0, 120));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    tell('page rejection: ' + String(e.reason).slice(0, 160));
  });

  window.__snakeMode = MODE;
  window.__snakeCursor = CUR;

  function toast(text) {
    try {
      if (toastEl && toastEl.parentNode) {
        toastEl.parentNode.removeChild(toastEl);
        toastEl = null;
      }
      window.clearTimeout(toastTimer);
      toastEl = document.createElement('div');
      toastEl.textContent = text;
      toastEl.style.cssText =
        'position:fixed;left:50%;top:8%;transform:translateX(-50%);' +
        'z-index:2147483647;pointer-events:none;' +
        'background:rgba(0,0,0,0.78);color:#fff;' +
        'font:600 16px sans-serif;padding:10px 18px;border-radius:999px;';
      (document.body || document.documentElement).appendChild(toastEl);
      toastTimer = window.setTimeout(function () {
        if (toastEl && toastEl.parentNode) {
          toastEl.parentNode.removeChild(toastEl);
        }
        toastEl = null;
      }, 1500);
    } catch (e) {}
  }

  var ARROW_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='22' height='24'>" +
    "<path d='M3 1 L3 19 L8 14.5 L11 21 L14.5 20 L11.5 14 L18 13.5 Z' " +
    "fill='white' stroke='black' stroke-width='1.4' " +
    "stroke-linejoin='round'/></svg>";

  function ensureCursor() {
    if (cursorEl && cursorEl.parentNode) {
      return;
    }
    cursorEl = document.createElement('div');
    cursorEl.style.cssText =
      'position:fixed;width:22px;height:24px;z-index:2147483647;' +
      'pointer-events:none;display:none;background-repeat:no-repeat;' +
      'background-image:url("data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(ARROW_SVG) + '");';
    (document.body || document.documentElement).appendChild(cursorEl);
  }

  function drawCursor() {
    ensureCursor();
    cursorEl.style.left = CUR.x + 'px';
    cursorEl.style.top = CUR.y + 'px';
    cursorEl.style.display = 'block';
  }

  // 40px a press, then up to 100 while the remote auto-repeats, clamped
  // to the viewport so the pointer can sit on the last pixel.
  function moveCursor(key) {
    var now = Date.now();
    if (now - lastMoveAt < 130) {
      fastCount = Math.min(fastCount + 1, 3);
    } else {
      fastCount = 0;
    }
    lastMoveAt = now;
    var step = 40 + fastCount * 20;
    if (key === 'ArrowUp') { CUR.y -= step; }
    if (key === 'ArrowDown') { CUR.y += step; }
    if (key === 'ArrowLeft') { CUR.x -= step; }
    if (key === 'ArrowRight') { CUR.x += step; }
    CUR.x = Math.max(0, Math.min(window.innerWidth - 1, CUR.x));
    CUR.y = Math.max(0, Math.min(window.innerHeight - 1, CUR.y));
    drawCursor();
  }

  window.__snakeToggleCursor = function () {
    MODE = MODE === 'game' ? 'cursor' : 'game';
    window.__snakeMode = MODE;
    if (MODE === 'cursor') {
      if (CUR.x < 0) {
        CUR.x = Math.floor(window.innerWidth / 2);
        CUR.y = Math.floor(window.innerHeight / 2);
      }
      drawCursor();
      toast('Cursor mode: OK clicks');
      tell('cursor mode on');
    } else {
      if (cursorEl && cursorEl.parentNode) {
        cursorEl.style.display = 'none';
      }
      toast('D-pad steers the game');
      tell('cursor mode off');
    }
    if (window.__snakeFit) {
      window.__snakeFit('toggle');
    }
  };

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopImmediatePropagation();
      tell('key ' + k + ' ' + e.keyCode +
           (MODE === 'cursor' ? ' -> click at cursor' : ' -> click'));
      if (window.__snakeClick) {
        window.__snakeClick();
      }
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown' ||
        k === 'ArrowLeft' || k === 'ArrowRight') {
      if (MODE === 'cursor') {
        e.preventDefault();
        e.stopImmediatePropagation();
        moveCursor(k);
        return;
      }
      tell('key ' + k + ' ' + e.keyCode);
      if (window.__snakeFit) {
        window.__snakeFit('key');
      }
    }
  }, true);
  true;
})();
`;

/**
 * Injected at load: fit, click, and the probe. The key router lives in the
 * document-start script; this one defines what Enter calls (clicking at the
 * cursor in cursor mode, the play button or the screen center otherwise)
 * and what the arrows ask for (a re-fit). Snapshots at load and three
 * seconds later show what Google actually drew: the game module streams in
 * after onload, so one early snapshot alone would condemn a healthy page.
 */
const CONTROL_PROBE = `
(function () {
  var lastClick = 0;
  function tell(msg) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'LOG', message: msg}));
    } catch (e) {}
  }
  tell('page script running on ' + location.href);

  // The game canvas: biggest buffer wins (a side panel draws a second one).
  function gameCanvas() {
    var list = document.querySelectorAll('canvas');
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < list.length; i++) {
      var area = list[i].width * list[i].height;
      if (area > bestArea) {
        bestArea = area;
        best = list[i];
      }
    }
    return best;
  }

  // Measure the panel's layout size (offsetWidth), never the bounding rect:
  // the rect includes a scale we already applied, which made every check see
  // a "too big" panel and flip the game between scaled and original size.
  // Compare the finished transform string, so an unchanged fit, or a panel
  // Google rebuilt mid-game, settles on one size and stays there.
  function fitGame(why) {
    try {
      var canvas = gameCanvas();
      if (!canvas) {
        return;
      }
      var host = document.querySelector('.m6tB9e > div');
      if (!host || !host.contains(canvas)) {
        tell('fit ' + why + ': no known host');
        return;
      }
      var w = host.offsetWidth;
      var h = host.offsetHeight;
      if (w < 4 || h < 4) {
        return;
      }
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var s = Math.min(vw / w, vh / h) / 1.06;
      if (s < 1.02) {
        s = 1;
      }
      if (s > 2.6) {
        s = 2.6;
      }
      var want = 'translate(-50%, -50%) scale(' + s.toFixed(3) + ')';
      if (host.style.transform === want) {
        return;
      }
      host.style.overflow = 'visible';
      host.style.transform = want;
      tell('fit ' + why + ': scale=' + s.toFixed(2) +
           ' panel ' + w + 'x' + h + ' in ' + vw + 'x' + vh);
    } catch (e) {
      tell('fit failed: ' + e);
    }
  }
  window.__snakeFit = fitGame;

  // One click for OK, from whichever pipe delivered it first. In cursor
  // mode it lands where the pointer stands; otherwise a visible play-ish
  // button wins, else whatever sits at the screen center (the canvas the
  // start overlay is drawn on) gets a real mouse sequence.
  function snakeClick(why) {
    var now = Date.now();
    if (now - lastClick < 400) {
      tell('click ignored (double ' + why + ')');
      return;
    }
    lastClick = now;
    try {
      fitGame(why);
      var cursorMode = window.__snakeMode === 'cursor';
      var target = null;
      var how = '';
      var cx = 0;
      var cy = 0;
      if (cursorMode) {
        var cur = window.__snakeCursor || {x: 0, y: 0};
        target = document.elementFromPoint(cur.x, cur.y);
        how = 'cursor-> ' + (target
          ? target.tagName + '.' + (target.className || '-')
          : 'nothing');
        cx = cur.x;
        cy = cur.y;
        if (!target) {
          tell('click ' + why + ': nothing under the cursor');
          return;
        }
      } else {
        var btns = document.querySelectorAll('button, [role=button], a');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var br = b.getBoundingClientRect();
          if (br.width < 1 || br.height < 1) {
            continue;
          }
          var txt = (b.textContent || '').trim().toLowerCase();
          if (/play|replay|start|again/.test(txt)) {
            target = b;
            how = 'button "' + txt.slice(0, 24) + '"';
            break;
          }
        }
        if (!target) {
          target = document.elementFromPoint(
            Math.floor(window.innerWidth / 2),
            Math.floor(window.innerHeight / 2));
          how = target
            ? target.tagName + '.' + (target.className || '-')
            : 'nothing';
        }
        if (!target) {
          tell('click ' + why + ': nothing under the center');
          return;
        }
      }
      if (target.tagName === 'BUTTON' || target.tagName === 'A' ||
          target.tagName === 'INPUT' || target.tagName === 'LABEL' ||
          target.getAttribute('role') === 'button') {
        target.click();
        tell('click ' + why + ': ' + how + ' via click()');
        setTimeout(warmCache, 4000);
        return;
      }
      if (!cursorMode) {
        var r = target.getBoundingClientRect();
        cx = Math.floor(r.left + r.width / 2);
        cy = Math.floor(r.top + r.height / 2);
      }
      target.dispatchEvent(new MouseEvent('mousemove',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy}));
      target.dispatchEvent(new PointerEvent('pointerdown',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy,
         button: 0, buttons: 1, pointerId: 1, isPrimary: true,
         pointerType: 'mouse'}));
      target.dispatchEvent(new MouseEvent('mousedown',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy,
         button: 0, buttons: 1}));
      target.dispatchEvent(new PointerEvent('pointerup',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy,
         button: 0, buttons: 0, pointerId: 1, isPrimary: true,
         pointerType: 'mouse'}));
      target.dispatchEvent(new MouseEvent('mouseup',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy,
         button: 0, buttons: 0}));
      target.dispatchEvent(new MouseEvent('click',
        {bubbles: true, cancelable: true, clientX: cx, clientY: cy,
         button: 0}));
      tell('click ' + why + ': ' + how + ' @' + cx + ',' + cy);
      setTimeout(warmCache, 4000);
    } catch (e) {
      tell('click failed: ' + e);
    }
  }
  window.__snakeClick = function () { snakeClick('rn'); };

  // Pull every asset once more while still online so the disk cache holds
  // the complete game (the start screen lazily fetches more after click).
  function warmCache() {
    try {
      var entries = performance.getEntriesByType('resource') || [];
      var urls = [];
      for (var i = 0; i < entries.length; i++) {
        var u = entries[i].name;
        if (u.indexOf('http') !== 0) {
          continue;
        }
        if (u.indexOf('client_204') > -1 || u.indexOf('gen_204') > -1) {
          continue; // zero-length beacons, nothing to store
        }
        if (urls.indexOf(u) < 0) {
          urls.push(u);
        }
      }
      var done = 0;
      var failed = 0;
      var idx = 0;
      function pump() {
        if (idx >= urls.length) {
          tell('warm: ' + done + ' ok, ' + failed + ' failed of ' +
               urls.length);
          return;
        }
        var batch = urls.slice(idx, idx + 12);
        idx += 12;
        Promise.all(batch.map(function (u) {
          return fetch(u, {cache: 'force-cache', mode: 'no-cors'}).then(
            function () { done++; },
            function () { failed++; });
        })).then(pump);
      }
      pump();
    } catch (e) {
      tell('warm failed: ' + e);
    }
  }

  function snapshot(tag) {
    try {
      fitGame(tag);
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var at = document.elementFromPoint(
        Math.floor(vw / 2), Math.floor(vh / 2));
      tell(tag + ' center=' + (at ? at.tagName + '.' + (at.className || '-')
        : 'none'));
      var canvases = document.querySelectorAll('canvas');
      var info = [];
      for (var i = 0; i < canvases.length && i < 4; i++) {
        var r = canvases[i].getBoundingClientRect();
        info.push(canvases[i].width + 'x' + canvases[i].height +
          '(shown ' + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
      }
      tell(tag + ' inner=' + vw + 'x' + vh + ' canvases=' + canvases.length +
           (info.length ? ' [' + info.join(', ') + ']' : ''));
      var container = document.querySelector('.m6tB9e');
      tell(tag + ' google=' + typeof window.google +
           ' container=' + (container ? container.children.length + ' kids'
             : 'missing') +
           ' bodyKids=' + document.body.children.length);
      var entries = performance.getEntriesByType('resource') || [];
      tell(tag + ' resources=' + entries.length);
    } catch (e) {
      tell(tag + ' snapshot failed: ' + e);
    }
  }
  snapshot('t0');
  setTimeout(function () { snapshot('t3'); }, 3000);
  true;
})();
`;

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();
  const webRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Select and Menu are decided here: OK becomes the page's click (center
  // or play button in game mode, the pointer's spot in cursor mode) and
  // Menu flips between those modes. Everything else is logged so a button
  // that is not mapped yet still shows up in logcat.
  useTVEventHandler(
    useCallback((event: HWEvent) => {
      const type = event.eventType;
      if (event.eventKeyAction === 1) {
        return; // key release, we act on the press
      }
      const web = webRef.current as any;
      if (!web?.injectJavaScript) {
        return;
      }
      if (type === 'select') {
        console.info('[snake] select -> page click');
        web.injectJavaScript(CLICK_SCRIPT);
      } else if (type === 'menu') {
        console.info('[snake] menu -> cursor toggle');
        web.injectJavaScript(CURSOR_TOGGLE_SCRIPT);
      } else {
        console.info(`[snake] tv ${type} a${event.eventKeyAction ?? '?'}`);
      }
    }, []),
  );

  const onLoad = useCallback(() => {
    console.info('[snake] page loaded');
    hideSplashScreenCallback();
    setLoaded(true);
    const web = webRef.current as any;
    if (web?.injectJavaScript) {
      try {
        web.injectJavaScript(CONTROL_PROBE);
      } catch (err) {
        console.warn('[snake] injectJavaScript failed:', err);
      }
    } else {
      console.warn('[snake] injectJavaScript unavailable on this WebView');
    }
  }, [hideSplashScreenCallback]);

  const onError = useCallback(
    (event: any) => {
      const description = event?.nativeEvent?.description || 'unknown error';
      console.error(`[snake] WebView error: ${description}`);
      hideSplashScreenCallback();
      setLoadError(description);
    },
    [hideSplashScreenCallback],
  );

  const onMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'LOG') {
        console.info(`[snake] ${msg.message}`);
      }
    } catch {
      // Not our JSON.
    }
  }, []);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        source={{uri: GAME_URL}}
        // Focus immediately so the remote drives the page.
        hasTVPreferredFocus
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={EARLY_PROBE}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        // Same as VegaTube and DOOM: arrows and Enter still reach the page,
        // Back stays with the system and leaves the app.
        allowSystemKeyEvents={false}
        // Serve from the disk cache regardless of age, falling back to the
        // network only when a file was never cached: that is what makes the
        // game load with the wifi off after one online visit.
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        onLoad={onLoad}
        onError={onError}
        onHttpError={(event: any) => {
          console.info(
            `[snake] http ${event.nativeEvent.statusCode} ` +
              `for ${event.nativeEvent.description || GAME_URL}`,
          );
        }}
        // Not in Amazon's props type (VegaTube casts it the same way):
        // log every committed navigation, redirects included.
        {...({
          onNavigationStateChange: (nav: any) => {
            if (nav?.url) {
              console.info(`[snake] nav ${nav.url} loading=${nav.loading}`);
            }
          },
        } as any)}
        onMessage={onMessage}
      />
      {!loaded && !loadError ? (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayText}>Loading Google&apos;s Snake...</Text>
        </View>
      ) : null}
      {loadError ? (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.errorText}>Couldn&apos;t reach Google</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
          <Text style={styles.errorDetail}>
            The game streams from google.com: check the stick is online.
          </Text>
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
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#000',
  },
  overlayText: {
    color: '#c6c6c6',
    fontSize: 20,
  },
  errorText: {
    color: '#fff',
    fontSize: 22,
    marginBottom: 8,
  },
  errorDetail: {
    color: '#9e9e9e',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 6,
  },
});
