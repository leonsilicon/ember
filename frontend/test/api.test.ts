import { expect, test } from 'bun:test';

import { AGENT_TTL_SECONDS, connect, keys } from '../src/bus';
import { newJob } from '../src/jobs';
import { SESSION_COOKIE, sessionToken } from '../src/web/auth';

// From test/setup.ts.
const TOKEN = process.env.SPLAT_TOKEN!;

const request = (path: string, token: string | null = TOKEN) =>
  new Request(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test('every route wants the token', async () => {
  const captures = await import('../src/app/(splat)/api/captures/route');
  const health = await import('../src/app/(splat)/health/route');
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
    const captures = await import('../src/app/(splat)/api/captures/route');
    const job = await import('../src/app/(splat)/api/captures/[id]/route');
    const health = await import('../src/app/(splat)/health/route');
    const live = await import('../src/app/(splat)/api/live/route');

    const list = (await (await captures.GET(request('/api/captures'))).json()) as { captures: object[] };
    expect(list.captures).toMatchObject([{ id: 'cap-1', state: 'done', step: 300 }]);
    // Internal bookkeeping stays out of the API.
    expect(list.captures[0]).not.toHaveProperty('snapshots');
    expect((await job.GET(request('/api/captures/cap-1'), params('cap-1'))).status).toBe(200);
    expect((await job.GET(request('/api/captures/nope'), params('nope'))).status).toBe(404);

    expect(await (await health.GET(request('/health'))).json()).toMatchObject({ ok: true, agent: false });
    const sessions = [{ id: 'capture-test', fused: 3, room: 'alice' }, { id: 'capture-bob', fused: 1, room: 'bob' }, { id: 'capture-old', fused: 2 }];
    await redis.set(k.agent, JSON.stringify({ id: 'agent', host: 'mac', brush: true, depthWorker: true, steps: 5000, maxResolution: 960, sessions }), 'EX', AGENT_TTL_SECONDS);
    expect(await (await health.GET(request('/health'))).json()).toMatchObject({ agent: true, brush: true, steps: 5000 });
    // The token sees every room; a username its own.
    expect(await (await live.GET(request('/api/live'))).json()).toEqual({ sessions });
    expect(await (await live.GET(request('/api/live?room=alice'))).json()).toEqual({ sessions: [sessions[0]] });
  } finally {
    redis.disconnect();
  }
});

test('a browser lists the captures of the username it signed in as; the token lists them all', async () => {
  const redis = connect();
  const k = keys();
  try {
    await redis.del(k.jobs);
    await redis.hset(k.jobs, 'cap-alice', JSON.stringify({ ...newJob('cap-alice', 'alice'), state: 'done' }));
    await redis.hset(k.jobs, 'cap-bob', JSON.stringify({ ...newJob('cap-bob', 'bob'), state: 'done' }));
    await redis.hset(k.jobs, 'cap-none', JSON.stringify({ ...newJob('cap-none'), state: 'done' }));
    const captures = await import('../src/app/(splat)/api/captures/route');
    const ids = async (response: Response) => ((await response.json()) as { captures: { id: string }[] }).captures.map((c) => c.id).sort();
    const asUser = (who: string, path = '/api/captures') =>
      new Request(`http://localhost${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${sessionToken(who)}` } });
    expect(await ids(await captures.GET(request('/api/captures')))).toEqual(['cap-alice', 'cap-bob', 'cap-none']);
    expect(await ids(await captures.GET(asUser('alice')))).toEqual(['cap-alice']);
    expect(await ids(await captures.GET(asUser('carol')))).toEqual([]);
    expect(await ids(await captures.GET(asUser('alice', '/api/captures?room=bob')))).toEqual(['cap-bob']);
    expect(await ids(await captures.GET(request('/api/captures?room=alice')))).toEqual(['cap-alice']);
  } finally {
    redis.disconnect();
  }
});
