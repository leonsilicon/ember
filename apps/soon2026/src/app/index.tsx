import { useEvent } from 'expo';
import { useIsFocused } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, {
  SplatCaptureView,
  type CaptureStatus,
  type SavedCapture,
} from '../../modules/splat-capture';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { compact, describeCapture, shareCapture } from '@/lib/captures';

type Phase =
  | { kind: 'ready' }
  | { kind: 'recording' }
  | { kind: 'saving' }
  | { kind: 'saved'; capture: SavedCapture }
  | { kind: 'failed'; message: string };

const INITIAL_STATUS: CaptureStatus = {
  recording: false,
  mode: 'features',
  tracking: 'notAvailable',
  frames: 0,
  points: 0,
  elapsed: 0,
  full: false,
};

const TRACKING_HINTS: Record<string, string> = {
  excessiveMotion: 'moving too fast',
  insufficientFeatures: 'needs more texture or light',
  initializing: 'move the phone a little',
  relocalizing: 'relocalizing',
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [capabilities] = useState(() => SplatCapture.getCapabilities());
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const status = useEvent(SplatCapture, 'onStatus', INITIAL_STATUS);

  async function startRecording() {
    try {
      await SplatCapture.startCapture({});
      setPhase({ kind: 'recording' });
    } catch (error) {
      setPhase({ kind: 'failed', message: message(error) });
    }
  }

  async function stopRecording() {
    setPhase({ kind: 'saving' });
    try {
      setPhase({ kind: 'saved', capture: await SplatCapture.stopCapture() });
    } catch (error) {
      setPhase({ kind: 'failed', message: message(error) });
    }
  }

  async function share(capture: SavedCapture) {
    try {
      await shareCapture(capture);
    } catch (error) {
      setPhase({ kind: 'failed', message: message(error) });
    }
  }

  if (!capabilities.arkit) {
    return (
      <ThemedView style={[styles.unsupported, { paddingTop: insets.top + Spacing.six }]}>
        <ThemedText type="subtitle">Capture needs an iPhone</ThemedText>
        <ThemedText themeColor="textSecondary">
          This device has no ARKit world tracking, so it can&apos;t record camera poses. Run the app on an
          iPhone. LiDAR is optional: without it, ARKit&apos;s feature points seed the splat instead.
        </ThemedText>
      </ThemedView>
    );
  }

  const lidar = status.mode === 'lidar';
  const trackingLabel = status.error
    ? 'Tracking lost, restarting…'
    : status.tracking === 'normal'
      ? 'Tracking'
      : status.tracking === 'limited'
        ? `Limited: ${TRACKING_HINTS[status.trackingReason ?? ''] ?? status.trackingReason ?? 'unknown'}`
        : 'Starting camera…';

  return (
    <View style={styles.container}>
      <SplatCaptureView style={StyleSheet.absoluteFill} showFeaturePoints={!lidar} active={focused} />

      <View style={[styles.chips, { top: insets.top + Spacing.two }]}>
        <Chip label={lidar ? 'LiDAR depth' : 'No LiDAR · feature points'} />
        <Chip label={trackingLabel} tone={status.tracking === 'normal' ? 'good' : 'warn'} />
      </View>

      <View style={[styles.panel, { marginBottom: insets.bottom + BottomTabInset + Spacing.three }]}>
        {phase.kind === 'ready' && (
          <>
            <Light>
              Walk slowly around the subject, keeping it in view.
              {lidar ? '' : ' The yellow dots are the feature points that will seed the splat.'}
            </Light>
            <RecordButton recording={false} onPress={startRecording} />
          </>
        )}

        {phase.kind === 'recording' && (
          <>
            <Light style={styles.stats}>
              {status.frames} frames · {compact(status.points)} points · {formatSeconds(status.elapsed)}
            </Light>
            {status.full && <Light>Frame budget reached. Tap stop to save.</Light>}
            {status.frozen && <Light>Tracking was lost, so recording paused here. Tap stop to save what was captured.</Light>}
            <RecordButton recording onPress={stopRecording} />
          </>
        )}

        {phase.kind === 'saving' && <Busy label="Saving capture…" />}

        {phase.kind === 'saved' && (
          <>
            <Light style={styles.stats}>Saved · {describeCapture(phase.capture)}</Light>
            <Light>Send the zip to whoever turns it into a splat. It&apos;s also kept in the Captures tab.</Light>
            <View style={styles.row}>
              <Button label="Share…" onPress={() => share(phase.capture)} />
              <Button label="New capture" secondary onPress={() => setPhase({ kind: 'ready' })} />
            </View>
          </>
        )}

        {phase.kind === 'failed' && (
          <>
            <Light style={styles.error}>{phase.message}</Light>
            <Button label="New capture" secondary onPress={() => setPhase({ kind: 'ready' })} />
          </>
        )}
      </View>
    </View>
  );
}

function formatSeconds(seconds: number) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Light({ children, style }: { children: ReactNode; style?: object }) {
  return (
    <ThemedText type="small" style={[styles.light, style]}>
      {children}
    </ThemedText>
  );
}

function Chip({ label, tone }: { label: string; tone?: 'good' | 'warn' }) {
  return (
    <View style={[styles.chip, tone === 'good' && styles.chipGood, tone === 'warn' && styles.chipWarn]}>
      <ThemedText type="smallBold" style={styles.light}>
        {label}
      </ThemedText>
    </View>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <ActivityIndicator color="#fff" />
      <Light>{label}</Light>
    </View>
  );
}

function RecordButton({ recording, onPress }: { recording: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      onPress={onPress}
      style={({ pressed }) => [styles.record, pressed && styles.pressed]}>
      <View style={recording ? styles.recordStop : styles.recordDot} />
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  disabled,
  secondary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        (pressed || disabled) && styles.pressed,
      ]}>
      <ThemedText type="smallBold" style={secondary ? styles.light : styles.buttonLabel}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'flex-end',
  },
  unsupported: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  chips: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  chipGood: {
    backgroundColor: 'rgba(28,120,64,0.8)',
  },
  chipWarn: {
    backgroundColor: 'rgba(170,110,0,0.85)',
  },
  panel: {
    marginHorizontal: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    gap: Spacing.three,
  },
  light: {
    color: '#fff',
    textAlign: 'center',
  },
  stats: {
    fontVariant: ['tabular-nums'],
  },
  error: {
    color: '#ffb4a8',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.two,
  },
  record: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordDot: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#e5352b',
  },
  recordStop: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#e5352b',
  },
  button: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + Spacing.half,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  buttonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  buttonLabel: {
    color: '#000',
  },
  pressed: {
    opacity: 0.6,
  },
});
