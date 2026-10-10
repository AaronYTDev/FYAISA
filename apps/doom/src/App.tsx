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
 * Controls live in the shell's key shim; the one thing the page cannot see
 * is Back (the WebView swallows it), so Back is handled here and injected
 * into the page as the Use key. Home exits the app.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
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

/** Space keydown+keyup: DOOM's open doors and press switches. */
const USE_KEY_SCRIPT =
  "window.__doomKey&&(" +
  "window.__doomKey(' ','Space',32,'keydown');" +
  "window.__doomKey(' ','Space',32,'keyup'));true;";

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
