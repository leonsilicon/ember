import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {/* The phone rides on the rover, so the app opens straight to the camera. */}
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Camera', headerShown: false }} />
        <Stack.Screen name="captures" options={{ title: 'Gallery', headerLargeTitle: true }} />
      </Stack>
    </ThemeProvider>
  );
}
