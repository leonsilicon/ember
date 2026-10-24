import { get } from '@vercel/blob';

import { blobPath } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { CORS, json, preflight, unauthorized } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/**
 * A training snapshot: `?step=N` asks for the one the client just saw in the job (the newest or
 * the one before it, see StoredJob); otherwise the newest.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return unauthorized();
  const { id } = await params;
  const job = await jobStore().get(id);
  if (!job) return json({ error: `no capture ${id}` }, 404);
  if (job.step === 0) return json({ error: 'no snapshot yet' }, 404);
  const requested = Number(new URL(request.url).searchParams.get('step'));
  const step = Number.isInteger(requested) && requested > 0 ? requested : job.step;
  if (!job.snapshots.includes(step)) return json({ error: `snapshot ${step} is gone; refetch the job` }, 404);
  // Each step has its own path, so the CDN's copy is always right.
  const result = await get(blobPath.snapshot(id, step), { access: 'private' });
  if (result?.statusCode !== 200) return json({ error: `snapshot ${step} is gone; refetch the job` }, 404);
  return new Response(result.stream, {
    headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-cache' },
  });
}

export { preflight as OPTIONS };
