import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { SplatPreview } from '@/components/splat-preview';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useDebugSettings } from '@/hooks/use-debug-settings';
import { compact, describeTime, formatBytes, formatDuration } from '@/lib/captures';

/** A capture's details, in a sheet over the gallery like the Photos app's Info, with its debug splat preview. */
export default function CaptureInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const debug = useDebugSettings();
  /** Undefined while loading; null if it's gone. */
  const [capture, setCapture] = useState<SavedCapture | null>();

  useEffect(() => {
    let alive = true;
    SplatCapture.listCaptures()
      .then((captures) => alive && setCapture(captures.find((c) => c.captureId === id) ?? null))
      .catch(() => alive && setCapture(null));
    return () => {
      alive = false;
    };
  }, [id]);

  if (!capture) {
    return (
      <ThemedView style={[styles.container, styles.content]}>
        {capture === null && <ThemedText themeColor="textSecondary">This capture was deleted.</ThemedText>}
      </ThemedView>
    );
  }

  const date = new Date(capture.savedAt);
  const seed = capture.mode === 'lidar' ? 'LiDAR points' : 'Feature points';
  const rows: [string, string][] = [];
  if (capture.mode) rows.push(['Depth', capture.mode === 'lidar' ? 'LiDAR' : 'No LiDAR']);
  if (capture.durationSeconds !== undefined) rows.push(['Length', formatDuration(capture.durationSeconds)]);
  if (capture.frames !== undefined) rows.push(['Frames', capture.frames.toLocaleString()]);
  if (capture.points !== undefined) rows.push([seed, compact(capture.points)]);
  rows.push(['Size', formatBytes(capture.bytes)]);

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View>
          <ThemedText type="smallBold">
            {date.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {describeTime(date)}
          </ThemedText>
        </View>

        <ThemedView type="backgroundElement" style={styles.card}>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <ThemedText type="small" themeColor="textSecondary">
                {label}
              </ThemedText>
              <ThemedText type="small">{value}</ThemedText>
            </View>
          ))}
          <ThemedText type="code" themeColor="textSecondary">
            {capture.captureId}.zip
          </ThemedText>
        </ThemedView>

        {debug.splatPreview && <SplatPreview capture={capture} serverUrl={debug.serverUrl} />}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.three,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
});
