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
};

export const DEFAULT_ROVER: RoverSpec = {
  widthM: 0.45,
  maxStepM: 0.08,
  maxDipM: 0.1,
  clearanceHeightM: 0.6,
  minPoints: 4,
  cameraHeightM: 0.3,
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
  return fitted == null
    ? { points, floorY: heading.origin[1] - rover.cameraHeightM, floorSource: 'camera_height', timestamp: camera.timestamp }
    : { points, floorY: fitted, floorSource: 'lidar', timestamp: camera.timestamp };
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
  for (const p of points) {
    const r = toRover(p, heading);
    if (r.forward <= 0) continue;
    const height = p[1] - floorY;
    const kind = height > rover.maxStepM && height < rover.clearanceHeightM ? 'obstacle' : height < -rover.maxDipM ? 'drop' : null;
    if (height >= rover.clearanceHeightM) continue; // overhead: neither ground nor in the way
    for (const s of strips) {
      const along = r.right * s.sin + r.forward * s.cos;
      if (along <= 0 || along > MAX_RANGE_M) continue;
      if (Math.abs(r.right * s.cos - r.forward * s.sin) > half) continue;
      if (along > s.observed) s.observed = along;
      if (kind) s.blocking.push([along, kind]);
    }
  }

  return strips.map((s) => {
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

/** The corridor closest to a bearing. */
export function corridorAt(lanes: readonly Corridor[], bearingDeg: number): Corridor | undefined {
  let best: Corridor | undefined;
  for (const lane of lanes) {
    if (!best || Math.abs(lane.bearingDeg - bearingDeg) < Math.abs(best.bearingDeg - bearingDeg)) best = lane;
  }
  return best;
}
