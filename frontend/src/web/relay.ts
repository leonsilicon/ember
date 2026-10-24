import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';
import type { RawData, WebSocket } from 'ws';

import { append, connect, inFields, latestId, parseOut, readStream, type InEntry, type OutEntry, type Role } from '../bus';
import { agentInfo, k, redis } from './redis';

type Socket = {
  ws: WebSocket;
  role: Role;
  session: string | null;
  /** A phone's `hello`, sent again when the agent restarts so it picks the session back up. */
  hello: Uint8Array | null;
  /** A viewer that fell behind skips messages, and asks for everything again once it catches up. */
  behind: boolean;
};

/** Bytes queued for a viewer past which it skips messages (see Socket.behind). */
const BACKLOG_LIMIT = 16 * 1024 ** 2;

function bytes(data: RawData) {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/** Whether a phone's message is its `hello` (see protocol.ts: u32 header length, then a JSON header). */
function isHello(message: Uint8Array) {
  if (message.byteLength < 4) return false;
  const length = new DataView(message.buffer, message.byteOffset).getUint32(0, true);
  // A hello's header is short; a keyframe's lists its feature points, so skip decoding those.
  if (length > 2048 || 4 + length > message.byteLength) return false;
  try {
    return JSON.parse(new TextDecoder().decode(message.subarray(4, 4 + length))).type === 'hello';
  } catch {
    return false;
  }
}

/**
 * Connects the phone and viewer sockets this function instance holds to the Mac agent, through
 * Redis (see bus.ts). One per instance: Fluid compute runs many sockets in one instance.
 */
class Relay {
  private sockets = new Map<string, Socket>();
  private reader: Redis | null = null;
  /** Resolves once reading live:out has started, from the position it starts at. */
  private reading: Promise<void> | null = null;

  async accept(ws: WebSocket, role: Role, session: string | null) {
    const peer = randomUUID();
    const socket: Socket = { ws, role, session, hello: null, behind: false };
    this.sockets.set(peer, socket);
    // Listen before announcing the socket, so the agent's first reply can't be missed, and hold
    // the socket's messages until it is announced (a phone sends its hello straight away).
    const announced = this.listen().then(() => this.publish({ kind: 'open', peer, role, session }));
    ws.on('message', (data, isBinary) => {
      if (role !== 'phone' || !isBinary) return;
      const message = bytes(data);
      if (isHello(message)) socket.hello = message;
      announced.then(() => this.publish({ kind: 'data', peer, data: message }));
    });
    // A broken connection (or a message over the size limit) is closed by ws; 'close' cleans up.
    ws.on('error', () => {});
    ws.on('close', () => {
      this.sockets.delete(peer);
      announced.then(() => this.publish({ kind: 'close', peer }));
    });
    await announced;
    if (!(await agentInfo())) {
      ws.send(
        role === 'phone'
          ? JSON.stringify({ type: 'error', message: 'The Mac agent is offline; live 3D resumes when it reconnects.' })
          : JSON.stringify({ type: 'agent', online: false }),
      );
    }
  }

  private publish(entry: InEntry) {
    return append(redis(), k.liveIn, inFields(entry)).catch((error) => console.error('live:in', error));
  }

  private listen() {
    this.reading ??= (async () => {
      let after = await latestId(redis(), k.liveOut);
      this.reader ??= connect();
      const reader = this.reader;
      void (async () => {
        while (this.sockets.size) {
          try {
            for (const { id, fields } of await readStream(reader, k.liveOut, after, 10_000)) {
              after = id;
              const entry = parseOut(fields);
              if (entry) this.deliver(entry);
            }
          } catch (error) {
            console.error('live:out', error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        this.reading = null;
      })();
    })();
    return this.reading;
  }

  private deliver(entry: OutEntry) {
    if (entry.kind === 'send') {
      for (const peer of entry.to) {
        const socket = this.sockets.get(peer);
        if (socket) this.send(peer, socket, entry.data);
      }
    } else if (entry.kind === 'close') {
      this.sockets.get(entry.peer)?.ws.close(entry.code, entry.reason);
    } else {
      // The agent (re)started and knows no one: announce every socket again.
      for (const [peer, socket] of this.sockets) {
        this.publish({ kind: 'open', peer, role: socket.role, session: socket.session });
        if (socket.hello) this.publish({ kind: 'data', peer, data: socket.hello });
      }
    }
  }

  private send(peer: string, socket: Socket, data: string | Uint8Array) {
    const { ws } = socket;
    if (ws.readyState !== ws.OPEN) return;
    if (socket.role === 'viewer' && ws.bufferedAmount > BACKLOG_LIMIT) {
      socket.behind = true;
      return;
    }
    ws.send(data, () => {
      if (socket.behind && ws.bufferedAmount === 0) {
        socket.behind = false;
        this.publish({ kind: 'resync', peer });
      }
    });
  }
}

let relay: Relay | null = null;

/** Hands a phone's (`/live/ingest`) or viewer's (`/live/socket`) socket to this instance's relay. */
export function relaySocket(ws: WebSocket, role: Role, session: string | null) {
  relay ??= new Relay();
  return relay.accept(ws, role, session);
}
