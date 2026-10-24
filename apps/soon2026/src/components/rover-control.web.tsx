import { StyleSheet } from 'react-native';

import { ThemedText } from './themed-text';

export function RoverControl() {
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
