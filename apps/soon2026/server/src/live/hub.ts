import type { Server, ServerWebSocket } from 'bun';

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

export type SocketData =
  | { role: 'phone'; session: string | null }
  | { role: 'viewer'; session: string | null; follow: boolean; resync: boolean };

type Socket = ServerWebSocket<SocketData>;

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

type Keyframe = { header: KeyframeHeader; payload: Uint8Array };

type Session = {
  id: string;
  mode: CaptureMode;
  device: string | null;
  startedAt: string;
  cloud: VoxelCloud;
  phone: Socket | null;
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
/** Points per viewer message, so one snapshot of a big cloud doesn't become one huge message. */
const POINTS_PER_MESSAGE = 200_000;

/**
 * The live reconstruction: phones stream keyframes in, each is turned into metric depth (LiDAR,
 * or the depth model scaled to ARKit's feature points), fused into a voxel cloud, and every
 * browser watching that session gets the voxels that changed.
 */
export class LiveHub {
  private sessions = new Map<string, Session>();
  private latest: Session | null = null;
  private viewers = new Set<Socket>();
  private estimator: Promise<DepthEstimator> | null = null;

  constructor(
    private config: LiveConfig,
    private startEstimator: () => Promise<DepthEstimator>,
  ) {}

  /** Upgrades `/live/ingest` (phones) and `/live/socket` (viewers); false for anything else. */
  upgrade(request: Request, server: Server<SocketData>) {
    const url = new URL(request.url);
    if (url.pathname === '/live/ingest') {
      return server.upgrade(request, { data: { role: 'phone', session: null } });
    }
    if (url.pathname === '/live/socket') {
      const session = url.searchParams.get('session');
      return server.upgrade(request, {
        data: { role: 'viewer', session, follow: !session, resync: false },
      });
    }
    return false;
  }

  readonly websocket = {
    // Keyframes are ~100 KB; LiDAR adds ~250 KB of depth.
    maxPayloadLength: 8 * 1024 ** 2,
    backpressureLimit: 64 * 1024 ** 2,
    open: (ws: Socket) => {
      if (ws.data.role === 'viewer') {
        this.viewers.add(ws);
        this.sendSession(ws, ws.data.follow ? this.latest : (this.sessions.get(ws.data.session ?? '') ?? null));
      }
    },
    message: (ws: Socket, message: string | Uint8Array) => {
      if (ws.data.role !== 'phone' || typeof message === 'string') return;
      try {
        this.onPhoneMessage(ws, message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    },
    drain: (ws: Socket) => {
      // A viewer that missed point updates under backpressure gets the whole cloud again.
      if (ws.data.role === 'viewer' && ws.data.resync) {
        ws.data.resync = false;
        this.sendSession(ws, this.sessions.get(ws.data.session ?? '') ?? null);
      }
    },
    close: (ws: Socket) => {
      this.viewers.delete(ws);
      if (ws.data.role !== 'phone') return;
      const session = this.sessions.get(ws.data.session ?? '');
      if (session?.phone === ws) {
        session.phone = null;
        session.stats.phoneConnected = false;
        this.broadcastStats(session);
      }
    },
  };

  list() {
    return [...this.sessions.values()].reverse().map((s) => ({
      id: s.id,
      mode: s.mode,
      device: s.device,
      startedAt: s.startedAt,
      voxelSize: s.cloud.voxelSize,
      ...s.stats,
    }));
  }

  cloud(id: string) {
    return this.sessions.get(id)?.cloud ?? null;
  }

  close() {
    this.estimator?.then((e) => e.close()).catch(() => {});
  }

  /** Resolves once every queued keyframe has been fused (used by tests). */
  async idle() {
    while ([...this.sessions.values()].some((s) => s.fusing || s.pending)) await Bun.sleep(5);
  }

  private onPhoneMessage(ws: Socket, message: Uint8Array) {
    const { header, payload } = parseIngest(message);
    if (header.type === 'hello') return this.hello(ws, header);
    const session = this.sessions.get(ws.data.session ?? '');
    if (!session || session.phone !== ws) throw new ProtocolError('send hello first');
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

  private hello(ws: Socket, hello: HelloHeader) {
    // The same id again is the phone reconnecting mid-recording: carry on with its cloud.
    let session = this.sessions.get(hello.session);
    if (!session) {
      session = {
        id: hello.session,
        mode: hello.mode,
        device: hello.device ?? null,
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
      this.sessions.set(session.id, session);
      for (const old of [...this.sessions.keys()].slice(0, -KEEP_SESSIONS)) this.sessions.delete(old);
      console.log(`Live session ${session.id} (${session.mode}${session.device ? `, ${session.device}` : ''})`);
    }
    if (session.phone && session.phone !== ws) session.phone.close(4000, 'replaced by a newer connection');
    session.phone = ws;
    session.stats.phoneConnected = true;
    ws.data.session = session.id;
    if (this.latest !== session) {
      this.latest = session;
      for (const viewer of this.viewers) {
        if (viewer.data.role === 'viewer' && viewer.data.follow) this.sendSession(viewer, session);
      }
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
  private sendSession(ws: Socket, session: Session | null) {
    if (ws.data.role !== 'viewer') return;
    ws.data.session = session?.id ?? null;
    ws.send(
      JSON.stringify(
        session
          ? { type: 'session', id: session.id, mode: session.mode, device: session.device, startedAt: session.startedAt, voxelSize: session.cloud.voxelSize, stats: session.stats }
          : { type: 'session', id: null },
      ),
    );
    if (!session) return;
    const { cloud } = session;
    for (let start = 0; start < cloud.count; start += POINTS_PER_MESSAGE) {
      const end = Math.min(start + POINTS_PER_MESSAGE, cloud.count);
      this.sendTo(ws, encodePoints(cloud, Array.from({ length: end - start }, (_, i) => start + i)));
    }
    if (session.lastKeyframe) this.sendTo(ws, session.lastKeyframe);
    if (session.lastPose) ws.send(JSON.stringify({ type: 'pose', pose: session.lastPose }));
  }

  private sendTo(ws: Socket, message: string | Uint8Array) {
    // 0 means the message was dropped because the viewer is too far behind.
    if (ws.send(message) === 0 && ws.data.role === 'viewer') ws.data.resync = true;
  }

  private broadcast(session: Session, message: string | Uint8Array) {
    for (const viewer of this.viewers) {
      if (viewer.data.session === session.id) this.sendTo(viewer, message);
    }
  }

  private broadcastStats(session: Session) {
    const message = JSON.stringify({ type: 'stats', stats: session.stats });
    this.broadcast(session, message);
    session.phone?.send(message);
  }
}
