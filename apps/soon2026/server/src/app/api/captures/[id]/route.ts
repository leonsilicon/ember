import { publicJob } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return unauthorized();
  const { id } = await params;
  const job = await jobStore().get(id);
  if (!job) return json({ error: `no capture ${id}` }, 404);
  return json(publicJob(job));
}

export { preflight as OPTIONS };
