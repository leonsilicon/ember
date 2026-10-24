import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { SplatPreview } from '@/components/splat-preview';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { updateDebugSettings, useDebugSettings } from '@/hooks/use-debug-settings';
import { useTheme } from '@/hooks/use-theme';
import { describeCapture, shareCapture } from '@/lib/captures';
import { checkServer, liveViewerUrl } from '@/lib/splat-preview';

export default function CapturesScreen() {
  const debug = useDebugSettings();
  const [captures, setCaptures] = useState<SavedCapture[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCaptures(await SplatCapture.listCaptures());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Re-read the folder whenever the screen is shown (a capture may have just been saved).
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  function confirmDelete(capture: SavedCapture) {
    Alert.alert('Delete capture?', 'The zip is removed from this phone. Copies you already sent are unaffected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await SplatCapture.deleteCapture(capture.captureId);
          refresh();
        },
      },
    ]);
  }

  async function share(capture: SavedCapture) {
    try {
      await shareCapture(capture);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ThemedView style={styles.container}>
      {/* Automatic insets keep content clear of the large-title header and the home indicator. */}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <ThemedText type="small" themeColor="textSecondary">
          Each capture is a zip of camera frames, poses and a seed point cloud, ready to turn into a splat. Share it
          from here, or find it in Files › On My iPhone › soon2026 (and in Finder when the phone is plugged in).
        </ThemedText>

        {error && (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        )}

        {captures?.length === 0 && (
          <ThemedText themeColor="textSecondary">No captures yet. Record one with the camera&apos;s record button.</ThemedText>
        )}

        {captures?.map((capture) => (
          <ThemedView key={capture.captureId} type="backgroundElement" style={styles.card}>
            <View style={styles.cardHeader}>
              <ThemedText type="smallBold">{new Date(capture.savedAt).toLocaleString()}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {capture.mode === 'lidar' ? 'LiDAR' : capture.mode === 'features' ? 'No LiDAR' : ''}
              </ThemedText>
            </View>
            <ThemedText type="small">{describeCapture(capture)}</ThemedText>
            <ThemedText type="code" themeColor="textSecondary">
              {capture.captureId}.zip
            </ThemedText>
            <View style={styles.actions}>
              <Action label="Share…" onPress={() => share(capture)} />
              <Action label="Delete" onPress={() => confirmDelete(capture)} destructive />
            </View>
            {debug.splatPreview && <SplatPreview capture={capture} serverUrl={debug.serverUrl} />}
          </ThemedView>
        ))}

        <DebugCard />
      </ScrollView>
    </ThemedView>
  );
}

/** Debug-only: preview splats trained on a Mac (server/) to compare with the real reconstruction. */
function DebugCard() {
  const theme = useTheme();
  const debug = useDebugSettings();
  // Only set while the field is being edited; otherwise it shows the shared URL.
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [server, setServer] = useState<string>('Checking…');

  useFocusEffect(
    useCallback(() => {
      if (!debug.splatPreview) return;
      let alive = true;
      checkServer(debug.serverUrl)
        .then(
          (h) =>
            alive &&
            setServer(
              !h.agent
                ? 'Connected, but the Mac agent is offline (bun run agent in server/), so nothing trains'
                : [
                    h.brush ? 'Connected · Mac agent ready' : 'Connected, but Brush is not installed on the Mac',
                    h.depthWorker ? null : 'live 3D needs server/scripts/install-depth.sh',
                  ]
                    .filter(Boolean)
                    .join(' · '),
            ),
        )
        .catch((e) => alive && setServer(`Unreachable (${e instanceof Error ? e.message : e})`));
      return () => {
        alive = false;
      };
    }, [debug.splatPreview, debug.serverUrl]),
  );

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.cardHeader}>
        <ThemedText type="smallBold">Debug: splat preview</ThemedText>
        <Switch value={debug.splatPreview} onValueChange={(splatPreview) => updateDebugSettings({ splatPreview })} />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        Sends a capture to the splat server, where a Mac running its agent trains it into a splat (Brush),
        and opens it in the browser, to compare with the real reconstruction. The viewer link works on any
        device.
      </ThemedText>
      {debug.splatPreview && (
        <>
          <TextInput
            value={draftUrl ?? debug.serverUrl}
            onChangeText={setDraftUrl}
            onEndEditing={() => {
              if (draftUrl !== null) updateDebugSettings({ serverUrl: draftUrl.trim() });
              setDraftUrl(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
          />
          <ThemedText type="small" themeColor="textSecondary">
            {server}
          </ThemedText>
          <View style={styles.cardHeader}>
            <ThemedText type="smallBold">Live 3D while recording</ThemedText>
            <Switch value={debug.liveStream} onValueChange={(liveStream) => updateDebugSettings({ liveStream })} />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            Streams each recording to the server, which rebuilds the scene as you move. It floats over the
            camera while you record (tap it to swap the two), and any browser can watch it at{' '}
            <ThemedText type="code">{liveViewerUrl(debug.serverUrl)}</ThemedText>
          </ThemedText>
        </>
      )}
    </ThemedView>
  );
}

function Action({ label, onPress, destructive }: { label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <ThemedText type="smallBold" style={destructive ? styles.error : undefined}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.two,
  },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.four,
    paddingTop: Spacing.one,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  error: {
    color: '#d0402b',
  },
  pressed: {
    opacity: 0.6,
  },
});
