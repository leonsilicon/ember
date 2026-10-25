import { inRoom } from '#rooms.ts';
import { authorized, roomOf } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { agentInfo } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/** The live sessions the Mac agent has (it keeps the last few in memory), in the request's room (see rooms.ts). */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const room = roomOf(request);
  const sessions = (await agentInfo())?.sessions ?? [];
  return json({ sessions: sessions.filter((session) => inRoom(room, session.room)) });
}

export { preflight as OPTIONS };
