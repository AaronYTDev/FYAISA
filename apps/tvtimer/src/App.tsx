/**
 * TV Timer for Vega OS.
 *
 * A stopwatch and a countdown timer in one app, driven entirely by the Fire
 * TV remote. Pure React Native — no WebView, no network, nothing to sign
 * into, works fully offline. KeplerFileSystem is not used; nothing is
 * persisted, so a session ends when the app leaves the foreground.
 *
 * Remote mapping:
 *   - D-pad left/right: switch between stopwatch and countdown
 *   - D-pad up/down: adjust the countdown minutes (countdown mode only)
 *   - OK: start / stop the running timer
 *   - Menu: reset the active timer
 *   - Back: quit to the launcher
 *   - Home: exit
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';

/** The two timer modes. */
type Mode = 'stopwatch' | 'countdown';

/**
 * One tenth of a second is the smallest unit we show, so the display never
 * jitters on a TV and the remote can hit whole seconds cleanly.
 */
const TICK_MS = 100;

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [mode, setMode] = useState<Mode>('stopwatch');
  // Elapsed hundredths for the stopwatch, and remaining hundredths for the
  // countdown. A single shared counter keeps the display code in one place.
  const [tenths, setTenths] = useState(0);
  // Countdown starting value in hundredths, so "reset" restores it.
  const [countdownTotal, setCountdownTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Format hundredths of a second as H:MM:SS (stopwatch) or M:SS (countdown). */
  const format = useCallback(
    (t: number): string => {
      const totalSecs = Math.floor(t / 10);
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      const h10 = t % 10;
      if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${h10}`;
      }
      return `${m}:${String(s).padStart(2, '0')}.${h10}`;
    },
    [],
  );

  /** Start or resume the tick loop. */
  const start = useCallback(() => {
    if (running) return;
    if (tenths === 0 && mode === 'countdown' && countdownTotal === 0) {
      return; // nothing to count down
    }
    setRunning(true);
    tickRef.current = setInterval(() => {
      setTenths(t => {
        const next = t - 1;
        if (next <= 0 && mode === 'countdown') {
          setRunning(false);
          tickRef.current && clearInterval(tickRef.current);
          tickRef.current = null;
          return 0;
        }
        return next;
      });
    }, TICK_MS);
  }, [running, tenths, mode, countdownTotal]);

  /** Stop the tick loop without resetting. */
  const stop = useCallback(() => {
    if (!running) return;
    setRunning(false);
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, [running]);

  /** Reset the active timer to its starting value. */
  const reset = useCallback(() => {
    stop();
    setTenths(mode === 'countdown' ? countdownTotal : 0);
  }, [mode, countdownTotal, stop]);

  /** Switch to the other mode, carrying nothing over. */
  const toggleMode = useCallback(() => {
    stop();
    setMode(m => (m === 'stopwatch' ? 'countdown' : 'stopwatch'));
    setTenths(0);
  }, [stop]);

  /** Bump the countdown up or down by a minute (remote up/down). */
  const adjustCountdown = useCallback(
    (dir: 1 | -1) => {
      if (mode !== 'countdown') return;
      if (running) return;
      const step = 600; // one minute in hundredths
      const next = Math.max(0, countdownTotal + dir * step);
      setCountdownTotal(next);
      setTenths(next);
    },
    [mode, running, countdownTotal],
  );

  // Remote input: D-pad left/right switches mode, up/down adjusts the
  // countdown, OK starts/stops, Menu resets.
  useTVEventHandler(
    useCallback((event: HWEvent) => {
      if (event.eventKeyAction !== 0) {
        return; // act on the press, not the release
      }
      const type = event.eventType;
      if (type === 'dpadLeft' || type === 'dpadRight') {
        toggleMode();
      } else if (type === 'dpadUp' || type === 'dpadDown') {
        adjustCountdown(type === 'dpadUp' ? 1 : -1);
      } else if (type === 'select') {
        running ? stop() : start();
      } else if (type === 'menu') {
        reset();
      }
    }, [mode, running, toggleMode, adjustCountdown, start, stop, reset]),
  );

  // Start ticking whenever running (re-mounts the interval after a render).
  useEffect(() => {
    if (running && !tickRef.current) {
      start();
    }
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [running, start]);

  // Back falls through to the system and leaves the app; Home exits.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    hideSplashScreenCallback();
  }, [hideSplashScreenCallback]);

  const isCountdown = mode === 'countdown';
  const label = isCountdown ? 'Countdown' : 'Stopwatch';
  const hint = isCountdown
    ? '▲▼ minutes   ◀▶ mode   OK start   Menu reset'
    : '◀▶ mode   OK start   Menu reset';

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.badge}>{label}</Text>
        <Text style={styles.time}>{format(tenths)}</Text>
        {isCountdown && countdownTotal === 0 && !running ? (
          <Text style={styles.hint}>Set minutes with ▲▼</Text>
        ) : null}
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 56,
    backgroundColor: '#1e1e1e',
    borderRadius: 22,
  },
  badge: {
    color: '#42a5f5',
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 2,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  time: {
    color: '#ffffff',
    fontSize: 96,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginVertical: 14,
  },
  hint: {
    color: '#9e9e9e',
    fontSize: 17,
    textAlign: 'center',
    marginTop: 4,
  },
});
