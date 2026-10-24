import { BlobNotFoundError, head } from '@vercel/blob';

import { blobPath, publicJob } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { jobStore, k, redis } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/** The phone finished uploading the zip: queue the capture for the Mac agent to train. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return unauthorized();
  const { id } = await params;
  const store = jobStore();
  const job = await store.get(id);
  if (!job) return json({ error: `no capture ${id}` }, 404);
  if (job.state !== 'uploading') return json({ error: `capture ${id} is already ${job.state}` }, 409);
  try {
    await head(blobPath.zip(id));
  } catch (error) {
    if (error instanceof BlobNotFoundError) return json({ error: `capture ${id} has no uploaded zip` }, 409);
    throw error;
  }
  const queued = await store.put({ ...job, state: 'queued' });
  await redis().rpush(k.queue, id);
  return json({ ...publicJob(queued), viewerPath: `/view/${id}` }, 201);
}

export { preflight as OPTIONS };
