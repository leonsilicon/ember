import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Spacing } from '@/constants/theme';
import type { MountCamera } from '@/hooks/use-mount-camera';

/**
 * Plays the camera server's MJPEG whole (`contain`), retries a second after losing it, and says
 * when it's playing and how big the frames are, which only an `<img>` that has decoded one knows.
 */
function page(origin: string) {
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style>
<img id="camera" alt="">
<script>
  const img = document.getElementById('camera');
  const post = (message) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const play = () => { img.src = ${JSON.stringify(origin)} + '/camera.mjpg?t=' + Date.now(); };
  let size = '';
  img.onerror = () => { size = ''; post({ type: 'lost' }); setTimeout(play, 1000); };
  setInterval(() => {
    const next = img.naturalWidth + 'x' + img.naturalHeight;
    if (img.naturalWidth > 0 && next !== size) {
      size = next;
      post({ type: 'playing', width: img.naturalWidth, height: img.naturalHeight });
    }
  }, 250);
  play();
</script>`;
}

type Playback = { origin: string; state: 'playing' | 'lost'; aspect?: number };

/**
 * In remote mode, what the phone on the rover sees: the MJPEG stream from its camera server
 * (CameraStreamServer), uncropped, in a web view, since `<img>` plays MJPEG as it arrives. Says so
 * while it's looking for that phone, connecting, or has lost it. `onAspect` gets the frames' shape
 * (width / height), so the viewfinder can take it. Fills its parent.
 */
export function MountCameraView({
  camera,
  onAspect,
}: {
  camera: MountCamera;
  onAspect?: (aspect: number) => void;
}) {
  const [playback, setPlayback] = useState<Playback>();
  const peer = camera.state === 'found' ? camera.peer : undefined;
  const current = peer && playback?.origin === peer.origin ? playback.state : undefined;

  function onMessage(event: WebViewMessageEvent) {
    if (!peer) return;
    const message = JSON.parse(event.nativeEvent.data) as { type: string; width?: number; height?: number };
    if (message.type === 'playing' && message.width && message.height) {
      setPlayback({ origin: peer.origin, state: 'playing' });
      onAspect?.(message.width / message.height);
    } else if (message.type === 'lost') {
      setPlayback({ origin: peer.origin, state: 'lost' });
    }
  }

  const status =
    camera.state === 'unsupported'
      ? { title: "Can't look for the rover's phone", detail: 'This build of the app is too old. Rebuild it.' }
      : camera.state === 'searching'
        ? {
            title: "Looking for the rover's phone…",
            detail: 'It needs the app open in mount mode, on the same Wi-Fi as this phone.',
            busy: true,
          }
        : current === 'playing'
          ? undefined
          : current === 'lost'
            ? { title: `Lost ${camera.peer.device}`, detail: 'Trying again…', busy: true }
            : { title: `Connecting to ${camera.peer.device}…`, busy: true };

  return (
    <View style={styles.container}>
      {peer && (
        <WebView
          // A fresh page for each phone.
          key={peer.origin}
          source={{ html: page(peer.origin), baseUrl: peer.origin }}
          originWhitelist={['*']}
          onMessage={onMessage}
          scrollEnabled={false}
          bounces={false}
          style={styles.web}
        />
      )}
      {status && (
        <View style={styles.status}>
          {status.busy && <ActivityIndicator color="#fff" />}
          <Text style={styles.title}>{status.title}</Text>
          {status.detail && <Text style={styles.detail}>{status.detail}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000',
    // Nothing to touch: what's shown is the other phone's.
    pointerEvents: 'none',
  },
  web: {
    backgroundColor: 'transparent',
  },
  status: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    textAlign: 'center',
  },
  detail: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    textAlign: 'center',
  },
});
