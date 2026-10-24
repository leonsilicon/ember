import { useEffect, useState } from 'react';

import SplatCapture, { type CameraStreamPeer } from '../../modules/splat-capture';

export type MountCamera =
  /** This build can't look (a native build from before the browser). */
  | { state: 'unsupported' }
  | { state: 'searching' }
  | { state: 'found'; peer: CameraStreamPeer; recording: boolean };

/** How often each found camera is asked whether its phone is recording. */
const POLL_MS = 2000;

/**
 * In remote mode: finds the phone in mount mode, the one on the rover, by the camera server it runs
 * on the Wi-Fi (CameraStreamServer), so this phone can show what the rover sees. For now there's
 * only ever one recording; it's the one that's recording if any is, else one running this app (its
 * server says who it is), else whatever else answers to `_rovercam._tcp` (the web app's mock).
 */
export function useMountCamera(enabled: boolean): MountCamera | null {
  const [streams, setStreams] = useState<CameraStreamPeer[]>([]);
  /** Whether each one's phone is recording, by origin, from its `/status`. */
  const [recording, setRecording] = useState<Record<string, boolean>>({});
  const supported = typeof SplatCapture.startCameraBrowse === 'function';

  useEffect(() => {
    if (!enabled || !supported) return;
    const subscription = SplatCapture.addListener('onCameraStreams', (event) => setStreams(event.streams));
    SplatCapture.startCameraBrowse();
    return () => {
      subscription.remove();
      SplatCapture.stopCameraBrowse();
      setStreams([]);
    };
  }, [enabled, supported]);

  // Restarted only when the cameras change, not each time the list is sent again.
  const origins = streams.map((stream) => stream.origin).join(' ');
  useEffect(() => {
    if (!enabled || origins === '') return;
    let alive = true;
    const poll = () => {
      for (const origin of origins.split(' ')) {
        fetch(`${origin}/status`)
          .then((response) => response.json())
          .then((status: { recording?: boolean }) => {
            if (alive) setRecording((current) => ({ ...current, [origin]: status.recording === true }));
          })
          .catch(() => {});
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, origins]);

  if (!enabled) return null;
  if (!supported) return { state: 'unsupported' };
  const rank = (peer: CameraStreamPeer) => (recording[peer.origin] ? 0 : peer.id ? 1 : 2);
  const peer = [...streams].sort((a, b) => rank(a) - rank(b))[0];
  return peer ? { state: 'found', peer, recording: recording[peer.origin] === true } : { state: 'searching' };
}
