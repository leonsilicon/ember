import { authorized } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { agentInfo } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

/** The live sessions the Mac agent has (it keeps the last few in memory). */
export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  return json({ sessions: (await agentInfo())?.sessions ?? [] });
}

export { preflight as OPTIONS };
