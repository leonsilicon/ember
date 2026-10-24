import { describe, expect, test } from 'bun:test';

import { headingFromPose } from '../../src/lib/rover-brain/geometry';
import { corridorAt, corridors, DEFAULT_ROVER, inView, ObstacleMemory, scanDepth } from '../../src/lib/rover-brain/obstacles';
import { pose, renderDepth, snapshot } from './scene';

describe('obstacles', () => {
  test('flat floor: floor found at camera height, every corridor clear', () => {
    const p = pose([0, 0.35, 0], 20, 0);
    const scan = scanDepth(snapshot(p, renderDepth(p)))!;
    expect(scan.floorSource).toBe('lidar');
    expect(scan.floorY).toBeCloseTo(0, 1);
    const lanes = corridors(scan, headingFromPose(p)!);
    expect(lanes.every((c) => c.blockedBy == null)).toBe(true);
    expect(corridorAt(lanes, 0)!.observedM).toBeGreaterThan(1.5);
  });

  test('a wall ahead blocks straight on at its distance, not the sides', () => {
    const p = pose([0, 0.35, 0], 15, 0);
    const scan = scanDepth(snapshot(p, renderDepth(p, [{ center: [0, 0, -1.5], halfWidth: 0.3, height: 0.5 }])))!;
    const lanes = corridors(scan, headingFromPose(p)!);
    const ahead = corridorAt(lanes, 0)!;
    expect(ahead.blockedBy).toBe('obstacle');
    expect(ahead.clearanceM).toBeGreaterThan(1.35);
    expect(ahead.clearanceM).toBeLessThan(1.65);
    expect(corridorAt(lanes, -30)!.blockedBy).toBeNull();
    expect(corridorAt(lanes, 30)!.blockedBy).toBeNull();
  });

  test('corridors follow the current heading after the rover turns', () => {
    const p = pose([0, 0.35, 0], 15, 0);
    const scan = scanDepth(snapshot(p, renderDepth(p, [{ center: [0, 0, -1.5], halfWidth: 0.3, height: 0.5 }])))!;
    const turnedRight = headingFromPose(pose([0, 0.35, 0], 15, 30))!;
    const lanes = corridors(scan, turnedRight);
    // The wall is now 30° to the left.
    expect(corridorAt(lanes, -30)!.blockedBy).toBe('obstacle');
    expect(corridorAt(lanes, 0)!.blockedBy).toBeNull();
  });

  test('a hole is a drop', () => {
    const p = pose([0, 0.35, 0], 25, 0);
    const scan = scanDepth(snapshot(p, renderDepth(p, [], [{ center: [0, 0, -1.2], radius: 0.35, depth: 0.3 }])))!;
    expect(corridorAt(corridors(scan, headingFromPose(p)!), 0)!.blockedBy).toBe('drop');
  });

  test('without depth there is no scan, and no scan blocks nothing', () => {
    const p = pose();
    expect(scanDepth(snapshot(p))).toBeNull();
    const lanes = corridors(null, headingFromPose(p)!);
    expect(lanes.every((c) => c.blockedBy == null && c.observedM === 0)).toBe(true);
  });

  test('floor falls back to camera height when it is not in view', () => {
    const p = pose([0, 0.35, 0], 0, 0);
    // The ground first shows ~0.69 m out (0.35 m below a level camera, ~27° half view), so a
    // wall at 0.5 m hides it completely.
    const wall = renderDepth(p, [{ center: [0, 0, -0.5], halfWidth: 3, height: 3 }]);
    const scan = scanDepth(snapshot(p, wall))!;
    expect(scan.floorSource).toBe('camera_height');
    expect(scan.floorY).toBeCloseTo(0.35 - DEFAULT_ROVER.cameraHeightM);
  });
});

describe('ObstacleMemory', () => {
  const wall = { center: [0, 0, -1.5] as [number, number, number], halfWidth: 0.3, height: 0.5 };

  test('an obstacle stays blocked after the rover turns away from it', () => {
    const memory = new ObstacleMemory();
    const ahead = pose([0, 0.35, 0], 15, 0);
    memory.add(scanDepth(snapshot(ahead, renderDepth(ahead, [wall])))!, 0);
    // Turned 60° right: the wall is now out of the camera's view.
    const turned = pose([0, 0.35, 0], 15, 60);
    memory.add(scanDepth(snapshot(turned, renderDepth(turned)))!, 200);
    const lanes = corridors(memory.scan(200), headingFromPose(turned)!);
    expect(corridorAt(lanes, -45)!.blockedBy).toBe('obstacle');
    // Without memory, the fresh scan alone knows nothing about it.
    const fresh = corridors(scanDepth(snapshot(turned, renderDepth(turned))), headingFromPose(turned)!);
    expect(corridorAt(fresh, -45)!.blockedBy).toBeNull();
  });

  test('what the camera sees now overrides memory, and old points expire', () => {
    const memory = new ObstacleMemory();
    const p = pose([0, 0.35, 0], 15, 0);
    memory.add(scanDepth(snapshot(p, renderDepth(p, [wall])))!, 0);
    expect(corridorAt(corridors(memory.scan(0), headingFromPose(p)!), 0)!.blockedBy).toBe('obstacle');
    // The obstacle moved away: the next scan of the same view is clear.
    memory.add(scanDepth(snapshot(p, renderDepth(p)))!, 200);
    expect(corridorAt(corridors(memory.scan(200), headingFromPose(p)!), 0)!.blockedBy).toBeNull();
    expect(memory.scan(10_000)!.points.length).toBe(0);
    expect(memory.ageMs(1200)).toBe(1000);
  });

  test('keeps a LiDAR floor over a camera-height guess', () => {
    const memory = new ObstacleMemory();
    const p = pose([0, 0.35, 0], 20, 0);
    memory.add(scanDepth(snapshot(p, renderDepth(p)))!, 0);
    const fitted = memory.floorY!;
    const level = pose([0, 0.35, 0], 0, 0);
    memory.add(scanDepth(snapshot(level, renderDepth(level, [{ center: [0, 0, -0.5], halfWidth: 3, height: 3 }])))!, 100);
    expect(memory.floorY).toBe(fitted);
  });

  test('inView', () => {
    const p = pose([0, 0.35, 0], 0, 0);
    const view = { pose: p, intrinsics: snapshot(p).intrinsics };
    expect(inView([0, 0.35, -2], view)).toBe(true);
    expect(inView([0, 0.35, 2], view)).toBe(false); // behind
    expect(inView([5, 0.35, -1], view)).toBe(false); // far off to the side
    expect(inView([0, 0.35, -9], view)).toBe(false); // beyond LiDAR range
  });
});

