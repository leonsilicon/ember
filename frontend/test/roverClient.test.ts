import { describe, expect, test } from 'bun:test';

import { HttpRoverClient, type FetchLike } from '#rover/clients/HttpRoverClient.ts';
import { SimulatedClient } from '#rover/clients/SimulatedClient.ts';
import { HEARTBEAT_MS, PROXY_BASE } from '#rover/protocol.ts';

interface Sent {
  url: string;
  method: string;
  form: Record<string, string> | null;
  keepalive: boolean;
}

/** A fake proxy+rover: records every request, answers like the firmware, and can be told to fail. */
function fakeRover(options: { token?: number; failControl?: () => boolean; statusReady?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET';
    const form = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    sent.push({ url, method, form, keepalive: Boolean(init.keepalive) });
    const endpoint = new URL(url, 'http://app').pathname.split('/').pop();
    if (endpoint === 'session') return Response.json({ token: options.token ?? 12345678 });
    if (endpoint === 'control') {
      if (options.failControl?.()) return new Response('Stale session or invalid command', { status: 409 });
      return Response.json({});
    }
    if (endpoint === 'status') return Response.json({ ready: options.statusReady ?? true, sequence: 1, pan: 1500, lift: 1500, pwm: [0, 0, 0, 0] });
    return new Response('Not found', { status: 404 });
  };
  const controls = () => sent.filter((s) => s.url.includes('/control'));
  return { sent, fetch, controls };
}

const until = async (cond: () => boolean, ms = 1500) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await Bun.sleep(5);
  }
};
const settle = () => Bun.sleep(30);

describe('HttpRoverClient', () => {
  test('connects through the proxy with the rover address, then sends full-state frames', async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    expect(rover.sent[0]!.url).toBe(`${PROXY_BASE}/session?rover=${encodeURIComponent('http://127.0.0.1:8788')}`);
    expect(rover.sent[0]!.method).toBe('POST');

    client.set({ wheel: 1 });
    await settle();
    const [first] = rover.controls();
    expect(first!.form).toEqual({ token: '12345678', seq: '1', wheel: '1', pan: '0', lift: '0', power: '20', speed: '10' });
    client.disconnect();
  });

  test('seq strictly increases across frames and the stop frame', async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    client.set({ wheel: 1 });
    client.set({ pan: 1 });
    client.set({ power: 40 });
    client.stop();
    await settle();
    const seqs = rover.controls().map((c) => Number(c.form!.seq));
    expect(seqs).toEqual([1, 2, 3, 4]);
    const last = rover.controls().at(-1)!.form!;
    expect(last).toMatchObject({ wheel: '0', pan: '0', lift: '0', power: '40' });
    expect(client.getSnapshot().motion).toEqual({ wheel: 0, pan: 0, lift: 0, power: 40, speed: 10 });
    client.disconnect();
  });

  test(`repeats the frame every ${HEARTBEAT_MS} ms while anything is held, and not when idle`, async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    await Bun.sleep(HEARTBEAT_MS * 3);
    expect(rover.controls()).toHaveLength(0);
    client.set({ lift: -1 });
    await Bun.sleep(HEARTBEAT_MS * 3 + 20);
    const held = rover.controls();
    expect(held.length).toBeGreaterThanOrEqual(3);
    expect(held.every((c) => c.form!.lift === '-1')).toBe(true);
    client.set({ lift: 0 });
    await settle();
    const count = rover.controls().length;
    await Bun.sleep(HEARTBEAT_MS * 3);
    expect(rover.controls().length).toBe(count);
    client.disconnect();
  });

  test('a failed frame zeroes everything, sends one keepalive zero frame, and drops to error', async () => {
    let fail = false;
    const rover = fakeRover({ failControl: () => fail });
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    client.set({ wheel: 2 });
    await settle();
    fail = true;
    client.set({ wheel: 1 });
    await until(() => client.getSnapshot().connection === 'error');
    const snap = client.getSnapshot();
    expect(snap.motion).toMatchObject({ wheel: 0, pan: 0, lift: 0 });
    expect(snap.lastError).toContain('409');
    expect(snap.status).toBeNull();
    const last = rover.controls().at(-1)!;
    expect(last.form).toMatchObject({ wheel: '0', pan: '0', lift: '0', seq: '3' });
    expect(last.keepalive).toBe(true);
    // Nothing more goes out: no auto-reconnect, no heartbeat.
    const count = rover.sent.length;
    await Bun.sleep(HEARTBEAT_MS * 3);
    expect(rover.sent.length).toBe(count);
  });

  test('a new session starts zeroed and never resumes what was held', async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    client.set({ wheel: 1, pan: 1 });
    await settle();
    client.connect();
    await until(() => rover.sent.filter((s) => s.url.includes('/session')).length === 2);
    await until(() => client.getSnapshot().connection === 'connected');
    expect(client.getSnapshot().motion).toMatchObject({ wheel: 0, pan: 0, lift: 0 });
    await Bun.sleep(HEARTBEAT_MS * 2);
    const afterSecondSession = rover.sent.slice(rover.sent.findIndex((s, i) => i > 0 && s.url.includes('/session')) + 1).filter((s) => s.url.includes('/control'));
    expect(afterSecondSession).toHaveLength(0);
    client.disconnect();
  });

  test('disconnect sends a zero frame and polls status while connected', async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    client.connect();
    await until(() => client.getSnapshot().status !== null);
    expect(client.getSnapshot().status).toEqual({ ready: true, sequence: 1, pan: 1500, lift: 1500, pwm: [0, 0, 0, 0] });
    client.set({ wheel: 4 });
    await settle();
    client.disconnect();
    await settle();
    expect(client.getSnapshot().connection).toBe('disconnected');
    expect(rover.controls().at(-1)!.form).toMatchObject({ wheel: '0', seq: '2' });
  });

  test('rejects a bad power before anything is sent', async () => {
    const rover = fakeRover();
    const client = new HttpRoverClient('http://127.0.0.1:8788', rover.fetch);
    expect(() => client.set({ power: 150 })).toThrow();
    expect(rover.sent).toHaveLength(0);
  });
});

describe('SimulatedClient', () => {
  test('runs the firmware rules in the browser: lease, servo travel, PWM report', async () => {
    const client = new SimulatedClient();
    client.connect();
    await until(() => client.getSnapshot().connection === 'connected');
    client.set({ wheel: 1, lift: 1, power: 50, speed: 100 });
    await until(() => client.getSnapshot().status?.lift === 2500);
    const status = client.getSnapshot().status!;
    expect(status.pwm).toEqual([127, 0, 0, 127]);
    expect(status.lift).toBe(2500);
    expect(status.pan).toBe(1500);
    client.stop();
    await until(() => client.getSnapshot().status?.pwm[0] === 0);
    expect(client.getSnapshot().status!.lift).toBe(2500);
    client.disconnect();
    expect(client.getSnapshot().connection).toBe('disconnected');
  });
});
