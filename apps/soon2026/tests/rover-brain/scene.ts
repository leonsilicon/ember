/** A synthetic ARKit camera over flat ground, rendering LiDAR depth and detection boxes. */

import { cameraPosition, rotate, unproject, type Intrinsics, type Pose, type Vec3 } from '../../src/lib/rover-brain/geometry';
import type { CameraSnapshot } from '../../src/lib/rover-brain/perceive';

/** iPhone-like sensor image (landscape) and its 256×192 depth map. */
export const K: Intrinsics = { fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440 };
export const DEPTH_W = 256;
export const DEPTH_H = 192;
/** The upright detection frame: the sensor image turned a quarter turn clockwise, longer side 768. */
export const FRAME = { width: 576, height: 768 };

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Camera-to-world pose, column-major: at `position`, looking `pitchDeg` below horizontal, turned
 * `yawDeg` to the right (clockwise from above) from world −z. The phone is held in landscape for
 * ARKit's camera axes, i.e. the sensor image's x axis is horizontal.
 */
export function pose(position: Vec3 = [0, 0.3, 0], pitchDeg = 20, yawDeg = 0): number[] {
  const p = deg(pitchDeg);
  const y = deg(-yawDeg);
  // Rx(-p): pitch down. Ry(y): yaw (negative = clockwise seen from above).
  const rx = [
    [1, 0, 0],
    [0, Math.cos(-p), -Math.sin(-p)],
    [0, Math.sin(-p), Math.cos(-p)],
  ];
  const ry = [
    [Math.cos(y), 0, Math.sin(y)],
    [0, 1, 0],
    [-Math.sin(y), 0, Math.cos(y)],
  ];
  const r = ry.map((row) => [0, 1, 2].map((j) => row[0] * rx[0][j] + row[1] * rx[1][j] + row[2] * rx[2][j]));
  return [
    r[0][0], r[1][0], r[2][0], 0,
    r[0][1], r[1][1], r[2][1], 0,
    r[0][2], r[1][2], r[2][2], 0,
    position[0], position[1], position[2], 1,
  ];
}

export type Wall = { center: Vec3; halfWidth: number; height: number };

/** Depth of the floor at y = 0 plus walls facing the camera, as the native payload encodes it. */
export function renderDepth(cameraPose: Pose, walls: Wall[] = [], holes: { center: Vec3; radius: number; depth: number }[] = []) {
  const values = new Float32Array(DEPTH_W * DEPTH_H);
  const kd = { ...K, fx: (K.fx * DEPTH_W) / K.width, fy: (K.fy * DEPTH_H) / K.height, cx: (K.cx * DEPTH_W) / K.width, cy: (K.cy * DEPTH_H) / K.height, width: DEPTH_W, height: DEPTH_H };
  const origin = cameraPosition(cameraPose);
  for (let v = 0; v < DEPTH_H; v++) {
    for (let u = 0; u < DEPTH_W; u++) {
      const dir = rotate(cameraPose, unproject(u + 0.5, v + 0.5, 1, kd)); // world step per metre of depth
      let best = Infinity;
      if (dir[1] < 0) {
        let t = -origin[1] / dir[1];
        const hit: Vec3 = [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t];
        for (const hole of holes) {
          if (Math.hypot(hit[0] - hole.center[0], hit[2] - hole.center[2]) < hole.radius) {
            t = -(origin[1] + hole.depth) / dir[1];
          }
        }
        best = t;
      }
      for (const wall of walls) {
        // A vertical plane through wall.center, facing the camera horizontally.
        const n: Vec3 = [wall.center[0] - origin[0], 0, wall.center[2] - origin[2]];
        const nl = Math.hypot(n[0], n[2]);
        const nn: Vec3 = [n[0] / nl, 0, n[2] / nl];
        const denom = dir[0] * nn[0] + dir[2] * nn[2];
        if (denom <= 1e-9) continue;
        const t = ((wall.center[0] - origin[0]) * nn[0] + (wall.center[2] - origin[2]) * nn[2]) / denom;
        const p: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
        const lateral = Math.abs((p[0] - wall.center[0]) * -nn[2] + (p[2] - wall.center[2]) * nn[0]);
        if (t > 0 && t < best && lateral <= wall.halfWidth && p[1] >= 0 && p[1] <= wall.height) best = t;
      }
      values[v * DEPTH_W + u] = Number.isFinite(best) && best < 8 ? best : 0;
    }
  }
  return { width: DEPTH_W, height: DEPTH_H, data: new Uint8Array(values.buffer), confidence: new Uint8Array(DEPTH_W * DEPTH_H).fill(2) };
}

export function snapshot(cameraPose: Pose, depth?: ReturnType<typeof renderDepth>, timestamp = 1): CameraSnapshot {
  return { pose: cameraPose, intrinsics: K, timestamp, trackingNormal: true, depth };
}

/** Projects a world point into the upright detection frame (null if behind the camera). */
export function toFrame(cameraPose: Pose, world: Vec3): [number, number] | null {
  // Inverse rotation: transpose of the 3×3 part.
  const o = cameraPosition(cameraPose);
  const d: Vec3 = [world[0] - o[0], world[1] - o[1], world[2] - o[2]];
  const cam: Vec3 = [
    cameraPose[0] * d[0] + cameraPose[1] * d[1] + cameraPose[2] * d[2],
    cameraPose[4] * d[0] + cameraPose[5] * d[1] + cameraPose[6] * d[2],
    cameraPose[8] * d[0] + cameraPose[9] * d[1] + cameraPose[10] * d[2],
  ];
  if (cam[2] >= 0) return null;
  const x = K.cx + (K.fx * cam[0]) / -cam[2];
  const y = K.cy - (K.fy * cam[1]) / -cam[2];
  const s = FRAME.width / K.height;
  return [(K.height - y) * s, x * s];
}

export function boxAt(cameraPose: Pose, world: Vec3, label = 'dry leaf', confidence = 0.3, half = 6) {
  const p = toFrame(cameraPose, world);
  if (!p) throw new Error('point is behind the camera');
  return { label, confidence, box: { xmin: p[0] - half, ymin: p[1] - half, xmax: p[0] + half, ymax: p[1] + half } };
}
