import {
  MaterialDesignIcons,
  type MaterialDesignIconsIconName,
} from '@react-native-vector-icons/material-design-icons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Glass } from './glass';

import { Spacing } from '@/constants/theme';

export type Indicator = {
  key: string;
  /** A Material Design Icons glyph (https://pictogrammers.com/library/mdi/). */
  icon: MaterialDesignIconsIconName;
  /** What it means: shown for a moment when it's tapped, and read by VoiceOver. */
  label: string;
  /** `on`: a setting that's on, in the Camera app's yellow, like its flash. */
  tone?: 'dim' | 'good' | 'warn' | 'on';
  /** A count beside the icon. */
  text?: string;
  /** For a setting, like the Camera app's flash: what a tap does, instead of saying what it means. */
  onPress?: () => void;
};

const TONES = {
  dim: 'rgba(255,255,255,0.5)',
  good: '#30D158',
  warn: '#FFD60A',
  on: '#FFD60A',
};

/**
 * The camera's status: small icons in a glass rail down the right of the viewfinder, each with its
 * count under it. Beside the rail, `caption` says what a tapped icon means for a moment, and `hint`
 * is guidance that stays while it applies.
 */
export function CameraStatus({
  indicators,
  hint,
  caption,
  onPressIndicator,
}: {
  indicators: Indicator[];
  hint?: string;
  caption?: string;
  onPressIndicator: (indicator: Indicator) => void;
}) {
  const message = caption ?? hint;

  return (
    <View style={styles.container}>
      {message && (
        <Animated.View
          key={message}
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          style={styles.message}>
          <Text style={[styles.messageText, caption == null && styles.hintText]}>{message}</Text>
        </Animated.View>
      )}
      <View style={styles.rail}>
        <Glass style={[StyleSheet.absoluteFill, styles.railShape]} />
        {indicators.map((indicator) => {
          const color = indicator.tone ? TONES[indicator.tone] : '#fff';
          return (
            <Pressable
              key={indicator.key}
              accessibilityRole={indicator.onPress ? 'button' : undefined}
              accessibilityLabel={indicator.label}
              hitSlop={Spacing.one}
              onPress={indicator.onPress ?? (() => onPressIndicator(indicator))}
              style={({ pressed }) => [styles.indicator, pressed && styles.pressed]}>
              <MaterialDesignIcons name={indicator.icon} size={22} color={color} />
              {indicator.text && <Text style={[styles.text, { color }]}>{indicator.text}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A caption that clears itself after a moment; showing another restarts the clock. */
export function useCaption(durationMs = 2500) {
  const [caption, setCaption] = useState<{ text: string; shownAt: number }>();

  useEffect(() => {
    if (!caption) return;
    const timeout = setTimeout(() => setCaption(undefined), durationMs);
    return () => clearTimeout(timeout);
  }, [caption, durationMs]);

  return [caption?.text, (text: string) => setCaption({ text, shownAt: Date.now() })] as const;
}

const RAIL_WIDTH = 40;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
    gap: Spacing.two,
    pointerEvents: 'box-none',
  },
  rail: {
    width: RAIL_WIDTH,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    gap: Spacing.two,
  },
  railShape: {
    borderRadius: RAIL_WIDTH / 2,
  },
  indicator: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: RAIL_WIDTH,
    minHeight: 28,
  },
  text: {
    fontSize: 11,
    fontWeight: 600,
    fontVariant: ['tabular-nums'],
  },
  /** Level with the rail's first icon. */
  message: {
    flexShrink: 1,
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  messageText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
  },
  hintText: {
    color: '#FFD60A',
  },
  pressed: {
    opacity: 0.5,
  },
});
