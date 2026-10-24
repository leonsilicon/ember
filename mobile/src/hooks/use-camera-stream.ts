import { useEffect, useState } from 'react';

import SplatCapture, { type CameraStreamStatus } from '../../modules/splat-capture';

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
