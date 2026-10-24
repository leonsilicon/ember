/**
 * How the Next.js app on Vercel and the Mac agent talk, through Redis. A socket to the app stays
 * on whichever function instance accepted it, and instances share no memory, so the phones' and
 * viewers' sockets are relayed through two streams:
 *
 *   live:in   relays → agent: a socket connecting (`open`), a phone's message (`data`), a viewer
 *             that fell behind asking for everything again (`resync`), a socket leaving (`close`).
 *             Each socket is a peer id its relay made up.
 *   live:out  agent → relays: a message for some peers (`send`), closing a peer (`close`), and
 *             the agent starting (`agent`), when relays announce their open sockets again.
 *
 * The capture jobs are a hash, the queue of captures to train a list, and the agent keeps a
 * heartbeat key alive while it runs, which also lists its live sessions. Everything is under one prefix (SPLAT_REDIS_PREFIX), so
 * development and tests can share a Redis with production.
 */
import Redis from 'ioredis';

import type { LiveSession } from './live/hub';

export function redisUrl(env: Record<string, string | undefined> = process.env) {
  // Vercel's Marketplace Redis integrations set one of these.
  const url = env.REDIS_URL ?? env.KV_URL;
  if (!url) throw new Error('REDIS_URL is not set (vercel env pull, or see SPLATS.md)');
  return url;
}

export function connect(url = redisUrl()) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function keys(prefix = process.env.SPLAT_REDIS_PREFIX ?? 'splat:') {
  return {
    jobs: `${prefix}jobs`,
    queue: `${prefix}queue`,
    agent: `${prefix}agent`,
    liveIn: `${prefix}live:in`,
    liveOut: `${prefix}live:out`,
  };
}

export type Keys = ReturnType<typeof keys>;

/**
 * How often the agent refreshes its heartbeat (and also whenever a recording starts or stops),
 * and how long the heartbeat outlives an agent that died. Sparing: Upstash's free plan allows
 * 500,000 commands a month, and an idle agent should use only a small part of that.
 */
export const AGENT_BEAT_SECONDS = 60;
export const AGENT_TTL_SECONDS = 180;

/** How long the agent's blocking reads wait before asking again, for the same reason. */
export const BLOCK_SECONDS = 60;

/** The agent's heartbeat: what /health reports, and the live sessions for /api/live. */
export type AgentInfo = {
  /** Which agent process (there must be only one) and which Mac it runs on. */
  id: string;
  host: string;
  brush: boolean;
  depthWorker: boolean;
  steps: number;
  maxResolution: number;
  sessions: LiveSession[];
};

/**
 * Entries kept per stream. Readers keep up within milliseconds, so this only bounds Redis memory:
 * a few seconds of keyframes (≤ 350 KB each) and point updates (≤ 1 MB each).
 */
export const STREAM_LENGTH = 200;

export type Role = 'phone' | 'viewer';

export type InEntry =
  | { kind: 'open'; peer: string; role: Role; session: string | null }
  | { kind: 'data'; peer: string; data: Uint8Array }
  | { kind: 'resync'; peer: string }
  | { kind: 'close'; peer: string };

export type OutEntry =
  | { kind: 'send'; to: string[]; data: string | Uint8Array }
  | { kind: 'close'; peer: string; code: number; reason: string }
  | { kind: 'agent' };

type Field = string | Buffer;

export function inFields(entry: InEntry): Field[] {
  switch (entry.kind) {
    case 'open':
      return ['kind', 'open', 'peer', entry.peer, 'role', entry.role, 'session', entry.session ?? ''];
    case 'data':
      return ['kind', 'data', 'peer', entry.peer, 'data', Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)];
    default:
      return ['kind', entry.kind, 'peer', entry.peer];
  }
}

export function outFields(entry: OutEntry): Field[] {
  switch (entry.kind) {
    case 'send': {
      const { data } = entry;
      // Text and binary WebSocket messages stay distinct on the way through.
      const body = typeof data === 'string' ? ['text', data] : ['binary', Buffer.from(data.buffer, data.byteOffset, data.byteLength)];
      return ['kind', 'send', 'to', entry.to.join(','), ...body];
    }
    case 'close':
      return ['kind', 'close', 'peer', entry.peer, 'code', String(entry.code), 'reason', entry.reason];
    case 'agent':
      return ['kind', 'agent'];
  }
}

function fieldMap(fields: Buffer[]) {
  const map = new Map<string, Buffer>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i].toString(), fields[i + 1]);
  return map;
}

/** A plain Uint8Array copy (Redis hands back Buffers that may share a pool). */
const bytes = (buffer: Buffer) => new Uint8Array(buffer);

export function parseIn(fields: Buffer[]): InEntry | null {
  const f = fieldMap(fields);
  const kind = f.get('kind')?.toString();
  const peer = f.get('peer')?.toString();
  if (!peer) return null;
  if (kind === 'open') {
    const role = f.get('role')?.toString();
    if (role !== 'phone' && role !== 'viewer') return null;
    return { kind, peer, role, session: f.get('session')?.toString() || null };
  }
  if (kind === 'data') {
    const data = f.get('data');
    return data ? { kind, peer, data: bytes(data) } : null;
  }
  if (kind === 'resync' || kind === 'close') return { kind, peer };
  return null;
}

export function parseOut(fields: Buffer[]): OutEntry | null {
  const f = fieldMap(fields);
  const kind = f.get('kind')?.toString();
  if (kind === 'send') {
    const to = f.get('to')?.toString().split(',').filter(Boolean) ?? [];
    const text = f.get('text');
    const binary = f.get('binary');
    if (text) return { kind, to, data: text.toString() };
    if (binary) return { kind, to, data: bytes(binary) };
    return null;
  }
  if (kind === 'close') {
    const peer = f.get('peer')?.toString();
    if (!peer) return null;
    return { kind, peer, code: Number(f.get('code')?.toString()) || 1000, reason: f.get('reason')?.toString() ?? '' };
  }
  if (kind === 'agent') return { kind };
  return null;
}

export type StreamEntry = { id: string; fields: Buffer[] };

/** The id of a stream's newest entry, to read only what comes after it. */
export async function latestId(redis: Redis, stream: string) {
  const [newest] = await redis.xrevrange(stream, '+', '-', 'COUNT', 1);
  return newest?.[0] ?? '0-0';
}

/**
 * Entries after the id `after`, waiting up to `blockMs` for the first. Uses its own connection,
 * since a blocked connection can't run anything else.
 */
export async function readStream(reader: Redis, stream: string, after: string, blockMs: number): Promise<StreamEntry[]> {
  const result = (await reader.xreadBuffer('BLOCK', blockMs, 'STREAMS', stream, after)) as
    | [Buffer, [Buffer, Buffer[]][]][]
    | null;
  if (!result) return [];
  return result[0][1].map(([id, fields]) => ({ id: id.toString(), fields }));
}

export function append(redis: Redis, stream: string, fields: Field[]) {
  return redis.xadd(stream, 'MAXLEN', '~', STREAM_LENGTH, '*', ...fields);
}
