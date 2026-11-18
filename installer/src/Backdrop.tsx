/**
 * Ambient background for the hub.
 *
 * Fire TV Safe Build:
 * - one native loop for the whole backdrop, never one per effect
 * - only transform and opacity are animated
 * - no Animated.Text, no color/shadow interpolation, no layout animation
 * - starts only after the intro has released its own native nodes
 *
 * The static layers still read as a deep, glowing gradient, so the screen gets
 * motion without turning launches into a memory pressure event.
 */
import * as React from 'react';
import {useEffect, useMemo, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useAppTheme} from './theme';

/** Multiplier on the base duration: bigger = slower. */
const ENERGY_SPEED: Record<'calm' | 'normal' | 'party', number> = {
  calm: 1.7,
  normal: 1,
  party: 0.55,
};

const GRID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*';

/** One shared loop. Every effect below reads from this value. */
const useDriver = (active: boolean, baseMs: number, speed: number) => {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: baseMs * speed,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: baseMs * speed,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, baseMs, speed, value]);

  return value;
};

/** Static depth stack. Large translucent ellipses fake a soft gradient. */
const Depth = ({accent, focus, link}: {accent: string; focus: string; link: string}) => (
  <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <View
      style={{
        position: 'absolute',
        left: '-18%',
        top: '-16%',
        width: 760,
        height: 760,
        borderRadius: 380,
        backgroundColor: accent,
        opacity: 0.055,
      }}
    />
    <View
      style={{
        position: 'absolute',
        right: '-14%',
        top: '18%',
        width: 660,
        height: 660,
        borderRadius: 330,
        backgroundColor: focus,
        opacity: 0.045,
      }}
    />
    <View
      style={{
        position: 'absolute',
        left: '22%',
        bottom: '-30%',
        width: 720,
        height: 720,
        borderRadius: 360,
        backgroundColor: link,
        opacity: 0.05,
      }}
    />
  </View>
);

const Aurora = ({
  driver,
  accent,
  focus,
  link,
}: {
  driver: Animated.Value;
  accent: string;
  focus: string;
  link: string;
}) => {
  const blobs = [
    {left: '-12%', top: '-10%', size: 640, color: accent, dx: 140, dy: 100, scale: 1.14},
    {left: '44%', top: '-18%', size: 700, color: focus, dx: -160, dy: 120, scale: 1.1},
    {left: '16%', top: '44%', size: 580, color: link, dx: 170, dy: -110, scale: 1.16},
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {blobs.map((blob, i) => (
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
              opacity: 0.12,
              transform: [
                {
                  translateX: driver.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-blob.dx, blob.dx],
                  }),
                },
                {
                  translateY: driver.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-blob.dy, blob.dy],
                  }),
                },
                {
                  scale: driver.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, blob.scale],
                  }),
                },
              ],
            } as any
          }
        />
      ))}
    </View>
  );
};

const Waves = ({
  driver,
  accent,
  focus,
  link,
}: {
  driver: Animated.Value;
  accent: string;
  focus: string;
  link: string;
}) => {
  const bands = [
    {top: '-18%', height: 440, color: accent, opacity: 0.14, dx: 220, dy: 60},
    {top: '12%', height: 520, color: focus, opacity: 0.09, dx: -250, dy: -50},
    {top: '56%', height: 480, color: link, opacity: 0.11, dx: 280, dy: 70},
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {bands.map((band, i) => (
        <Animated.View
          key={i}
          style={
            {
              position: 'absolute',
              left: '-28%',
              width: '156%',
              top: band.top,
              height: band.height,
              borderRadius: band.height / 2,
              backgroundColor: band.color,
              opacity: band.opacity,
              transform: [
                {
                  translateX: driver.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-band.dx, band.dx],
                  }),
                },
                {
                  translateY: driver.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-band.dy, band.dy],
                  }),
                },
              ],
            } as any
          }
        />
      ))}
    </View>
  );
};

const Sweep = ({driver, accent}: {driver: Animated.Value; accent: string}) => (
  <Animated.View
    pointerEvents="none"
    style={
      {
        position: 'absolute',
        top: '-25%',
        left: 0,
        width: 260,
        height: '150%',
        backgroundColor: accent,
        opacity: 0.11,
        transform: [
          {
            translateX: driver.interpolate({
              inputRange: [0, 1],
              outputRange: [-450, 2300],
            }),
          },
          {rotate: '18deg'},
        ],
      } as any
    }
  />
);

const Grid = ({driver, accent}: {driver: Animated.Value; accent: string}) => {
  const {width, height} = useWindowDimensions();
  const cellW = Math.max(120, width / 7);
  const cellH = Math.max(110, height / 5);
  const cols = Math.max(5, Math.ceil(width / cellW));
  const rows = Math.max(4, Math.ceil(height / cellH));
  const cells: React.ReactElement[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(
        <View
          key={`grid-${r}-${c}`}
          style={{
            position: 'absolute',
            left: c * cellW,
            top: r * cellH,
            width: cellW - 4,
            height: cellH - 4,
            borderWidth: 1,
            borderColor: accent,
            opacity: 0.06,
          }}
        />,
      );
    }
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {cells}
      <Animated.View
        style={
          {
            position: 'absolute',
            left: 0,
            top: 0,
            width: cellW * 1.2,
            height: '100%',
            backgroundColor: accent,
            opacity: driver.interpolate({inputRange: [0, 1], outputRange: [0.015, 0.09]}),
            transform: [
              {
                translateX: driver.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-cellW * 1.3, width + cellW],
                }),
              },
            ],
          } as any
        }
      />
    </View>
  );
};

/**
 * Full-screen, continuously falling glyph columns. Two identical stacked copies
 * per column scroll by one copy-height on a linear native loop, so the sawtooth
 * reset is invisible. Only transform/opacity are native-animated; no layout,
 * no color interpolation, one loop for the whole effect.
 */
const MatrixRain = ({
  driver,
  accent,
  speed,
}: {
  driver: Animated.Value;
  accent: string;
  speed: number;
}) => {
  const {width, height} = useWindowDimensions();
  const fall = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(fall, {
        toValue: 1,
        duration: 2600 * speed,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [fall, speed]);

  const glyphH = 28;
  const rows = Math.max(6, Math.ceil(height / glyphH) + 1);
  const copyH = rows * glyphH;
  const columns = useMemo(() => {
    const count = Math.max(8, Math.ceil(width / 64));
    return Array.from({length: count}, (_, c) => ({
      left: Math.round((c * width) / count),
      chars: Array.from(
        {length: rows},
        (_, r) => GRID_CHARS[(c * 11 + r * 7 + r * c) % GRID_CHARS.length],
      ).join('\n'),
    }));
  }, [width, rows]);

  const translateY = fall.interpolate({inputRange: [0, 1], outputRange: [-copyH, 0]});

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {opacity: driver.interpolate({inputRange: [0, 1], outputRange: [0.55, 0.95]})},
      ]}>
      {columns.map(col => (
        <Animated.View
          key={col.left}
          style={{
            position: 'absolute',
            left: col.left,
            top: 0,
            transform: [{translateY}],
          }}>
          {[0, 1].map(copy => (
            <Text
              key={copy}
              style={{
                color: accent,
                fontSize: 18,
                lineHeight: glyphH,
                width: 26,
                textAlign: 'center',
                opacity: copy === 0 ? 0.58 : 0.42,
              }}>
              {col.chars}
            </Text>
          ))}
        </Animated.View>
      ))}
    </Animated.View>
  );
};

export const Backdrop = () => {
  const {resolved} = useAppTheme();
  const active = resolved.background !== 'none';
  const speed = ENERGY_SPEED[resolved.energy];
  const baseMs = resolved.background === 'sweep' ? 9000 : 14000;
  const driver = useDriver(active, baseMs, speed);

  if (!active) {
    return null;
  }

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root]}>
      <Depth accent={resolved.accent} focus={resolved.focus} link={resolved.link} />
      {resolved.background === 'aurora' ? (
        <Aurora driver={driver} accent={resolved.accent} focus={resolved.focus} link={resolved.link} />
      ) : null}
      {resolved.background === 'waves' ? (
        <Waves driver={driver} accent={resolved.accent} focus={resolved.focus} link={resolved.link} />
      ) : null}
      {resolved.background === 'sweep' ? <Sweep driver={driver} accent={resolved.accent} /> : null}
      {resolved.background === 'grid' ? <Grid driver={driver} accent={resolved.accent} /> : null}
      {resolved.background === 'matrix-rain' ? (
        <MatrixRain driver={driver} accent={resolved.accent} speed={speed} />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {overflow: 'hidden'},
});
