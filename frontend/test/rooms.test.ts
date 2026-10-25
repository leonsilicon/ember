import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { WebSocketServer } from 'ws';

import { PING, roomRelay } from '../src/web/rooms';

/** The room relay (src/web/rooms.ts) on a plain ws server, standing in for Vercel's upgradeWebSocket. */
async function startServer() {
  const sockets = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    sockets.handleUpgrade(request, socket, head, (ws) => {
      if (url.pathname === '/live/map/ingest') void roomRelay().sendFrom(ws, url.searchParams.get('room')!);
      else void roomRelay().watch(ws, url.searchParams.get('room'));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    base: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    stop() {
      for (const client of sockets.clients) client.terminate();
      http.close();
    },
  };
}

function open(url: string) {
  const ws = new WebSocket(url);
  const messages: string[] = [];
  ws.onmessage = (event) => messages.push(String(event.data));
  return new Promise<{ ws: WebSocket; messages: string[] }>((resolve, reject) => {
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = reject;
  });
}

async function waitFor(condition: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(20);
  }
}

test('a phone’s map lines reach the browsers in its room, and it hears how many are watching', async () => {
  const server = await startServer();
  try {
    const phone = await open(`${server.base}/live/map/ingest?room=alice`);
    // Nobody's watching yet.
    await waitFor(() => phone.messages.includes('{"type":"watching","viewers":0}'));

    const alice = await open(`${server.base}/live/map?room=alice`);
    const bob = await open(`${server.base}/live/map?room=bob`);
    const nobody = await open(`${server.base}/live/map`);
    await waitFor(() => alice.messages.includes('{"type":"room","room":"alice"}'));
    await waitFor(() => nobody.messages.includes('{"type":"room","room":null}'));

    const line = JSON.stringify({ type: 'map', t: 1, rover: { x: 0, z: 0, yawDeg: 0 }, leaves: [], corridors: [] });
    // Until the subscription is in place a line can be lost, as a live map's can; keep sending as the phone does.
    const sending = setInterval(() => phone.ws.send(line), 50);
    try {
      await waitFor(() => alice.messages.includes(line));
    } finally {
      clearInterval(sending);
    }
    phone.ws.send(PING);
    await sleep(100);
    expect(bob.messages.filter((m) => m.includes('"type":"map"'))).toHaveLength(0);
    expect(alice.messages.includes(PING)).toBe(false);

    // The count is taken every few seconds in production; here the relay's own counter answers at once.
    expect(await roomRelay().watchers('alice')).toBe(1);
    expect(await roomRelay().watchers('carol')).toBe(0);

    for (const socket of [alice, bob, nobody, phone]) socket.ws.close();
    await waitFor(() => [alice, bob, nobody, phone].every((s) => s.ws.readyState === WebSocket.CLOSED));
    expect(await roomRelay().watchers('alice')).toBe(0);
  } finally {
    server.stop();
  }
});
