/**
 * Snake — the classic game for a TV remote.
 *
 * Steering goes through useTVEventHandler (Amazon's raw D-pad hook): the
 * Pressable-focus pattern the hub apps use doesn't fit a game whose state
 * moves on a timer. Walls kill, each snack grows the snake and speeds it up.
 * OK starts / pauses / restarts, Back quits.
 */
import * as React from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
  useTVEventHandler,
  type HWEvent,
} from '@amazon-devices/react-native-kepler';

/** Board size in cells. The on-screen cell size adapts to the screen. */
const COLS = 15;
const ROWS = 9;
/** Cells never grow past this, so the board leaves room for the HUD. */
const MAX_CELL = 72;

type Pt = {x: number; y: number};
type Dir = 'up' | 'down' | 'left' | 'right';
type Status = 'ready' | 'playing' | 'paused' | 'over';

type GameState = {
  snake: Pt[]; // head first
  dir: Dir;
  food: Pt | null; // null means the board is full — game over
  score: number;
  status: Status;
};

const DELTA: Record<Dir, Pt> = {
  up: {x: 0, y: -1},
  down: {x: 0, y: 1},
  left: {x: -1, y: 0},
  right: {x: 1, y: 0},
};
const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

/** Drop a snack on a random cell the snake isn't occupying. */
const randomFood = (snake: Pt[]): Pt | null => {
  const free: Pt[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!snake.some(s => s.x === x && s.y === y)) {
        free.push({x, y});
      }
    }
  }
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
};

const newGame = (status: Status): GameState => {
  const snake = [
    {x: 7, y: 4},
    {x: 6, y: 4},
    {x: 5, y: 4},
  ];
  return {snake, dir: 'right', food: randomFood(snake), score: 0, status};
};

/**
 * One move. Consumes the next queued turn, advances the head, and checks
 * walls (death) and self-collision (death) before eating (grow + new food).
 */
const stepOnce = (g: GameState, turns: Dir[]): GameState => {
  if (g.status !== 'playing') {
    return g;
  }
  const dir = turns.shift() ?? g.dir;
  const head = g.snake[0];
  const nh = {x: head.x + DELTA[dir].x, y: head.y + DELTA[dir].y};
  if (nh.x < 0 || nh.y < 0 || nh.x >= COLS || nh.y >= ROWS) {
    return {...g, dir, status: 'over'};
  }
  const eats = !!g.food && nh.x === g.food.x && nh.y === g.food.y;
  const body = eats ? g.snake : g.snake.slice(0, g.snake.length - 1);
  if (body.some(s => s.x === nh.x && s.y === nh.y)) {
    return {...g, dir, status: 'over'};
  }
  const snake = [nh, ...body];
  if (!eats) {
    return {...g, dir, snake};
  }
  const score = g.score + 1;
  const food = randomFood(snake);
  return {...g, dir, snake, score, food, status: food ? 'playing' : 'over'};
};

/** A bit faster every snack, with a floor so it stays playable. */
const msPerStep = (score: number) => Math.max(85, 210 - score * 7);

export const App = () => {
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const [game, setGame] = useState<GameState>(() => newGame('ready'));
  // Mirror of `game` for the remote handler, which gets registered once and
  // must not re-register on every move.
  const gameRef = useRef(game);
  gameRef.current = game;
  // Turns pressed since the last move: a queue so two quick presses between
  // ticks both count. Same-direction and reverse presses are dropped when
  // queued, which also makes remote keydown/keyup double-fire harmless.
  const turnsRef = useRef<Dir[]>([]);
  // Some remotes fire select twice (keydown + keyup); debounce it so a single
  // press doesn't pause and immediately resume.
  const lastSelectRef = useRef(0);

  const {width, height} = useWindowDimensions();
  const cell = Math.min(
    MAX_CELL,
    Math.floor(Math.min((width * 0.92) / COLS, (height - 190) / ROWS)),
  );

  // Nothing to load here; the splash just waits for the first frame.
  useEffect(() => {
    hideSplashScreenCallback();
  }, [hideSplashScreenCallback]);

  useEffect(() => {
    if (game.status !== 'playing') {
      return;
    }
    const iv = setInterval(
      () => setGame(g => stepOnce(g, turnsRef.current)),
      msPerStep(game.score),
    );
    return () => clearInterval(iv);
  }, [game.status, game.score]);

  useEffect(() => {
    // Returning false lets the OS close the app, same as the hub menus.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => false);
    return () => sub.remove();
  }, []);

  const onRemote = useCallback((e: HWEvent) => {
    const key = e.eventType;
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      const g = gameRef.current;
      if (g.status === 'paused') {
        return; // paused stays paused until OK
      }
      if (g.status === 'ready' || g.status === 'over') {
        // Any arrow starts a fresh game moving in that direction. Pressing
        // the one direction the snake can't go just starts it straight ahead.
        const fresh = newGame('playing');
        turnsRef.current = key === OPPOSITE[fresh.dir] ? [] : [key];
        setGame(fresh);
        return;
      }
      const last = turnsRef.current.length
        ? turnsRef.current[turnsRef.current.length - 1]
        : g.dir;
      if (
        turnsRef.current.length < 2 &&
        key !== last &&
        key !== OPPOSITE[last]
      ) {
        turnsRef.current.push(key);
      }
      return;
    }
    if (key === 'select' || key === 'enter') {
      const now = Date.now();
      if (now - lastSelectRef.current < 300) {
        return;
      }
      lastSelectRef.current = now;
      turnsRef.current = [];
      setGame(g => {
        if (g.status === 'ready') {
          return {...g, status: 'playing'};
        }
        if (g.status === 'playing') {
          return {...g, status: 'paused'};
        }
        if (g.status === 'paused') {
          return {...g, status: 'playing'};
        }
        return newGame('playing'); // game over → play again
      });
    }
  }, []);
  useTVEventHandler(onRemote);

  const hint =
    game.status === 'ready'
      ? 'Press OK to start — an arrow starts you moving that way'
      : game.status === 'playing'
      ? 'OK pauses · Back quits'
      : game.status === 'paused'
      ? 'Paused — OK resumes'
      : `Game over — score ${game.score}. OK plays again`;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>SNAKE</Text>
      <Text style={styles.score}>Score {game.score}</Text>
      <View style={[styles.board, {width: COLS * cell, height: ROWS * cell}]}>
        {game.food ? (
          <View
            style={[
              styles.food,
              {
                left: game.food.x * cell + 4,
                top: game.food.y * cell + 4,
                width: cell - 8,
                height: cell - 8,
              },
            ]}
          />
        ) : null}
        {game.snake.map((s, i) => (
          <View
            key={i}
            style={[
              i === 0 ? styles.head : styles.seg,
              {
                left: s.x * cell + 2,
                top: s.y * cell + 2,
                width: cell - 4,
                height: cell - 4,
              },
            ]}
          />
        ))}
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {color: '#4caf50', fontSize: 34, fontWeight: '700', letterSpacing: 6},
  score: {color: '#8b8b99', fontSize: 18, marginTop: 6, marginBottom: 16},
  board: {
    backgroundColor: '#101018',
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#23232d',
  },
  seg: {position: 'absolute', backgroundColor: '#3fae4f', borderRadius: 4},
  head: {position: 'absolute', backgroundColor: '#7ee787', borderRadius: 4},
  food: {position: 'absolute', backgroundColor: '#e50914', borderRadius: 999},
  hint: {color: '#8b8b99', fontSize: 17, marginTop: 20, paddingHorizontal: 40, textAlign: 'center'},
});
