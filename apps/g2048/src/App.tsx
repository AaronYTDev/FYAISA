/**
 * 2048 for Vega OS.
 *
 * The classic sliding-tile puzzle, fully offline and drawn with plain React
 * Native views. The remote drives every move: D-pad slides tiles, OK starts a
 * new game, Menu undoes the last move, Back quits, Home exits. No WebView, no
 * network, no account, no bundled third-party assets.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
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

const SIZE = 4;
type Grid = number[];

const PALETTE: Record<number, {bg: string; fg: string}> = {
  0: {bg: '#222a3b', fg: '#66738d'},
  2: {bg: '#eee4da', fg: '#3b4252'},
  4: {bg: '#ede0c8', fg: '#3b4252'},
  8: {bg: '#f2b179', fg: '#ffffff'},
  16: {bg: '#f59563', fg: '#ffffff'},
  32: {bg: '#f67c5f', fg: '#ffffff'},
  64: {bg: '#f65e3b', fg: '#ffffff'},
  128: {bg: '#edcf72', fg: '#ffffff'},
  256: {bg: '#edcc61', fg: '#ffffff'},
  512: {bg: '#edc850', fg: '#ffffff'},
  1024: {bg: '#edc53f', fg: '#ffffff'},
  2048: {bg: '#edc22e', fg: '#ffffff'},
};

const emptyGrid = (): Grid => Array.from({length: SIZE * SIZE}, () => 0);

const addTile = (grid: Grid): Grid => {
  const free: number[] = [];
  grid.forEach((v, i) => { if (v === 0) free.push(i); });
  if (!free.length) return grid;
  const index = free[Math.floor(Math.random() * free.length)];
  const next = [...grid];
  next[index] = Math.random() < 0.9 ? 2 : 4;
  return next;
};

const newGame = (): {grid: Grid; score: number} => ({
  grid: addTile(addTile(emptyGrid())),
  score: 0,
});

/** Collapse one line toward index 0, merging each tile at most once. */
const collapse = (line: number[]): {line: number[]; gained: number} => {
  const compact = line.filter(v => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < compact.length; i++) {
    if (compact[i] === compact[i + 1]) {
      const value = compact[i] * 2;
      out.push(value);
      gained += value;
      i += 1;
    } else {
      out.push(compact[i]);
    }
  }
  while (out.length < SIZE) out.push(0);
  return {line: out, gained};
};

const moveGrid = (grid: Grid, dir: 'left' | 'right' | 'up' | 'down'): {grid: Grid; gained: number; changed: boolean} => {
  const next = emptyGrid();
  let gained = 0;
  for (let line = 0; line < SIZE; line++) {
    const cells: number[] = [];
    for (let col = 0; col < SIZE; col++) {
      if (dir === 'left') cells.push(grid[line * SIZE + col]);
      else if (dir === 'right') cells.push(grid[line * SIZE + (SIZE - 1 - col)]);
      else if (dir === 'up') cells.push(grid[col * SIZE + line]);
      else cells.push(grid[(SIZE - 1 - col) * SIZE + line]);
    }
    const collapsed = collapse(cells);
    gained += collapsed.gained;
    for (let col = 0; col < SIZE; col++) {
      const value = collapsed.line[col];
      if (dir === 'left') next[line * SIZE + col] = value;
      else if (dir === 'right') next[line * SIZE + (SIZE - 1 - col)] = value;
      else if (dir === 'up') next[col * SIZE + line] = value;
      else next[(SIZE - 1 - col) * SIZE + line] = value;
    }
  }
  const changed = next.some((v, i) => v !== grid[i]);
  return {grid: changed ? addTile(next) : grid, gained, changed};
};

const canMove = (grid: Grid): boolean => {
  if (grid.some(v => v === 0)) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r * SIZE + c];
      if (c + 1 < SIZE && v === grid[r * SIZE + c + 1]) return true;
      if (r + 1 < SIZE && v === grid[(r + 1) * SIZE + c]) return true;
    }
  }
  return false;
};

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [state, setState] = useState(newGame);
  const [history, setHistory] = useState<{grid: Grid; score: number}[]>([]);
  const [message, setMessage] = useState('D-pad to slide');
  const [won, setWon] = useState(false);

  const biggest = useMemo(() => Math.max(0, ...state.grid), [state.grid]);
  const gameOver = !canMove(state.grid);

  const restart = useCallback(() => {
    setState(newGame());
    setHistory([]);
    setWon(false);
    setMessage('New game');
  }, []);

  const undo = useCallback(() => {
    setHistory(prev => {
      if (!prev.length) {
        setMessage('Nothing to undo');
        return prev;
      }
      const last = prev[prev.length - 1];
      setState(last);
      setWon(false);
      setMessage('Undone');
      return prev.slice(0, -1);
    });
  }, []);

  const slide = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    if (gameOver) return;
    setState(prev => {
      const moved = moveGrid(prev.grid, dir);
      if (!moved.changed) return prev;
      setHistory(h => [...h.slice(-19), prev]);
      const next = {grid: moved.grid, score: prev.score + moved.gained};
      if (!won && next.grid.includes(2048)) {
        setWon(true);
        setMessage('2048! OK for another round');
      } else if (!canMove(next.grid)) {
        setMessage('No moves left — OK for a new game');
      } else if (moved.gained > 0) {
        setMessage(`+${moved.gained}`);
      } else {
        setMessage('D-pad to slide');
      }
      return next;
    });
  }, [gameOver, won]);

  useTVEventHandler(
    useCallback((event: HWEvent) => {
      if (event.eventKeyAction !== 0) return;
      const type = event.eventType;
      if (type === 'dpadLeft') slide('left');
      else if (type === 'dpadRight') slide('right');
      else if (type === 'dpadUp') slide('up');
      else if (type === 'dpadDown') slide('down');
      else if (type === 'select' && (gameOver || won)) restart();
      else if (type === 'menu') undo();
    }, [slide, restart, undo, gameOver, won]),
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => false);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    hideSplashScreenCallback();
  }, [hideSplashScreenCallback]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>PUZZLE</Text>
          <Text style={styles.title}>2048</Text>
        </View>
        <View style={styles.scores}>
          <View style={styles.scoreBox}>
            <Text style={styles.scoreLabel}>SCORE</Text>
            <Text style={styles.scoreValue}>{state.score}</Text>
          </View>
          <View style={styles.scoreBox}>
            <Text style={styles.scoreLabel}>BEST</Text>
            <Text style={styles.scoreValue}>{biggest}</Text>
          </View>
        </View>
      </View>

      <View style={styles.board}>
        {state.grid.map((value, i) => {
          const color = PALETTE[value] || PALETTE[2048];
          return (
            <View
              key={i}
              style={[styles.tile, {backgroundColor: color.bg, borderColor: color.fg}]}>
              <Text style={[styles.tileText, {color: color.fg}]}>
                {value === 0 ? '' : value}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.status}>
        <Text style={styles.message}>{message}</Text>
        <Text style={styles.hint}>
          {gameOver || won
            ? 'OK new game   Menu undo   Back exit'
            : 'D-pad slide   OK restart   Menu undo   Back exit'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#10131d',
    paddingHorizontal: 42,
    paddingTop: 30,
    paddingBottom: 22,
    alignItems: 'center',
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  kicker: {color: '#ffb02e', fontSize: 16, fontWeight: '700', letterSpacing: 4},
  title: {color: '#f5f7ff', fontSize: 62, fontWeight: '800', lineHeight: 68},
  scores: {flexDirection: 'row', gap: 12},
  scoreBox: {
    backgroundColor: '#1b2233',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minWidth: 110,
    alignItems: 'center',
  },
  scoreLabel: {color: '#8794ad', fontSize: 13, letterSpacing: 2},
  scoreValue: {color: '#f5f7ff', fontSize: 24, fontWeight: '700'},
  board: {
    width: 628,
    height: 628,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    backgroundColor: '#1b2233',
    padding: 12,
    borderRadius: 20,
  },
  tile: {
    width: 140,
    height: 140,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  tileText: {fontSize: valueFontSize(), fontWeight: '800'},
  status: {marginTop: 18, alignItems: 'center'},
  message: {color: '#ffb02e', fontSize: 22, fontWeight: '700'},
  hint: {color: '#8794ad', fontSize: 16, marginTop: 6},
});

function valueFontSize(): number {
  // Kept as a function so the style stays a plain object on old JS engines.
  return 46;
}
