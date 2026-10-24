import { get } from '@vercel/blob';

import { blobPath } from '#jobs.ts';
import { authorized } from '#web/auth.ts';
import { CORS, json, preflight, unauthorized } from '#web/http.ts';

export const dynamic = 'force-dynamic';

/** The capture's camera poses (the viewer starts where the phone started). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return unauthorized();
  const { id } = await params;
  // Training again replaces it at the same path, so skip the CDN's copy.
  const result = await get(blobPath.transforms(id), { access: 'private', useCache: false });
  if (result?.statusCode !== 200) return json({ error: `no transforms for capture ${id} yet` }, 404);
  return new Response(result.stream, {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' },
  });
}

export { preflight as OPTIONS };
