import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

/**
 * A recording's live 3D reconstruction, as the splat server's `/live` page draws it: the point
 * cloud growing as the phone streams keyframes, followed by a chase camera. Fills its parent.
 * `interactive` lets touches move the view: one finger orbits, two pan,
 * pinch and twist. That stops the camera following the phone until `ref`'s `follow()`, or until
 * it's no longer interactive; `onFollowingChange` says when it stops and starts.
 * `lockSession` keeps the page on one recording (its capture id) rather than the newest one: the
 * page is loaded ahead of recording, following, and locked once the recording exists.
 */
export function LiveSplatView({
  url,
  interactive,
  lockSession = null,
  onFollowingChange,
  ref,
}: {
  url: string;
  interactive: boolean;
  lockSession?: string | null;
  onFollowingChange?: (following: boolean) => void;
  ref?: Ref<{ follow(): void }>;
}) {
  // The package's typings default WebView's extra props to `undefined`, which leaves it no props.
  const webView = useRef<WebView<object>>(null);
  const [error, setError] = useState<string | null>(null);

  // Told again after every load, since a reloaded page starts out following.
  const lock = useCallback(() => {
    webView.current?.injectJavaScript(`window.__liveLock && window.__liveLock(${JSON.stringify(lockSession)}); true;`);
  }, [lockSession]);
  useEffect(lock, [lock]);

  // The page ignores touches until told it's fullscreen; this too is told again after every load.
  const tellInteractive = useCallback(() => {
    webView.current?.injectJavaScript(
      `window.liveInteractive = ${interactive}; window.dispatchEvent(new Event('liveinteractive')); true;`,
    );
  }, [interactive]);
  useEffect(tellInteractive, [tellInteractive]);

  useImperativeHandle(ref, () => ({
    follow: () => webView.current?.injectJavaScript(`window.dispatchEvent(new Event('livefollow')); true;`),
  }));

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
        onLoadEnd={() => {
          lock();
          tellInteractive();
        }}
        onMessage={({ nativeEvent }) => {
          const message = JSON.parse(nativeEvent.data);
          if (message.type === 'following') onFollowingChange?.(message.following);
        }}
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
