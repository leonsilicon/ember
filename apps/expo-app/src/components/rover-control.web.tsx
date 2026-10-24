import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { ThemedText } from './themed-text';

export function RoverRemote(_props: { left?: ReactNode; right?: ReactNode }) {
  return (
    <ThemedText style={styles.centerText} themeColor="textSecondary">
      The rover is driven over Bluetooth LE,{'\n'}so it is only available in the iOS and Android
      apps.
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  centerText: {
    textAlign: 'center',
  },
});
