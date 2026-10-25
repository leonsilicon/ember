import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect, useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  withTiming,
  ZoomIn,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, {
  SplatCaptureView,
  type CameraPosition,
  type CameraStreamStatus,
  type CaptureStatus,
  type LiveStatus,
  type SavedCapture,
} from '../../modules/splat-capture';

import { BottomTray } from '@/components/bottom-tray';
import { CameraMenu } from '@/components/camera-menu';
import { CameraStatus, RailIcon, useCaption, type Indicator, type RailElement } from '@/components/camera-status';
import { DetectionOverlay } from '@/components/detection-overlay';
import { Glass } from '@/components/glass';
import { LiveSplatView } from '@/components/live-splat-view';
import { MountCameraView } from '@/components/mount-camera-view';
import { CorridorFan, RoverBrainMenu } from '@/components/rover-brain-menu';
import { RoverRemote } from '@/components/rover-control';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useCameraZoom, useZoomLevel, zoomTo } from '@/hooks/use-camera-zoom';
import { useDetections, type Detection, type Detections } from '@/hooks/use-detections';
import { useMountCamera, type MountCamera } from '@/hooks/use-mount-camera';
import { useCameraStream, usePublishDetections } from '@/hooks/use-camera-stream';
import { useRoverBrain } from '@/hooks/use-rover-brain';
import { updateSplatSettings, useSplatSettings } from '@/hooks/use-splat-settings';
import { compact } from '@/lib/captures';
import { useRover } from '@/lib/rover';
import { liveFollowEmbedUrl, SPLAT_TOKEN } from '@/lib/splat-server';

type Phase =
  | { kind: 'ready' }
  /** `liveServerUrl`: the splat server it streams to, which rebuilds it live in 3D. */
  | { kind: 'recording'; captureId: string; liveServerUrl?: string }
  | { kind: 'saving' };

/**
 * `mount`: the phone rides on the rover, so its camera is the one that matters: it shows it,
 * detects leaves in it, records it and serves it on the Wi-Fi. `remote`: the phone is in someone's
 * hand, driving the rover, so its own camera is no use: it shows the camera of the phone in mount
 * mode instead (for now there's only ever one), above the remote's controls.
 */
type Mode = 'mount' | 'remote';

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
    if (!live.fused && live.lastSkip) {
      // The first keyframes often can't be placed yet (too few feature points in view): say why.
      return { key, icon: 'cube-outline', tone: 'dim', label: `Live 3D: ${live.lastSkip}` };
    }
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

/**
 * Why the web app can't see this camera, in words, or undefined when it can (or might: a laptop that
 * hasn't connected yet isn't a problem the phone can see). Shown as a hint that stays on the camera
 * screen while it applies.
 */
function cameraStreamProblem(stream: CameraStreamStatus | null): string | undefined {
  if (!stream) return undefined;
  if (stream.state === 'blocked') return "Laptop can't see this camera: turn on Local Network for this app in Settings (tap the cast icon)";
  if (stream.state === 'failed') return `Laptop can't see this camera: ${stream.error ?? 'its server failed to start'}`;
  if (stream.state === 'ready' && !stream.urls?.length) return "Laptop can't see this camera: join the laptop's Wi-Fi";
  return undefined;
}

/** The Wi-Fi camera for the web app's live mode: the address to type in there, and who's watching. */
function describeCameraStream(stream: CameraStreamStatus): Indicator {
  const key = 'wifi-camera';
  if (stream.state === 'blocked') {
    return {
      key,
      icon: 'cast-off',
      tone: 'warn',
      label: 'Laptop view blocked: Local Network access is off for this app',
      onPress: () => void Linking.openSettings(),
    };
  }
  if (stream.state === 'ready') {
    const url = stream.urls?.[0];
    if (!url) return { key, icon: 'cast-off', tone: 'dim', label: 'Laptop view: join a Wi-Fi network so the web app can reach this phone' };
    const viewers = stream.viewers;
    return {
      key,
      icon: viewers > 0 ? 'cast-connected' : 'cast',
      tone: viewers > 0 ? 'good' : undefined,
      text: viewers > 0 ? String(viewers) : undefined,
      label: `Laptop view: ${url.replace('http://', '')} in the web app's live mode${viewers > 0 ? ` · ${viewers} watching` : ''}`,
    };
  }
  if (stream.state === 'failed') return { key, icon: 'cast-off', tone: 'warn', label: `Laptop view off: ${stream.error ?? 'failed to start'}` };
  return { key, icon: 'cast', tone: 'dim', label: 'Laptop view: starting…' };
}

/** In remote mode: the phone in mount mode whose camera this one shows. */
function describeMount(camera: MountCamera | null): Indicator {
  const key = 'mount';
  if (camera?.state === 'found') {
    const { device, origin } = camera.peer;
    return {
      key,
      icon: 'cellphone-link',
      tone: 'good',
      label: `Showing ${device}'s camera${camera.recording ? ', recording' : ''}, at ${origin.replace('http://', '')}`,
    };
  }
  if (camera?.state === 'unsupported') {
    return { key, icon: 'cellphone-link-off', tone: 'warn', label: "This build can't look for the rover's phone. Rebuild it." };
  }
  return { key, icon: 'cellphone-link', tone: 'dim', busy: true, label: "Looking for the rover's phone on the Wi-Fi" };
}

function describeDetections(detections: Detections): Indicator {
  const key = 'detections';
  if (detections.status) {
    return {
      key,
      icon: detections.unavailable ? 'leaf-off' : 'leaf',
      tone: detections.unavailable ? 'warn' : 'dim',
      label: detections.status,
      // Loading, or running its first frames: the spinner says so, since there's nothing to show yet.
      busy: detections.busy,
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
 * The main screen, laid out like the Camera app: the viewfinder, showing the camera's whole frame
 * with live object detection drawn over it and the status rail down its right, the gallery, record
 * button and remote along its foot, and the live 3D reconstruction below it. In remote mode (see
 * `Mode`) the viewfinder shows the camera of the phone on the rover instead, above the remote.
 */
export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const focused = useIsFocused();
  // The phone rides on the rover: were the screen to lock, ARKit and detection would stop with it.
  // (Development builds already keep it awake; this is for the production app.)
  useKeepAwake();
  const [capabilities] = useState(() => SplatCapture.getCapabilities());
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [mode, setMode] = useState<Mode>('mount');
  const remote = mode === 'remote';
  const [camera, setCamera] = useState<CameraPosition>('back');
  const [detection, setDetection] = useState(true);
  const [featurePoints, setFeaturePoints] = useState(true);
  /** Record with LiDAR depth, on phones that have it; toggled like the Camera app's flash. */
  const [lidarOn, setLidarOn] = useState(true);
  /** Shows the detector's timing over the viewfinder. */
  const [debugOverlay, setDebugOverlay] = useState(false);
  /** The newest capture, for the gallery button; `fresh` once this screen has just saved it. */
  const [latest, setLatest] = useState<{ capture: SavedCapture; fresh: boolean } | null>(null);
  const status = useEvent(SplatCapture, 'onStatus', INITIAL_STATUS);
  const recording = phase.kind === 'recording';
  const splat = useSplatSettings();
  /**
   * The live 3D view behind the camera is loaded ahead of recording (following the newest session,
   * hidden), and shown, locked onto the recording, once one streams; so it has nothing left to load then.
   */
  const liveReady = splat.liveStream && camera === 'back';
  const liveShown = recording && phase.liveServerUrl !== undefined;
  // Moving the live view stops it following the phone; the rail's Follow icon puts it back.
  const liveView = useRef<{ follow(): void }>(null);
  const [liveFollowing, setLiveFollowing] = useState(true);
  // The stream to the splat server connects ahead of recording too (while the viewfinder is on
  // screen, on the back camera), so a recording streams from its first frame, not after a handshake.
  useEffect(() => {
    try {
      SplatCapture.setLiveServer(splat.liveStream ? splat.serverUrl : null, SPLAT_TOKEN);
    } catch {
      // An older native build without standby: the recording connects when it starts.
    }
  }, [splat.liveStream, splat.serverUrl]);
  // In remote mode there's no camera of this phone's to zoom.
  const { zoom, pinch, style: zoomStyle } = useCameraZoom(!remote);
  // Crops each frame to the zoom, so zooming in on a leaf shows it to the detector bigger and sharper.
  const detections = useDetections(detection && capabilities.arkit && !remote, zoom);
  const rover = useRover();
  // Places leaves in the world, scans LiDAR for obstacles, and runs the drive-to-leaf autopilot.
  // The front camera can't place anything in the world.
  const brain = useRoverBrain(
    detections.result,
    detection && capabilities.arkit && focused && camera === 'back' && !remote,
  );
  // The web app's live mode watches this camera over the Wi-Fi while the screen is open: in mount
  // mode, or while this phone records.
  const cameraStream = useCameraStream(capabilities.arkit && focused && (!remote || recording));
  // The same boxes and tags for the web app's live view (none while detection is off).
  usePublishDetections(
    cameraStream,
    detection ? detections.result : undefined,
    detections.result && brain.captionsFor === detections.result ? brain.captions : undefined,
  );
  // In remote mode, the camera of the phone in mount mode.
  const mountCamera = useMountCamera(remote && focused);
  /** Its frames' shape (width / height), once they play. */
  const [mountAspect, setMountAspect] = useState(3 / 4);
  /** Where the remote's tray starts, so the other phone's camera fits above it. */
  const [trayTop, setTrayTop] = useState<number>();
  const { stopAutopilot } = brain;
  const [caption, showCaption] = useCaption();

  // Driving by hand takes over from the autopilot.
  useEffect(() => {
    if (remote) stopAutopilot();
  }, [remote, stopAutopilot]);

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
      const liveServerUrl = splat.liveStream ? splat.serverUrl : undefined;
      const { captureId } = await SplatCapture.startCapture({
        liveServerUrl,
        serverToken: SPLAT_TOKEN,
        forceFeaturePoints: !lidarOn,
      });
      setPhase({ kind: 'recording', captureId, liveServerUrl });
      if (zoom.get() > 1) showCaption('Zoom magnifies the preview and detection; the recording keeps the whole view');
    } catch (error) {
      setPhase({ kind: 'ready' });
      Alert.alert("Couldn't start recording", message(error));
    }
  }

  async function stopRecording() {
    setPhase({ kind: 'saving' });
    try {
      // Like the Camera app, the gallery button turning into the new capture is the confirmation.
      setLatest({ capture: await SplatCapture.stopCapture(), fresh: true });
      setPhase({ kind: 'ready' });
    } catch (error) {
      setPhase({ kind: 'ready' });
      Alert.alert("Couldn't save the capture", message(error));
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

  const busy = recording || phase.kind === 'saving';
  // The rover's brain places leaves in the world, which the front camera can't. With the remote
  // out, the rover is driven by hand.
  const roverBrain = !remote && detection && !front;
  // Zoom and the camera flip head the rail.
  const indicators: (Indicator | RailElement)[] = [
    { key: 'zoom', element: <ZoomButton zoom={zoom} /> },
    {
      key: 'flip',
      icon: 'camera-flip-outline',
      // Only the back camera records, so it can't change mid-recording.
      tone: !capabilities.frontCamera || busy ? 'dim' : undefined,
      label: front ? 'Switch to the back camera' : 'Switch to the front camera',
      onPress: () => {
        if (!capabilities.frontCamera) {
          showCaption('This phone has no front camera ARKit can use');
        } else if (busy) {
          showCaption('Only the back camera records, so it stays on until the recording stops');
        } else {
          // Each camera starts at 1×, as in the Camera app.
          zoom.set(1);
          setCamera(front ? 'back' : 'front');
        }
      },
    },
  ];
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
  if (liveShown && !liveFollowing) indicators.push({ key: 'follow', element: <FollowButton live={liveView} /> });
  if (detection) {
    indicators.push(describeDetections(detections));
  } else {
    // Switched off in the camera options: say so, rather than leaving no trace, since the rover's
    // brain is off with it. A tap turns it back on, like the LiDAR indicator.
    indicators.push({
      key: 'detections',
      icon: 'leaf-off',
      tone: 'dim',
      label: 'Detection off. Tap to turn it on',
      onPress: () => {
        setDetection(true);
        showCaption('Detection on');
      },
    });
  }
  if (roverBrain) {
    indicators.push({
      key: 'rover',
      element: <RoverBrainMenu brain={brain} canDrive={rover.connection.state === 'connected'} />,
    });
  }
  if (cameraStream) indicators.push(describeCameraStream(cameraStream));
  // Guidance beside the rail while it applies: what's wrong with the recording (tracking matters
  // most while recording, so only then does it say what's wrong with it), else what the autopilot
  // is doing.
  const hint = recording && status.frozen
    ? 'Tracking was lost, so recording paused here. Tap stop to save what was captured.'
    : recording && status.full
      ? 'Frame budget reached. Tap stop to save.'
      : recording && !front && tracking.tone === 'warn'
        ? tracking.label
        : roverBrain && brain.autopilot.on && brain.autopilot.message
          ? brain.autopilot.message
          : cameraStreamProblem(cameraStream);
  const result = detections.result;
  // The viewfinder shows the camera's whole frame, uncropped, so all the rover can see is on screen
  // and under the detection boxes: it takes the frame's shape at the screen's full width, under the
  // status bar, in a card with rounded corners like Instagram's camera. The detector's frames are
  // whole frames; until one arrives, it's the shape ARKit's default formats have: 4:3 for world
  // tracking (the back camera), 16:9 for face tracking (the front), both upright. Below it, the live
  // 3D view is the background. On a screen too short for both, the viewfinder narrows rather than
  // crops.
  const frameAspect = result ? result.frameSize.width / result.frameSize.height : front ? 9 / 16 : 3 / 4;
  const mountViewfinderHeight = Math.min(screen.width / frameAspect, screen.height - insets.top - MIN_LIVE_HEIGHT);
  // In remote mode it shows the other phone's camera, whole too, above the remote's tray.
  const viewfinderHeight = remote
    ? Math.min(screen.width / mountAspect, (trayTop ?? screen.height) - insets.top - Spacing.two)
    : mountViewfinderHeight;
  const viewfinderWidth = viewfinderHeight * (remote ? mountAspect : frameAspect);
  const viewfinderFrame = {
    top: insets.top,
    left: (screen.width - viewfinderWidth) / 2,
    width: viewfinderWidth,
    height: viewfinderHeight,
  };
  // Everything below the camera, reaching up into its rounded corners. In remote mode it stays
  // where it is, hidden under the remote's tray.
  const liveFrame = { top: insets.top + mountViewfinderHeight - CARD_RADIUS, left: 0, right: 0, bottom: 0 };
  const liveIdle = !splat.liveStream ? 'Off in the camera options' : front ? 'Back camera only' : 'Starts when you record';

  // The camera's options close the rail.
  indicators.push({
    key: 'options',
    element: (
      <CameraMenu
        detection={detection}
        onDetectionChange={setDetection}
        featurePoints={featurePoints}
        onFeaturePointsChange={setFeaturePoints}
        liveStream={splat.liveStream}
        onLiveStreamChange={(liveStream) => updateSplatSettings({ liveStream })}
        debug={debugOverlay}
        onDebugChange={setDebugOverlay}
        detectionInfo={detections.status ?? detections.model}
      />
    ),
  });

  return (
    <View style={styles.container}>
      {focused && <StatusBar style="light" />}

      {/*
        The live 3D reconstruction is the background, and takes pans wherever it shows: one finger
        orbits, two pan, pinch and twist.
      */}
      <View style={[styles.live, liveFrame, remote && styles.hidden]}>
        {liveReady && (
          <View style={[StyleSheet.absoluteFill, !liveShown && styles.hidden]}>
            <LiveSplatView
              key={splat.serverUrl}
              ref={liveView}
              url={liveFollowEmbedUrl(splat.serverUrl)}
              interactive
              onFollowingChange={setLiveFollowing}
              lockSession={recording ? phase.captureId : null}
            />
          </View>
        )}
        {(!liveShown || !liveReady) && <LiveIdle text={liveIdle} />}
      </View>

      {/* Pinch to zoom the camera. */}
      <GestureDetector gesture={pinch}>
        <Animated.View layout={SWAP} style={[styles.card, viewfinderFrame]}>
          {/* Zoomed by pinching, and clipped by the card. */}
          <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>
            {/* Pauses itself while the gallery covers it, unless a recording is in progress. */}
            <SplatCaptureView
              style={StyleSheet.absoluteFill}
              camera={camera}
              showFeaturePoints={featurePoints && !lidar}
              // Its camera is no use in remote mode, so it pauses (unless recording).
              active={!remote}
            />
          </Animated.View>
          {result && (
            <DetectionOverlay
              detections={result.detections}
              inputSize={result.frameSize}
              frameSize={result.frameSize}
              viewSize={{ width: viewfinderWidth, height: viewfinderHeight }}
              zoom={zoom}
              rotated180={false}
              distances={result.distances}
              captions={brain.captionsFor === result ? brain.captions : undefined}
            />
          )}
          {mountCamera && <MountCameraView camera={mountCamera} onAspect={setMountAspect} />}
        </Animated.View>
      </GestureDetector>

      <View style={[styles.overlay, viewfinderFrame]}>
        <CameraStatus
          indicators={remote ? [describeMount(mountCamera)] : indicators}
          hint={hint}
          caption={caption}
          onPressIndicator={(indicator) => showCaption(indicator.label)}
        />

        {debugOverlay && (
          <View style={styles.debug}>
            <ThemedText type="code" style={styles.debugText}>
              {result
                ? `${Math.round(result.latencyMs)} ms${result.zoom > 1 ? ` at ${result.zoom.toFixed(1)}×` : ''} · ${result.frameSize.width}×${result.frameSize.height}`
                : '– ms'}
            </ThemedText>
            {roverBrain && <CorridorFan brain={brain} />}
          </View>
        )}

        {/*
          The gallery, the record button and the remote. While recording, the time takes the
          gallery's place (it can't open mid-recording anyway). The remote's tray covers them.
        */}
        <Fade hidden={remote} style={styles.dock}>
          <View style={styles.side}>
            {recording ? (
              <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={styles.timerPill}>
                <Text style={styles.timerText}>{formatSeconds(status.elapsed)}</Text>
              </Animated.View>
            ) : (
              <GalleryButton
                capture={latest?.capture}
                pop={latest?.fresh}
                disabled={busy}
                onPress={() => router.push('/captures')}
              />
            )}
          </View>
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
          <View style={styles.side}>
            <RemoteButton connected={rover.connection.state === 'connected'} onPress={() => setMode('remote')} />
          </View>
        </Fade>
      </View>

      {remote && (
        <BottomTray label="Remote" onClose={() => setMode('mount')} onTop={setTrayTop}>
          <RoverRemote />
        </BottomTray>
      )}
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

/** The live 3D panel before it has a recording to rebuild: what it is, and when it starts. */
function LiveIdle({ text }: { text: string }) {
  return (
    <View style={styles.liveIdle}>
      <SymbolView name="cube" size={24} tintColor="rgba(255,255,255,0.5)" />
      <Text style={styles.liveIdleTitle}>Live 3D</Text>
      <Text style={styles.liveIdleText}>{text}</Text>
    </View>
  );
}

/**
 * Like the Camera app's 1× button, at the head of the rail: how far the camera is zoomed in (yellow
 * when it is), and a tap zooms in to 2× or back out to 1×. Pinching the viewfinder zooms anywhere
 * in between.
 */
function ZoomButton({ zoom }: { zoom: SharedValue<number> }) {
  const level = useZoomLevel(zoom, 0.1);
  const zoomed = level > 1;
  const label = `${Number(level.toFixed(1))}×`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Zoom ${label}`}
      accessibilityHint={zoomed ? 'Zooms back out to 1×' : 'Zooms in to 2×. Pinch the viewfinder to zoom further.'}
      hitSlop={Spacing.one}
      onPress={() => zoomTo(zoom, zoomed ? 1 : 2)}
      style={({ pressed }) => pressed && styles.pressed}>
      <RailIcon>
        <Text style={[styles.zoomText, zoomed && styles.zoomTextOn]}>{label}</Text>
      </RailIcon>
    </Pressable>
  );
}

/** In the rail once the live 3D view has been moved: puts it back behind the phone. */
function FollowButton({ live }: { live: RefObject<{ follow(): void } | null> }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Follow the phone"
      hitSlop={Spacing.one}
      onPress={() => live.current?.follow()}
      style={({ pressed }) => pressed && styles.pressed}>
      <RailIcon icon="crosshairs-gps" />
    </Pressable>
  );
}

/**
 * Right of the record button: switches to remote mode, where this phone drives the rover from a tray
 * like the Camera app's controls tray, and shows the camera of the phone on the rover. A green dot
 * says a rover is connected.
 */
function RemoteButton({ connected, onPress }: { connected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={connected ? 'Remote, rover connected' : 'Remote'}
      onPress={onPress}
      style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
      <Glass style={[StyleSheet.absoluteFill, styles.roundShape]} />
      <SymbolView name="gamecontroller.fill" size={22} tintColor="#fff" />
      {connected && <View style={styles.connected} />}
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

const ROUND_SIZE = 48;
const THUMBNAIL_SIZE = 44;
const RECORD_SIZE = 80;
const RECORD_DOT_SIZE = 64;
const RECORD_STOP_SIZE = 30;
/** The least of the live 3D view worth showing below the camera: on short screens, the camera narrows to leave it. */
const MIN_LIVE_HEIGHT = 120;
/** The camera card's corners, like Instagram's. */
const CARD_RADIUS = 24;
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
  /** The camera, edge to edge with rounded corners, like Instagram's. */
  card: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: CARD_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: '#000',
  },
  /** The live 3D view, behind the camera. */
  live: {
    position: 'absolute',
    backgroundColor: '#000',
  },
  /** Loaded but not showing: before a recording. */
  hidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  /** Centred on what shows below the camera's rounded corners. */
  liveIdle: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingTop: CARD_RADIUS,
  },
  liveIdleTitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: 600,
  },
  liveIdleText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    textAlign: 'center',
  },
  /** Over the viewfinder, letting touches through to the camera between its controls. */
  overlay: {
    position: 'absolute',
    pointerEvents: 'box-none',
  },
  debug: {
    position: 'absolute',
    top: Spacing.three,
    left: Spacing.three,
    gap: Spacing.two,
    pointerEvents: 'none',
  },
  debugText: {
    color: '#fff',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
  /** The gallery, record button and remote, at the foot of the viewfinder. */
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  /** Either side of the record button, each centred in its half. */
  side: {
    flex: 1,
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  inert: {
    pointerEvents: 'none',
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
  round: {
    width: ROUND_SIZE,
    height: ROUND_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundShape: {
    borderRadius: ROUND_SIZE / 2,
  },
  zoomText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    fontVariant: ['tabular-nums'],
    // Legible over any picture, like the icons beside it.
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  /** On the remote button's shoulder. */
  connected: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#000',
    backgroundColor: '#30D158',
  },
  /** The Camera app's yellow, as on its zoom buttons. */
  zoomTextOn: {
    color: '#FFD60A',
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
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
    width: RECORD_DOT_SIZE,
    height: RECORD_DOT_SIZE,
    borderRadius: RECORD_DOT_SIZE / 2,
    backgroundColor: '#FF3B30',
  },
  recordPressed: {
    transform: [{ scale: 0.94 }],
  },
  disabled: {
    opacity: 0.35,
  },
  pressed: {
    opacity: 0.6,
  },
});
