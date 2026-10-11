/**
 * The launch intro.
 *
 * Plays once when the hub starts: "FYAISA" sits as one tight wordmark, then the
 * letters spread apart and each one's word slides into the gap beside it — F to
 * "F**k", Y to "You", A to "Amazon,", and so on — so the name spells itself out
 * into what it stands for. Every word's first letter wears the theme's accent
 * colour, which is why the six of them still read as F Y A I S A.
 *
 * It is also the launch cover, not an extra wait in front of one: the first
 * frame dismisses Amazon's splash screen, so the catalog keeps loading behind
 * this and a slow or offline start still lands on the hub when it ends. Any
 * remote press skips straight there.
 *
 * Every size here is a fraction of the window, and the whole line is measured
 * first and scaled down to fit, so it reads the same way on any panel.
 */
import * as React from 'react';
import {useCallback, useEffect, useMemo, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, useWindowDimensions} from 'react-native';
import {Pressable} from '@amazon-devices/react-native-kepler';
import {useAppTheme} from './theme';

/**
 * What each letter of the wordmark stands for. Order matters: F, Y, A, I, S, A
 * spelled down the first letters is the name.
 */
const MEANING = ['F**k', 'You', 'Amazon,', "I'm", 'Sideloading', 'Anyways'];

/** Timeline, in ms: hold on the wordmark, then spread, then read, then leave. */
const ENTER_MS = 450;
const HOLD_MS = 2100;
const SPREAD_MS = 1250;
const READ_MS = 1400;
const LEAVE_MS = 550;

export const Intro = ({
  onDone,
  onFirstFrame,
}: {
  onDone: () => void;
  /** Called once the overlay is on screen, so the caller can drop the splash. */
  onFirstFrame?: () => void;
}) => {
  const {resolved} = useAppTheme();
  const {width} = useWindowDimensions();

  const enter = useRef(new Animated.Value(0)).current;
  const spread = useRef(new Animated.Value(0)).current;
  const leave = useRef(new Animated.Value(0)).current;
  const done = useRef(false);
  // The parent hands down a fresh callback every render; hold it in a ref so
  // `finish` stays stable and the timeline effect below runs exactly once.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const finish = useCallback(() => {
    if (done.current) {
      return;
    }
    done.current = true;
    onDoneRef.current();
  }, []);

  /**
   * Where every letter and word sits while the wordmark is tight, and how far
   * it travels to its resting place once the letters spread. Character widths
   * are estimated — that only loosens or tightens the gaps — and the whole line
   * is scaled to fit the window first, so it can't run off the edge.
   */
  const layout = useMemo(() => {
    const maxWidth = width * 0.94;
    const chars = MEANING.map(w => w.length);
    const CHAR = 0.6; // rough width of a character, as a share of font size

    let letterF = width * 0.12;
    let wordF = width * 0.03;
    let box = letterF * 0.66;
    let pad = letterF * 0.08;
    const wordW = chars.map(c => wordF * CHAR * c);
    const total = MEANING.length * (box + 2 * pad) + wordW.reduce((a, b) => a + b, 0);
    const fit = total > maxWidth ? maxWidth / total : 1;
    letterF *= fit;
    wordF *= fit;
    box *= fit;
    pad *= fit;
    const word = wordW.map(w => w * fit);

    const letters = [];
    const words = [];
    let x = 0;
    for (let i = 0; i < MEANING.length; i++) {
      // Tight: the letters sit flush, i * box apart.
      const tight = i * box;
      letters.push({left: tight, delta: x - tight, box});
      x += box + pad;
      // Each word tucks in after its letter, in the gap it opens up.
      const tightWord = (i + 1) * box;
      words.push({left: tightWord, delta: x - tightWord});
      x += word[i] + pad;
    }
    const fullTotal = x - pad;
    const tightTotal = MEANING.length * box;
    return {
      letterF,
      wordF,
      letters,
      words,
      rowHeight: letterF * 1.3,
      // The words sit down at the letters' foot, not on their baseline and not
      // dropped all the way below them — low enough to read as one line.
      wordTop: Math.round(letterF * 0.8),
      fullTotal,
      // At rest the row is full width; while tight it has to slide over to stay
      // centred, since the words already claim their space.
      rowShift: (fullTotal - tightTotal) / 2,
      rule: Math.round(width * 0.42),
      ruleGap: Math.round(letterF * 0.36),
    };
  }, [width]);

  useEffect(() => {
    const run = Animated.sequence([
      Animated.timing(enter, {
        toValue: 1,
        duration: ENTER_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.delay(HOLD_MS),
      Animated.timing(spread, {
        toValue: 1,
        duration: SPREAD_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.delay(READ_MS),
      Animated.timing(leave, {
        toValue: 1,
        duration: LEAVE_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    run.start(({finished}) => finished && finish());
    return () => run.stop();
  }, [enter, spread, leave, finish]);

  const {letters, words, letterF, wordF, rowHeight, wordTop, fullTotal, rowShift} = layout;

  return (
    <Pressable
      focusable
      hasTVPreferredFocus
      onPress={finish}
      onLayout={onFirstFrame}
      style={[styles.fill, {backgroundColor: resolved.bg}]}>
      <Animated.View
        style={
          {
            alignItems: 'center',
            opacity: leave.interpolate({inputRange: [0, 1], outputRange: [1, 0]}),
            transform: [{scale: leave.interpolate({inputRange: [0, 1], outputRange: [1, 1.04]})}],
          } as any
        }>
        <Animated.View
          style={
            {
              alignItems: 'center',
              opacity: enter,
              transform: [
                {scale: enter.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})},
              ],
            } as any
          }>
          <Animated.View
            style={
              {
                width: fullTotal,
                height: rowHeight,
                overflow: 'visible',
                transform: [
                  {
                    translateX: spread.interpolate({
                      inputRange: [0, 1],
                      outputRange: [rowShift, 0],
                    }),
                  },
                ],
              } as any
            }>
            {letters.map((l, i) => (
              <Animated.View
                key={`letter-${i}`}
                style={
                  {
                    position: 'absolute',
                    left: l.left,
                    top: 0,
                    height: rowHeight,
                    justifyContent: 'center',
                    transform: [
                      {
                        translateX: spread.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, l.delta],
                        }),
                      },
                    ],
                  } as any
                }>
                <Text
                  style={{
                    width: l.box,
                    textAlign: 'center',
                    color: resolved.text,
                    fontSize: letterF,
                    fontWeight: '700',
                  }}>
                  {MEANING[i][0]}
                </Text>
              </Animated.View>
            ))}
            {words.map((w, i) => {
              const start = 0.12 + i * 0.08;
              const span: [number, number] = [start, start + 0.4];
              return (
                <Animated.View
                  key={`word-${i}`}
                  style={
                    {
                      position: 'absolute',
                      left: w.left,
                      top: wordTop,
                      opacity: spread.interpolate({inputRange: span, outputRange: [0, 1]}),
                      transform: [
                        {
                          translateX: spread.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, w.delta],
                          }),
                        },
                        {
                          translateY: spread.interpolate({
                            inputRange: span,
                            outputRange: [Math.round(wordF * 0.8), 0],
                          }),
                        },
                      ],
                    } as any
                  }>
                  <Text style={{color: resolved.textDim, fontSize: wordF}}>
                    <Text style={{color: resolved.accent}}>{MEANING[i][0]}</Text>
                    {MEANING[i].slice(1)}
                  </Text>
                </Animated.View>
              );
            })}
          </Animated.View>

          {/* A short rule sweeps out underneath once the words have landed. */}
          <Animated.View
            style={
              {
                width: layout.rule,
                height: 3,
                borderRadius: 2,
                marginTop: layout.ruleGap,
                backgroundColor: resolved.accent,
                opacity: spread.interpolate({inputRange: [0.4, 0.9], outputRange: [0, 0.9]}),
                transform: [
                  {scaleX: spread.interpolate({inputRange: [0.35, 0.95], outputRange: [0, 1]})},
                ],
              } as any
            }
          />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  fill: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});
