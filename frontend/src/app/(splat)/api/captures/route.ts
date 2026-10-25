import { del, issueSignedToken, presignUrl } from '@vercel/blob';

import { blobPath, newJob, publicJob, UPLOAD_WINDOW_MS } from '#jobs.ts';
import { inRoom, normalizeUsername } from '#rooms.ts';
import { authorized, roomOf } from '#web/auth.ts';
import { CAPTURE_ID, json, preflight, unauthorized } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/** The most the phone may upload (captures are a few hundred MB). */
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

/** The captures in the request's room (see rooms.ts): a browser's username, or every room's for a token. */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const room = roomOf(request);
  return json({ captures: (await jobStore().list()).filter((job) => inRoom(room, job.room)).map(publicJob) });
}

/**
 * Starts a capture upload (X-Capture-Id names it; X-Room is the username the phone is set to, whose
 * browsers list it). The phone PUTs the zip straight to the Blob store at `uploadUrl`, then POSTs
 * `/api/captures/:id/uploaded` to queue it for the Mac.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return unauthorized();
  const requested = request.headers.get('x-capture-id') ?? '';
  const id = CAPTURE_ID.test(requested) ? requested : `cap-${Date.now().toString(36)}`;
  const room = normalizeUsername(request.headers.get('x-room'));
  const store = jobStore();
  const existing = await store.get(id);
  if (existing?.state === 'queued' || existing?.state === 'training' || existing?.state === 'paused') {
    return json({ error: `capture ${id} is already ${existing.state}; cancel it first` }, 409);
  }
  // Uploading a capture again trains it from scratch.
  if (existing?.snapshots.length) await del(existing.snapshots.map((step) => blobPath.snapshot(id, step)));
  const job = await store.put(newJob(id, room));

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
