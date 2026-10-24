import { upgradeWebSocket } from '@vercel/functions';

import { authorized } from '#web/auth.ts';
import { unauthorized } from '#web/http.ts';
import { relaySocket } from '#web/relay.ts';

export const dynamic = 'force-dynamic';
// Sockets close at the function's limit (300 s on Hobby); the page reconnects and catches up.
export const maxDuration = 300;

/** A browser watching the live reconstruction: `?session=` for one recording, or the newest. */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const session = new URL(request.url).searchParams.get('session');
  return upgradeWebSocket((ws) => relaySocket(ws, 'viewer', session));
}
