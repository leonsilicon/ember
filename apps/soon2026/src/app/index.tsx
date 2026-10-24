import { useEvent } from 'expo';
import { router, useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, {
  SplatCaptureView,
  type CaptureStatus,
  type SavedCapture,
} from '../../modules/splat-capture';

import { CameraMenu } from '@/components/camera-menu';
import { DetectionOverlay, labelColor, type Size } from '@/components/detection-overlay';
import { RoverSheet } from '@/components/rover-sheet';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useDetections, type Detection } from '@/hooks/use-detections';
import { compact, describeCapture, shareCapture } from '@/lib/captures';
import { useRover } from '@/lib/rover';

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

function summarize(detections: Detection[]) {
  const byLabel = new Map<string, { count: number; confidence: number }>();
  for (const { label, confidence } of detections) {
    const entry = byLabel.get(label);
    if (entry) {
      entry.count += 1;
      entry.confidence = Math.max(entry.confidence, confidence);
    } else {
      byLabel.set(label, { count: 1, confidence });
    }
  }
  return [...byLabel].sort(([, a], [, b]) => b.confidence - a.confidence);
}

/**
 * The main screen, since the phone rides on the rover: the camera, with live object detection
 * drawn over it, recording splat captures, and the rover's controls in a sheet.
 */
export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [capabilities] = useState(() => SplatCapture.getCapabilities());
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [detection, setDetection] = useState(true);
  const [featurePoints, setFeaturePoints] = useState(true);
  const [roverOpen, setRoverOpen] = useState(false);
  const [viewSize, setViewSize] = useState<Size>({ width: 0, height: 0 });
  const status = useEvent(SplatCapture, 'onStatus', INITIAL_STATUS);
  const detections = useDetections(detection && capabilities.arkit);
  const rover = useRover();

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
  const busy = phase.kind === 'recording' || phase.kind === 'saving';
  const result = detections.result;

  return (
    <View
      style={styles.container}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setViewSize({ width, height });
      }}>
      {focused && <StatusBar style="light" />}

      {/* Pauses itself while the gallery covers it, unless a recording is in progress. */}
      <SplatCaptureView style={StyleSheet.absoluteFill} showFeaturePoints={featurePoints && !lidar} />

      {result && (
        <DetectionOverlay
          detections={result.detections}
          inputSize={result.frameSize}
          frameSize={result.frameSize}
          viewSize={viewSize}
          rotated180={false}
        />
      )}

      <View style={[styles.top, { top: insets.top + Spacing.two }]}>
        <View style={styles.row}>
          <CameraMenu
            detection={detection}
            onDetectionChange={setDetection}
            featurePoints={featurePoints}
            onFeaturePointsChange={setFeaturePoints}
            detectionInfo={detections.status ?? detections.model}
          />
          <View style={styles.chips}>
            {phase.kind === 'recording' ? (
              <Chip
                tone="recording"
                label={`REC ${formatSeconds(status.elapsed)} · ${status.frames} frames · ${compact(status.points)} points`}
              />
            ) : (
              <Chip label={lidar ? 'LiDAR depth' : 'No LiDAR · feature points'} />
            )}
            <Chip label={trackingLabel} tone={status.tracking === 'normal' ? 'good' : 'warn'} />
          </View>
        </View>

        {detection && (
          <View style={styles.chips}>
            {detections.status && <Chip label={detections.status} />}
            {detections.error && <Chip label={`Detection failed: ${detections.error}`} tone="warn" />}
            {result &&
              summarize(result.detections).map(([label, { count, confidence }]) => (
                <Chip
                  key={label}
                  label={count > 1 ? `${label} ×${count}` : label}
                  detail={`${Math.round(confidence * 100)}%`}
                  borderColor={labelColor(label)}
                />
              ))}
          </View>
        )}
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + Spacing.three }]}>
        {phase.kind === 'recording' && (status.full || status.frozen) && (
          <View style={styles.panel}>
            {status.full && <Light>Frame budget reached. Tap stop to save.</Light>}
            {status.frozen && (
              <Light>Tracking was lost, so recording paused here. Tap stop to save what was captured.</Light>
            )}
          </View>
        )}

        {phase.kind === 'saving' && (
          <View style={styles.panel}>
            <Busy label="Saving capture…" />
          </View>
        )}

        {phase.kind === 'saved' && (
          <View style={styles.panel}>
            <Light style={styles.stats}>Saved · {describeCapture(phase.capture)}</Light>
            <Light>Send the zip to whoever turns it into a splat. It&apos;s also kept in the gallery.</Light>
            <View style={styles.buttons}>
              <Button label="Share…" onPress={() => share(phase.capture)} />
              <Button label="Done" secondary onPress={() => setPhase({ kind: 'ready' })} />
            </View>
          </View>
        )}

        {phase.kind === 'failed' && (
          <View style={styles.panel}>
            <Light style={styles.error}>{phase.message}</Light>
            <Button label="Dismiss" secondary onPress={() => setPhase({ kind: 'ready' })} />
          </View>
        )}

        <View style={styles.controls}>
          <RoundButton
            icon="photo.on.rectangle"
            label="Gallery"
            disabled={busy}
            onPress={() => router.push('/captures')}
          />
          <RecordButton
            recording={phase.kind === 'recording'}
            saving={phase.kind === 'saving'}
            onPress={phase.kind === 'recording' ? stopRecording : startRecording}
          />
          <RoundButton
            icon="car.fill"
            label="Rover controls"
            badge={rover.connection.state === 'connected'}
            onPress={() => setRoverOpen(true)}
          />
        </View>
      </View>

      {roverOpen && <RoverSheet onClose={() => setRoverOpen(false)} />}
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

function Chip({
  label,
  detail,
  tone,
  borderColor,
}: {
  label: string;
  detail?: string;
  tone?: 'good' | 'warn' | 'recording';
  borderColor?: string;
}) {
  return (
    <View
      style={[
        styles.chip,
        tone === 'good' && styles.chipGood,
        tone === 'warn' && styles.chipWarn,
        tone === 'recording' && styles.chipRecording,
        borderColor != null && [styles.chipOutlined, { borderColor }],
      ]}>
      <ThemedText type="smallBold" style={[styles.light, styles.stats]}>
        {label}
      </ThemedText>
      {detail && (
        <ThemedText type="code" style={styles.lightSecondary}>
          {detail}
        </ThemedText>
      )}
    </View>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <View style={styles.buttons}>
      <ActivityIndicator color="#fff" />
      <Light>{label}</Light>
    </View>
  );
}

function RecordButton({
  recording,
  saving,
  onPress,
}: {
  recording: boolean;
  saving: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      disabled={saving}
      onPress={onPress}
      style={({ pressed }) => [styles.record, pressed && styles.pressed]}>
      {saving ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <View style={recording ? styles.recordStop : styles.recordDot} />
      )}
    </Pressable>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  disabled,
  badge,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Draws a green dot, e.g. while the rover is connected. */
  badge?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.round, (pressed || disabled) && styles.pressed]}>
      <SymbolView name={icon} size={22} tintColor="#fff" />
      {badge && <View style={styles.badge} />}
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  secondary,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, pressed && styles.pressed]}>
      <ThemedText type="smallBold" style={secondary ? styles.light : styles.buttonLabel}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const ROUND_SIZE = 52;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  unsupported: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  top: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  chipOutlined: {
    paddingHorizontal: Spacing.two + Spacing.half,
    borderWidth: 1.5,
  },
  chipGood: {
    backgroundColor: 'rgba(28,120,64,0.8)',
  },
  chipWarn: {
    backgroundColor: 'rgba(170,110,0,0.85)',
  },
  chipRecording: {
    backgroundColor: 'rgba(229,53,43,0.85)',
  },
  bottom: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: 0,
    gap: Spacing.three,
  },
  panel: {
    padding: Spacing.three,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    gap: Spacing.three,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
  },
  light: {
    color: '#fff',
    textAlign: 'center',
  },
  lightSecondary: {
    color: 'rgba(255,255,255,0.7)',
  },
  stats: {
    fontVariant: ['tabular-nums'],
  },
  error: {
    color: '#ffb4a8',
    textAlign: 'center',
  },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.two,
  },
  round: {
    width: ROUND_SIZE,
    height: ROUND_SIZE,
    borderRadius: ROUND_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#000',
    backgroundColor: '#30D158',
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
