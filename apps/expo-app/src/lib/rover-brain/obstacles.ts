/**
 * Where the rover must not drive, from LiDAR depth.
 *
 * Depth is lifted into world points once per scan and kept there, so as the rover turns the
 * corridors are recomputed from its current heading without waiting for a new scan. Each point is
 * classed by its height above the floor:
 *
 * - **obstacle**: higher than the rover can climb (`maxStepM`) but low enough to hit
 *   (below `clearanceHeightM`; branches overhead don't count);
 * - **drop**: lower than the floor by more than `maxDipM` (ditch, kerb, stairs down);
 * - otherwise **ground**.
 *
 * A **corridor** is a rover-wide strip along one bearing. Its clearance is how far the rover can
 * drive that way before the strip holds `minPoints` blocking points.
 *
 * Corridors start at the camera, but the body reaches back behind it. Something remembered right
 * beside the body (within `sideMarginM` of its side, as far back as `bodyBackM`) closes every
 * corridor on that side, so the rover doesn't steer into what it's passing.
 */

import { decodeDepth, headingFromPose, scaleIntrinsics, toRover, transformPoint, unproject } from './geometry';
import type { DepthMap, Heading, Intrinsics, Pose, Vec3 } from './geometry';

export type RoverSpec = {
  /** Strip width the rover needs, metres. */
  widthM: number;
  /** Taller than this blocks. */
  maxStepM: number;
  /** Deeper than this is a drop. */
  maxDipM: number;
  /** Ignore anything higher than this above the floor (overhanging branches). */
  clearanceHeightM: number;
  /** Blocking points needed in a strip before it counts as blocked (LiDAR noise). */
  minPoints: number;
  /** Lens height above the ground, used when the floor can't be seen in the depth. */
  cameraHeightM: number;
  /** How far the body reaches back behind the camera. */
  bodyBackM: number;
  /** Something this close to the body's side blocks steering that way. */
  sideMarginM: number;
};

export const DEFAULT_ROVER: RoverSpec = {
  widthM: 0.45,
  maxStepM: 0.08,
  maxDipM: 0.1,
  clearanceHeightM: 0.6,
  minPoints: 4,
  cameraHeightM: 0.3,
  bodyBackM: 0.35,
  sideMarginM: 0.1,
};

/** Bearings the corridors are checked along, degrees (0 ahead, + right). */
export const CORRIDOR_BEARINGS = [-45, -37.5, -30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30, 37.5, 45];

/** The iPhone's LiDAR reaches about 5 m. */
export const MAX_RANGE_M = 5;

export type Corridor = {
  bearingDeg: number;
  /** How far the rover can drive this way before something blocks it. */
  clearanceM: number;
  blockedBy: 'obstacle' | 'drop' | null;
  /** How far this way the depth actually reaches (0 if it saw nothing). */
  observedM: number;
};

/** LiDAR points in the world, with the floor they were measured against. */
export type DepthScan = {
  points: Vec3[];
  floorY: number;
  floorSource: 'lidar' | 'camera_height';
  /** ARKit timestamp of the frame, seconds. */
  timestamp: number;
  /** The camera that took it, so memory knows which volume this scan covers. */
  view?: { pose: Pose; intrinsics: Intrinsics };
};

/** Depth-map pixels → world points, every `stride` pixels. */
export function depthToWorld(map: DepthMap, pose: Pose, k: Intrinsics, stride = 4, minConfidence = 1): Vec3[] {
  const kd = scaleIntrinsics(k, map.width, map.height);
  const points: Vec3[] = [];
  for (let y = 0; y < map.height; y += stride) {
    for (let x = 0; x < map.width; x += stride) {
      const i = y * map.width + x;
      const d = map.values[i];
      if (!Number.isFinite(d) || d < 0.1 || d > MAX_RANGE_M + 1) continue;
      if (map.confidence && map.confidence[i] < minConfidence) continue;
      points.push(transformPoint(pose, unproject(x + 0.5, y + 0.5, d, kd)));
    }
  }
  return points;
}

/**
 * The floor's height in world y: the most common level below the camera among points ahead of it.
 * Null when too little ground is in view.
 */
export function estimateFloorY(points: readonly Vec3[], heading: Heading, binM = 0.02): number | null {
  const below: number[] = [];
  const forwardOf: number[] = [];
  for (const p of points) {
    const r = toRover(p, heading);
    const drop = -r.up;
    if (r.forward > 0.2 && r.forward < 3 && drop > 0.05 && drop < 3) {
      below.push(drop);
      forwardOf.push(r.forward);
    }
  }
  if (below.length < 100) return null;
  const bins = new Map<number, number>();
  for (const d of below) {
    const b = Math.floor(d / binM);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [b, count] of bins) {
    // Neighbouring bins too, so a floor split across a bin edge still wins.
    const total = count + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0);
    if (total > bestCount) {
      best = b;
      bestCount = total;
    }
  }
  const peak = below.map((d, i) => [d, forwardOf[i]]).filter(([d]) => Math.abs(d / binM - (best + 0.5)) <= 1.5);
  // A real floor is one level that holds a good share of the points and stretches away from the
  // camera. A wall close in front puts points at every height below the camera, all at the same
  // distance, and must not pass for a floor.
  const forwards = peak.map(([, f]) => f);
  if (peak.length < 0.3 * below.length || Math.max(...forwards) - Math.min(...forwards) < 0.3) return null;
  const levels = peak.map(([d]) => d).sort((a, b) => a - b);
  return heading.origin[1] - levels[Math.floor(levels.length / 2)];
}

/** Lifts one frame's depth into a scan, or null without depth or a usable pose. */
export function scanDepth(
  camera: {
    pose: Pose;
    intrinsics: Intrinsics;
    timestamp: number;
    depth?: { width: number; height: number; data: Uint8Array; confidence?: Uint8Array };
  },
  rover: RoverSpec = DEFAULT_ROVER,
): DepthScan | null {
  const map = decodeDepth(camera.depth);
  const heading = headingFromPose(camera.pose);
  if (!map || !heading) return null;
  const points = depthToWorld(map, camera.pose, camera.intrinsics);
  const fitted = estimateFloorY(points, heading);
  const view = { pose: camera.pose, intrinsics: camera.intrinsics };
  return fitted == null
    ? { points, floorY: heading.origin[1] - rover.cameraHeightM, floorSource: 'camera_height', timestamp: camera.timestamp, view }
    : { points, floorY: fitted, floorSource: 'lidar', timestamp: camera.timestamp, view };
}

/** Corridor clearances from the rover's current heading. */
export function corridors(
  scan: DepthScan | null,
  heading: Heading,
  rover: RoverSpec = DEFAULT_ROVER,
  bearings: readonly number[] = CORRIDOR_BEARINGS,
): Corridor[] {
  const half = rover.widthM / 2;
  const strips = bearings.map((bearingDeg) => {
    const b = (bearingDeg * Math.PI) / 180;
    return { bearingDeg, sin: Math.sin(b), cos: Math.cos(b), blocking: [] as [number, 'obstacle' | 'drop'][], observed: 0 };
  });

  const points = scan?.points ?? [];
  const floorY = scan?.floorY ?? 0;
  const besides = { left: 0, right: 0 };
  for (const p of points) {
    const r = toRover(p, heading);
    const height = p[1] - floorY;
    const kind = height > rover.maxStepM && height < rover.clearanceHeightM ? 'obstacle' : height < -rover.maxDipM ? 'drop' : null;
    if (height >= rover.clearanceHeightM) continue; // overhead: neither ground nor in the way
    if (r.forward <= 0) {
      if (kind && r.forward > -rover.bodyBackM && Math.abs(r.right) < half + rover.sideMarginM) {
        besides[r.right > 0 ? 'right' : 'left'] += 1;
      }
      continue;
    }
    for (const s of strips) {
      const along = r.right * s.sin + r.forward * s.cos;
      if (along <= 0 || along > MAX_RANGE_M) continue;
      if (Math.abs(r.right * s.cos - r.forward * s.sin) > half) continue;
      if (along > s.observed) s.observed = along;
      if (kind) s.blocking.push([along, kind]);
    }
  }

  return strips.map((s) => {
    const beside = s.bearingDeg > 0 ? besides.right : s.bearingDeg < 0 ? besides.left : 0;
    if (beside >= rover.minPoints) {
      return { bearingDeg: s.bearingDeg, clearanceM: 0, blockedBy: 'obstacle' as const, observedM: s.observed };
    }
    if (s.blocking.length < rover.minPoints) {
      return { bearingDeg: s.bearingDeg, clearanceM: MAX_RANGE_M, blockedBy: null, observedM: s.observed };
    }
    s.blocking.sort((a, b) => a[0] - b[0]);
    // The minPoints-th nearest blocking point: a few stray readings can't stop the rover.
    const nearest = s.blocking.slice(0, rover.minPoints);
    const drops = nearest.filter(([, kind]) => kind === 'drop').length;
    return {
      bearingDeg: s.bearingDeg,
      clearanceM: nearest[nearest.length - 1][0],
      blockedBy: drops * 2 > nearest.length ? 'drop' : 'obstacle',
      observedM: s.observed,
    };
  });
}

export type ObstacleMemoryOptions = {
  /** Points older than this are forgotten (things move; AR drift adds up). */
  maxAgeMs: number;
  /** Points are merged into cubes this size, keeping the newest, so memory stays small. */
  voxelM: number;
  maxPoints: number;
};

export const DEFAULT_OBSTACLE_MEMORY: ObstacleMemoryOptions = { maxAgeMs: 10_000, voxelM: 0.05, maxPoints: 20000 };

/** Whether a world point falls inside a camera's image, in front of it and within LiDAR range. */
export function inView(p: Vec3, view: { pose: Pose; intrinsics: Intrinsics }, maxDepthM = MAX_RANGE_M): boolean {
  const m = view.pose;
  const d = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
  // Camera-space point: the transpose of the pose's rotation applied to the offset.
  const x = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
  const y = m[4] * d[0] + m[5] * d[1] + m[6] * d[2];
  const z = m[8] * d[0] + m[9] * d[1] + m[10] * d[2];
  const depth = -z;
  if (depth < 0.1 || depth > maxDepthM) return false;
  const k = view.intrinsics;
  const u = k.cx + (k.fx * x) / depth;
  const v = k.cy - (k.fy * y) / depth;
  return u >= 0 && u < k.width && v >= 0 && v < k.height;
}

/**
 * LiDAR points from the last few seconds, in world coordinates.
 *
 * The phone sees about 50° side to side in portrait, but the rover steers across ±45° and turns in
 * place to search. Keeping recent scans means that a rock it just turned away from is still
 * blocked, rather than "unknown" because it's out of view. Each new scan is the truth for what the
 * camera can see now: remembered points inside its view are dropped before it's added, so memory
 * only fills in what's out of view, and forgets that after `maxAgeMs`.
 */
export class ObstacleMemory {
  private cells = new Map<string, { point: Vec3; atMs: number }>();
  private floor: { y: number; source: DepthScan['floorSource'] } | null = null;
  private lastScanAtMs = -Infinity;
  private lastTimestamp = 0;

  constructor(private readonly options: ObstacleMemoryOptions = DEFAULT_OBSTACLE_MEMORY) {}

  add(scan: DepthScan, nowMs: number) {
    if (scan.view) {
      const view = scan.view;
      for (const [key, cell] of this.cells) {
        if (inView(cell.point, view)) this.cells.delete(key);
      }
    }
    const v = this.options.voxelM;
    for (const p of scan.points) {
      const key = `${Math.floor(p[0] / v)},${Math.floor(p[1] / v)},${Math.floor(p[2] / v)}`;
      this.cells.set(key, { point: p, atMs: nowMs });
    }
    // A LiDAR-fitted floor beats the camera-height guess; keep the last good one.
    if (scan.floorSource === 'lidar' || !this.floor || this.floor.source !== 'lidar') {
      this.floor = { y: scan.floorY, source: scan.floorSource };
    }
    this.lastScanAtMs = nowMs;
    this.lastTimestamp = scan.timestamp;
    this.prune(nowMs);
  }

  /** The remembered points as one scan, for `corridors`. Null before the first scan. */
  scan(nowMs: number): DepthScan | null {
    if (!this.floor) return null;
    this.prune(nowMs);
    return {
      points: [...this.cells.values()].map((c) => c.point),
      floorY: this.floor.y,
      floorSource: this.floor.source,
      timestamp: this.lastTimestamp,
    };
  }

  /** Milliseconds since the last scan was added. */
  ageMs(nowMs: number) {
    return nowMs - this.lastScanAtMs;
  }

  get floorY(): number | null {
    return this.floor?.y ?? null;
  }

  clear() {
    this.cells.clear();
    this.floor = null;
    this.lastScanAtMs = -Infinity;
  }

  private prune(nowMs: number) {
    for (const [key, cell] of this.cells) {
      if (nowMs - cell.atMs > this.options.maxAgeMs) this.cells.delete(key);
    }
    if (this.cells.size > this.options.maxPoints) {
      const oldest = [...this.cells].sort((a, b) => a[1].atMs - b[1].atMs);
      for (const [key] of oldest.slice(0, this.cells.size - this.options.maxPoints)) this.cells.delete(key);
    }
  }
}

/** The corridor closest to a bearing. */
export function corridorAt(lanes: readonly Corridor[], bearingDeg: number): Corridor | undefined {
  let best: Corridor | undefined;
  for (const lane of lanes) {
    if (!best || Math.abs(lane.bearingDeg - bearingDeg) < Math.abs(best.bearingDeg - bearingDeg)) best = lane;
  }
  return best;
}
