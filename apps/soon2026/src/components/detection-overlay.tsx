import { StyleSheet, View } from 'react-native';
import type { ObjectDetection } from 'react-native-executorch';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';

export type Size = {
  width: number;
  height: number;
};

type Box = ObjectDetection<'xyxy', string>['box'];

type DetectionOverlayProps = {
  detections: readonly ObjectDetection<'xyxy', string>[];
  /** Size of the model input the boxes are expressed in. */
  inputSize: Size;
  /** Upright size of the camera frame that was letterboxed into the model input. */
  frameSize: Size;
  /** On-screen size of the camera preview, which fills its view (`resizeMode="cover"`). */
  viewSize: Size;
  /** Whether the model input was upside down, so boxes have to be rotated back. */
  rotated180: boolean;
  /** Extra text per detection, by index, e.g. how far away it is. */
  captions?: readonly (string | undefined)[];
};

const PALETTE = ['#FF453A', '#FF9F0A', '#FFD60A', '#30D158', '#64D2FF', '#0A84FF', '#BF5AF2', '#FF375F'];

export function labelColor(label: string) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function rotateBox(box: Box, size: Size): Box {
  return {
    ...box,
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
  rotated180,
  captions,
}: DetectionOverlayProps) {
  if (frameSize.width <= 0 || frameSize.height <= 0) {
    return null;
  }

  // The resizer letterboxes the whole frame into the model input ("contain") while the
  // preview crops it to fill the view ("cover"), so both scales are relative to the frame.
  const inputScale = Math.min(inputSize.width / frameSize.width, inputSize.height / frameSize.height);
  const viewScale = Math.max(viewSize.width / frameSize.width, viewSize.height / frameSize.height);
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
          <View
            key={index}
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
                {detection.label} {Math.round(detection.confidence * 100)}%
                {captions?.[index] ? ` · ${captions[index]}` : ''}
              </ThemedText>
            </View>
          </View>
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
