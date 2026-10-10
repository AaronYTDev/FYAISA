/**
 * Google Snake for Vega OS.
 *
 * Google's snake arcade game (the doodle build Google serves for a snake
 * search) lives on google.com. This app is only a frame around it: a Vega
 * WebView pointed at the game URL. Content keys reach the page on the same
 * path DOOM uses, and a small script injected at every load reports which
 * URL landed and every key the page sees, so the remote plumbing can be
 * read out of logcat instead of guessed at.
 *
 * Back falls through to the system and leaves the app, Home exits.
 */
import React, {useCallback, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';

/** Google's full-screen snake arcade game. */
const GAME_URL = 'https://www.google.com/fbx?fbx=snake_arcade';

/**
 * Injected after every page load. The first line proves injection works on
 * a cross-origin page and shows where we actually landed (redirects,
 * consent walls); after that every keydown the page receives goes to the
 * console as `[snake] key ...`.
 */
const KEY_PROBE = `
(function () {
  function tell(msg) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({type: 'LOG', message: msg}));
    } catch (e) {}
  }
  tell('page script running on ' + location.href);
  window.addEventListener('keydown', function (e) {
    tell('key ' + e.key + ' ' + e.keyCode);
  }, true);
  true;
})();
`;

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();
  const webRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const onLoad = useCallback(() => {
    console.info('[snake] page loaded');
    hideSplashScreenCallback();
    setLoaded(true);
    const web = webRef.current as any;
    if (web?.injectJavaScript) {
      try {
        web.injectJavaScript(KEY_PROBE);
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
        javaScriptEnabled
        domStorageEnabled
        onLoad={onLoad}
        onError={onError}
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
