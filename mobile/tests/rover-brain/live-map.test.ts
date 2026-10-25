import { describe, expect, test } from 'bun:test';

import { Brain } from '../../src/lib/rover-brain/brain';
import { headingFromPose } from '../../src/lib/rover-brain/geometry';
import { liveMap, parseLiveMap } from '../../src/lib/rover-brain/live-map';
import { pose } from './scene';

describe('liveMap', () => {
  test('carries the rover, pile, leaves and corridors, and survives the wire', () => {
    const brain = new Brain();
    brain.setPile({ center: [0.5, 0, -1], radiusM: 0.75 });
    const heading = headingFromPose(pose([1.234, 0.3, 2.345], 0));
    brain.observe([{ world: [1, 0, 0.5], label: 'dry leaf', score: 0.3, source: 'lidar' }], heading, 0);
    const tick = brain.tick(0, heading);
    const map = liveMap(brain, heading, tick, 1000);

    expect(map.rover).toEqual({ x: 1.23, z: 2.35, yawDeg: Math.round(heading!.yawDeg) });
    expect(map.pile).toEqual({ x: 0.5, z: -1, radiusM: 0.75 });
    expect(map.leaves).toHaveLength(1);
    expect(map.autopilot.on).toBe(false);
    expect(map.targetId).toBeNull();

    const line = JSON.stringify(map);
    expect(parseLiveMap(line)).toEqual(map);
  });

  test('a lost pose sends no rover', () => {
    const brain = new Brain();
    expect(liveMap(brain, null, brain.tick(0, null), 0).rover).toBeNull();
  });

  test('box lines are not maps', () => {
    expect(parseLiveMap(JSON.stringify({ t: 1, width: 10, height: 10, boxes: [] }))).toBeNull();
    expect(parseLiveMap('not json')).toBeNull();
  });
});
