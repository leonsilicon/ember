import { StyleSheet } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';

export function LiveDetector() {
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="subtitle">Live detection</ThemedText>
      <ThemedText style={styles.centerText} themeColor="textSecondary">
        YOLO object detection runs on-device with the camera,{'\n'}so it is only available in the
        iOS and Android apps.
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  centerText: {
    textAlign: 'center',
  },
});
