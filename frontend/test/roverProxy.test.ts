import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { localHost, roverTarget } from '#web/rover-proxy.ts';

import { GET, POST } from '../src/app/(rover)/api/rover/[endpoint]/route';

const params = (endpoint: string) => ({ params: Promise.resolve({ endpoint }) });
const auth = { authorization: 'Bearer test-token', host: 'localhost:8899' };

let rover: ReturnType<typeof Bun.serve>;
let roverUrl: string;
let slow = false;
const seen: { path: string; body: string }[] = [];

beforeAll(() => {
  rover = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, body: await req.text() });
      if (slow) await Bun.sleep(2000);
      if (path === '/session') return Response.json({ token: 4242 });
      if (path === '/control') return Response.json({});
      if (path === '/status') return Response.json({ ready: true, sequence: 0, pan: 1500, lift: 1500, pwm: [0, 0, 0, 0] });
      return new Response('Not found', { status: 404 });
    },
  });
  roverUrl = `http://127.0.0.1:${rover.port}`;
});
afterAll(() => rover.stop(true));

describe('rover address filter', () => {
  test('allows local networks only, as an origin', () => {
    for (const h of ['192.168.4.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '169.254.1.1', '127.0.0.1', 'localhost', 'rover.local']) expect(localHost(h)).toBe(true);
    for (const h of ['8.8.8.8', '172.32.0.1', '1.1.1.1', 'example.com', '192.169.0.1']) expect(localHost(h)).toBe(false);
    expect(roverTarget(new Request('http://app/api/rover/status'))).toEqual({ url: 'http://192.168.4.1' });
    expect(roverTarget(new Request('http://app/api/rover/status?rover=http://127.0.0.1:8788'))).toEqual({ url: 'http://127.0.0.1:8788' });
    expect(roverTarget(new Request('http://app/api/rover/status?rover=https://192.168.4.1'))).toMatchObject({ status: 400 });
    expect(roverTarget(new Request('http://app/api/rover/status?rover=http://192.168.4.1/other'))).toMatchObject({ status: 400 });
    expect(roverTarget(new Request('http://app/api/rover/status?rover=http://example.com'))).toMatchObject({ status: 403 });
    expect(roverTarget(new Request('http://app/api/rover/status?rover=garbage'))).toMatchObject({ status: 400 });
  });
});

describe('/api/rover proxy', () => {
  test('needs the access token', async () => {
    const res = await GET(new Request(`http://app/api/rover/status?rover=${roverUrl}`), params('status'));
    expect(res.status).toBe(401);
  });

  test('forwards only the three endpoints, with their methods', async () => {
    expect((await GET(new Request(`http://app/api/rover/reboot?rover=${roverUrl}`, { headers: auth }), params('reboot'))).status).toBe(405);
    expect((await GET(new Request(`http://app/api/rover/control?rover=${roverUrl}`, { headers: auth }), params('control'))).status).toBe(405);
    expect((await POST(new Request(`http://app/api/rover/status?rover=${roverUrl}`, { method: 'POST', headers: auth }), params('status'))).status).toBe(405);
  });

  test('passes the form body through and the rover answer back', async () => {
    const body = new URLSearchParams({ token: '4242', seq: '1', wheel: '1', pan: '0', lift: '0', power: '20', speed: '10' });
    const res = await POST(new Request(`http://app/api/rover/control?rover=${roverUrl}`, { method: 'POST', headers: auth, body }), params('control'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(seen.at(-1)).toEqual({ path: '/control', body: body.toString() });
    const session = await POST(new Request(`http://app/api/rover/session?rover=${roverUrl}`, { method: 'POST', headers: auth, body: '' }), params('session'));
    expect(await session.json()).toEqual({ token: 4242 });
  });

  test('refuses an address off the local network and a cross-origin page', async () => {
    const res = await GET(new Request('http://app/api/rover/status?rover=http://example.com', { headers: auth }), params('status'));
    expect(res.status).toBe(403);
    const cross = await GET(new Request(`http://app/api/rover/status?rover=${roverUrl}`, { headers: { ...auth, origin: 'http://evil.test' } }), params('status'));
    expect(cross.status).toBe(403);
  });

  test('answers 502 when the rover is unreachable or too slow', async () => {
    const down = await GET(new Request('http://app/api/rover/status?rover=http://127.0.0.1:9', { headers: auth }), params('status'));
    expect(down.status).toBe(502);
    expect(await down.text()).toContain('Wi-Fi');
    slow = true;
    try {
      const late = await GET(new Request(`http://app/api/rover/status?rover=${roverUrl}`, { headers: auth }), params('status'));
      expect(late.status).toBe(502);
    } finally {
      slow = false;
    }
  }, 5000);

  test('on Vercel says the cloud cannot reach the rover', async () => {
    process.env.VERCEL = '1';
    try {
      const res = await GET(new Request(`http://app/api/rover/status?rover=${roverUrl}`, { headers: auth }), params('status'));
      expect(res.status).toBe(503);
    } finally {
      delete process.env.VERCEL;
    }
  });
});
