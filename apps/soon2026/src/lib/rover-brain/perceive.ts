/**
 * Detection boxes from one frame → leaves placed in the world and relative to the rover.
 *
 * Each box's centre is taken back to the sensor image the pose and intrinsics describe. With LiDAR
 * depth there, the leaf is at that depth (exact up to ~5 m). Without it (out of LiDAR range, or no
 * LiDAR), the centre's ray is intersected with the floor: leaves lie on the ground, so that's a
 * good estimate as long as the ground is roughly flat.
 */

import { decodeDepth, depthAt, headingFromPose, rayToFloor, toRover, transformPoint, unproject, uprightToSensor } from './geometry';
import type { Intrinsics, Pose, RoverPoint, Size, Vec3 } from './geometry';
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

export type LocatedLeaf = LeafObservation & {
  /** Index into the frame's detections. */
  index: number;
  /** Where it is from the rover when the frame was taken. */
  rover: RoverPoint;
};

/**
 * Places each detection; detections that can't be placed (above the horizon with no depth) are
 * left out. `floorY` is the floor's world height from the latest depth scan, if known.
 */
export function locateDetections(
  detections: readonly BoxDetection[],
  frameSize: Size,
  camera: CameraSnapshot,
  floorY: number | null,
): LocatedLeaf[] {
  const heading = headingFromPose(camera.pose);
  if (!heading || frameSize.width <= 0 || frameSize.height <= 0) return [];
  const depth = decodeDepth(camera.depth);
  const k = camera.intrinsics;

  const located: LocatedLeaf[] = [];
  detections.forEach((detection, index) => {
    const { box } = detection;
    const [x, y] = uprightToSensor((box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2, frameSize, k);
    let world: Vec3 | null = null;
    let source: LeafObservation['source'] = 'lidar';
    const d = depth ? depthAt(depth, x, y, k) : null;
    if (d != null) {
      world = transformPoint(camera.pose, unproject(x, y, d, k));
    } else if (floorY != null) {
      world = rayToFloor(x, y, camera.pose, k, floorY);
      source = 'floor';
    }
    if (!world) return;
    located.push({
      index,
      world,
      label: detection.label,
      score: detection.confidence,
      source,
      rover: toRover(world, heading),
    });
  });
  return located;
}
