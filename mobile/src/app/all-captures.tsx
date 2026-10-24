import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { updateSplatSettings, useSplatSettings } from '@/hooks/use-splat-settings';
import { useTheme } from '@/hooks/use-theme';
import { describeDay, describeTime, formatDuration } from '@/lib/captures';
import { checkServer, liveViewerUrl } from '@/lib/splat-server';

const COLUMNS = 3;
const GAP = 2;

/** Every capture as a grid, like the Photos library, newest first. Tapping one opens it in the gallery. */
export default function AllCapturesScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [captures, setCaptures] = useState<SavedCapture[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read the folder whenever the screen is shown (the gallery may have deleted one).
  useFocusEffect(
    useCallback(() => {
      SplatCapture.listCaptures()
        .then(setCaptures)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, []),
  );

  const cell = (Math.min(width, MaxContentWidth) - GAP * (COLUMNS - 1)) / COLUMNS;

  return (
    <ThemedView style={styles.container}>
      {/* Automatic insets keep content clear of the large-title header and the home indicator. */}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.grid}>
          {captures?.map((capture) => {
            const date = new Date(capture.savedAt);
            return (
              <Pressable
                key={capture.captureId}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Capture, ${describeDay(date)} ${describeTime(date)}`}
                // Back to the gallery, on this capture.
                onPress={() => router.dismissTo({ pathname: '/captures', params: { id: capture.captureId } })}
                style={({ pressed }) => [
                  styles.cell,
                  { width: cell, height: cell, backgroundColor: theme.backgroundElement },
                  pressed && styles.pressed,
                ]}>
                {capture.thumbnailUri ? (
                  <Image source={capture.thumbnailUri} style={StyleSheet.absoluteFill} contentFit="cover" />
                ) : (
                  <SymbolView name="cube.transparent" size={28} tintColor={theme.textSecondary} />
                )}
                {capture.durationSeconds !== undefined && (
                  <Text style={styles.duration}>{formatDuration(capture.durationSeconds)}</Text>
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.footer}>
          {error && (
            <ThemedText type="small" style={styles.error}>
              {error}
            </ThemedText>
          )}

          {captures?.length === 0 && (
            <ThemedText themeColor="textSecondary">
              No captures yet. Record one with the camera&apos;s record button.
            </ThemedText>
          )}

          {captures && captures.length > 0 && (
            <ThemedText type="smallBold" style={styles.count}>
              {captures.length === 1 ? '1 Capture' : `${captures.length} Captures`}
            </ThemedText>
          )}

          <ThemedText type="small" themeColor="textSecondary">
            Each capture is a zip of camera frames, poses and a seed point cloud, ready to turn into a splat. Share it
            from the gallery, or find it in Files › On My iPhone › soon2026 (and in Finder when the phone is plugged
            in).
          </ThemedText>

          <ServerCard />
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/** The splat server: where captures train and recordings stream live, and whether its Mac is ready. */
function ServerCard() {
  const theme = useTheme();
  const splat = useSplatSettings();
  // Only set while the field is being edited; otherwise it shows the shared URL.
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [server, setServer] = useState<string>('Checking…');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      checkServer(splat.serverUrl)
        .then(
          (h) =>
            alive &&
            setServer(
              !h.agent
                ? 'Connected, but the Mac agent is offline (bun run agent in frontend), so nothing trains'
                : [
                    h.brush ? 'Connected · Mac agent ready' : 'Connected, but Brush is not installed on the Mac',
                    h.depthWorker ? null : 'live 3D needs frontend/scripts/install-depth.sh',
                  ]
                    .filter(Boolean)
                    .join(' · '),
            ),
        )
        .catch((e) => alive && setServer(`Unreachable (${e instanceof Error ? e.message : e})`));
      return () => {
        alive = false;
      };
    }, [splat.serverUrl]),
  );

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedText type="smallBold">Splat server</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        A capture is turned into a splat the first time it&apos;s opened in the gallery: it goes to the server, where a
        Mac running its agent trains it (Brush), and the gallery shows how it&apos;s going, with pause and cancel.
        While Live 3D (in the camera options) is on, each recording streams there as well, and any browser can watch
        it at <ThemedText type="code">{liveViewerUrl(splat.serverUrl)}</ThemedText>
      </ThemedText>
      <TextInput
        value={draftUrl ?? splat.serverUrl}
        onChangeText={setDraftUrl}
        onEndEditing={() => {
          if (draftUrl !== null) updateSplatSettings({ serverUrl: draftUrl.trim() });
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
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: Spacing.four,
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  /** Edge to edge, like the Photos library. */
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  /** Bottom right, like a video's length in Photos. */
  duration: {
    position: 'absolute',
    right: Spacing.one + Spacing.half,
    bottom: Spacing.half,
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
  footer: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  count: {
    textAlign: 'center',
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
  error: {
    color: '#d0402b',
  },
  pressed: {
    opacity: 0.6,
  },
});
