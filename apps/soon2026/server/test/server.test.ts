import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app';
import type { ServerConfig } from '../src/config';
import { isUnsafeEntry } from '../src/dataset';

// Stands in for brush_app: writes a snapshot PLY every --export-every steps, with the
// step zero-padded to the width of --total-steps as Brush does (splat_0100.ply for 1000 steps).
const FAKE_BRUSH = `#!/bin/bash
echo "$@" > "$(dirname "$0")/brush-args.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --export-path) out="$2"; shift ;;
    --total-steps) steps="$2"; shift ;;
    --export-every) every="$2"; shift ;;
  esac
  shift
done
for ((i = every; i <= steps; i += every)); do
  name=$(printf "splat_%0\${#steps}d.ply" $i)
  printf 'ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nend_header\\n' $((i * 10)) > "$out/$name"
done
`;

let root: string;

async function makeConfig(brush: string | null): Promise<ServerConfig> {
  return { port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), brushBin: brush, steps: 300, exportEvery: 100, maxResolution: 960, shDegree: 1, growthFraction: 0.5, maxSplats: 600_000, depthWorkerBin: null, depthModel: null, live: { voxelSize: 0.02, maxDepth: 4, gridWidth: 256, gridHeight: 192 } };
}

async function fakeBrush(script = FAKE_BRUSH) {
  const file = path.join(root, 'brush_app');
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}

/** Zips a dataset the way the phone does: one top-level folder holding transforms.json. */
async function captureZip(frames: { file_path: string }[], files: string[] = ['images/frame_00000.jpg']) {
  const dataset = path.join(root, 'phone', 'dataset');
  await mkdir(path.join(dataset, 'images'), { recursive: true });
  for (const f of files) await writeFile(path.join(dataset, f), 'jpeg bytes');
  await writeFile(
    path.join(dataset, 'transforms.json'),
    JSON.stringify({ ply_file_path: 'points.ply', frames: frames.map((f) => ({ ...f, transform_matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], fl_x: 900, fl_y: 900, w: 1280, h: 960 })) }),
  );
  await writeFile(path.join(dataset, 'points.ply'), 'ply\n');
  await writeFile(path.join(dataset, 'capture.json'), JSON.stringify({ mode: 'features', points: 1234 }));
  const zip = path.join(root, 'capture.zip');
  const proc = Bun.spawn(['zip', '-qr', zip, 'dataset'], { cwd: path.join(root, 'phone') });
  expect(await proc.exited).toBe(0);
  return zip;
}

type App = Awaited<ReturnType<typeof createApp>>;

async function getJson<T = Record<string, any>>(app: App, url: string): Promise<T> {
  return (await (await app.fetch(new Request(`http://localhost${url}`))).json()) as T;
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function upload(app: App, zip: string, id = 'cap-test-1') {
  return app.fetch(
    new Request('http://localhost/api/captures', { method: 'POST', headers: { 'X-Capture-Id': id }, body: Bun.file(zip) }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'splat-server-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('capture upload → training → viewing', () => {
  test('trains an uploaded capture and serves the final snapshot', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    const res = await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    expect(res.status).toBe(201);
    expect(await body(res)).toMatchObject({ id: 'cap-test-1', state: 'queued', frames: 1, mode: 'features', seedPoints: 1234, viewerPath: '/view/cap-test-1' });

    await app.trainer.whenIdle();
    const job = await getJson(app, '/api/captures/cap-test-1');
    expect(job).toMatchObject({ state: 'done', step: 300, steps: 300, gaussians: 3000, error: null });
    expect(job.datasetDir).toBeUndefined();

    const ply = await app.fetch(new Request('http://localhost/api/captures/cap-test-1/splat.ply'));
    expect(ply.status).toBe(200);
    expect(ply.headers.get('access-control-allow-origin')).toBe('*');
    expect(await ply.text()).toContain('element vertex 3000');

    const viewer = await app.fetch(new Request('http://localhost/view/cap-test-1'));
    expect(await viewer.text()).toContain('@sparkjsdev/spark@2.3.1');
    const list = await getJson(app, '/api/captures');
    expect(list.captures.map((c: { id: string }) => c.id)).toEqual(['cap-test-1']);
  });

  test('passes the growth fraction and splat cap to Brush', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await app.trainer.whenIdle();
    const args = await Bun.file(path.join(root, 'brush-args.txt')).text();
    expect(args).toContain('--growth-select-fraction 0.5');
    expect(args).toContain('--max-splats 600000');
  });

  test('keeps only the newest snapshot on disk', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await app.trainer.whenIdle();
    const files = await Array.fromAsync(new Bun.Glob('splat_*.ply').scan(app.trainer.runDir('cap-test-1')));
    expect(files).toEqual(['splat_300.ply']);
  });

  test('serves the snapshot step the client asks for', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await app.trainer.whenIdle();
    const exact = await app.fetch(new Request('http://localhost/api/captures/cap-test-1/splat.ply?step=300'));
    expect(await exact.text()).toContain('element vertex 3000');
    const gone = await app.fetch(new Request('http://localhost/api/captures/cap-test-1/splat.ply?step=100'));
    expect(gone.status).toBe(404);
    const traversal = await app.fetch(new Request('http://localhost/api/captures/cap-test-1/splat.ply?step=../x'));
    expect(traversal.status).toBe(200); // falls back to the newest snapshot
  });

  test('reports a Brush failure with its stderr', async () => {
    const app = await createApp(await makeConfig(await fakeBrush('#!/bin/bash\necho "GPU on fire" >&2\nexit 3\n')));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await app.trainer.whenIdle();
    const job = await getJson(app, '/api/captures/cap-test-1');
    expect(job.state).toBe('failed');
    expect(job.error).toContain('code 3');
    expect(job.error).toContain('GPU on fire');
  });

  test('fails clearly when Brush is not installed', async () => {
    const app = await createApp(await makeConfig(null));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await app.trainer.whenIdle();
    const job = await getJson(app, '/api/captures/cap-test-1');
    expect(job).toMatchObject({ state: 'failed' });
    expect(job.error).toContain('install-brush.sh');
  });

  test('rejects a dataset whose images are missing', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    const res = await upload(app, await captureZip([{ file_path: 'images/frame_00001.jpg' }]));
    expect(res.status).toBe(422);
    expect((await body(res)).error).toContain('missing image');
  });

  test('rejects frame paths that escape the dataset', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    const res = await upload(app, await captureZip([{ file_path: '../../etc/passwd' }]));
    expect(res.status).toBe(422);
  });

  test('replaces an unsafe capture id with a generated one', async () => {
    const app = await createApp(await makeConfig(await fakeBrush()));
    const res = await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]), '../escape');
    expect((await body(res)).id).toMatch(/^cap-[a-z0-9]+$/);
    await app.trainer.whenIdle();
  });

  test('a Brush binary that cannot start fails the job without stalling the queue', async () => {
    const app = await createApp(await makeConfig(path.join(root, 'missing-brush')));
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]), 'first');
    await upload(app, await captureZip([{ file_path: 'images/frame_00000.jpg' }]), 'second');
    await app.trainer.whenIdle();
    expect(app.store.get('first')?.state).toBe('failed');
    expect(app.store.get('second')?.state).toBe('failed');
    expect(app.store.get('second')?.error).toContain('ENOENT');
  });

  test('resumes queued jobs after a restart', async () => {
    const config = await makeConfig(null);
    const first = await createApp(config);
    await upload(first, await captureZip([{ file_path: 'images/frame_00000.jpg' }]));
    await first.trainer.whenIdle();
    await first.store.flush();

    const restarted = await createApp({ ...config, brushBin: await fakeBrush() });
    const job = restarted.store.get('cap-test-1')!;
    restarted.store.update({ ...job, state: 'training' });
    restarted.trainer.enqueue('cap-test-1');
    await restarted.trainer.whenIdle();
    expect(restarted.store.get('cap-test-1')?.state).toBe('done');
  });
});

test('archive entries that escape the extraction dir are unsafe', () => {
  expect(isUnsafeEntry('dataset/images/a.jpg')).toBe(false);
  expect(isUnsafeEntry('../a.jpg')).toBe(true);
  expect(isUnsafeEntry('dataset/../../a.jpg')).toBe(true);
  expect(isUnsafeEntry('/etc/passwd')).toBe(true);
});
