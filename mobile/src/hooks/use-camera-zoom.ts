import { useState } from 'react';
import { usePinchGesture } from 'react-native-gesture-handler';
import {
  clamp,
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * As far as the Camera app zooms a single wide camera. The zoom is digital, so past the point
 * where the crop has fewer pixels than the detector's input it adds no detail, but what's zoomed
 * in on still fills more of the input, which is what OWL-ViT needs to find a small leaf.
 */
const MAX_ZOOM = 5;

/**
 * Pinch-to-zoom for the camera preview, from 1× to `MAX_ZOOM`×, like the Camera app's digital
 * zoom. The pinch runs on the UI thread, and `style` scales the preview there, about its centre and
 * inside a view that clips it, so it shows the centred 1/zoom of the camera's view. Detection reads
 * `zoom` for every frame and crops to the same part (see useDetections).
 */
export function useCameraZoom(enabled: boolean) {
  const zoom = useSharedValue(1);
  const pinch = usePinchGesture({
    enabled,
    onUpdate: (event) => {
      zoom.set(clamp(zoom.get() * event.scaleChange, 1, MAX_ZOOM));
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: zoom.get() }] }));
  return { zoom, pinch, style };
}

/** Eases the zoom to `level`, like tapping the Camera app's zoom buttons. */
export function zoomTo(zoom: SharedValue<number>, level: number) {
  zoom.set(withTiming(level, { duration: 250, easing: Easing.out(Easing.cubic) }));
}

/**
 * `zoom` as React state, for what's drawn from it rather than animated; it follows the pinch a
 * frame behind. `step` rounds it, so a label only re-renders when its text changes.
 */
export function useZoomLevel(zoom: SharedValue<number>, step = 0) {
  const [level, setLevel] = useState(1);
  useAnimatedReaction(
    () => (step > 0 ? Math.round(zoom.get() / step) * step : zoom.get()),
    (current, previous) => {
      if (current !== previous) scheduleOnRN(setLevel, current);
    },
  );
  return level;
}
