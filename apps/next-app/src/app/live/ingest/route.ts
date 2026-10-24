import { upgradeWebSocket } from '@vercel/functions';

import { authorized } from '#web/auth.ts';
import { unauthorized } from '#web/http.ts';
import { relaySocket } from '#web/relay.ts';

export const dynamic = 'force-dynamic';
// Sockets close at the function's limit (300 s on Hobby); the phone reconnects and carries on.
export const maxDuration = 300;

/** A phone streaming a recording (see live/protocol.ts). Keyframes with LiDAR depth are ~350 KB. */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  return upgradeWebSocket((ws) => relaySocket(ws, 'phone', null), { maxPayload: 8 * 1024 ** 2 });
}
