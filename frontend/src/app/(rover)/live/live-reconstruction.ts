'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { LiveSession, SessionStats } from '#live/hub.ts';

import type { LiveScene } from './live-scene';

/** How many keyframes must have seen a point for it to show; the index is the setting, the text its name. */
export const CONFIDENCE = [
  [1, 'all points'],
  [2, 'seen twice+'],
  [3, 'seen 3×+'],
] as const;

export type Connection = 'connecting' | 'open' | 'reconnecting';

declare global {
  interface Window {
    /** Set by the app (see the app's live-splat-view.tsx): whether its view of this page is fullscreen. */
    liveInteractive?: boolean;
    /** react-native-webview's channel back to the app. */
    ReactNativeWebView?: { postMessage(message: string): void };
    /** The app's floating view locks the page onto its recording by id as it starts. */
    __liveLock?: (id: string | null) => void;
  }
}

/**
 * The live reconstruction: the server's socket (`/live/socket`), the scene that draws it
 * (live-scene.ts) in `container` (the element the page renders for it), and what the page shows about it. With no session it follows
 * whichever phone started streaming most recently. `embed` is the app's floating view while it
 * records: it only takes touches while the app shows it fullscreen (the app says so by setting
 * `liveInteractive` and dispatching `liveinteractive`), otherwise it follows the phone; the app's
 * Follow button dispatches `livefollow`, and the page posts `{ type: 'following', following }` back
 * as that changes. `room` is the username the app is set to, for the embed (a browser's own room is
 * the username it signed in as; see rooms.ts).
 */
export function useLiveReconstruction(container: RefObject<HTMLDivElement | null>, initial: string | null, embed: boolean, room: string | null = null) {
  /** The session asked for; null follows the newest. The app's floating view changes it (`__liveLock`). */
  const [requested, setRequested] = useState(initial);
  const scene = useRef<LiveScene | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [agentOnline, setAgentOnline] = useState(true);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  /** Something to look at: points, or at least the first keyframe's picture and frustum. */
  const [hasPoints, setHasPoints] = useState(false);
  const [ready, setReady] = useState(false);
  const [interactive, setInteractive] = useState(!embed);
  const [follow, setFollow] = useState(true);
  const [confidence, setConfidence] = useState(0);
  const [size, setSize] = useState(1.3);

  // The app loads this page before a recording, following the newest session, then locks it onto
  // its recording by id as soon as it starts; so when the first points arrive it's long since loaded.
  useEffect(() => {
    if (!embed) return;
    window.__liveLock = (id) => setRequested(id);
    return () => {
      delete window.__liveLock;
    };
  }, [embed]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const url = new URL('/live/socket', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (requested) url.searchParams.set('session', requested);
      if (room) url.searchParams.set('room', room);
      const socket = new WebSocket(url);
      ws = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => setConnection('open');
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        const view = scene.current;
        if (!view) return;
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'session') {
            const next: LiveSession | null = message.id ? { ...message.stats, ...message } : null;
            view.reset();
            setSession(next);
            setStats(message.stats ?? null);
            setHasPoints(Boolean(message.stats?.voxels));
            setFollow(true);
            setAgentOnline(true);
          } else if (message.type === 'pose') view.applyPose(message.pose);
          else if (message.type === 'stats') setStats(message.stats);
          else if (message.type === 'agent') setAgentOnline(message.online);
          return;
        }
        const kind = new Uint32Array(event.data, 0, 1)[0];
        if (kind === 1) {
          view.applyPoints(event.data);
          if (view.pointCount > 0) setHasPoints(true);
        } else if (kind === 2) {
          // The keyframe's picture and frustum are drawn, so there's something to see before any points.
          view.applyKeyframe(event.data).then(() => setHasPoints(true), (error) => console.warn('keyframe image', error));
        }
      };
      // The server closes sockets every few minutes (and on restarts); carry on with a new one.
      socket.onclose = () => {
        if (disposed) return;
        setConnection('reconnecting');
        retry = setTimeout(connect, 1000);
      };
    }

    // three.js needs the browser, so the scene loads only there.
    import('./live-scene').then(({ LiveScene }) => {
      if (disposed || !container.current) return;
      scene.current = new LiveScene(container.current, () => setFollow(false));
      setReady(true);
      connect();
    });
    return () => {
      disposed = true;
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
    };
  }, [container, requested, room]);

  useEffect(() => {
    if (!embed) return;
    const sync = () => {
      const on = window.liveInteractive === true;
      setInteractive(on);
      // Back in the floating view, it's the phone's again.
      if (!on) setFollow(true);
    };
    const followPhone = () => setFollow(true);
    sync();
    addEventListener('liveinteractive', sync);
    addEventListener('livefollow', followPhone);
    return () => {
      removeEventListener('liveinteractive', sync);
      removeEventListener('livefollow', followPhone);
    };
  }, [embed]);
  useEffect(() => {
    scene.current?.setInteractive(interactive);
  }, [ready, interactive]);
  useEffect(() => {
    if (scene.current) scene.current.follow = follow;
    if (embed) window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'following', following: follow }));
  }, [ready, embed, follow]);
  useEffect(() => {
    scene.current?.setMinViews(CONFIDENCE[confidence][0]);
  }, [ready, confidence]);
  useEffect(() => {
    scene.current?.setPointSize((session?.voxelSize ?? 0.02) * size);
  }, [ready, session, size]);

  const cycleConfidence = useCallback(() => setConfidence((c) => (c + 1) % CONFIDENCE.length), []);

  /** The points shown, as a PLY file the browser downloads. */
  const download = useCallback(() => {
    if (!scene.current || !session) return;
    const url = URL.createObjectURL(scene.current.toPly(CONFIDENCE[confidence][0]));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${session.id}-live.ply`;
    link.click();
    URL.revokeObjectURL(url);
  }, [session, confidence]);

  return {
    connection,
    agentOnline,
    session,
    stats,
    hasPoints,
    /** The phone is streaming into this session right now. */
    phoneOn: connection === 'open' && Boolean(stats?.phoneConnected),
    follow,
    setFollow,
    confidence,
    setConfidence,
    cycleConfidence,
    size,
    setSize,
    download,
  };
}
