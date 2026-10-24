/**
 * Detection boxes from one frame → leaves placed in the world, checked against LiDAR.
 *
 * **Placing.** With LiDAR, depth is sampled on a grid over the middle of the box and the median
 * taken, so a small leaf whose exact centre pixel misses it (or a noisy reading) doesn't throw the
 * position off. Without depth there (out of LiDAR range, or no LiDAR), the box centre's ray is
 * intersected with the floor: leaves lie on the ground, so that's a good estimate on flat ground.
 *
 * **Checking.** OWL-ViT also fires on brown things that aren't leaves on the ground: bark, a
 * wooden fence, a cardboard box, a whole hillside. LiDAR knows where each box really is, so a
 * detection is rejected when
 * - it's well above the floor (`maxHeightAboveFloorM`): leaves to collect lie on the ground;
 * - it's physically too big (`maxSizeM`) or too small (`minSizeM`) to be a leaf or a leaf pile;
 * - it's too far away to place reliably (`maxRangeM`).
 * Floor-ray placements can't be height-checked (they're on the floor by construction), only sized.
 */

import { decodeDepth, depthAt, headingFromPose, norm, rayToFloor, toRover, transformPoint, unproject, uprightToSensor } from './geometry';
import type { DepthMap, Intrinsics, Pose, RoverPoint, Size, Vec3 } from './geometry';
import type { LeafObservation } from './leaf-map';

export type Box = { xmin: number; ymin: number; xmax: number; ymax: number };
export type BoxDetection = { box: Box; label: string; confidence: number };

export type CameraSnapshot = {
  pose: Pose;
  intrinsics: Intrinsics;
  timestamp: number;
  trackingNormal: boolean;
  depth?: { width: number; height: number; data: Uint8Array; confidence?: Uint8Array };
};

export type LeafCheck = {
  /** Highest a detection may sit above the floor and still count as lying on the ground. */
  maxHeightAboveFloorM: number;
  /** Physical extent of the box (its larger side), metres. Piles can be big; trees and walls are bigger. */
  maxSizeM: number;
  minSizeM: number;
  /** Beyond this, placements (especially floor rays) are too rough to drive to. */
  maxRangeM: number;
};

export const DEFAULT_LEAF_CHECK: LeafCheck = {
  maxHeightAboveFloorM: 0.25,
  maxSizeM: 1.5,
  minSizeM: 0.02,
  maxRangeM: 8,
};

export type LeafRejection = 'off_ground' | 'too_big' | 'too_small' | 'too_far' | 'unplaceable';

export type LocatedLeaf = LeafObservation & {
  /** Index into the frame's detections. */
  index: number;
  /** Where it is from the rover when the frame was taken. */
  rover: RoverPoint;
  /** Height above the floor in metres, when both are known. */
  heightAboveFloorM: number | null;
  /** The box's larger side in metres. */
  sizeM: number;
};

export type RejectedDetection = {
  index: number;
  reason: LeafRejection;
  /** Present when the detection could be placed at all. */
  rover?: RoverPoint;
  heightAboveFloorM?: number | null;
  sizeM?: number;
};

/**
 * Median depth over a grid of points in the middle of a box (sensor-image coordinates), or null
 * if none of them has a reading. `inner` is the fraction of the box sampled, centred.
 */
export function boxDepth(map: DepthMap, corners: [number, number][], k: Intrinsics, inner = 0.5, grid = 5) {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = ((x1 - x0) * inner) / 2;
  const hh = ((y1 - y0) * inner) / 2;
  const samples: number[] = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const fx = grid === 1 ? 0 : (i / (grid - 1)) * 2 - 1;
      const fy = grid === 1 ? 0 : (j / (grid - 1)) * 2 - 1;
      const d = depthAt(map, cx + fx * hw, cy + fy * hh, k, 0);
      if (d != null) samples.push(d);
    }
  }
  if (!samples.length) return depthAt(map, cx, cy, k, 1);
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * How far each detection is from the phone, measured with LiDAR: metres in a straight line to
 * where the box centre's ray meets the box's median depth (`boxDepth`). Null for a box LiDAR has
 * no reading in (beyond its ~5 m range, or only low-confidence readings); undefined for a frame
 * without depth (no LiDAR, or the front camera). Unlike placing leaves, it needs no AR tracking.
 */
export function lidarDistances(
  detections: readonly BoxDetection[],
  frameSize: Size,
  camera: Pick<CameraSnapshot, 'intrinsics' | 'depth'>,
): (number | null)[] | undefined {
  const depth = decodeDepth(camera.depth);
  if (!depth || frameSize.width <= 0 || frameSize.height <= 0) return undefined;
  const k = camera.intrinsics;
  return detections.map(({ box }) => {
    const corners = [uprightToSensor(box.xmin, box.ymin, frameSize, k), uprightToSensor(box.xmax, box.ymax, frameSize, k)];
    const d = boxDepth(depth, corners, k);
    if (d == null) return null;
    const [x, y] = uprightToSensor((box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2, frameSize, k);
    return norm(unproject(x, y, d, k));
  });
}

/**
 * Places and checks each detection. `floorY` is the floor's world height from the latest depth
 * scan, if known. Returns the leaves worth tracking and, for the HUD, what was rejected and why.
 */
export function locateDetections(
  detections: readonly BoxDetection[],
  frameSize: Size,
  camera: CameraSnapshot,
  floorY: number | null,
  check: LeafCheck = DEFAULT_LEAF_CHECK,
): { leaves: LocatedLeaf[]; rejected: RejectedDetection[] } {
  const leaves: LocatedLeaf[] = [];
  const rejected: RejectedDetection[] = [];
  const heading = headingFromPose(camera.pose);
  if (!heading || frameSize.width <= 0 || frameSize.height <= 0) {
    return { leaves, rejected: detections.map((_, index) => ({ index, reason: 'unplaceable' as const })) };
  }
  const depth = decodeDepth(camera.depth);
  const k = camera.intrinsics;
  // Focal lengths in the upright frame's pixels: its x axis is the sensor's y axis and vice versa.
  const fu = (k.fy * frameSize.width) / k.height;
  const fv = (k.fx * frameSize.height) / k.width;

  detections.forEach((detection, index) => {
    const { box } = detection;
    const [x, y] = uprightToSensor((box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2, frameSize, k);
    let world: Vec3 | null = null;
    let source: LeafObservation['source'] = 'lidar';
    let range: number | null = null; // metres along the optical axis
    const corners = [uprightToSensor(box.xmin, box.ymin, frameSize, k), uprightToSensor(box.xmax, box.ymax, frameSize, k)];
    const d = depth ? boxDepth(depth, corners, k) : null;
    if (d != null) {
      world = transformPoint(camera.pose, unproject(x, y, d, k));
      range = d;
    } else if (floorY != null) {
      world = rayToFloor(x, y, camera.pose, k, floorY);
      source = 'floor';
      if (world) {
        // Depth along the optical axis of the floor point, for sizing the box.
        const o = [camera.pose[12], camera.pose[13], camera.pose[14]];
        range = -(
          camera.pose[8] * (world[0] - o[0]) +
          camera.pose[9] * (world[1] - o[1]) +
          camera.pose[10] * (world[2] - o[2])
        );
      }
    }
    if (!world || range == null || range <= 0) {
      rejected.push({ index, reason: 'unplaceable' });
      return;
    }

    const rover = toRover(world, heading);
    const sizeM = Math.max(((box.xmax - box.xmin) * range) / fu, ((box.ymax - box.ymin) * range) / fv);
    const heightAboveFloorM = floorY != null && source === 'lidar' ? world[1] - floorY : null;
    const reason: LeafRejection | null =
      rover.distance > check.maxRangeM
        ? 'too_far'
        : heightAboveFloorM != null && heightAboveFloorM > check.maxHeightAboveFloorM
          ? 'off_ground'
          : sizeM > check.maxSizeM
            ? 'too_big'
            : sizeM < check.minSizeM
              ? 'too_small'
              : null;
    if (reason) {
      rejected.push({ index, reason, rover, heightAboveFloorM, sizeM });
      return;
    }
    leaves.push({
      index,
      world,
      label: detection.label,
      score: detection.confidence,
      source,
      rover,
      heightAboveFloorM,
      sizeM,
    });
  });
  return { leaves, rejected };
}
