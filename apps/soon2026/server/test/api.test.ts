import { expect, test } from 'bun:test';

import { AGENT_TTL_SECONDS, connect, keys } from '../src/bus';
import { newJob } from '../src/jobs';

// From test/setup.ts.
const TOKEN = process.env.SPLAT_TOKEN!;

const request = (path: string, token: string | null = TOKEN) =>
  new Request(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test('every route wants the token', async () => {
  const captures = await import('../src/app/api/captures/route');
  const health = await import('../src/app/health/route');
  for (const response of [
    await captures.GET(request('/api/captures', null)),
    await captures.GET(request('/api/captures', 'wrong')),
    await captures.POST(new Request('http://localhost/api/captures', { method: 'POST' })),
    await health.GET(request('/health', null)),
  ]) {
    expect(response.status).toBe(401);
  }
  // A browser's cookie counts too (see proxy.ts).
  const cookie = new Request('http://localhost/api/captures', { headers: { Cookie: `splat_token=${TOKEN}` } });
  expect((await captures.GET(cookie)).status).toBe(200);
});

test('lists captures, and reports the Mac agent through its heartbeat', async () => {
  const redis = connect();
  const k = keys();
  try {
    await redis.hset(k.jobs, 'cap-1', JSON.stringify({ ...newJob('cap-1'), state: 'done', step: 300, snapshots: [300] }));
    const captures = await import('../src/app/api/captures/route');
    const job = await import('../src/app/api/captures/[id]/route');
    const health = await import('../src/app/health/route');
    const live = await import('../src/app/api/live/route');

    const list = (await (await captures.GET(request('/api/captures'))).json()) as { captures: object[] };
    expect(list.captures).toMatchObject([{ id: 'cap-1', state: 'done', step: 300 }]);
    // Internal bookkeeping stays out of the API.
    expect(list.captures[0]).not.toHaveProperty('snapshots');
    expect((await job.GET(request('/api/captures/cap-1'), params('cap-1'))).status).toBe(200);
    expect((await job.GET(request('/api/captures/nope'), params('nope'))).status).toBe(404);

    expect(await (await health.GET(request('/health'))).json()).toMatchObject({ ok: true, agent: false });
    const sessions = [{ id: 'capture-test', fused: 3 }];
    await redis.set(k.agent, JSON.stringify({ brush: true, depthWorker: true, steps: 5000, maxResolution: 960, sessions }), 'EX', AGENT_TTL_SECONDS);
    expect(await (await health.GET(request('/health'))).json()).toMatchObject({ agent: true, brush: true, steps: 5000 });
    expect(await (await live.GET(request('/api/live'))).json()).toEqual({ sessions });
  } finally {
    redis.disconnect();
  }
});
