/**
 * Geometry for placing detections in the world and relative to the rover.
 *
 * ARKit conventions throughout: the world is gravity-aligned with +y up (the session runs with
 * `worldAlignment = .gravity`); camera space has +x right, +y up, looking down −z; poses are
 * camera-to-world 4×4 matrices stored column-major (16 numbers).
 *
 * The **rover frame** is horizontal and moves with the phone: `forward` is where the camera looks,
 * flattened onto the ground; `right` is 90° clockwise from it seen from above. `bearingDeg` is 0
 * straight ahead and positive to the right, matching the drive mixer (`+turn` is right).
 */

export type Vec3 = [number, number, number];
export type Pose = readonly number[];
export type Intrinsics = { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
export type Size = { width: number; height: number };

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export function isPose(pose: unknown): pose is Pose {
  return Array.isArray(pose) && pose.length === 16 && pose.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Rotates a direction from camera to world space (no translation). */
export function rotate(pose: Pose, v: Vec3): Vec3 {
  return [
    pose[0] * v[0] + pose[4] * v[1] + pose[8] * v[2],
    pose[1] * v[0] + pose[5] * v[1] + pose[9] * v[2],
    pose[2] * v[0] + pose[6] * v[1] + pose[10] * v[2],
  ];
}

/** Maps a camera-space point to world space. */
export function transformPoint(pose: Pose, p: Vec3): Vec3 {
  const r = rotate(pose, p);
  return [r[0] + pose[12], r[1] + pose[13], r[2] + pose[14]];
}

export function cameraPosition(pose: Pose): Vec3 {
  return [pose[12], pose[13], pose[14]];
}

/** Where the rover is and which way it faces, on the ground plane. */
export type Heading = {
  origin: Vec3;
  /** Horizontal unit vectors (y = 0) in world space. */
  forward: Vec3;
  right: Vec3;
  /** Compass-like yaw of `forward` in degrees, for counting turns while searching. */
  yawDeg: number;
};

/**
 * The rover's heading from the phone's pose: the camera's viewing direction made horizontal.
 * Null when the camera points (almost) straight up or down, where that direction is undefined.
 */
export function headingFromPose(pose: Pose): Heading | null {
  const look = rotate(pose, [0, 0, -1]);
  const length = Math.hypot(look[0], look[2]);
  if (length < 0.05) return null;
  const forward: Vec3 = [look[0] / length, 0, look[2] / length];
  // forward × up, with up = +y: 90° clockwise seen from above.
  const right: Vec3 = [-forward[2], 0, forward[0]];
  return {
    origin: cameraPosition(pose),
    forward,
    right,
    yawDeg: (Math.atan2(forward[0], -forward[2]) * 180) / Math.PI,
  };
}

/** A world point seen from the rover. */
export type RoverPoint = {
  /** Metres to the right of / ahead of the phone, and above it (negative: below). */
  right: number;
  forward: number;
  up: number;
  /** Horizontal distance in metres. */
  distance: number;
  /** 0 straight ahead, positive to the right, in degrees. */
  bearingDeg: number;
};

export function toRover(world: Vec3, heading: Heading): RoverPoint {
  const d = sub(world, heading.origin);
  const right = dot(d, heading.right);
  const forward = dot(d, heading.forward);
  return {
    right,
    forward,
    up: d[1],
    distance: Math.hypot(right, forward),
    // + 0 turns -0 into 0.
    bearingDeg: (Math.atan2(right, forward) * 180) / Math.PI + 0,
  };
}

/** Smallest signed difference a − b between two angles, in degrees (−180..180]. */
export function angleDiffDeg(a: number, b: number) {
  let d = (a - b) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * A pixel of the upright detection frame → the same point in the sensor-oriented camera image the
 * intrinsics describe. Native code makes the detection frame by turning the sensor image a quarter
 * turn clockwise (`.oriented(.right)`) and scaling it, so a sensor point (x, y) of a W×H image
 * lands at (H − y, x) before scaling.
 */
export function uprightToSensor(u: number, v: number, frame: Size, k: Intrinsics): [number, number] {
  const uprightU = (u * k.height) / frame.width;
  const uprightV = (v * k.width) / frame.height;
  return [uprightV, k.height - uprightU];
}

/** Camera-space point for sensor pixel (x, y) at `depth` metres (along the optical axis). */
export function unproject(x: number, y: number, depth: number, k: Intrinsics): Vec3 {
  return [((x - k.cx) / k.fx) * depth, (-(y - k.cy) / k.fy) * depth, -depth];
}

export function scaleIntrinsics(k: Intrinsics, width: number, height: number): Intrinsics {
  const sx = width / k.width;
  const sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy, width, height };
}

/** LiDAR depth decoded for lookups. */
export type DepthMap = {
  width: number;
  height: number;
  /** Metres along the optical axis, row-major, sensor orientation. */
  values: Float32Array;
  confidence?: Uint8Array;
};

/** Decodes the native depth payload; undefined if it's missing or the wrong size. */
export function decodeDepth(raw?: {
  width: number;
  height: number;
  data: Uint8Array;
  confidence?: Uint8Array;
}): DepthMap | undefined {
  if (!raw || raw.width <= 0 || raw.height <= 0) return undefined;
  const count = raw.width * raw.height;
  if (raw.data.byteLength < count * 4) return undefined;
  // Copy first: the bytes may not start on a 4-byte boundary, which Float32Array requires.
  const values = new Float32Array(raw.data.slice(0, count * 4).buffer);
  const confidence = raw.confidence && raw.confidence.length >= count ? raw.confidence : undefined;
  return { width: raw.width, height: raw.height, values, confidence };
}

const MIN_DEPTH_M = 0.1;
const MAX_DEPTH_M = 6;

/**
 * Median depth around a sensor-image pixel (the depth map is a lower-resolution view of the same
 * image), ignoring missing and low-confidence readings. Null where there's none.
 */
export function depthAt(map: DepthMap, x: number, y: number, k: Intrinsics, radius = 1, minConfidence = 1) {
  const cx = Math.floor((x * map.width) / k.width);
  const cy = Math.floor((y * map.height) / k.height);
  const samples: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= map.width || py >= map.height) continue;
      const i = py * map.width + px;
      const d = map.values[i];
      if (!Number.isFinite(d) || d < MIN_DEPTH_M || d > MAX_DEPTH_M) continue;
      if (map.confidence && map.confidence[i] < minConfidence) continue;
      samples.push(d);
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * Where the ray through a sensor pixel meets the horizontal floor at height `floorY`, or null if
 * it doesn't (at or above the horizon, or further than `maxRangeM`).
 */
export function rayToFloor(x: number, y: number, pose: Pose, k: Intrinsics, floorY: number, maxRangeM = 30) {
  const dir = rotate(pose, unproject(x, y, 1, k));
  if (dir[1] >= -1e-6) return null;
  const origin = cameraPosition(pose);
  const t = (floorY - origin[1]) / dir[1];
  if (t <= 0) return null;
  const point = add(origin, scale(dir, t));
  if (Math.hypot(point[0] - origin[0], point[2] - origin[2]) > maxRangeM) return null;
  return point;
}
