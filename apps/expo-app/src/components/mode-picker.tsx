import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import Animated, { Easing, LinearTransition } from 'react-native-reanimated';

import { Glass } from './glass';

import { Spacing } from '@/constants/theme';

export type ModeOption<T extends string> = {
  value: T;
  label: string;
  /** Draws a green dot after the label, e.g. while the rover is connected. */
  badge?: boolean;
};

/**
 * The Camera app's mode switcher: the modes in a glass capsule, the current one in yellow on a
 * bubble that slides over to whichever one is picked.
 */
export function ModePicker<T extends string>({
  modes,
  value,
  onChange,
}: {
  modes: ModeOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const [layouts, setLayouts] = useState<Partial<Record<T, LayoutRectangle>>>({});
  const selected = layouts[value];

  return (
    <View accessibilityRole="tablist" style={styles.capsule}>
      <Glass style={[StyleSheet.absoluteFill, styles.round]} />
      {selected && (
        <Animated.View layout={SLIDE} style={[styles.bubble, { left: selected.x, width: selected.width }]}>
          <Glass style={[StyleSheet.absoluteFill, styles.round]} />
        </Animated.View>
      )}
      {modes.map((mode) => {
        const active = mode.value === value;
        return (
          <Pressable
            key={mode.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={mode.label}
            onLayout={(event) => {
              const layout = event.nativeEvent.layout;
              setLayouts((current) => ({ ...current, [mode.value]: layout }));
            }}
            onPress={() => onChange(mode.value)}
            style={styles.mode}>
            <Text style={[styles.label, active && styles.labelActive]}>{mode.label.toUpperCase()}</Text>
            {mode.badge && <View style={styles.badge} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const HEIGHT = 48;
const INSET = 4;
// Eases into place rather than springing: a spring's overshoot carries the bubble past the capsule's ends.
const SLIDE = LinearTransition.duration(260).easing(Easing.out(Easing.cubic));

const styles = StyleSheet.create({
  capsule: {
    flexDirection: 'row',
    height: HEIGHT,
    padding: INSET,
  },
  round: {
    borderRadius: HEIGHT / 2,
  },
  bubble: {
    position: 'absolute',
    top: INSET,
    bottom: INSET,
  },
  mode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
    paddingHorizontal: Spacing.three,
  },
  label: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: 0.8,
  },
  labelActive: {
    color: '#FFD60A',
  },
  badge: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#30D158',
  },
});
