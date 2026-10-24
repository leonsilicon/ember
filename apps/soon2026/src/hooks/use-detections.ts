import { useEffect, useState } from 'react';
import {
  models,
  useObjectDetector,
  type CocoClassYolo,
  type ObjectDetection,
} from 'react-native-executorch';

import SplatCapture from '../../modules/splat-capture';

import type { Size } from '@/components/detection-overlay';

// YOLO26 Small at 512px is noticeably more accurate than Nano and still runs in real time.
// `DEFAULT` resolves to the Core ML export on iOS (Neural Engine) and XNNPACK on Android.
const MODEL = models.objectDetection.YOLO26.SMALL.SIZE_512.DEFAULT;
const MODEL_NAME = 'YOLO26s · 512';
// Frames come scaled to the model's input size, so letterboxing them needs no further resize.
const FRAME_SIZE = 512;
const CONFIDENCE_THRESHOLD = 0.4;
const RETRY_MS = 1000;

export type Detection = ObjectDetection<'xyxy', CocoClassYolo>;

export type DetectionResult = {
  detections: Detection[];
  /** The upright camera frame the boxes are in, scaled down from the camera's full size. */
  frameSize: Size;
  /** Inference time, smoothed over recent frames. */
  latencyMs: number;
};

export type Detections = {
  /** The model, and how fast it runs once it does. */
  model: string;
  /** Why detection isn't running: the model is still downloading or loading, or failed to load. */
  status?: string;
  result?: DetectionResult;
  error?: string;
};

/**
 * Runs YOLO on the capture camera's frames while `enabled`. The AR session owns the camera,
 * so frames come from it (see `nextDetectionFrame`) rather than from a second camera session.
 */
export function useDetections(enabled: boolean): Detections {
  const detector = useObjectDetector(MODEL);
  const { detectObjects } = detector;
  const [result, setResult] = useState<DetectionResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || detectObjects == null) return;
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        try {
          // Resolves once the camera delivers a frame, so this waits while the preview is paused.
          const frame = await SplatCapture.nextDetectionFrame(FRAME_SIZE);
          if (cancelled || frame == null) continue;
          const start = Date.now();
          const detections = await detectObjects(
            { data: frame.data, width: frame.width, height: frame.height, format: 'rgba', layout: 'hwc' },
            { confidenceThreshold: CONFIDENCE_THRESHOLD },
          );
          if (cancelled) break;
          const latencyMs = Date.now() - start;
          setResult((previous) => ({
            detections,
            frameSize: { width: frame.width, height: frame.height },
            latencyMs: previous ? previous.latencyMs * 0.9 + latencyMs * 0.1 : latencyMs,
          }));
          setError(undefined);
        } catch (e) {
          if (cancelled) break;
          setError(e instanceof Error ? e.message : String(e));
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, detectObjects]);

  let status: string | undefined;
  if (detector.error) {
    status = `Couldn't load ${MODEL_NAME}: ${detector.error.message}`;
  } else if (!detector.isReady) {
    status =
      detector.downloadProgress < 100
        ? `Downloading ${MODEL_NAME}… ${Math.round(detector.downloadProgress)}%`
        : `Loading ${MODEL_NAME}…`;
  }

  const running = enabled && !status;
  return {
    // Rounded so the menu showing it isn't rebuilt on every frame.
    model: running && result ? `${MODEL_NAME} · ~${Math.round(result.latencyMs / 10) * 10} ms` : MODEL_NAME,
    status,
    result: running ? result : undefined,
    error: running ? error : undefined,
  };
}
