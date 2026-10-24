import { describe, expect, test } from 'bun:test';

import { LeafMap } from '../../src/lib/rover-brain/leaf-map';
import { decodeDepth, uprightToSensor } from '../../src/lib/rover-brain/geometry';
import { boxDepth, locateDetections } from '../../src/lib/rover-brain/perceive';
import { boxAt, FRAME, K, pose, renderDepth, snapshot, toFrame } from './scene';

const obs = (x: number, z: number, source: 'lidar' | 'floor' = 'lidar') => ({
  world: [x, 0, z] as [number, number, number],
  label: 'dry leaf',
  score: 0.2,
  source,
});

describe('locateDetections', () => {
  test('LiDAR places a leaf where it is; floor ray agrees without depth', () => {
    const p = pose([0, 0.3, 0], 25, 0);
    const leaf: [number, number, number] = [0.3, 0, -1.2];
    const detections = [boxAt(p, leaf)];
    const [withDepth] = locateDetections(detections, FRAME, snapshot(p, renderDepth(p)), 0).leaves;
    expect(withDepth.source).toBe('lidar');
    expect(withDepth.world[0]).toBeCloseTo(0.3, 1);
    expect(withDepth.world[2]).toBeCloseTo(-1.2, 1);
    expect(withDepth.heightAboveFloorM!).toBeCloseTo(0, 1);
    expect(withDepth.rover.distance).toBeCloseTo(Math.hypot(0.3, 1.2), 1);
    expect(withDepth.rover.bearingDeg).toBeGreaterThan(10);

    const [noDepth] = locateDetections(detections, FRAME, snapshot(p), 0).leaves;
    expect(noDepth.source).toBe('floor');
    expect(noDepth.heightAboveFloorM).toBeNull();
    expect(noDepth.world[0]).toBeCloseTo(0.3, 2);
    expect(noDepth.world[2]).toBeCloseTo(-1.2, 2);
  });

  test('unplaceable detections are rejected; indices refer to the input', () => {
    const p = pose([0, 0.3, 0], 25, 0);
    // The scene holds the phone in landscape, so the sensor image's top (the sky) is the upright
    // frame's right edge.
    const sky = { label: 'dry leaf', confidence: 0.1, box: { xmin: 570, ymin: 380, xmax: 575, ymax: 388 } };
    const { leaves, rejected } = locateDetections([sky, boxAt(p, [0, 0, -1])], FRAME, snapshot(p), 0);
    expect(leaves.map((l) => l.index)).toEqual([1]);
    expect(rejected).toEqual([{ index: 0, reason: 'unplaceable' }]);
    expect(locateDetections([boxAt(p, [0, 0, -1])], FRAME, snapshot(p), null).leaves).toEqual([]);
  });

  test('LiDAR rejects a "leaf" that is up on a wall', () => {
    const p = pose([0, 0.3, 0], 10, 0);
    const depth = renderDepth(p, [{ center: [0, 0, -1.5], halfWidth: 1, height: 1.5 }]);
    const onWall = boxAt(p, [0.2, 0.6, -1.5]);
    const onGround = boxAt(p, [-0.5, 0, -1.2]);
    const { leaves, rejected } = locateDetections([onWall, onGround], FRAME, snapshot(p, depth), 0);
    expect(leaves.map((l) => l.index)).toEqual([1]);
    expect(rejected[0].reason).toBe('off_ground');
    expect(rejected[0].heightAboveFloorM!).toBeCloseTo(0.6, 1);
  });

  test('physical size: a leaf-sized box passes, a hillside-sized one does not', () => {
    const p = pose([0, 0.3, 0], 25, 0);
    const depth = renderDepth(p);
    const leaf = boxAt(p, [0, 0, -1.2], 'dry leaf', 0.3, 6); // 12 px across at 1.2 m: a few cm
    // ~500 px across the ground around a point 4 m away: about 3.5 m, a hillside rather than a
    // pile. (The scene holds the phone in landscape, so world-horizontal is the frame's v axis.)
    const [u, v] = toFrame(p, [0, 0, -4])!;
    const huge = { label: 'leaf pile', confidence: 0.2, box: { xmin: u - 20, ymin: v - 250, xmax: u + 20, ymax: v + 250 } };
    const { leaves, rejected } = locateDetections([leaf, huge], FRAME, snapshot(p, depth), 0);
    expect(leaves.length).toBe(1);
    expect(leaves[0].sizeM).toBeGreaterThan(0.02);
    expect(leaves[0].sizeM).toBeLessThan(0.15);
    expect(rejected[0].reason).toBe('too_big');
  });

  test('too far to trust', () => {
    const p = pose([0, 0.3, 0], 2, 0);
    const far = boxAt(p, [0, 0, -9], 'dry leaf', 0.3, 2);
    const { rejected } = locateDetections([far], FRAME, snapshot(p), 0);
    expect(rejected[0].reason).toBe('too_far');
  });
});

describe('boxDepth', () => {
  test('a box over a small object reads the object, not the background at a stray centre pixel', () => {
    const p = pose([0, 0.3, 0], 10, 0);
    // A post 1 m away, 16 cm wide: the box centre lands on it, and so do most grid samples.
    const depth = renderDepth(p, [{ center: [0, 0, -1], halfWidth: 0.08, height: 0.6 }]);
    const map = decodeDepth(depth)!;
    const [u, v] = toFrame(p, [0, 0.2, -1])!;
    const corners: [number, number][] = [
      uprightToSensor(u - 10, v - 10, FRAME, K),
      uprightToSensor(u + 10, v + 10, FRAME, K),
    ];
    expect(boxDepth(map, corners, K)!).toBeCloseTo(1, 1);
  });
});

describe('LeafMap', () => {
  test('merges nearby sightings and confirms after three', () => {
    const map = new LeafMap();
    map.observe([obs(0, -1)], 0);
    map.observe([obs(0.05, -1.02)], 100);
    expect(map.snapshot()[0].state).toBe('tentative');
    map.observe([obs(0.02, -0.98), obs(1, -2)], 200);
    const leaves = map.snapshot();
    expect(leaves.length).toBe(2);
    expect(leaves[0].hits).toBe(3);
    expect(leaves[0].state).toBe('confirmed');
    expect(leaves[1].state).toBe('tentative');
  });

  test('forgets unconfirmed one-offs but keeps confirmed leaves', () => {
    const map = new LeafMap();
    for (let t = 0; t < 3; t++) map.observe([obs(0, -1)], t * 100);
    map.observe([obs(2, -2)], 300);
    map.observe([], 10_000);
    const leaves = map.snapshot();
    expect(leaves.length).toBe(1);
    expect(leaves[0].state).toBe('confirmed');
  });

  test('collected leaves stay collected when seen again', () => {
    const map = new LeafMap();
    const [id] = map.observe([obs(0, -1)], 0);
    map.markCollected(id);
    map.observe([obs(0.01, -1)], 100);
    expect(map.snapshot().length).toBe(1);
    expect(map.get(id)!.state).toBe('collected');
  });

  test('floor guesses never move a LiDAR-placed leaf', () => {
    const map = new LeafMap();
    const [id] = map.observe([obs(0, -1)], 0);
    map.observe([obs(0.2, -1, 'floor')], 100);
    expect(map.get(id)!.world[0]).toBe(0);
    expect(map.get(id)!.hits).toBe(2);
  });
});
