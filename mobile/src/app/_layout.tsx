import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StyleSheet, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    // For the camera's pinch to zoom.
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        {/* The phone rides on the rover, so the app opens straight to the camera. */}
        <Stack>
          <Stack.Screen name="index" options={{ title: 'Camera', headerShown: false }} />
          {/* Every capture as a grid, from the camera screen's gallery, which its back button returns to. */}
          <Stack.Screen
            name="all-captures"
            options={{ title: 'All Captures', headerLargeTitle: true, headerBackTitle: 'Gallery' }}
          />
          <Stack.Screen
            name="capture-info"
            options={{
              title: 'Info',
              headerShown: false,
              presentation: 'formSheet',
              sheetAllowedDetents: [0.5, 1],
              sheetGrabberVisible: true,
            }}
          />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
