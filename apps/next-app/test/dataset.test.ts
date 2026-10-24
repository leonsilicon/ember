import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { focusPoint } from '../src/dataset';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'splat-dataset-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Binary PLY in the layout the phone writes: float x/y/z + uchar red/green/blue. */
function ply(points: [number, number, number][]) {
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body = Buffer.alloc(points.length * 15);
  points.forEach(([x, y, z], i) => {
    body.writeFloatLE(x, i * 15);
    body.writeFloatLE(y, i * 15 + 4);
    body.writeFloatLE(z, i * 15 + 8);
  });
  return Buffer.concat([Buffer.from(header), body]);
}

// Camera at (0, 1.5, 0) looking down −z (identity rotation), 1280×960, ~65° horizontal FOV.
const frame = {
  transform_matrix: [[1, 0, 0, 0], [0, 1, 0, 1.5], [0, 0, 1, 0], [0, 0, 0, 1]],
  fl_x: 1000, fl_y: 1000, cx: 640, cy: 480, w: 1280, h: 960,
};

function grid(z: number, n = 10): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([(i - n / 2) * 0.05, 1.5 + (j - n / 2) * 0.05, z]);
  return out;
}

test('orbits around the median depth of what the first camera sees', async () => {
  // A wall 2 m ahead, plus clutter behind the camera and far off to the side that it can't see.
  const points = [...grid(-2), ...grid(3), ...grid(-2).map(([x, y, z]) => [x + 50, y, z] as [number, number, number])];
  await writeFile(path.join(dir, 'points.ply'), ply(points));
  const focus = await focusPoint(dir, frame, 'points.ply');
  expect(focus).not.toBeNull();
  expect(focus![0]).toBeCloseTo(0, 5);
  expect(focus![1]).toBeCloseTo(1.5, 5);
  expect(focus![2]).toBeCloseTo(-2, 3);
});

test('gives up without enough visible seed points', async () => {
  await writeFile(path.join(dir, 'points.ply'), ply(grid(-2, 3)));
  expect(await focusPoint(dir, frame, 'points.ply')).toBeNull();
  expect(await focusPoint(dir, frame, undefined)).toBeNull();
  expect(await focusPoint(dir, frame, 'missing.ply')).toBeNull();
});

test('ignores PLYs it cannot read rather than guessing', async () => {
  await writeFile(path.join(dir, 'points.ply'), 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n');
  expect(await focusPoint(dir, frame, 'points.ply')).toBeNull();
});
