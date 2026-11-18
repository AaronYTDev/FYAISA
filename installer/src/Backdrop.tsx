/**
 * Ambient background for the hub.
 *
 * Six effects, all built from plain animated Views (transforms + opacity, so
 * they run on the native driver and cost almost nothing on a Fire TV Stick):
 *
 *   aurora — three big soft blobs drifting and breathing
 *   waves  — wide translucent ribbons sweeping side to side (PS4-store-ish)
 *   sweep  — a single light bar trailing diagonally across the screen
 *   grid   — a subtle glowing grid that breathes with the theme accent
 *   matrix-rain — falling green characters on dark (Matrix preset)
 *
 * It sits behind everything and never takes input. The animation speed is set
 * by the theme's "energy" (calm / normal / party). When the theme's background
 * is "off" nothing renders at all.
 */
import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { Easing, StyleSheet, Animated, View } from 'react-native';
import {useAppTheme} from './theme';

/** Multiplier on the base duration: bigger = slower. */
const ENERGY_SPEED: Record<'calm' | 'normal' | 'party', number> = {
  calm: 1.7,
  normal: 1,
  party: 0.55,
};

/**
 * One shared set of loop drivers. They always run while any effect is active;
 * the individual renderers read from them, so switching effects doesn't change
 * the number of hooks between renders.
 */
const useDrivers = (active: boolean, baseMs: number, speed: number) => {
  const drivers = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (!active) {
      return;
    }
    const loops = drivers.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: baseMs * speed * (1 + i * 0.35),
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: baseMs * speed * (1 + i * 0.35),
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach(loop => loop.start());
    return () => loops.forEach(loop => loop.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, baseMs, speed]);

  return drivers;
};

const Waves = ({
  drivers,
  accent,
  focus,
  link,
}: {
  drivers: Animated.Value[];
  accent: string;
  focus: string;
  link: string;
}) => {
  const bands = [
    {top: '-22%', height: 460, color: accent, opacity: 0.16, dx: 240, dy: 70},
    {top: '2%', height: 560, color: focus, opacity: 0.1, dx: -280, dy: -50},
    {top: '40%', height: 500, color: link, opacity: 0.12, dx: 320, dy: 80},
    {top: '70%', height: 460, color: focus, opacity: 0.08, dx: -220, dy: -60},
  ];
  return (
    <>
      {bands.map((band, i) => {
        const value = drivers[i % drivers.length];
        return (
          <Animated.View
            key={i}
            style={
              {
                position: 'absolute',
                left: '-30%',
                width: '160%',
                top: band.top,
                height: band.height,
                borderRadius: band.height / 2,
                backgroundColor: band.color,
                opacity: band.opacity,
                transform: [
                  {
                    translateX: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-band.dx, band.dx],
                    }),
                  },
                  {
                    translateY: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-band.dy, band.dy],
                    }),
                  },
                ],
              } as any
            }
          />
        );
      })}
    </>
  );
};

const Aurora = ({
  drivers,
  accent,
  focus,
  link,
}: {
  drivers: Animated.Value[];
  accent: string;
  focus: string;
  link: string;
}) => {
  const blobs = [
    {left: '-15%', top: '-12%', size: 640, color: accent, opacity: 0.18, dx: 150, dy: 110},
    {left: '42%', top: '-20%', size: 740, color: focus, opacity: 0.12, dx: -170, dy: 130},
    {left: '18%', top: '42%', size: 580, color: link, opacity: 0.14, dx: 190, dy: -120},
  ];
  return (
    <>
      {blobs.map((blob, i) => {
        const value = drivers[i % drivers.length];
        return (
          <Animated.View
            key={i}
            style={
              {
                position: 'absolute',
                left: blob.left,
                top: blob.top,
                width: blob.size,
                height: blob.size,
                borderRadius: blob.size / 2,
                backgroundColor: blob.color,
                opacity: blob.opacity,
                transform: [
                  {
                    translateX: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-blob.dx, blob.dx],
                    }),
                  },
                  {
                    translateY: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-blob.dy, blob.dy],
                    }),
                  },
                  {
                    scale: value.interpolate({inputRange: [0, 1], outputRange: [1, 1.18]}),
                  },
                ],
              } as any
            }
          />
        );
      })}
    </>
  );
};

const GRID_COLUMNS = 6;
const GRID_ROWS = 5;
const GRID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*';

const Grid = ({
  driver,
  accent,
}: {
  driver: Animated.Value;
  accent: string;
}) => {
  // A grid of cells whose border color pulses between the surface and accent.
  const cells: React.ReactElement[] = [];
  const cellW = 160;
  const cellH = 140;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLUMNS; c++) {
      const pulse = driver.interpolate({
        inputRange: [0, 0.5, 1],
        outputRange: [0, 1, 0],
      });
      cells.push(
        <Animated.View
          key={`grid-${r}-${c}`}
          style={
            {
              position: 'absolute',
              left: c * cellW,
              top: r * cellH,
              width: cellW - 4,
              height: cellH - 4,
              borderWidth: 1,
              borderColor: accent,
              opacity: pulse.interpolate({
                inputRange: [0, 1],
                outputRange: [0.04, 0.18],
              }),
            } as any
          }
        />
      );
    }
  }
  return <>{cells}</>;
};

const MatrixRain = ({
  driver,
  accent,
}: {
  driver: Animated.Value;
  accent: string;
}) => {
  // Falling columns of characters, Matrix style. One loop drives each column;
  // its characters share the value with staggered translateY ranges. Values
  // are created once and all loops are stopped on unmount — no render-time
  // animation starts, and Animated.timing drives a plain Animated.Value
  // instead of an interpolation derived from the shared driver.
  const columns = useMemo(
    () =>
      Array.from({length: 10}, (_, index) => ({
        index,
        left: index * 44,
        duration: 1200 + index * 200,
        chars: Array.from(
          {length: 6},
          () => GRID_CHARS[Math.floor(Math.random() * GRID_CHARS.length)],
        ),
        value: new Animated.Value(0),
      })),
    [],
  );

  useEffect(() => {
    const loops = columns.map(col =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(col.index * 90),
          Animated.timing(col.value, {
            toValue: 1,
            duration: col.duration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(col.value, {
            toValue: 0,
            duration: 0,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach(loop => loop.start());
    return () => loops.forEach(loop => loop.stop());
  }, [columns]);

  const opacity = driver.interpolate({inputRange: [0, 1], outputRange: [0.55, 0.95]});
  const items: React.ReactElement[] = [];
  columns.forEach(col => {
    col.chars.forEach((ch, r) => {
      const fall = col.value.interpolate({
        inputRange: [0, 1],
        outputRange: [-160 - r * 38, 1120 + col.index * 24 + r * 38],
      });
      items.push(
        <Animated.Text
          key={`matrix-${col.index}-${r}`}
          style={
            {
              position: 'absolute',
              left: col.left,
              top: 0,
              color: accent,
              fontSize: 18,
              opacity,
              transform: [{translateY: fall}],
            } as any
          }>
          {ch}
        </Animated.Text>
      );
    });
  });
  return <>{items}</>;
};

const Sweep = ({driver, accent}: {driver: Animated.Value; accent: string}) => (
  <Animated.View
    style={
      {
        position: 'absolute',
        top: '-25%',
        left: 0,
        width: 240,
        height: '150%',
        backgroundColor: accent,
        opacity: 0.12,
        transform: [
          {
            translateX: driver.interpolate({
              inputRange: [0, 1],
              outputRange: [-400, 2200],
            }),
          },
          {rotate: '18deg'},
        ],
      } as any
    }
  />
);

export const Backdrop = () => {
  const {resolved} = useAppTheme();
  const active = resolved.background !== 'none';
  const speed = ENERGY_SPEED[resolved.energy];
  const baseMs = resolved.background === 'sweep' ? 9000 : 15000;
  const drivers = useDrivers(active, baseMs, speed);

  if (!active) {
    return null;
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {resolved.background === 'waves' ? (
        <Waves drivers={drivers} accent={resolved.accent} focus={resolved.focus} link={resolved.link} />
      ) : null}
      {resolved.background === 'aurora' ? (
        <Aurora drivers={drivers} accent={resolved.accent} focus={resolved.focus} link={resolved.link} />
      ) : null}
      {resolved.background === 'sweep' ? <Sweep driver={drivers[0]} accent={resolved.accent} /> : null}
      {resolved.background === 'grid' ? <Grid driver={drivers[0]} accent={resolved.accent} /> : null}
      {resolved.background === 'matrix-rain' ? (
        <MatrixRain driver={drivers[0]} accent={resolved.accent} />
      ) : null}
    </View>
  );
};
