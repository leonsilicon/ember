import { ENDPOINTS, type Endpoint } from '#rover/protocol.ts';
import { authorized } from '#web/auth.ts';
import { roverTarget } from '#web/rover-proxy.ts';

export const dynamic = 'force-dynamic';

/** Longer than the rover's own client timeout (900 ms), so the browser gives up first. */
const UPSTREAM_TIMEOUT_MS = 1200;
const MAX_BODY_BYTES = 2048;

/**
 * The same-origin proxy to the rover's firmware (firmware/DualServoBench, see rover/protocol.ts):
 * `/api/rover/<endpoint>` forwards to `<rover>/<endpoint>` for the three endpoints the firmware has,
 * with the form body as is, and hands the rover's status and body back. The rover has no CORS and
 * is plain http, so a page can't call it directly; its own server can, when it runs on the laptop
 * on the rover's Wi-Fi. On Vercel it can't (no local network), and says so.
 */
async function forward(request: Request, { params }: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = await params;
  if (!authorized(request)) return text('missing or wrong access token', 401);
  // The browser's own pages only: a page on another origin gets no cookie anyway, but say so plainly.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) return text('Origin rejected', 403);
  if (!(endpoint in ENDPOINTS) || ENDPOINTS[endpoint as Endpoint] !== request.method) return text('Unsupported rover endpoint or method', 405);
  if (process.env.VERCEL) return text("The site on Vercel can't reach the rover: it's on the laptop's Wi-Fi. Drive from the dev server on the laptop.", 503);
  const target = roverTarget(request);
  if ('error' in target) return text(target.error, target.status);

  let body: string | undefined;
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY_BYTES) return text('Body too large', 413);
  }
  try {
    const upstream = await fetch(`${target.url}/${endpoint}`, {
      method: request.method,
      headers: body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return text(`Rover unreachable at ${target.url}. Is this laptop on the rover's Wi-Fi?`, 502);
  }
}

const text = (message: string, status: number) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export { forward as GET, forward as POST };
