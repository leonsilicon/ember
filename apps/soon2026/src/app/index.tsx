import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useFocusEffect, useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, {
  SplatCaptureView,
  type CameraPosition,
  type CaptureStatus,
  type LiveStatus,
  type SavedCapture,
} from '../../modules/splat-capture';

import { CameraMenu } from '@/components/camera-menu';
import { CameraStatus, useCaption, type Indicator } from '@/components/camera-status';
import { DetectionOverlay, type Size } from '@/components/detection-overlay';
import { Glass } from '@/components/glass';
import { LiveSplatView } from '@/components/live-splat-view';
import { ModePicker } from '@/components/mode-picker';
import { RoverBrainHud } from '@/components/rover-brain-hud';
import { RoverRemote } from '@/components/rover-control';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useDebugSettings } from '@/hooks/use-debug-settings';
import { useDetections, type Detection, type Detections } from '@/hooks/use-detections';
import { useRoverBrain } from '@/hooks/use-rover-brain';
import { compact } from '@/lib/captures';
import { useRover } from '@/lib/rover';
import { liveEmbedUrl, SPLAT_TOKEN } from '@/lib/splat-preview';

type Phase =
  | { kind: 'ready' }
  /** `liveServerUrl`: the splat server it streams to, which rebuilds it live in 3D. */
  | { kind: 'recording'; captureId: string; liveServerUrl?: string }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string };

/** `camera` records splat captures; `remote` drives the rover. The camera stays live in both. */
type Mode = 'camera' | 'remote';

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

function describeTracking(status: CaptureStatus): Indicator {
  const key = 'tracking';
  if (status.error) return { key, icon: 'crosshairs-off', tone: 'warn', label: 'Tracking lost, restarting…' };
  if (status.tracking === 'normal') return { key, icon: 'crosshairs-gps', label: 'Tracking' };
  if (status.tracking === 'limited') {
    const reason = TRACKING_HINTS[status.trackingReason ?? ''] ?? status.trackingReason ?? 'unknown';
    return { key, icon: 'crosshairs-question', tone: 'warn', label: `Limited tracking: ${reason}` };
  }
  return { key, icon: 'crosshairs', tone: 'dim', label: 'Starting camera…' };
}

/** While recording: how the stream to the server's live reconstruction is doing. */
function describeLive(live: LiveStatus): Indicator {
  const key = 'live';
  if (live.state === 'open') {
    const points = live.points ? ` · ${compact(live.points)} points` : '';
    return {
      key,
      icon: 'cube-scan',
      tone: live.fused > 0 ? 'good' : undefined,
      label: `Live 3D: ${live.fused} keyframes fused${points}`,
    };
  }
  if (live.state === 'connecting') return { key, icon: 'cube-outline', tone: 'dim', label: 'Live 3D: connecting…' };
  return { key, icon: 'cube-off-outline', tone: 'warn', label: `Live 3D: ${live.error ?? live.state}` };
}

function describeDetections(detections: Detections): Indicator {
  const key = 'detections';
  if (detections.status) {
    return {
      key,
      icon: detections.unavailable ? 'leaf-off' : 'leaf',
      tone: detections.unavailable ? 'warn' : 'dim',
      label: detections.status,
    };
  }
  if (detections.error) return { key, icon: 'leaf-off', tone: 'warn', label: `Detection failed: ${detections.error}` };
  const found = detections.result?.detections ?? [];
  if (found.length === 0) return { key, icon: 'leaf', label: `${detections.model}: nothing in view` };
  const summary = summarize(found)
    .map(([label, { count, confidence }]) => `${count > 1 ? `${label} ×${count}` : label} ${Math.round(confidence * 100)}%`)
    .join(', ');
  return { key, icon: 'leaf', tone: 'good', text: String(found.length), label: `${detections.model}: ${summary}` };
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
 * The main screen, since the phone rides on the rover, laid out like the Camera app: the
 * viewfinder with live object detection drawn over it, and below it the gallery, the modes
 * (recording splat captures, or driving the rover) and the camera flip.
 */
export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [capabilities] = useState(() => SplatCapture.getCapabilities());
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [mode, setMode] = useState<Mode>('camera');
  const [camera, setCamera] = useState<CameraPosition>('back');
  const [detection, setDetection] = useState(true);
  const [featurePoints, setFeaturePoints] = useState(true);
  /** Record with LiDAR depth, on phones that have it; toggled like the Camera app's flash. */
  const [lidarOn, setLidarOn] = useState(true);
  /** Shows the detector's timing over the viewfinder. */
  const [debugOverlay, setDebugOverlay] = useState(false);
  /** The live 3D view fills the viewfinder and the camera floats, instead of the other way round. */
  const [swapped, setSwapped] = useState(false);
  /** The newest capture, for the gallery button; `fresh` once this screen has just saved it. */
  const [latest, setLatest] = useState<{ capture: SavedCapture; fresh: boolean } | null>(null);
  const [viewSize, setViewSize] = useState<Size>({ width: 0, height: 0 });
  const status = useEvent(SplatCapture, 'onStatus', INITIAL_STATUS);
  const detections = useDetections(detection && capabilities.arkit);
  const rover = useRover();
  // Places leaves in the world, scans LiDAR for obstacles, and runs the drive-to-leaf autopilot.
  // The front camera can't place anything in the world.
  const brain = useRoverBrain(detections.result, detection && capabilities.arkit && focused && camera === 'back');
  const { stopAutopilot } = brain;
  const debug = useDebugSettings();
  const [caption, showCaption] = useCaption();
  // Like the Camera app, a sideways swipe across the viewfinder moves to the next or previous mode.
  const [swipe] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) => Math.abs(dx) > 24 && Math.abs(dx) > 2 * Math.abs(dy),
      onPanResponderRelease: (_, { dx }) => {
        if (Math.abs(dx) > 48) setMode(dx < 0 ? 'remote' : 'camera');
      },
    }),
  );

  // Driving by hand takes over from the autopilot.
  useEffect(() => {
    if (mode === 'remote') stopAutopilot();
  }, [mode, stopAutopilot]);

  // Re-read on every return, since the gallery can delete the newest capture.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      SplatCapture.listCaptures()
        .then(([newest]) => alive && setLatest(newest ? { capture: newest, fresh: false } : null))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  async function startRecording() {
    try {
      // With Live 3D on, the server rebuilds the scene as it records, shown here and at <server>/live.
      const liveServerUrl = debug.splatPreview && debug.liveStream ? debug.serverUrl : undefined;
      const { captureId } = await SplatCapture.startCapture({
        liveServerUrl,
        serverToken: SPLAT_TOKEN,
        forceFeaturePoints: !lidarOn,
      });
      setSwapped(false);
      setPhase({ kind: 'recording', captureId, liveServerUrl });
    } catch (error) {
      setPhase({ kind: 'failed', message: message(error) });
    }
  }

  async function stopRecording() {
    setPhase({ kind: 'saving' });
    try {
      // Like the Camera app, the gallery button turning into the new capture is the confirmation.
      setLatest({ capture: await SplatCapture.stopCapture(), fresh: true });
      setPhase({ kind: 'ready' });
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

  const front = camera === 'front';
  const recording = phase.kind === 'recording';
  // A recording keeps the mode it started with.
  const lidar = recording ? status.mode === 'lidar' : capabilities.lidar && lidarOn;
  const tracking = describeTracking(status);

  function toggleLidar() {
    if (!capabilities.lidar) {
      showCaption('LiDAR needs a phone with a LiDAR scanner, like an iPhone Pro');
    } else if (recording) {
      showCaption(`This recording uses ${lidar ? 'LiDAR' : 'feature points'}. Stop it to switch.`);
    } else {
      setLidarOn(!lidarOn);
      showCaption(lidarOn ? 'LiDAR off' : 'LiDAR on');
    }
  }

  const indicators: Indicator[] = [];
  if (recording) {
    indicators.push({
      key: 'frames',
      icon: 'camera-burst',
      tone: status.full ? 'warn' : undefined,
      text: String(status.frames),
      label: `${status.frames} frames, ${compact(status.points)} points${status.full ? ': frame budget reached' : ''}`,
    });
  }
  if (front) {
    indicators.push({
      key: 'camera',
      icon: 'video-off',
      tone: 'dim',
      label: 'Front camera: it previews and detects, but only the back camera records',
    });
  } else {
    indicators.push(
      {
        key: 'lidar',
        icon: lidar ? 'blur' : 'blur-off',
        tone: lidar ? 'on' : capabilities.lidar ? undefined : 'dim',
        label: !capabilities.lidar
          ? "No LiDAR on this phone: ARKit's feature points seed the splat"
          : lidar
            ? 'LiDAR on: its depth seeds the splat'
            : "LiDAR off: ARKit's feature points seed the splat",
        onPress: toggleLidar,
      },
      tracking,
    );
  }
  if (recording && status.live) indicators.push(describeLive(status.live));
  if (detection) indicators.push(describeDetections(detections));
  const busy = recording || phase.kind === 'saving';
  const result = detections.result;
  const liveUrl = recording && phase.liveServerUrl ? liveEmbedUrl(phase.liveServerUrl, phase.captureId) : null;
  const liveMain = liveUrl !== null && swapped;
  const barHeight = BAR_PADDING + BAR_CONTENT + Math.max(insets.bottom, Spacing.three);

  const options = (
    <CameraMenu
      detection={detection}
      onDetectionChange={setDetection}
      featurePoints={featurePoints}
      onFeaturePointsChange={setFeaturePoints}
      debug={debugOverlay}
      onDebugChange={setDebugOverlay}
      detectionInfo={detections.status ?? detections.model}
    />
  );

  return (
    <View style={styles.container}>
      {focused && <StatusBar style="light" />}

      <View
        style={[styles.viewfinder, { top: insets.top, bottom: barHeight }]}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewSize({ width, height });
        }}
        // Swipes would fight the live 3D view's orbit drags while it fills the viewfinder.
        {...(liveMain ? undefined : swipe.panHandlers)}>
        {/*
          While a recording streams to the server, its live 3D reconstruction floats top left, and
          tapping it swaps it with the camera, like a FaceTime call.
          Both views keep their place in the tree as they swap, so neither the AR session nor the
          3D page restarts.
        */}
        <View style={StyleSheet.absoluteFill}>
          <Animated.View layout={SWAP} style={liveMain ? styles.pip : StyleSheet.absoluteFill}>
            {/* Pauses itself while the gallery covers it, unless a recording is in progress. */}
            <SplatCaptureView
              style={StyleSheet.absoluteFill}
              camera={camera}
              showFeaturePoints={featurePoints && !lidar}
            />
            {result && !liveMain && (
              <DetectionOverlay
                detections={result.detections}
                inputSize={result.frameSize}
                frameSize={result.frameSize}
                viewSize={viewSize}
                rotated180={false}
                captions={brain.captionsFor === result ? brain.captions : undefined}
              />
            )}
            {liveMain && <SwapButton label="Show the camera" onPress={() => setSwapped(false)} />}
          </Animated.View>
          {liveUrl && (
            <Animated.View
              layout={SWAP}
              entering={POP}
              style={liveMain ? StyleSheet.absoluteFill : styles.pip}>
              <LiveSplatView url={liveUrl} interactive={liveMain} />
              {!liveMain && <SwapButton label="Show live 3D" onPress={() => setSwapped(true)} />}
            </Animated.View>
          )}
        </View>

        {/* Its captions stop short of the floating view. */}
        <View style={[styles.top, styles.passThrough, liveUrl !== null && styles.topBesidePip]}>
          <CameraStatus
            indicators={indicators}
            // Tracking matters most while recording, so only then does it say what's wrong.
            hint={recording && !front && tracking.tone === 'warn' ? tracking.label : undefined}
            caption={caption}
            onPressIndicator={(indicator) => showCaption(indicator.label)}
          />
        </View>

        {debugOverlay && (
          <ThemedText type="code" style={[styles.debug, liveUrl !== null && styles.debugUnderPip]}>
            {result ? `${Math.round(result.latencyMs)} ms` : '– ms'}
          </ThemedText>
        )}

        <View style={[styles.dock, styles.passThrough]}>
          {recording && (status.full || status.frozen) && (
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

          {phase.kind === 'failed' && (
            <View style={styles.panel}>
              <Light style={styles.error}>{phase.message}</Light>
              <Button label="Dismiss" secondary onPress={() => setPhase({ kind: 'ready' })} />
            </View>
          )}

          {mode === 'camera' && detection && !front && (
            <RoverBrainHud brain={brain} canDrive={rover.connection.state === 'connected'} />
          )}

          {mode === 'camera' ? (
            <View style={[styles.controls, styles.passThrough]}>
              {/* Balances the options, so the record button stays centred. */}
              <View style={styles.side} />
              <RecordButton
                recording={recording}
                saving={phase.kind === 'saving'}
                dimmed={front && !recording}
                onPress={
                  recording
                    ? stopRecording
                    : front
                      ? () => showCaption('Only the back camera records. Flip to record.')
                      : startRecording
                }
              />
              <View style={[styles.side, styles.passThrough]}>{options}</View>
            </View>
          ) : (
            <RoverRemote right={options} />
          )}
        </View>
      </View>

      {/* Like the Camera app's, it clears to black while recording, leaving only the time. */}
      <View style={[styles.bar, { height: barHeight }]}>
        <Fade hidden={recording} style={styles.barRow}>
          <View style={styles.side}>
            <GalleryButton
              capture={latest?.capture}
              pop={latest?.fresh}
              disabled={busy}
              onPress={() => router.push('/captures')}
            />
          </View>
          <ModePicker
            modes={[
              { value: 'camera', label: 'Camera' },
              { value: 'remote', label: 'Remote', badge: rover.connection.state === 'connected' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <View style={styles.side}>
            <FlipButton
              front={front}
              // Only the back camera records, so it can't change mid-recording.
              disabled={!capabilities.frontCamera || busy}
              onPress={() => setCamera(front ? 'back' : 'front')}
            />
          </View>
        </Fade>
        {recording && (
          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={styles.timer}>
            <View style={styles.timerPill}>
              <Text style={styles.timerText}>{formatSeconds(status.elapsed)}</Text>
            </View>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

/** Fades out while `hidden`, staying mounted, and meanwhile lets taps and VoiceOver past it. */
function Fade({ hidden, style, children }: { hidden: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const fade = useAnimatedStyle(() => ({ opacity: withTiming(hidden ? 0 : 1, { duration: 200 }) }));

  return (
    <Animated.View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[style, fade, hidden && styles.inert]}>
      {children}
    </Animated.View>
  );
}

/** Like the Camera app's recording time, e.g. 00:42. */
function formatSeconds(seconds: number) {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Light({ children, style }: { children: ReactNode; style?: object }) {
  return (
    <ThemedText type="small" style={[styles.light, style]}>
      {children}
    </ThemedText>
  );
}

/** Covers the floating view, which swaps with the main one when tapped. */
function SwapButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [StyleSheet.absoluteFill, pressed && styles.swapPressed]}
    />
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

/**
 * The Camera app's video shutter: a red dot in a glass ring, which shrinks to a square while
 * recording. `dimmed` while it can't record, when it still takes taps, to say why.
 */
function RecordButton({
  recording,
  saving,
  dimmed,
  onPress,
}: {
  recording: boolean;
  saving: boolean;
  dimmed?: boolean;
  onPress: () => void;
}) {
  const dot = useAnimatedStyle(() => {
    const size = recording ? RECORD_STOP_SIZE : RECORD_DOT_SIZE;
    return {
      width: withTiming(size),
      height: withTiming(size),
      borderRadius: withTiming(recording ? Spacing.two : size / 2),
    };
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      accessibilityState={{ disabled: saving || dimmed }}
      disabled={saving}
      onPress={onPress}
      style={({ pressed }) => [styles.record, pressed && styles.recordPressed]}>
      <Glass colorScheme="light" style={[StyleSheet.absoluteFill, styles.recordRing]} />
      {saving ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Animated.View style={[styles.recordDot, dimmed && styles.disabled, dot]} />
      )}
    </Pressable>
  );
}

function FlipButton({ front, disabled, onPress }: { front: boolean; disabled: boolean; onPress: () => void }) {
  // Half a turn per flip, like the Camera app's.
  const icon = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(front ? '180deg' : '0deg', { duration: 350 }) }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={front ? 'Switch to the back camera' : 'Switch to the front camera'}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.round, (pressed || disabled) && styles.pressed]}>
      <Glass style={[StyleSheet.absoluteFill, styles.roundShape]} />
      <Animated.View style={icon}>
        <SymbolView name="arrow.triangle.2.circlepath" size={22} weight="medium" tintColor="#fff" />
      </Animated.View>
    </Pressable>
  );
}

/**
 * Like the Camera app's: the newest capture's first frame, which pops in when a recording is
 * saved. Falls back to an icon when there's no capture, or it has no thumbnail.
 */
function GalleryButton({
  capture,
  pop,
  onPress,
  disabled,
}: {
  capture?: SavedCapture;
  pop?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Gallery"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => (pressed || disabled) && styles.pressed}>
      {capture?.thumbnailUri ? (
        // Keyed by capture, so a newly saved one mounts fresh and plays the pop.
        <Animated.View
          key={capture.captureId}
          entering={pop ? POP : undefined}
          style={styles.thumbnail}>
          <Image source={capture.thumbnailUri} style={StyleSheet.absoluteFill} contentFit="cover" />
        </Animated.View>
      ) : (
        <View style={styles.thumbnail}>
          <Glass style={[StyleSheet.absoluteFill, styles.thumbnailShape]} />
          <SymbolView name="photo.on.rectangle" size={20} tintColor="#fff" />
        </View>
      )}
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

const ROUND_SIZE = 48;
const THUMBNAIL_SIZE = 44;
const RECORD_SIZE = 80;
const RECORD_DOT_SIZE = 64;
const RECORD_STOP_SIZE = 30;
/** The room either side of the record button and of the modes, so the columns line up. */
const SIDE_WIDTH = 64;
const BAR_PADDING = Spacing.three;
/** The mode capsule's height. */
const BAR_CONTENT = 48;
/** The floating view: 3:4, like the camera frames. */
const PIP_WIDTH = 126;
const PIP_HEIGHT = 168;
// Eased, not sprung: springs overshoot and bounce.
const SWAP = LinearTransition.duration(260).easing(Easing.out(Easing.cubic));
const POP = ZoomIn.duration(250).easing(Easing.out(Easing.cubic));

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
  viewfinder: {
    position: 'absolute',
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  top: {
    position: 'absolute',
    top: Spacing.three,
    left: Spacing.three,
    right: Spacing.three,
  },
  topBesidePip: {
    left: Spacing.three + PIP_WIDTH + Spacing.two,
  },
  passThrough: {
    pointerEvents: 'box-none',
  },
  /** Top left, where the floating view goes while recording. */
  debug: {
    position: 'absolute',
    top: Spacing.three,
    left: Spacing.three,
    color: '#fff',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
    pointerEvents: 'none',
  },
  debugUnderPip: {
    top: Spacing.three + PIP_HEIGHT + Spacing.two,
  },
  pip: {
    position: 'absolute',
    top: Spacing.three,
    left: Spacing.three,
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    // Above the main view whichever one it is (they swap order).
    zIndex: 1,
    borderRadius: Spacing.three,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  swapPressed: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  dock: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: Spacing.three,
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
  },
  side: {
    width: SIDE_WIDTH,
    alignItems: 'center',
  },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: BAR_PADDING,
    paddingHorizontal: Spacing.three,
  },
  barRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  inert: {
    pointerEvents: 'none',
  },
  /** Where the modes were, like the Camera app's recording time. */
  timer: {
    position: 'absolute',
    top: BAR_PADDING,
    left: 0,
    right: 0,
    height: BAR_CONTENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.one + Spacing.half,
    backgroundColor: '#FF3B30',
  },
  timerText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 600,
    fontVariant: ['tabular-nums'],
  },
  light: {
    color: '#fff',
    textAlign: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundShape: {
    borderRadius: ROUND_SIZE / 2,
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    // Centred on the capsule beside it.
    marginTop: (BAR_CONTENT - THUMBNAIL_SIZE) / 2,
    borderRadius: Spacing.two + Spacing.half,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  thumbnailShape: {
    borderRadius: Spacing.two + Spacing.half,
  },
  record: {
    width: RECORD_SIZE,
    height: RECORD_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordRing: {
    borderRadius: RECORD_SIZE / 2,
  },
  recordDot: {
    backgroundColor: '#FF3B30',
  },
  recordPressed: {
    transform: [{ scale: 0.94 }],
  },
  disabled: {
    opacity: 0.35,
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
