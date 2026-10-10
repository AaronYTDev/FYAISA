/**
 * DOOM for Vega OS.
 *
 * id Software's shareware episode, compiled from doomgeneric to WebAssembly
 * with emscripten, runs inside a Vega WebView and draws to a canvas. The
 * shell page ships as an app asset (file:///pkg/assets is the WebView's
 * default file access) and the game blob rides in as base64: the bridge
 * drops oversized injectJavaScript payloads (VegaTube's 630 KB TizenTube
 * bundle was accepted and never executed), so it crosses in 16 KB
 * order-independent chunks that the page reassembles, decodes and evals.
 *
 * Controls live in the shell's key shim; the remote's system buttons never
 * reach the WebView at all, so they are handled here instead: Back is the
 * Use key, Menu is Escape (the DOOM menu and backing out of submenus), both
 * injected into the page. Every raw TV event is logged so a button that is
 * not mapped yet still shows up in logcat. Home exits the app.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';
import {DOOM_B64} from './doomPayload';

const SHELL_URI = 'file:///pkg/assets/shell.html';

/** Bridge-safe payload size: what VegaTube ships its bundle in. */
const CHUNK_SIZE = 16 * 1024;

const CHUNKS: string[] = (() => {
  const chunks: string[] = [];
  for (let i = 0; i < DOOM_B64.length; i += CHUNK_SIZE) {
    chunks.push(DOOM_B64.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
})();

/** One slice: stores itself under its index, counts, boots at the full set. */
const buildChunkScript = (index: number): string =>
  'window.__doomPush&&window.__doomPush(' +
  index +
  ',' +
  CHUNKS.length +
  ',' +
  JSON.stringify(CHUNKS[index]) +
  ');';

/** Space pair: DOOM's open doors and press switches (single-flighted in the page). */
const USE_KEY_SCRIPT = 'window.__doomUse&&window.__doomUse();true;';

/** Escape pair: the DOOM menu, and backing out of submenus. */
const ESCAPE_KEY_SCRIPT = 'window.__doomEscape&&window.__doomEscape();true;';

/** D-pad directions are the page's own business; log the rest of the remote. */
const NAV_KEYS: Record<string, boolean> = {
  up: true,
  down: true,
  left: true,
  right: true,
};

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();
  const webRef = useRef<any>(null);
  const sentRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const sendGame = useCallback(() => {
    const web = webRef.current as any;
    if (sentRef.current) {
      return;
    }
    if (!web?.injectJavaScript) {
      console.warn('[doom] injectJavaScript unavailable on this WebView');
      return;
    }
    sentRef.current = true;
    try {
      CHUNKS.forEach((_, index) => {
        web.injectJavaScript(buildChunkScript(index));
      });
      console.info(
        `[doom] sending ${CHUNKS.length} chunks of ${CHUNK_SIZE / 1024} KB`,
      );
    } catch (err) {
      console.error('[doom] injectJavaScript failed:', err);
    }
  }, []);

  const onLoad = useCallback(() => {
    console.info('[doom] shell loaded');
    hideSplashScreenCallback();
    sendGame();
  }, [hideSplashScreenCallback, sendGame]);

  const onError = useCallback(
    (event: any) => {
      const description = event?.nativeEvent?.description || 'unknown error';
      console.error(`[doom] WebView error: ${description}`);
      hideSplashScreenCallback();
      setLoadError(description);
    },
    [hideSplashScreenCallback],
  );

  const onMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'DOOM_LOG') {
        console.info(`[doom] ${msg.message}`);
      }
    } catch {
      // Not our JSON.
    }
  }, []);

  // Menu and Play/Pause are system buttons: the WebView never sees them, but
  // the UserInputManager does. Forward the two that matter into the page and
  // log every other event, pressing on (action 0 or a single fire) only.
  useTVEventHandler(
    useCallback(
      (event: HWEvent) => {
        const action = event.eventKeyAction;
        if (!NAV_KEYS[event.eventType]) {
          console.info(`[doom] tv ${event.eventType} a${action ?? '?'}`);
        }
        if (action === 1 || loadError) {
          return; // key release (handled on press) or no page to talk to
        }
        const web = webRef.current as any;
        if (!web?.injectJavaScript) {
          return;
        }
        if (event.eventType === 'menu') {
          web.injectJavaScript(ESCAPE_KEY_SCRIPT);
        } else if (
          event.eventType === 'playpause' ||
          event.eventType === 'pause'
        ) {
          web.injectJavaScript(USE_KEY_SCRIPT);
        }
      },
      [loadError],
    ),
  );

  // The WebView swallows Back, so the page never sees it: forward it as the
  // Use key. Once the shell failed to load there is nothing to use, so Back
  // falls through and exits the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const web = webRef.current as any;
      if (!loadError && web?.injectJavaScript) {
        web.injectJavaScript(USE_KEY_SCRIPT);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [loadError]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        source={{uri: SHELL_URI}}
        // Focus immediately so the remote drives the game.
        hasTVPreferredFocus
        javaScriptEnabled
        domStorageEnabled
        // Let the Web Audio context (SDL_mixer's output) start without a
        // gesture; the remote's first press resumes it if the WebView still
        // holds it suspended.
        mediaPlaybackRequiresUserAction={false}
        onLoad={onLoad}
        onError={onError}
        onMessage={onMessage}
      />
      {loadError ? (
        <View style={styles.errorOverlay} pointerEvents="none">
          <Text style={styles.errorText}>Couldn&apos;t start DOOM</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
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
  errorOverlay: {
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
  errorText: {
    color: '#fff',
    fontSize: 22,
    marginBottom: 8,
  },
  errorDetail: {
    color: '#9e9e9e',
    fontSize: 14,
    textAlign: 'center',
  },
});
