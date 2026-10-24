import { del, issueSignedToken, presignUrl } from '@vercel/blob';

import { blobPath, newJob, publicJob } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { CAPTURE_ID, json, preflight, unauthorized } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/** How long the phone has to upload, and the most it may upload (captures are a few hundred MB). */
const UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  return json({ captures: (await jobStore().list()).map(publicJob) });
}

/**
 * Starts a capture upload (X-Capture-Id names it). The phone PUTs the zip straight to the Blob
 * store at `uploadUrl`, then POSTs `/api/captures/:id/uploaded` to queue it for the Mac.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return unauthorized();
  const requested = request.headers.get('x-capture-id') ?? '';
  const id = CAPTURE_ID.test(requested) ? requested : `cap-${Date.now().toString(36)}`;
  const store = jobStore();
  const existing = await store.get(id);
  if (existing?.state === 'queued' || existing?.state === 'training') {
    return json({ error: `capture ${id} is already training` }, 409);
  }
  // Uploading a capture again trains it from scratch.
  if (existing?.snapshots.length) await del(existing.snapshots.map((step) => blobPath.snapshot(id, step)));
  const job = await store.put(newJob(id));

  const pathname = blobPath.zip(id);
  const validUntil = Date.now() + UPLOAD_WINDOW_MS;
  const token = await issueSignedToken({ pathname, operations: ['put'], validUntil, maximumSizeInBytes: MAX_UPLOAD_BYTES });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'private',
    validUntil,
    maximumSizeInBytes: MAX_UPLOAD_BYTES,
    // The agent fetches it by this exact path; presigned uploads otherwise add a random suffix.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return json({ ...publicJob(job), uploadUrl: presignedUrl }, 201);
}

export { preflight as OPTIONS };
