/**
 * Super Mario Bros for Vega OS
 * -----------------------------
 * A NES emulator shell that downloads the SMB ROM from an external source
 * on first launch (no ROM bundled, legally clean).
 *
 * TV remote mapping:
 * - D-Pad = NES D-Pad
 * - Menu = Start
 * - Back = Select
 * - Fast-forward = A
 * - Play/Pause = B
 *
 * The emulator runs in a WebView using jsnes (loaded from CDN).
 * The ROM is downloaded from an external host on first launch.
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
  useTVEventHandler,
  Pressable as KeplerPressable,
} from '@amazon-devices/react-native-kepler';
import {KeplerFileSystem} from '@amazon-kepler-file-system';

// ROM download URL (external host, not bundled)
const ROM_URL = 'https://archive.org/download/SuperMarioBrosUSA/Super%20Mario%20Bros.%20%28USA%29.nes';
const ROM_CACHE_PATH = '/data/smb-rom.nes';

// jsnes CDN
const JSNES_CDN = 'https://cdn.jsdelivr.net/npm/jsnes@1.2.1/dist/jsnes.min.js';

const APP_VERSION = '1.0.0';

export const App = () => {
  const webRef = useRef(null);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [romReady, setRomReady] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  // Check if ROM is already cached, if not download it
  useEffect(() => {
    checkAndDownloadRom();
  }, []);

  const checkAndDownloadRom = async () => {
    setLoading(true);
    try {
      // Check if ROM exists in cache
      const exists = await KeplerFileSystem.exists(ROM_CACHE_PATH);
      if (exists) {
        console.info('[SMB] ROM found in cache');
        setRomReady(true);
        setLoading(false);
        hideSplashScreenCallback();
        return;
      }

      // Download ROM from external source
      console.info('[SMB] Downloading ROM from external source...');
      const res = await fetch(ROM_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const romData = await res.arrayBuffer();

      // Save to cache
      const romBytes = new Uint8Array(romData);
      const romBase64 = btoa(String.fromCharCode(...romBytes));
      await KeplerFileSystem.removeFile(ROM_CACHE_PATH).catch(() => {});
      await KeplerFileSystem.writeStringToFile(ROM_CACHE_PATH, romBase64, 'UTF-8');

      console.info('[SMB] ROM downloaded and cached');
      setRomReady(true);
      setLoading(false);
      hideSplashScreenCallback();
    } catch (e: any) {
      console.error('[SMB] ROM download failed:', e?.message || e);
      setError(`Failed to download ROM: ${e?.message || e}`);
      setLoading(false);
      hideSplashScreenCallback();
    }
  };

  // Forward button press to the WebView emulator
  const sendButton = useCallback((button: string, pressed: boolean) => {
    const web = webRef.current as any;
    if (!web?.injectJavaScript) return;
    web.injectJavaScript(
      `window.__nesButton && window.__nesButton('${button}', ${pressed});`
    );
  }, []);

  // TV remote button mapping
  useTVEventHandler((event: any) => {
    if (!romReady) return;

    const {eventType, eventKeyAction} = event;
    // Filter: only handle keydown (eventKeyAction 0) to avoid double-firing
    if (eventKeyAction !== 0) return;

    switch (eventType) {
      case 'up':
        sendButton('up', true);
        break;
      case 'down':
        sendButton('down', true);
        break;
      case 'left':
        sendButton('left', true);
        break;
      case 'right':
        sendButton('right', true);
        break;
      case 'select':
        // OK button = A
        sendButton('a', true);
        break;
      case 'menu':
        // Menu = Start
        sendButton('start', true);
        break;
      case 'back':
        // Back = Select
        sendButton('select', true);
        break;
      case 'ff':
        // Fast-forward = A
        sendButton('a', true);
        break;
      case 'playpause':
        // Play/Pause = B
        sendButton('b', true);
        break;
    }
  });

  // Handle key release (for buttons that need press-and-release)
  useTVEventHandler((event: any) => {
    if (!romReady) return;

    const {eventType, eventKeyAction} = event;
    // Only handle keyup (eventKeyAction 1)
    if (eventKeyAction !== 1) return;

    switch (eventType) {
      case 'up':
        sendButton('up', false);
        break;
      case 'down':
        sendButton('down', false);
        break;
      case 'left':
        sendButton('left', false);
        break;
      case 'right':
        sendButton('right', false);
        break;
      case 'select':
        sendButton('a', false);
        break;
      case 'menu':
        sendButton('start', false);
        break;
      case 'back':
        sendButton('select', false);
        break;
      case 'ff':
        sendButton('a', false);
        break;
      case 'playpause':
        sendButton('b', false);
        break;
    }
  });

  // Back button: show menu overlay
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setShowMenu(prev => !prev);
      return true;
    });
    return () => sub.remove();
  }, []);

  const retryDownload = useCallback(() => {
    setError(null);
    checkAndDownloadRom();
  }, []);

  return (
    <View style={styles.container}>
      {loading && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.loadingText}>Downloading ROM…</Text>
        </View>
      )}

      {error && (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>ROM Download Failed</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>
            Check your internet connection and try again.
          </Text>
          <KeplerPressable
            hasTVPreferredFocus
            onPress={retryDownload}
            style={({focused}: {focused: boolean}) => [
              styles.retryButton,
              focused && styles.focusedRing,
            ]}>
            <Text style={styles.retryText}>Retry</Text>
          </KeplerPressable>
        </View>
      )}

      {romReady && (
        <WebView
          ref={webRef}
          style={styles.webview}
          source={{uri: 'file:///pkg/assets/smb/index.html'}}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowSystemKeyEvents={false}
          mediaPlaybackRequiresUserAction={false}
        />
      )}

      {showMenu && (
        <View style={styles.menuOverlay}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Super Mario Bros</Text>
            <Text style={styles.menuText}>D-Pad: Move</Text>
            <Text style={styles.menuText}>OK: A</Text>
            <Text style={styles.menuText}>Menu: Start</Text>
            <Text style={styles.menuText}>Back: Select</Text>
            <Text style={styles.menuText}>FF: A</Text>
            <Text style={styles.menuText}>Play/Pause: B</Text>
            <KeplerPressable
              hasTVPreferredFocus
              onPress={() => setShowMenu(false)}
              style={({focused}: {focused: boolean}) => [
                styles.menuBtn,
                focused && styles.focusedRing,
              ]}>
              <Text style={styles.menuBtnText}>Close</Text>
            </KeplerPressable>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000'},
  webview: {flex: 1, backgroundColor: '#000'},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  loadingText: {color: '#aaa', fontSize: 18, marginTop: 16},
  errorTitle: {color: '#fff', fontSize: 24, marginBottom: 12},
  errorText: {color: '#ccc', fontSize: 16, textAlign: 'center', marginBottom: 8},
  errorHint: {color: '#888', fontSize: 14, textAlign: 'center', marginBottom: 24},
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: '#e50914',
    borderRadius: 4,
  },
  retryText: {color: '#fff', fontSize: 18},
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuCard: {
    backgroundColor: '#16161d',
    borderRadius: 12,
    padding: 32,
    maxWidth: 480,
    alignItems: 'center',
  },
  menuTitle: {color: '#fff', fontSize: 28, fontWeight: '700', marginBottom: 20},
  menuText: {color: '#a9a9b8', fontSize: 16, marginBottom: 8},
  menuBtn: {
    marginTop: 20,
    backgroundColor: '#e50914',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 6,
  },
  menuBtnText: {color: '#fff', fontSize: 18},
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