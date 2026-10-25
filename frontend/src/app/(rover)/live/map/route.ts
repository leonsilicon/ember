import { upgradeWebSocket } from '@vercel/functions';

import { authorized, roomOf } from '#web/auth.ts';
import { unauthorized } from '#web/http.ts';
import { roomRelay } from '#web/rooms.ts';

export const dynamic = 'force-dynamic';
// Sockets close at the function's limit (300 s on Hobby); the page reconnects and carries on.
export const maxDuration = 300;

/**
 * A browser watching a room's live map (the control page's top view): the room is the username it
 * signed in as, or `?room=`. It's told the room first (`{ type: 'room' }`), then gets each map line
 * the phone sends there (see web/rooms.ts).
 */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const room = roomOf(request);
  return upgradeWebSocket((ws) => roomRelay().watch(ws, room));
}
