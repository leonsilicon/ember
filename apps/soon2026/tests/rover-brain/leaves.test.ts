import { describe, expect, test } from 'bun:test';

import { LeafMap } from '../../src/lib/rover-brain/leaf-map';
import { locateDetections } from '../../src/lib/rover-brain/perceive';
import { boxAt, FRAME, pose, renderDepth, snapshot } from './scene';

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
    const [withDepth] = locateDetections(detections, FRAME, snapshot(p, renderDepth(p)), 0);
    expect(withDepth.source).toBe('lidar');
    expect(withDepth.world[0]).toBeCloseTo(0.3, 1);
    expect(withDepth.world[2]).toBeCloseTo(-1.2, 1);
    expect(withDepth.rover.distance).toBeCloseTo(Math.hypot(0.3, 1.2), 1);
    expect(withDepth.rover.bearingDeg).toBeGreaterThan(10);

    const [noDepth] = locateDetections(detections, FRAME, snapshot(p), 0);
    expect(noDepth.source).toBe('floor');
    expect(noDepth.world[0]).toBeCloseTo(0.3, 2);
    expect(noDepth.world[2]).toBeCloseTo(-1.2, 2);
  });

  test('unplaceable detections are dropped; indices refer to the input', () => {
    const p = pose([0, 0.3, 0], 25, 0);
    // The scene holds the phone in landscape, so the sensor image's top (the sky) is the upright
    // frame's right edge.
    const sky = { label: 'dry leaf', confidence: 0.1, box: { xmin: 570, ymin: 380, xmax: 575, ymax: 388 } };
    const located = locateDetections([sky, boxAt(p, [0, 0, -1])], FRAME, snapshot(p), 0);
    expect(located.length).toBe(1);
    expect(located[0].index).toBe(1);
    expect(locateDetections([boxAt(p, [0, 0, -1])], FRAME, snapshot(p), null)).toEqual([]);
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
