import { useEffect, useState } from 'react';

import SplatCapture, { type CameraStreamStatus } from '../../modules/splat-capture';

import { detectionTag, labelColor } from '@/components/detection-overlay';
import type { DetectionResult } from '@/hooks/use-detections';

/** The web app's iPhone camera panel connects here by default. */
export const CAMERA_STREAM_PORT = 8787;
const POLL_MS = 2000;

/**
 * Serves the camera preview on the Wi-Fi while `enabled` (the camera screen is open), so the web app's
 * live mode can show what the rover sees. Returns where to point it and how many are watching.
 */
export function useCameraStream(enabled: boolean): CameraStreamStatus | null {
  const [status, setStatus] = useState<CameraStreamStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      setStatus(SplatCapture.startCameraStream(CAMERA_STREAM_PORT));
      timer = setInterval(() => setStatus(SplatCapture.cameraStreamStatus()), POLL_MS);
    } catch (error) {
      // An older native build without the stream: nothing to show.
      setStatus({ state: 'failed', viewers: 0, error: error instanceof Error ? error.message : String(error) });
    }
    return () => {
      if (timer) clearInterval(timer);
      try {
        SplatCapture.stopCameraStream();
      } catch {
        // Never started.
      }
      setStatus(null);
    };
  }, [enabled]);

  return status;
}

/** One box for the web app's live view: corners as fractions of the upright frame, and its tag. */
export type StreamedBox = { id: number; x0: number; y0: number; x1: number; y1: number; color: string; text: string; coasting: boolean };

/**
 * Sends the leaf detector's boxes to the Wi-Fi camera's viewers each time it finishes a frame, tagged
 * as the camera screen tags them, so the web app's live view shows what the rover sees. The boxes are
 * in the whole upright frame (even pinch-zoomed), which is the picture the stream sends. An empty list
 * clears them when detection stops.
 */
export function usePublishDetections(
  stream: CameraStreamStatus | null,
  result: DetectionResult | undefined,
  captions: readonly (string | undefined)[] | undefined,
) {
  const ready = stream?.state === 'ready';
  useEffect(() => {
    if (!ready) return;
    const width = result?.frameSize.width ?? 0;
    const height = result?.frameSize.height ?? 0;
    const boxes: StreamedBox[] =
      result && width > 0 && height > 0
        ? result.detections.map((d, i) => ({
            id: d.id,
            x0: d.box.xmin / width,
            y0: d.box.ymin / height,
            x1: d.box.xmax / width,
            y1: d.box.ymax / height,
            color: labelColor(d.label),
            text: detectionTag(d.label, d.confidence, result.distances?.[i], result.distances != null, captions?.[i]),
            coasting: d.coasting,
          }))
        : [];
    try {
      SplatCapture.publishCameraDetections(JSON.stringify({ t: Date.now(), width, height, boxes }));
    } catch {
      // An older native build without it: the web app just shows no boxes.
    }
  }, [ready, result, captions]);
}
