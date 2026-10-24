import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, type SharedValue } from 'react-native-reanimated';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useZoomLevel } from '@/hooks/use-camera-zoom';
import type { Box } from '@/lib/detection-tracker';

export type Size = {
  width: number;
  height: number;
};

/** A box to draw, in `inputSize`'s pixels. */
export type OverlayDetection = {
  box: Box;
  label: string;
  confidence: number;
  /** Keeps the same view (and its fade) on the same leaf from frame to frame. */
  id?: number;
};

type DetectionOverlayProps = {
  detections: readonly OverlayDetection[];
  /** Size of the model input the boxes are expressed in. */
  inputSize: Size;
  /** Upright size of the camera frame that was letterboxed into the model input. */
  frameSize: Size;
  /** On-screen size of the camera preview, which fills its view (`resizeMode="cover"`). */
  viewSize: Size;
  /** The preview's pinch zoom: it shows the centred 1/zoom of the frame, magnified to fill the view. */
  zoom: SharedValue<number>;
  /** Whether the model input was upside down, so boxes have to be rotated back. */
  rotated180: boolean;
  /**
   * How far each detection is from the phone in metres, by index; null where it isn't known. When
   * given, each tag shows it in place of the detector's confidence.
   */
  distances?: readonly (number | null)[];
  /** Extra text per detection, by index, e.g. why the rover ignores it. */
  captions?: readonly (string | undefined)[];
};

const PALETTE = ['#FF453A', '#FF9F0A', '#FFD60A', '#30D158', '#64D2FF', '#0A84FF', '#BF5AF2', '#FF375F'];

// A box comes and goes with a short fade rather than popping, which reads as a glitch.
const APPEAR = FadeIn.duration(150);
const VANISH = FadeOut.duration(200);

export function labelColor(label: string) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** "45 cm" up close, "1.4 m" from a metre on, "– m" when unknown. */
export function formatDistance(metres: number | null | undefined) {
  if (metres == null) return '– m';
  const cm = Math.round(metres * 100);
  return cm < 100 ? `${cm} cm` : `${metres.toFixed(1)} m`;
}

function rotateBox(box: Box, size: Size): Box {
  return {
    xmin: size.width - box.xmax,
    xmax: size.width - box.xmin,
    ymin: size.height - box.ymax,
    ymax: size.height - box.ymin,
  };
}

export function DetectionOverlay({
  detections,
  inputSize,
  frameSize,
  viewSize,
  zoom,
  rotated180,
  distances,
  captions,
}: DetectionOverlayProps) {
  // Follows the pinch, so the boxes stay on what they found as the preview zooms.
  const level = useZoomLevel(zoom);

  if (frameSize.width <= 0 || frameSize.height <= 0) {
    return null;
  }

  // The resizer letterboxes the whole frame into the model input ("contain") while the
  // preview crops it to fill the view ("cover"), so both scales are relative to the frame.
  const inputScale = Math.min(inputSize.width / frameSize.width, inputSize.height / frameSize.height);
  const viewScale = Math.max(viewSize.width / frameSize.width, viewSize.height / frameSize.height) * level;
  const scale = viewScale / inputScale;
  const offsetX = (viewSize.width - inputSize.width * scale) / 2;
  const offsetY = (viewSize.height - inputSize.height * scale) / 2;

  return (
    <View style={styles.overlay}>
      {detections.map((detection, index) => {
        const box = rotated180 ? rotateBox(detection.box, inputSize) : detection.box;
        const color = labelColor(detection.label);
        const top = offsetY + box.ymin * scale;

        return (
          <Animated.View
            key={detection.id ?? index}
            entering={APPEAR}
            exiting={VANISH}
            style={[
              styles.box,
              {
                left: offsetX + box.xmin * scale,
                top,
                width: (box.xmax - box.xmin) * scale,
                height: (box.ymax - box.ymin) * scale,
                borderColor: color,
              },
            ]}>
            <View
              style={[styles.tag, top < 24 ? styles.tagInside : styles.tagAbove, { backgroundColor: color }]}>
              <ThemedText type="smallBold" style={styles.tagText} numberOfLines={1}>
                {detection.label}{' '}
                {distances ? formatDistance(distances[index]) : `${Math.round(detection.confidence * 100)}%`}
                {captions?.[index] ? ` · ${captions[index]}` : ''}
              </ThemedText>
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'none',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: Spacing.one,
  },
  tag: {
    position: 'absolute',
    left: -2,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderRadius: Spacing.one,
  },
  tagAbove: {
    bottom: '100%',
    marginBottom: Spacing.half,
  },
  tagInside: {
    top: Spacing.half,
    left: Spacing.half,
  },
  tagText: {
    color: '#ffffff',
    fontSize: 12,
    lineHeight: 18,
  },
});
