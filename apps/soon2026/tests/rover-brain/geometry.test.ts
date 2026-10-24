import { describe, expect, test } from 'bun:test';

import {
  angleDiffDeg,
  decodeDepth,
  depthAt,
  headingFromPose,
  rayToFloor,
  toRover,
  transformPoint,
  unproject,
  uprightToSensor,
} from '../../src/lib/rover-brain/geometry';
import { FRAME, K, pose, renderDepth, toFrame } from './scene';

describe('heading', () => {
  test('forward is the view flattened, right is clockwise from above', () => {
    const h = headingFromPose(pose([0, 0.3, 0], 30, 0))!;
    expect(h.forward[0]).toBeCloseTo(0);
    expect(h.forward[2]).toBeCloseTo(-1);
    expect(h.right[0]).toBeCloseTo(1);
    expect(h.yawDeg).toBeCloseTo(0);
    const turned = headingFromPose(pose([0, 0.3, 0], 30, 90))!;
    expect(turned.forward[0]).toBeCloseTo(1);
    expect(turned.yawDeg).toBeCloseTo(90);
  });

  test('looking straight down has no heading', () => {
    expect(headingFromPose(pose([0, 0.3, 0], 90, 0))).toBeNull();
  });

  test('toRover gives distance and signed bearing', () => {
    const h = headingFromPose(pose([1, 0.3, 1], 20, 0))!;
    const r = toRover([2, 0, 0], h); // 1 m right, 1 m ahead
    expect(r.distance).toBeCloseTo(Math.SQRT2);
    expect(r.bearingDeg).toBeCloseTo(45);
    expect(toRover([0, 0, 0], h).bearingDeg).toBeCloseTo(-45);
    expect(Object.is(toRover([1, 0, 0], h).bearingDeg, -0)).toBe(false);
  });

  test('angleDiffDeg wraps', () => {
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20);
    expect(angleDiffDeg(350, 10)).toBeCloseTo(-20);
    expect(angleDiffDeg(180, -180)).toBeCloseTo(0);
  });
});

describe('pixels', () => {
  test('uprightToSensor undoes the quarter turn and scale', () => {
    const p = pose([0, 0.3, 0], 20, 0);
    const world: [number, number, number] = [0.4, 0, -1.5];
    const [u, v] = toFrame(p, world)!;
    const [x, y] = uprightToSensor(u, v, FRAME, K);
    // Back through the sensor pixel at the true depth lands on the point.
    const o = [p[12], p[13], p[14]];
    const depth = -(
      p[8] * (world[0] - o[0]) + p[9] * (world[1] - o[1]) + p[10] * (world[2] - o[2])
    );
    const back = transformPoint(p, unproject(x, y, depth, K));
    expect(back[0]).toBeCloseTo(world[0], 4);
    expect(back[2]).toBeCloseTo(world[2], 4);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(FRAME.width);
  });

  test('ray onto the floor and above the horizon', () => {
    const p = pose([0, 0.3, 0], 20, 0);
    const centre = rayToFloor(K.cx, K.cy, p, K, 0)!;
    expect(centre[1]).toBeCloseTo(0);
    expect(-centre[2]).toBeCloseTo(0.3 / Math.tan((20 * Math.PI) / 180), 4);
    // Top of the sensor image in landscape is above a 20° pitch? 1440/2/1400 → ~27° up from the axis.
    expect(rayToFloor(K.cx, 0, p, K, 0)).toBeNull();
  });
});

describe('depth', () => {
  test('decodes misaligned bytes and reads a median', () => {
    const raw = renderDepth(pose());
    const shifted = new Uint8Array(raw.data.byteLength + 1);
    shifted.set(raw.data, 1);
    const map = decodeDepth({ ...raw, data: shifted.subarray(1) })!;
    expect(map.values.length).toBe(raw.width * raw.height);
    expect(depthAt(map, K.cx, K.cy + 300, K)).toBeGreaterThan(0.3);
    expect(decodeDepth({ ...raw, data: raw.data.subarray(0, 10) })).toBeUndefined();
    expect(decodeDepth(undefined)).toBeUndefined();
  });

  test('skips low-confidence and missing readings', () => {
    const raw = renderDepth(pose());
    raw.confidence.fill(0);
    expect(depthAt(decodeDepth(raw)!, K.cx, K.cy + 300, K)).toBeNull();
    const empty = { ...raw, data: new Uint8Array(raw.data.byteLength), confidence: undefined };
    expect(depthAt(decodeDepth(empty)!, K.cx, K.cy, K)).toBeNull();
  });
});
