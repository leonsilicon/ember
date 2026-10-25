import { setTimeout as sleep } from 'node:timers/promises';

import type { Role } from '../bus';
import { inRoom } from '../rooms';
import type { DepthEstimator } from './depth-worker';
import { anchorsInView, depthFromDisparity, fitDisparity, scaleIntrinsics } from './geometry';
import {
  encodeKeyframe,
  encodePoints,
  parseIngest,
  ProtocolError,
  type CaptureMode,
  type HelloHeader,
  type KeyframeHeader,
} from './protocol';
import { DEFAULT_INTEGRATE, VoxelCloud } from './voxels';

export type LiveConfig = {
  voxelSize: number;
  /** Depth past this many metres isn't fused: monocular depth gets too coarse further out. */
  maxDepth: number;
  /** The depth model's output is resampled to this grid, which is also what gets unprojected. */
  gridWidth: number;
  gridHeight: number;
};

export type PeerData =
  | { role: 'phone'; session: string | null }
  /**
   * `wanted`: the session a viewer asked for, which it gets once the phone starts it if it hasn't yet.
   * `room`: the username it signed in as; following the newest session means the newest in its room
   * (null: of any room). See rooms.ts.
   */
  | { role: 'viewer'; session: string | null; wanted: string | null; follow: boolean; room: string | null };

/** A phone or browser connected to the hub, by the id of its socket (see bus.ts). */
export type Peer = { id: string; data: PeerData };

/** How the hub reaches its peers: through the app's socket relays (Redis), or directly in tests. */
export interface LiveTransport {
  /** Sends one message to several peers. */
  send(peers: Peer[], message: string | Uint8Array): void;
  close(peer: Peer, code: number, reason: string): void;
}

export type SessionStats = {
  phoneConnected: boolean;
  /** Keyframes the phone sent, fused into the cloud, and skipped (with the latest reason). */
  received: number;
  fused: number;
  skipped: number;
  lastSkip: string | null;
  voxels: number;
  /** Median depth error of the latest fit against ARKit's points (no-LiDAR only). */
  fitError: number | null;
  /** Server time to fuse the latest keyframe. */
  fuseMs: number | null;
};

/** A session as /api/live lists it. */
export type LiveSession = SessionStats & {
  id: string;
  mode: CaptureMode;
  device: string | null;
  /** The username the phone sends to (its hello's `room`); null from a phone with none set. */
  room: string | null;
  startedAt: string;
  voxelSize: number;
};

type Keyframe = { header: KeyframeHeader; payload: Uint8Array };

type Session = {
  id: string;
  mode: CaptureMode;
  device: string | null;
  room: string | null;
  startedAt: string;
  cloud: VoxelCloud;
  phone: Peer | null;
  /** The newest keyframe waiting to be fused; when the server falls behind, older ones are dropped. */
  pending: Keyframe | null;
  fusing: boolean;
  stats: SessionStats;
  lastPose: number[] | null;
  /** The latest fused keyframe's image message, so a viewer that joins late can draw the frustum. */
  lastKeyframe: Uint8Array | null;
};

/** Sessions kept in memory (a viewer can still open a finished one). Older ones are dropped. */
const KEEP_SESSIONS = 4;
/** Points per viewer message (20 bytes each), so no message passes 1 MB on its way through Redis. */
const POINTS_PER_MESSAGE = 50_000;

/**
 * The live reconstruction: phones stream keyframes in, each is turned into metric depth (LiDAR,
 * or the depth model scaled to ARKit's feature points), fused into a voxel cloud, and every
 * browser watching that session gets the voxels that changed.
 */
export class LiveHub {
  /** In the order they started; a phone's hello for a known id moves it to the end, as the newest. */
  private sessions = new Map<string, Session>();
  private peers = new Map<string, Peer>();
  private viewers = new Set<Peer>();
  private estimator: Promise<DepthEstimator> | null = null;

  constructor(
    private config: LiveConfig,
    private transport: LiveTransport,
    private startEstimator: () => Promise<DepthEstimator>,
  ) {}

  /**
   * A phone or viewer connected. A viewer asks for one session, or follows the newest without one:
   * the newest in its `room` (the username it signed in as), or of any room when it has none.
   */
  open(id: string, role: Role, wanted: string | null = null, room: string | null = null) {
    this.close(id);
    console.log(`${role} ${id.slice(0, 8)} connected${wanted ? ` for ${wanted}` : ''}${room ? ` in ${room}` : ''}`);
    const peer: Peer = {
      id,
      data: role === 'phone' ? { role, session: null } : { role, session: wanted, wanted, follow: !wanted, room },
    };
    this.peers.set(id, peer);
    if (peer.data.role === 'viewer') {
      this.viewers.add(peer);
      this.sendSession(peer, peer.data.follow ? this.latestIn(room) : (this.sessions.get(wanted ?? '') ?? null));
    }
  }

  /** The session that started (or picked back up) most recently in `room`; of any room for null. */
  private latestIn(room: string | null): Session | null {
    let latest: Session | null = null;
    for (const session of this.sessions.values()) if (inRoom(room, session.room)) latest = session;
    return latest;
  }

  /** A message from a phone. Anything malformed is reported back to it. */
  message(id: string, message: Uint8Array) {
    const peer = this.peers.get(id);
    if (!peer) {
      // Its `open` never arrived (or the agent started after it): the phone is told, so it reconnects.
      console.warn(`message from unknown peer ${id.slice(0, 8)}; asking it to reconnect`);
      this.transport.close({ id, data: { role: 'phone', session: null } }, 4001, 'unknown connection; reconnect');
      return;
    }
    if (peer.data.role !== 'phone') return;
    try {
      this.onPhoneMessage(peer, message);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.send(peer, JSON.stringify({ type: 'error', message: error.message }));
    }
  }

  /** Sends a viewer that missed messages (it fell behind) everything again. */
  resync(id: string) {
    const peer = this.peers.get(id);
    if (peer?.data.role === 'viewer') this.sendSession(peer, this.sessions.get(peer.data.session ?? '') ?? null);
  }

  /** A phone or viewer disconnected. */
  close(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.viewers.delete(peer);
    if (peer.data.role !== 'phone') return;
    console.log(`phone ${id.slice(0, 8)} disconnected`);
    const session = this.sessions.get(peer.data.session ?? '');
    if (session?.phone === peer) {
      session.phone = null;
      session.stats.phoneConnected = false;
      this.broadcastStats(session);
    }
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].reverse().map((s) => ({
      id: s.id,
      mode: s.mode,
      device: s.device,
      room: s.room,
      startedAt: s.startedAt,
      voxelSize: s.cloud.voxelSize,
      ...s.stats,
    }));
  }

  cloud(id: string) {
    return this.sessions.get(id)?.cloud ?? null;
  }

  /** Stops the depth worker. */
  stop() {
    this.estimator?.then((e) => e.close()).catch(() => {});
  }

  /** Resolves once every queued keyframe has been fused (used by tests). */
  async idle() {
    while ([...this.sessions.values()].some((s) => s.fusing || s.pending)) await sleep(5);
  }

  private onPhoneMessage(peer: Peer, message: Uint8Array) {
    const { header, payload } = parseIngest(message);
    if (header.type === 'hello') return this.hello(peer, header);
    const session = this.sessions.get(peer.data.session ?? '');
    if (!session || session.phone !== peer) throw new ProtocolError('send hello first');
    if (header.type === 'pose') {
      session.lastPose = header.pose;
      this.broadcast(session, JSON.stringify({ type: 'pose', t: header.t, pose: header.pose }));
      return;
    }
    session.stats.received++;
    if (session.pending) this.skip(session, 'server busy, dropped an older keyframe');
    session.pending = { header, payload };
    this.fuseQueued(session);
  }

  private hello(peer: Peer, hello: HelloHeader) {
    // The same id again is the phone reconnecting mid-recording: carry on with its cloud.
    let session = this.sessions.get(hello.session);
    if (!session) {
      session = {
        id: hello.session,
        mode: hello.mode,
        device: hello.device ?? null,
        room: hello.room ?? null,
        startedAt: new Date().toISOString(),
        cloud: new VoxelCloud(this.config.voxelSize),
        phone: null,
        pending: null,
        fusing: false,
        stats: {
          phoneConnected: true, received: 0, fused: 0, skipped: 0, lastSkip: null, voxels: 0, fitError: null, fuseMs: null,
        },
        lastPose: null,
        lastKeyframe: null,
      };
      for (const old of [...this.sessions.keys()].slice(0, 1 - KEEP_SESSIONS)) this.sessions.delete(old);
      console.log(`Live session ${session.id} (${session.mode}${session.device ? `, ${session.device}` : ''}${session.room ? `, ${session.room}` : ''})`);
    }
    // Newest last (a Map keeps insertion order), so followers of its room find it.
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
    if (session.phone && session.phone !== peer) this.transport.close(session.phone, 4000, 'replaced by a newer connection');
    session.phone = peer;
    session.stats.phoneConnected = true;
    peer.data.session = session.id;
    for (const viewer of this.viewers) {
      if (viewer.data.role !== 'viewer' || viewer.data.session === session.id) continue;
      if ((viewer.data.follow && inRoom(viewer.data.room, session.room)) || viewer.data.wanted === session.id) this.sendSession(viewer, session);
    }
    this.broadcastStats(session);
  }

  private skip(session: Session, reason: string) {
    session.stats.skipped++;
    session.stats.lastSkip = reason;
  }

  private async fuseQueued(session: Session) {
    if (session.fusing) return;
    session.fusing = true;
    try {
      while (session.pending) {
        const keyframe = session.pending;
        session.pending = null;
        const started = performance.now();
        try {
          await this.fuse(session, keyframe);
          session.stats.fuseMs = Math.round(performance.now() - started);
        } catch (error) {
          this.skip(session, error instanceof Error ? error.message : String(error));
        }
        this.broadcastStats(session);
      }
    } finally {
      session.fusing = false;
    }
  }

  /** Starts the depth worker now, so the first keyframe doesn't wait for its model to load. */
  warm() {
    this.depthEstimator().catch(() => {});
  }

  private depthEstimator() {
    this.estimator ??= this.startEstimator();
    return this.estimator.catch((error) => {
      // Try again on the next keyframe (e.g. once the worker is installed).
      this.estimator = null;
      throw error;
    });
  }

  private async fuse(session: Session, { header, payload }: Keyframe) {
    const jpeg = payload.subarray(0, header.jpegBytes);
    const lidar = header.depth;
    const width = lidar?.width ?? this.config.gridWidth;
    const height = lidar?.height ?? this.config.gridHeight;
    const estimator = await this.depthEstimator();
    let result;
    try {
      result = await estimator.estimate(jpeg, width, height, !lidar);
    } catch (error) {
      if (!estimator.alive) this.estimator = null;
      throw error;
    }
    const k = scaleIntrinsics(header.intrinsics, width, height);

    let depth: Float32Array;
    if (lidar) {
      const pixels = width * height;
      const start = header.jpegBytes;
      depth = new Float32Array(payload.slice(start, start + pixels * 4).buffer);
      if (lidar.confidence) {
        const confidence = payload.subarray(start + pixels * 4, start + pixels * 5);
        for (let i = 0; i < pixels; i++) if (confidence[i] < 1) depth[i] = NaN;
      }
    } else {
      // ARKit's feature points pin down the scale; what's already reconstructed keeps this frame
      // consistent with earlier ones, so overlapping views don't leave doubled surfaces. The
      // coarse 16-cell grid keeps the cloud from outnumbering ARKit's points by much.
      const arkit = anchorsInView(header.anchors ?? [], header.pose, k);
      const cloud = session.cloud.anchorsInView(header.pose, k, { minViews: 2, maxDepth: this.config.maxDepth, cells: 16 });
      const fit = result.disparity && fitDisparity(result.disparity, width, height, [...arkit, ...cloud]);
      if (!fit) {
        this.skip(
          session,
          arkit.length + cloud.length < 8
            ? `only ${arkit.length} feature points in view; aim at something with more texture`
            : 'the feature points and the depth model disagree',
        );
        return;
      }
      session.stats.fitError = fit.medianError;
      depth = depthFromDisparity(result.disparity!, fit, this.config.maxDepth);
    }

    const touched = session.cloud.integrate(depth, result.rgb, width, height, k, header.pose, {
      ...DEFAULT_INTEGRATE,
      maxDepth: this.config.maxDepth,
    });
    session.stats.fused++;
    session.stats.voxels = session.cloud.count;
    session.lastKeyframe = encodeKeyframe({ seq: header.seq, pose: header.pose, intrinsics: header.intrinsics }, jpeg);
    for (let i = 0; i < touched.length; i += POINTS_PER_MESSAGE) {
      this.broadcast(session, encodePoints(session.cloud, touched.slice(i, i + POINTS_PER_MESSAGE)));
    }
    this.broadcast(session, session.lastKeyframe);
  }

  /** Points a viewer at a session (or at none yet) and sends everything it has so far. */
  private sendSession(peer: Peer, session: Session | null) {
    if (peer.data.role !== 'viewer') return;
    peer.data.session = session?.id ?? null;
    this.send(
      peer,
      JSON.stringify(
        session
          ? { type: 'session', id: session.id, mode: session.mode, device: session.device, room: session.room, startedAt: session.startedAt, voxelSize: session.cloud.voxelSize, stats: session.stats }
          : { type: 'session', id: null },
      ),
    );
    if (!session) return;
    const { cloud } = session;
    for (let start = 0; start < cloud.count; start += POINTS_PER_MESSAGE) {
      const end = Math.min(start + POINTS_PER_MESSAGE, cloud.count);
      this.send(peer, encodePoints(cloud, Array.from({ length: end - start }, (_, i) => start + i)));
    }
    if (session.lastKeyframe) this.send(peer, session.lastKeyframe);
    if (session.lastPose) this.send(peer, JSON.stringify({ type: 'pose', pose: session.lastPose }));
  }

  private send(peer: Peer, message: string | Uint8Array) {
    this.transport.send([peer], message);
  }

  private broadcast(session: Session, message: string | Uint8Array) {
    const watching = [...this.viewers].filter((viewer) => viewer.data.session === session.id);
    if (watching.length) this.transport.send(watching, message);
  }

  private broadcastStats(session: Session) {
    const message = JSON.stringify({ type: 'stats', stats: session.stats });
    const to = [...this.viewers].filter((viewer) => viewer.data.session === session.id);
    if (session.phone) to.push(session.phone);
    if (to.length) this.transport.send(to, message);
  }
}
