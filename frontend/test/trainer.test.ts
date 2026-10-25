import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Redis from 'ioredis';

import { directoryStorage } from '../src/agent/storage';
import { Trainer } from '../src/agent/trainer';
import { connect, keys } from '../src/bus';
import type { ServerConfig } from '../src/config';
import { isUnsafeEntry } from '../src/dataset';
import { blobPath, JobStore, newJob } from '../src/jobs';
import { testPrefix } from './redis';

const FAKE_BRUSH = path.join(import.meta.dir, 'fixtures/fake-brush.sh');
const FAILING_BRUSH = path.join(import.meta.dir, 'fixtures/failing-brush.sh');
const SLOW_BRUSH = path.join(import.meta.dir, 'fixtures/slow-brush.sh');

const redis: Redis = connect();
let root: string;
let blobDir: string;
let store: JobStore;

afterAll(() => redis.disconnect());

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'splat-trainer-'));
  blobDir = path.join(root, 'blob');
  store = new JobStore(redis, keys(testPrefix()).jobs);
  process.env.BRUSH_ARGS_FILE = path.join(root, 'brush-args.txt');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function trainer(brushBin: string | null, storage = directoryStorage(blobDir)) {
  const config: ServerConfig = {
    port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), brushBin, steps: 300, exportEvery: 100,
    maxResolution: 960, shDegree: 1, growthFraction: 0.5, maxSplats: 600_000, depthWorkerBin: null, depthModel: null,
    live: { voxelSize: 0.02, maxDepth: 4, gridWidth: 256, gridHeight: 192 },
  };
  return new Trainer(store, storage, config);
}

/**
 * Puts a capture where the phone's upload would (its zip in storage, its job queued). The zip is
 * laid out like the phone's: one top-level folder holding transforms.json.
 */
async function queueCapture(id: string, frames: { file_path: string }[], files = ['images/frame_00000.jpg']) {
  const dataset = path.join(root, 'phone', id, 'dataset');
  await mkdir(path.join(dataset, 'images'), { recursive: true });
  for (const f of files) await writeFile(path.join(dataset, f), 'jpeg bytes');
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const transforms = { ply_file_path: 'points.ply', frames: frames.map((f) => ({ ...f, transform_matrix: identity, fl_x: 900, fl_y: 900, w: 1280, h: 960 })) };
  await writeFile(path.join(dataset, 'transforms.json'), JSON.stringify(transforms));
  await writeFile(path.join(dataset, 'points.ply'), 'ply\n');
  await writeFile(path.join(dataset, 'capture.json'), JSON.stringify({ mode: 'features', points: 1234 }));
  const zip = path.join(blobDir, blobPath.zip(id));
  await mkdir(path.dirname(zip), { recursive: true });
  expect(spawnSync('zip', ['-qr', zip, 'dataset'], { cwd: path.dirname(dataset) }).status).toBe(0);
  await store.put({ ...newJob(id), state: 'queued' });
}

const stored = (pathname: string) => readFile(path.join(blobDir, pathname), 'utf8').catch(() => null);

describe('training a queued capture', () => {
  test('trains it and keeps only the final snapshot in storage', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(FAKE_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    const job = await store.get('cap-1');
    expect(job).toMatchObject({ state: 'done', mode: 'features', frames: 1, seedPoints: 1234, step: 300, steps: 300, gaussians: 3000, snapshots: [300] });
    expect(await stored(blobPath.snapshot('cap-1', 300))).toContain('element vertex 3000');
    expect(await stored(blobPath.snapshot('cap-1', 200))).toBeNull();
    expect(JSON.parse((await stored(blobPath.transforms('cap-1')))!).frames).toHaveLength(1);
    // The zip has done its job.
    expect(await stored(blobPath.zip('cap-1'))).toBeNull();
    expect(await readdir(t.runDir('cap-1'))).toContain('splat_300.ply');
    expect((await readdir(t.runDir('cap-1'))).filter((f) => f.endsWith('.ply'))).toEqual(['splat_300.ply']);
  });

  test('publishes the final snapshot even when Brush exits during an upload', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    // Uploads as slow as a 10 MB snapshot's to Blob: Brush finishes while the first is still going.
    const storage = directoryStorage(blobDir);
    const slow = { ...storage, upload: async (...args: Parameters<typeof storage.upload>) => {
      if (args[0].endsWith('.ply')) await new Promise((resolve) => setTimeout(resolve, 2500));
      return storage.upload(...args);
    } };
    const t = trainer(SLOW_BRUSH, slow);
    t.enqueue('cap-1');
    await t.whenIdle();
    expect(await store.get('cap-1')).toMatchObject({ state: 'done', step: 300, gaussians: 3000, snapshots: [300] });
    expect(await stored(blobPath.snapshot('cap-1', 100))).toBeNull();
    expect((await readdir(t.runDir('cap-1'))).filter((f) => f.endsWith('.ply'))).toEqual(['splat_300.ply']);
  }, 20_000);

  test('keeps training when a snapshot cannot be published for a while', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    // The first snapshot's upload finds the network down (past storage's own retries); a later tick sends it.
    const storage = directoryStorage(blobDir);
    let plyUploads = 0;
    const flaky = { ...storage, upload: async (...args: Parameters<typeof storage.upload>) => {
      if (args[0].endsWith('.ply') && ++plyUploads === 1) throw new TypeError('ECONNRESET: The socket connection was closed unexpectedly.');
      return storage.upload(...args);
    } };
    const t = trainer(SLOW_BRUSH, flaky);
    t.enqueue('cap-1');
    await t.whenIdle();
    expect(plyUploads).toBeGreaterThanOrEqual(2);
    expect(await store.get('cap-1')).toMatchObject({ state: 'done', step: 300, gaussians: 3000, snapshots: [300] });
    expect(await stored(blobPath.snapshot('cap-1', 300))).toContain('element vertex 3000');
  }, 20_000);

  test('says so when the splat is trained but cannot be stored', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const storage = directoryStorage(blobDir);
    const down = { ...storage, upload: async (...args: Parameters<typeof storage.upload>) => {
      if (args[0].endsWith('.ply')) throw new TypeError('ECONNRESET: The socket connection was closed unexpectedly.');
      return storage.upload(...args);
    } };
    const t = trainer(FAKE_BRUSH, down);
    t.enqueue('cap-1');
    await t.whenIdle();
    const job = await store.get('cap-1');
    expect(job?.state).toBe('failed');
    expect(job?.error).toContain("trained, but the splat couldn't be stored");
    expect(job?.error).toContain('ECONNRESET');
    // The splat is still on disk, and the zip in storage, for when the network is back.
    expect(await readdir(t.runDir('cap-1'))).toContain('splat_300.ply');
    expect(await stored(blobPath.zip('cap-1'))).not.toBeNull();
  });

  test('passes the growth fraction and splat cap to Brush', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(FAKE_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    const args = await readFile(process.env.BRUSH_ARGS_FILE!, 'utf8');
    expect(args).toContain('--growth-select-fraction 0.5');
    expect(args).toContain('--max-splats 600000');
  });

  test('reports a Brush failure with its stderr', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(FAILING_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    const job = await store.get('cap-1');
    expect(job?.state).toBe('failed');
    expect(job?.error).toContain('code 3');
    expect(job?.error).toContain('GPU on fire');
  });

  test('fails clearly when Brush is not installed', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(null);
    t.enqueue('cap-1');
    await t.whenIdle();
    expect((await store.get('cap-1'))?.error).toContain('install-brush.sh');
  });

  test('rejects a dataset whose images are missing', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00001.jpg' }]);
    const t = trainer(FAKE_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    expect(await store.get('cap-1')).toMatchObject({ state: 'failed', error: 'missing image images/frame_00001.jpg' });
  });

  test('rejects frame paths that escape the dataset', async () => {
    await queueCapture('cap-1', [{ file_path: '../../etc/passwd' }]);
    const t = trainer(FAKE_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    expect((await store.get('cap-1'))?.error).toContain('bad frame path');
  });

  test('a Brush binary that cannot start fails the job without stalling the queue', async () => {
    await queueCapture('first', [{ file_path: 'images/frame_00000.jpg' }]);
    await queueCapture('second', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(path.join(root, 'missing-brush'));
    t.enqueue('first');
    t.enqueue('second');
    await t.whenIdle();
    expect((await store.get('first'))?.state).toBe('failed');
    expect((await store.get('second'))?.error).toContain('ENOENT');
  });

  test('trains a job only while it is queued, so a repeated queue entry does nothing', async () => {
    await queueCapture('cap-1', [{ file_path: 'images/frame_00000.jpg' }]);
    const t = trainer(FAKE_BRUSH);
    t.enqueue('cap-1');
    await t.whenIdle();
    const done = await store.get('cap-1');
    t.enqueue('cap-1');
    await t.whenIdle();
    expect(await store.get('cap-1')).toEqual(done);
  });
});

test('archive entries that escape the extraction dir are unsafe', () => {
  expect(isUnsafeEntry('dataset/images/a.jpg')).toBe(false);
  expect(isUnsafeEntry('../a.jpg')).toBe(true);
  expect(isUnsafeEntry('dataset/../../a.jpg')).toBe(true);
  expect(isUnsafeEntry('/etc/passwd')).toBe(true);
});
