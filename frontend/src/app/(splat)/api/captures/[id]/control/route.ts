import { del } from '@vercel/blob';

import { blobPath, publicJob, type StoredJob } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { jobStore, k, redis } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

type Action = 'pause' | 'resume' | 'cancel';

/**
 * Pauses, resumes or cancels a capture's training, for the app: `{ "action": "pause" | "resume" |
 * "cancel" }`. A job the Mac agent hasn't started is held back or dropped here, by taking it off
 * the queue; one Brush is on gets a `pause:`, `resume:` or `cancel:` entry on the same queue, which
 * the agent acts on (see agent.ts). Cancelling keeps nothing: the capture trains again only when
 * the app uploads it again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return unauthorized();
  const { id } = await params;
  const { action } = ((await request.json().catch(() => null)) ?? {}) as { action?: Action };
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    return json({ error: 'action must be pause, resume or cancel' }, 400);
  }
  const store = jobStore();
  const job = await store.get(id);
  if (!job) return json({ error: `no capture ${id}` }, 404);

  let next: StoredJob;
  if (action === 'pause') {
    if (job.state !== 'queued' && job.state !== 'training') return json({ error: `capture ${id} is ${job.state}` }, 409);
    if (job.state === 'queued') await redis().lrem(k.queue, 0, id);
    else await redis().rpush(k.queue, `pause:${id}`);
    next = { ...job, state: 'paused', pausedFrom: job.state };
  } else if (action === 'resume') {
    if (job.state !== 'paused') return json({ error: `capture ${id} is ${job.state}` }, 409);
    const { pausedFrom = 'queued', ...rest } = job;
    if (pausedFrom === 'queued') await redis().rpush(k.queue, id);
    else await redis().rpush(k.queue, `resume:${id}`);
    next = { ...rest, state: pausedFrom };
  } else {
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      return json({ error: `capture ${id} is ${job.state}` }, 409);
    }
    const { pausedFrom, ...rest } = job;
    const onTheMac = job.state === 'training' || (job.state === 'paused' && pausedFrom === 'training');
    if (onTheMac) {
      // The agent stops Brush and removes what it made.
      await redis().rpush(k.queue, `cancel:${id}`);
    } else {
      await redis().lrem(k.queue, 0, id);
      const files = [...job.snapshots.map((step) => blobPath.snapshot(id, step)), blobPath.zip(id)];
      // An upload that never finished has no zip; nothing to remove then.
      await del(files).catch(() => {});
    }
    next = { ...rest, state: 'cancelled', step: 0, snapshots: [], gaussians: null, trainSeconds: null, error: null };
  }
  return json(publicJob(await store.put(next)));
}

export { preflight as OPTIONS };
