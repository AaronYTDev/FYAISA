/**
 * Scoreboard for Vega OS.
 *
 * A two-team scorekeeper for board games, card games and couch tournaments.
 * Pure React Native — no WebView, no network, no sign-in. The remote owns the
 * whole interface: D-pad up/down picks a team, left/right and OK change the
 * score, Menu resets the match, Back quits, Home exits.
 */
import React, {useCallback, useEffect, useState} from 'react';
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

type Team = 0 | 1;

const COLORS = {
  bg: '#0b0f18',
  panel: '#141b2b',
  panelActive: '#1d2a42',
  left: '#3d8bff',
  right: '#ff5d5d',
  text: '#f5f7ff',
  dim: '#9aa7bd',
  hint: '#c6d2e6',
  focus: '#ffb02e',
};

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [selected, setSelected] = useState<Team>(0);
  const [winTarget, setWinTarget] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const adjust = useCallback((delta: number) => {
    const team = selected;
    setScores(prev => {
      const next: [number, number] = [...prev];
      next[team] = Math.max(0, Math.min(999, next[team] + delta));
      return next;
    });
    setFlash(delta > 0 ? `+${delta} ${team === 0 ? 'Home' : 'Away'}` : `${delta} ${team === 0 ? 'Home' : 'Away'}`);
  }, [selected]);

  const addSelected = useCallback(() => adjust(1), [adjust]);

  const reset = useCallback(() => {
    setScores([0, 0]);
    setWinTarget(0);
    setFlash('Match reset');
  }, []);

  const cycleTarget = useCallback(() => {
    setWinTarget(v => (v + 5) % 55); // 0 = off, then 5..50
    setFlash('Target changed');
  }, []);

  const winner = winTarget > 0 && (scores[0] >= winTarget || scores[1] >= winTarget)
    ? scores[0] >= winTarget ? 'Home wins' : 'Away wins'
    : null;

  useTVEventHandler(
    useCallback((event: HWEvent) => {
      if (event.eventKeyAction !== 0) return;
      const type = event.eventType;
      if (type === 'dpadUp' || type === 'dpadDown') {
        setSelected(s => (s === 0 ? 1 : 0));
      } else if (type === 'dpadLeft') {
        adjust(-1);
      } else if (type === 'dpadRight' || type === 'select') {
        adjust(1);
      } else if (type === 'menu') {
        reset();
      } else if (type === 'playpause' || type === 'pause') {
        cycleTarget();
      }
    }, [adjust, reset, cycleTarget]),
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => false);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    hideSplashScreenCallback();
  }, [hideSplashScreenCallback]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(id);
  }, [flash]);

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Text style={styles.kicker}>COUCH SCOREBOARD</Text>
        <Text style={styles.target}>
          {winTarget > 0 ? `First to ${winTarget}` : 'Free play'}
        </Text>
      </View>

      <View style={styles.boards}>
        <View style={[styles.team, selected === 0 && styles.teamActive]}>
          <View style={[styles.teamBar, {backgroundColor: COLORS.left}]} />
          <Text style={styles.teamName}>HOME</Text>
          <Text style={[styles.score, selected === 0 && styles.scoreActive]}>{scores[0]}</Text>
          <Text style={styles.teamHint}>{selected === 0 ? 'Selected' : 'D-pad up/down'}</Text>
        </View>
        <View style={[styles.team, selected === 1 && styles.teamActive]}>
          <View style={[styles.teamBar, {backgroundColor: COLORS.right}]} />
          <Text style={styles.teamName}>AWAY</Text>
          <Text style={[styles.score, selected === 1 && styles.scoreActive]}>{scores[1]}</Text>
          <Text style={styles.teamHint}>{selected === 1 ? 'Selected' : 'D-pad up/down'}</Text>
        </View>
      </View>

      <View style={styles.status}>
        {winner ? (
          <Text style={styles.winner}>{winner}</Text>
        ) : (
          <Text style={styles.flash}>{flash || 'Ready'}</Text>
        )}
      </View>

      <View style={styles.help}>
        <Text style={styles.helpLine}>
          ▲▼ pick team   ◀ minus   ▶ / OK plus   Menu reset
        </Text>
        <Text style={styles.helpLine}>Play/Pause changes the winning target</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 44,
    paddingTop: 34,
    paddingBottom: 24,
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kicker: {
    color: COLORS.focus,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 3,
  },
  target: {
    color: COLORS.dim,
    fontSize: 18,
  },
  boards: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 24,
    marginTop: 34,
    marginBottom: 20,
  },
  team: {
    flex: 1,
    backgroundColor: COLORS.panel,
    borderRadius: 24,
    padding: 24,
    borderWidth: 4,
    borderColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  teamActive: {
    backgroundColor: COLORS.panelActive,
    borderColor: COLORS.focus,
  },
  teamBar: {
    width: 84,
    height: 8,
    borderRadius: 4,
    marginBottom: 20,
  },
  teamName: {
    color: COLORS.dim,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 4,
  },
  score: {
    color: COLORS.text,
    fontSize: 150,
    fontWeight: '800',
    lineHeight: 164,
    marginVertical: 8,
  },
  scoreActive: {color: COLORS.focus},
  teamHint: {color: COLORS.dim, fontSize: 16},
  status: {alignItems: 'center', minHeight: 38},
  flash: {color: COLORS.hint, fontSize: 20},
  winner: {color: COLORS.focus, fontSize: 28, fontWeight: '700'},
  help: {marginTop: 18, alignItems: 'center'},
  helpLine: {color: COLORS.dim, fontSize: 17, marginBottom: 6},
});
