import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

/**
 * A recording's live 3D reconstruction, as the splat server's `/live` page draws it: the point
 * cloud growing as the phone streams keyframes, followed by a chase camera. Fills its parent.
 * `interactive` lets drags orbit it (it goes back to following a few seconds later).
 */
export function LiveSplatView({ url, interactive }: { url: string; interactive: boolean }) {
  // The package's typings default WebView's extra props to `undefined`, which leaves it no props.
  const webView = useRef<WebView<object>>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <View style={[styles.container, !interactive && styles.passThrough]}>
      <WebView<object>
        ref={webView}
        source={{ uri: url }}
        // Transparent until the page paints, so it doesn't flash white.
        style={styles.web}
        scrollEnabled={false}
        bounces={false}
        onLoadStart={() => setError(null)}
        onError={({ nativeEvent }) => setError(nativeEvent.description)}
        onHttpError={({ nativeEvent }) => setError(`Server replied ${nativeEvent.statusCode}`)}
        // iOS kills the page's process under memory pressure, which leaves a blank view.
        onContentProcessDidTerminate={() => webView.current?.reload()}
      />
      {error && (
        <View style={styles.error}>
          <ThemedText type="code" style={styles.errorText}>
            Live 3D: {error}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // The page's own background.
    backgroundColor: '#0b0c0e',
  },
  passThrough: {
    pointerEvents: 'none',
  },
  web: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  error: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    padding: Spacing.two,
    backgroundColor: '#0b0c0e',
  },
  errorText: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
  },
});
