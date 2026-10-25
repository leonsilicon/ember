import { upgradeWebSocket } from '@vercel/functions';

import { normalizeUsername } from '#rooms.ts';
import { authorized } from '#web/auth.ts';
import { json, unauthorized } from '#web/http.ts';
import { roomRelay } from '#web/rooms.ts';

export const dynamic = 'force-dynamic';
// Sockets close at the function's limit (300 s on Hobby); the phone reconnects and carries on.
export const maxDuration = 300;

/**
 * A phone sending its rover brain's live map to its room, `?room=<username>` (the app's
 * use-room-publisher.ts): text messages, one map line each, for the browsers signed in as that
 * username. It's told how many are watching (`{ type: 'watching' }`), and sends nothing to nobody.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const room = normalizeUsername(new URL(request.url).searchParams.get('room'));
  if (!room) return json({ error: 'room: a username is needed (?room=)' }, 400);
  return upgradeWebSocket((ws) => roomRelay().sendFrom(ws, room), { maxPayload: 64 * 1024 });
}
