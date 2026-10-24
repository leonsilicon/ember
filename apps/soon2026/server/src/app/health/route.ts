import { authorized } from '#web/auth.ts';
import { json, preflight, unauthorized } from '#web/http.ts';
import { agentInfo } from '#web/redis.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!authorized(request)) return unauthorized();
  const agent = await agentInfo();
  return json({
    ok: true,
    /** Whether the Mac agent is running; training and live 3D wait for it. */
    agent: Boolean(agent),
    brush: agent?.brush ?? false,
    depthWorker: agent?.depthWorker ?? false,
    steps: agent?.steps ?? null,
    maxResolution: agent?.maxResolution ?? null,
  });
}

export { preflight as OPTIONS };
