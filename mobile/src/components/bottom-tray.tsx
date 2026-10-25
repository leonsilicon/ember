import { useEffect, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass } from './glass';

import { Spacing } from '@/constants/theme';

/** How far it's pulled down before letting go puts it away. */
const DISMISS_DISTANCE = 80;
/** Flicked down this fast (points per ms), it goes away however far it moved. */
const DISMISS_VELOCITY = 0.6;
/** From the screen's edges, and what sits above the tray (the gallery's card) keeps from it. */
export const TRAY_MARGIN = Spacing.two;
/** Concentric with an iPhone's screen corners (about 44 pt), from TRAY_MARGIN in. */
const RADIUS = 36;

/**
 * Like the Camera app's controls tray (flash, exposure, format): a sheet of tinted glass that rises
 * from the bottom of the screen over the controls there, inset from the screen's edges and rounded
 * to match its corners. Dragging it down, or tapping its grabber, puts it away; render it only
 * while it's open, so it slides out on closing.
 */
export function BottomTray({
  label,
  modal = true,
  onClose,
  onLayout,
  children,
}: {
  label: string;
  /** VoiceOver stays within it, as in a sheet. False where what's above it is part of the same thing, like the gallery's card. */
  modal?: boolean;
  onClose: () => void;
  /** The sheet's layout whenever it changes: its height is what sits above it has to leave. */
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const drag = useSharedValue(0);
  // Let go far enough down; the responder outlives renders, so it can't hold `onClose` itself.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (dismissed) onClose();
  }, [dismissed, onClose]);
  // Drags that start on something that keeps its touches, like a joystick, stay with it.
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) => dy > 8 && dy > Math.abs(dx),
      // Pulled up, it gives a little, then stops.
      onPanResponderMove: (_, { dy }) => drag.set(dy > 0 ? dy : -Math.sqrt(-dy)),
      onPanResponderRelease: (_, { dy, vy }) => {
        if (dy > DISMISS_DISTANCE || vy > DISMISS_VELOCITY) setDismissed(true);
        else drag.set(withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) }));
      },
      onPanResponderTerminate: () => drag.set(withTiming(0, { duration: 200 })),
    }),
  );
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: drag.get() }] }));

  return (
    <Animated.View
      entering={RISE}
      exiting={SINK}
      accessibilityViewIsModal={modal}
      accessibilityLabel={label}
      onAccessibilityEscape={onClose}
      style={styles.anchor}>
      <Animated.View
        {...pan.panHandlers}
        onLayout={onLayout}
        style={[styles.tray, { paddingBottom: Math.max(insets.bottom - TRAY_MARGIN, Spacing.three) }, dragged]}>
        <Glass tintColor="rgba(0,0,0,0.3)" style={[StyleSheet.absoluteFill, styles.shape]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${label.toLowerCase()}`}
          hitSlop={Spacing.three}
          onPress={onClose}
          style={styles.grabberArea}>
          <View style={styles.grabber} />
        </Pressable>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

const RISE = SlideInDown.duration(350).easing(Easing.out(Easing.cubic));
const SINK = SlideOutDown.duration(250).easing(Easing.in(Easing.cubic));

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: TRAY_MARGIN,
    right: TRAY_MARGIN,
    bottom: TRAY_MARGIN,
  },
  tray: {
    paddingHorizontal: Spacing.four,
  },
  shape: {
    borderRadius: RADIUS,
  },
  grabberArea: {
    alignSelf: 'center',
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
});
