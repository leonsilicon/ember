import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ServerConfig } from './config';
import { DatasetError, extractCapture } from './dataset';
import { JobStore, publicJob, Trainer } from './jobs';
import { indexPage, viewerPage } from './pages';

const CAPTURE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// Any origin may read the API, so a teammate's own web app can list and load splats.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Capture-Id',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

function html(body: string) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function createApp(config: ServerConfig) {
  await mkdir(path.join(config.dataDir, 'uploads'), { recursive: true });
  const store = new JobStore(path.join(config.dataDir, 'jobs.json'));
  await store.load();
  const trainer = new Trainer(store, config);
  // Anything interrupted by a restart trains again from the start.
  for (const job of store.list()) {
    if (job.state === 'queued' || job.state === 'training') trainer.enqueue(job.id);
  }

  async function receiveCapture(request: Request) {
    const requested = request.headers.get('x-capture-id') ?? '';
    const id = CAPTURE_ID.test(requested) ? requested : `cap-${Date.now().toString(36)}`;
    if (trainer.isBusyWith(id)) return json({ error: `capture ${id} is already training` }, 409);
    if (!request.body) return json({ error: 'empty upload' }, 400);

    const zipPath = path.join(config.dataDir, 'uploads', `${id}.zip`);
    const bytes = await Bun.write(zipPath, new Response(request.body));
    if (bytes === 0) return json({ error: 'empty upload' }, 400);

    const extractDir = path.join(config.dataDir, 'captures', id);
    await rm(extractDir, { recursive: true, force: true });
    try {
      const capture = await extractCapture(zipPath, extractDir);
      const job = store.update({
        id,
        createdAt: new Date().toISOString(),
        state: 'queued',
        mode: capture.mode,
        frames: capture.frames,
        seedPoints: capture.seedPoints,
        steps: config.steps,
        step: 0,
        gaussians: null,
        trainSeconds: null,
        error: null,
        focus: capture.focus,
        datasetDir: capture.datasetDir,
      });
      trainer.enqueue(id);
      return json({ ...publicJob(job), viewerPath: `/view/${id}` }, 201);
    } catch (error) {
      await rm(extractDir, { recursive: true, force: true });
      if (error instanceof DatasetError) return json({ error: error.message }, 422);
      throw error;
    } finally {
      await rm(zipPath, { force: true });
    }
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/') return html(indexPage(store.list().map(publicJob)));
    if (url.pathname === '/health') {
      return json({ ok: true, brush: config.brushBin, steps: config.steps, maxResolution: config.maxResolution });
    }
    if (url.pathname === '/api/captures') {
      if (request.method === 'POST') return receiveCapture(request);
      return json({ captures: store.list().map(publicJob) });
    }

    const [scope, kind, id, asset] = parts;
    if (scope === 'view' && kind && CAPTURE_ID.test(kind) && store.get(kind)) return html(viewerPage(kind));
    if (scope !== 'api' || kind !== 'captures' || !id) return json({ error: 'not found' }, 404);
    const job = store.get(id);
    if (!job) return json({ error: `no capture ${id}` }, 404);

    if (!asset) return json(publicJob(job));
    if (asset === 'transforms.json') {
      return new Response(Bun.file(path.join(job.datasetDir, 'transforms.json')), { headers: CORS });
    }
    if (asset === 'splat.ply') {
      if (job.step === 0) return json({ error: 'no snapshot yet' }, 404);
      // ?step=N asks for a specific snapshot (the one the client just saw in the job);
      // otherwise the newest.
      const requested = Number(url.searchParams.get('step'));
      const step = Number.isInteger(requested) && requested > 0 ? requested : job.step;
      const snapshot = await trainer.snapshotPath(id, step);
      if (!snapshot) return json({ error: `snapshot ${step} is gone; refetch the job` }, 404);
      return new Response(Bun.file(snapshot), {
        headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
    }
    return json({ error: 'not found' }, 404);
  }

  return { fetch, store, trainer };
}
