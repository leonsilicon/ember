import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoverControl } from './rover-control';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The rover controls, in a sheet over the bottom of the camera, which stays live above it.
 * It's a plain view rather than a native sheet, whose drag-to-dismiss would compete with the
 * joystick for vertical drags.
 */
export function RoverSheet({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  return (
    <Animated.View entering={SlideInDown.duration(250)} exiting={SlideOutDown.duration(200)} style={styles.sheet}>
      <ThemedView style={[styles.content, { paddingBottom: insets.bottom + Spacing.three }]}>
        <View style={styles.header}>
          <ThemedText type="smallBold">Rover</ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close rover controls"
            hitSlop={Spacing.two}
            onPress={onClose}
            style={({ pressed }) => [
              styles.close,
              { backgroundColor: theme.backgroundElement },
              pressed && styles.pressed,
            ]}>
            <SymbolView name="xmark" size={12} weight="bold" tintColor={theme.textSecondary} />
          </Pressable>
        </View>
        <RoverControl />
      </ThemedView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  content: {
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    borderCurve: 'continuous',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  close: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
