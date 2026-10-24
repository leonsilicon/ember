import { useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import {
  models,
  useObjectDetector,
  type CocoClassYolo,
  type ObjectDetection,
} from 'react-native-executorch';
import type { ImageBuffer } from 'react-native-executorch/cv';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
} from 'react-native-vision-camera';
import { useResizer, type GPUFrame } from 'react-native-vision-camera-resizer';
import { scheduleOnRN } from 'react-native-worklets';

import { DetectionOverlay, labelColor, type Size } from './detection-overlay';
import { ThemedText } from './themed-text';

import { BottomTabInset, Spacing } from '@/constants/theme';

// YOLO26 Small at 512px is noticeably more accurate than Nano and still runs in real time.
// `DEFAULT` resolves to the Core ML export on iOS (Neural Engine) and XNNPACK on Android.
const MODEL = models.objectDetection.YOLO26.SMALL.SIZE_512.DEFAULT;
const MODEL_NAME = 'YOLO26s · 512';
const INPUT_SIZE: Size = { width: 512, height: 512 };
const CONFIDENCE_THRESHOLD = 0.4;

type FrameResult = {
  detections: ObjectDetection<'xyxy', CocoClassYolo>[];
  frameSize: Size;
  rotated180: boolean;
  latencyMs: number;
};

function summarize(detections: FrameResult['detections']) {
  const byLabel = new Map<CocoClassYolo, { count: number; confidence: number }>();
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

export function LiveDetector() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const device = useCameraDevice('back');
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();

  const detector = useObjectDetector(MODEL);
  const { detectObjectsWorklet } = detector;

  const { resizer } = useResizer({
    ...INPUT_SIZE,
    channelOrder: 'rgb',
    dataType: 'uint8',
    // Letterbox the whole frame into the square model input, so objects anywhere on screen are seen.
    scaleMode: 'contain',
    pixelLayout: 'interleaved',
  });

  const [viewSize, setViewSize] = useState<Size>({ width: 0, height: 0 });
  const [result, setResult] = useState<FrameResult>();
  const [frameError, setFrameError] = useState<string>();

  useEffect(() => {
    if (isFocused && canRequestPermission) {
      requestPermission();
    }
  }, [isFocused, canRequestPermission, requestPermission]);

  const onFrameResult = (next: FrameResult) => {
    setResult(next);
    setFrameError(undefined);
  };

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    // Camera buffers arrive sideways, and the GPU resizer turns sideways frames upside down, so the
    // model would see the scene rotated by 180°. On iOS, have AVFoundation rotate buffers upright
    // instead. (Android keeps sideways buffers, which the resizer docs recommend there; its boxes
    // are rotated back in the overlay.)
    enablePhysicalBufferRotation: Platform.OS === 'ios',
    // Frames that arrive while the model is busy are dropped on purpose; don't warn about each one.
    onFrameDropped: () => {},
    onFrame(frame) {
      'worklet';
      if (resizer == null || detectObjectsWorklet == null) {
        frame.dispose();
        return;
      }

      let resized: GPUFrame | undefined;
      try {
        const start = Date.now();
        const isSideways = frame.orientation === 'left' || frame.orientation === 'right';

        resized = resizer.resize(frame);
        const input: ImageBuffer = {
          data: new Uint8Array(resized.getPixelBuffer()),
          ...INPUT_SIZE,
          format: 'rgb',
          layout: 'hwc',
        };
        const detections = detectObjectsWorklet(input, {
          confidenceThreshold: CONFIDENCE_THRESHOLD,
        });

        scheduleOnRN(onFrameResult, {
          detections,
          frameSize: isSideways
            ? { width: frame.height, height: frame.width }
            : { width: frame.width, height: frame.height },
          rotated180: isSideways,
          latencyMs: Date.now() - start,
        });
      } catch (error) {
        scheduleOnRN(setFrameError, String(error));
      } finally {
        resized?.dispose();
        frame.dispose();
      }
    },
  });

  let status: string | undefined;
  if (!hasPermission) {
    status = canRequestPermission
      ? 'Waiting for camera access…'
      : 'Camera access is off. Allow it in Settings to identify objects.';
  } else if (device == null) {
    status = 'No camera found. Live detection needs a physical device.';
  } else if (detector.error) {
    status = `Couldn't load ${MODEL_NAME}: ${detector.error.message}`;
  } else if (!detector.isReady) {
    status =
      detector.downloadProgress < 100
        ? `Downloading ${MODEL_NAME}… ${Math.round(detector.downloadProgress)}%`
        : `Loading ${MODEL_NAME}…`;
  }

  const visibleResult = isFocused && !status ? result : undefined;
  const summary = visibleResult ? summarize(visibleResult.detections) : [];

  return (
    <View
      style={styles.container}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setViewSize({ width, height });
      }}>
      {isFocused && <StatusBar style="light" />}

      {/* Tabs stay mounted, and even an inactive Camera configures a capture session, which takes
          the camera away from ARKit on the Capture tab. Only mount it while this tab is focused. */}
      {isFocused && hasPermission && device != null && (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive
          outputs={[frameOutput]}
          orientationSource="interface"
          resizeMode="cover"
          enableNativeZoomGesture
          enableNativeTapToFocusGesture
        />
      )}

      {visibleResult && (
        <DetectionOverlay
          detections={visibleResult.detections}
          inputSize={INPUT_SIZE}
          frameSize={visibleResult.frameSize}
          viewSize={viewSize}
          rotated180={visibleResult.rotated180}
        />
      )}

      <View style={[styles.header, { top: insets.top + Spacing.two }]}>
        <View style={styles.pill}>
          <ThemedText type="smallBold" style={styles.hudText}>
            {MODEL_NAME}
          </ThemedText>
          {visibleResult && (
            <ThemedText type="code" style={styles.hudTextSecondary}>
              {visibleResult.latencyMs} ms · {Math.round(1000 / Math.max(visibleResult.latencyMs, 1))}{' '}
              fps
            </ThemedText>
          )}
        </View>
      </View>

      <View style={[styles.footer, { bottom: insets.bottom + BottomTabInset + Spacing.three }]}>
        {status ? (
          <View style={styles.panel}>
            <ThemedText type="small" style={styles.hudText}>
              {status}
            </ThemedText>
            {!hasPermission && !canRequestPermission && (
              <Pressable
                onPress={() => Linking.openSettings()}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                <ThemedText type="smallBold" style={styles.buttonText}>
                  Open Settings
                </ThemedText>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.panel}>
            <ThemedText type="smallBold" style={styles.hudTextSecondary}>
              {frameError ? `Detection failed: ${frameError}` : 'IN FRAME'}
            </ThemedText>
            <View style={styles.chips}>
              {summary.length === 0 ? (
                <ThemedText type="small" style={styles.hudText}>
                  Point the camera at something…
                </ThemedText>
              ) : (
                summary.map(([label, { count, confidence }]) => (
                  <View key={label} style={[styles.chip, { borderColor: labelColor(label) }]}>
                    <ThemedText type="smallBold" style={styles.hudText}>
                      {count > 1 ? `${label} ×${count}` : label}
                    </ThemedText>
                    <ThemedText type="code" style={styles.hudTextSecondary}>
                      {Math.round(confidence * 100)}%
                    </ThemedText>
                  </View>
                ))
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
  },
  footer: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  panel: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderWidth: 1.5,
    borderRadius: Spacing.three,
  },
  hudText: {
    color: '#ffffff',
  },
  hudTextSecondary: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.three,
    backgroundColor: '#ffffff',
  },
  buttonText: {
    color: '#000000',
  },
  pressed: {
    opacity: 0.7,
  },
});
