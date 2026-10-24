'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { LiveSession, SessionStats } from '#live/hub.ts';

import type { LiveScene } from './live-scene';
import styles from './live-viewer.module.css';

const CONFIDENCE = [
  [1, 'all points'],
  [2, 'seen twice+'],
  [3, 'seen 3×+'],
] as const;

type Connection = 'connecting' | 'open' | 'reconnecting';

function describeStats(s: SessionStats) {
  const fit = s.fitError != null ? ` · depth fit ±${(s.fitError * 100).toFixed(1)}%` : '';
  const ms = s.fuseMs != null ? ` · ${s.fuseMs} ms/keyframe` : '';
  const skipped = s.skipped ? `, ${s.skipped.toLocaleString()} skipped` : '';
  return `${s.voxels.toLocaleString()} points · ${s.fused.toLocaleString()} keyframes fused${skipped}${fit}${ms}`;
}

/**
 * The live reconstruction in the browser (see live-scene.ts), fed by the server's socket. With no
 * session it follows whichever phone started streaming most recently. `embed` (the app's floating
 * view while it records) drops the page's controls and text.
 */
export function LiveViewer({ session: requested, embed }: { session: string | null; embed: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<LiveScene | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [agentOnline, setAgentOnline] = useState(true);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [hasPoints, setHasPoints] = useState(false);
  const [follow, setFollow] = useState(true);
  const [confidence, setConfidence] = useState(0);
  const [size, setSize] = useState(1.3);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Embedded there's no Follow button, so following resumes a few seconds after a drag ends.
    let resumeFollow: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const url = new URL('/live/socket', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (requested) url.searchParams.set('session', requested);
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
          view.applyKeyframe(event.data).catch((error) => console.warn('keyframe image', error));
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
      scene.current = new LiveScene(container.current, {
        start: () => {
          clearTimeout(resumeFollow);
          setFollow(false);
        },
        end: () => {
          if (embed) resumeFollow = setTimeout(() => setFollow(true), 3000);
        },
      });
      connect();
    });
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(resumeFollow);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      scene.current?.dispose();
      scene.current = null;
    };
  }, [requested, embed]);

  useEffect(() => {
    if (scene.current) scene.current.follow = follow;
  }, [follow]);
  useEffect(() => {
    scene.current?.setMinViews(CONFIDENCE[confidence][0]);
  }, [confidence]);
  useEffect(() => {
    scene.current?.setPointSize((session?.voxelSize ?? 0.02) * size);
  }, [session, size]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'f') setFollow((on) => !on);
      if (event.key === 'c') setConfidence((c) => (c + 1) % CONFIDENCE.length);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  function download() {
    if (!scene.current || !session) return;
    const url = URL.createObjectURL(scene.current.toPly(CONFIDENCE[confidence][0]));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${session.id}-live.ply`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const label =
    connection === 'connecting'
      ? 'connecting…'
      : connection === 'reconnecting'
        ? 'reconnecting to the server…'
        : !agentOnline
          ? 'the Mac agent is offline'
          : session
            ? `${session.id}${session.device ? ` · ${session.device}` : ''}${session.mode === 'lidar' ? ' · LiDAR' : ' · no LiDAR'}`
            : 'no session yet';
  const phoneOn = connection === 'open' && Boolean(stats?.phoneConnected);

  return (
    <div ref={container} className={styles.root}>
      {!embed && (
        <div className={styles.top}>
          <h1>Live reconstruction</h1>
          <span>
            <span className={`${styles.dot} ${phoneOn ? styles.on : ''}`} />
            {label}
          </span>
          <span className={styles.stats}>{stats && describeStats(stats)}</span>
          <span className={styles.skip}>{stats?.lastSkip ? `Last skip: ${stats.lastSkip}` : ''}</span>
          <Link href="/">Splat captures</Link>
        </div>
      )}
      {!hasPoints && (
        <div className={`${styles.empty} ${embed ? styles.compact : ''}`}>
          <div>
            {!agentOnline ? (
              <>
                <strong>The Mac agent is offline</strong>
                {!embed && 'Live 3D starts once it reconnects (bun run agent in server/).'}
              </>
            ) : embed ? (
              <>
                <strong>Live 3D</strong>Waiting for the first keyframe…
              </>
            ) : (
              <>
                <strong>Waiting for the phone</strong>In the app, turn on Live 3D, then start recording.
                <br />
                Points appear here as you move the phone around.
              </>
            )}
          </div>
        </div>
      )}
      {!embed && (
        <div className={styles.bottom}>
          <button className={styles.button} aria-pressed={follow} title="F" onClick={() => setFollow(!follow)}>
            Follow phone
          </button>
          <button className={styles.button} title="C" onClick={() => setConfidence((confidence + 1) % CONFIDENCE.length)}>
            Show: {CONFIDENCE[confidence][1]}
          </button>
          <label className={styles.control}>
            Size{' '}
            <input type="range" min="0.4" max="3" step="0.1" value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <button className={styles.button} disabled={!session || !hasPoints} onClick={download}>
            Download PLY
          </button>
        </div>
      )}
    </div>
  );
}
