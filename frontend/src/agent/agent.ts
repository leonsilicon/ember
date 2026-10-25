import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import type Redis from 'ioredis';

import {
  AGENT_BEAT_SECONDS,
  AGENT_TTL_SECONDS,
  BLOCK_SECONDS,
  append,
  connect,
  keys,
  latestId,
  outFields,
  parseIn,
  readStream,
  type AgentInfo,
  type OutEntry,
} from '../bus';
import type { ServerConfig } from '../config';
import { JobStore } from '../jobs';
import { DepthWorker, type DepthEstimator } from '../live/depth-worker';
import { LiveHub, type LiveTransport } from '../live/hub';
import type { Storage } from './storage';
import { Trainer } from './trainer';

export type AgentOptions = {
  config: ServerConfig;
  redisUrl: string;
  /** SPLAT_REDIS_PREFIX: production, development and tests can share one Redis. */
  prefix?: string;
  storage: Storage;
  startEstimator?: () => Promise<DepthEstimator>;
};

function startDepthWorker(config: ServerConfig): Promise<DepthEstimator> {
  if (!config.depthWorkerBin || !config.depthModel) {
    return Promise.reject(new Error('The depth worker is not installed on the Mac; run frontend/scripts/install-depth.sh'));
  }
  return DepthWorker.start(config.depthWorkerBin, config.depthModel);
}

/**
 * The Mac's half of the splat server. It trains the captures the app queues, and runs the live
 * reconstruction for the phones and viewers whose sockets the app relays to it (see bus.ts).
 */
/** How long a heartbeat write may take, and how many may fail in a row before the agent gives its connections up. */
const HEARTBEAT_TIMEOUT_MS = 15_000;
const HEARTBEAT_MISSES = 2;

/** `promise`, or a rejection once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Another agent's heartbeat, once a lingering one (its agent killed, not stopped) has had time to expire. */
async function otherAgent(redis: Redis, key: string): Promise<AgentInfo | null> {
  const deadline = Date.now() + (AGENT_TTL_SECONDS + 10) * 1000;
  for (let waited = false; ; waited = true) {
    const json = await redis.get(key);
    if (!json) return null;
    const other = JSON.parse(json) as AgentInfo;
    if (Date.now() > deadline) return other;
    if (!waited) {
      console.log(`Another Mac agent's heartbeat is in Redis (${other.id.slice(0, 8)} on ${other.host}); waiting up to ${AGENT_TTL_SECONDS} s for it to stop…`);
    }
    await sleep(5000);
  }
}

export async function startAgent({ config, redisUrl, prefix, storage, startEstimator }: AgentOptions) {
  const k = keys(prefix);
  // Blocking reads tie up a connection, so the live stream and the queue get their own.
  const redis = connect(redisUrl);
  const liveReader = connect(redisUrl);
  const queueReader = connect(redisUrl);
  // Two agents would both answer every phone and viewer. An agent that was killed rather than stopped leaves its
  // heartbeat behind for up to AGENT_TTL_SECONDS (a stopped one removes its own), so a restart waits that long for the
  // key to clear before giving up; a live agent keeps renewing it, and then this one does give up.
  const id = randomUUID();
  const other = await otherAgent(redis, k.agent);
  if (other) {
    for (const client of [redis, liveReader, queueReader]) client.disconnect();
    throw new Error(`another Mac agent is already running (on ${other.host}); stop it first`);
  }
  let running = true;

  const publish = (entry: OutEntry) => {
    // One connection runs commands in order, so messages reach the relays in the order sent.
    append(redis, k.liveOut, outFields(entry)).catch((error) => console.error('live:out', error));
  };
  const transport: LiveTransport = {
    send: (peers, data) => publish({ kind: 'send', to: peers.map((peer) => peer.id), data }),
    close: (peer, code, reason) => publish({ kind: 'close', peer: peer.id, code, reason }),
  };
  const hub = new LiveHub(config.live, transport, startEstimator ?? (() => startDepthWorker(config)));
  // The first keyframe would otherwise wait for the depth model to load.
  hub.warm();
  const store = new JobStore(redis, k.jobs);
  const trainer = new Trainer(store, storage, config);

  const beat = () => {
    const info: AgentInfo = {
      id,
      host: hostname(),
      brush: Boolean(config.brushBin),
      depthWorker: Boolean(config.depthWorkerBin && config.depthModel),
      steps: config.steps,
      maxResolution: config.maxResolution,
      sessions: hub.list(),
    };
    return withTimeout(redis.set(k.agent, JSON.stringify(info), 'EX', AGENT_TTL_SECONDS), HEARTBEAT_TIMEOUT_MS);
  };
  await beat();
  // A connection the OS still calls open can be dead (the Mac changed networks: 2026-10-24, from a phone's hotspot
  // to Wi-Fi), and then every command on it waits forever while the heartbeat expires and the app says the agent is
  // offline. So a heartbeat that doesn't go through twice ends the process, and the supervisor (pm2, or `vpx _dev`'s
  // mprocs) starts a fresh one with new connections.
  let missed = 0;
  const heartbeat = setInterval(async () => {
    try {
      await beat();
      missed = 0;
    } catch (error) {
      missed++;
      console.error(`heartbeat ${missed}/${HEARTBEAT_MISSES}:`, error instanceof Error ? error.message : error);
      if (missed < HEARTBEAT_MISSES) return;
      console.error('Redis is not answering; exiting so the supervisor restarts the agent with new connections');
      process.exit(2);
    }
  }, AGENT_BEAT_SECONDS * 1000);
  // Recordings starting and stopping show up in /api/live (and the phone dot) without waiting for the next beat.
  let recordings = '';
  const beatIfRecordingsChanged = () => {
    const now = JSON.stringify(hub.list().map((s) => [s.id, s.phoneConnected]));
    if (now === recordings) return;
    recordings = now;
    beat().catch((error) => console.error('heartbeat', error));
  };

  async function readLive() {
    let after = await latestId(redis, k.liveIn);
    // Relays announce the sockets they hold, so phones and viewers already connected join in.
    publish({ kind: 'agent' });
    while (running) {
      try {
        for (const { id, fields } of await readStream(liveReader, k.liveIn, after, BLOCK_SECONDS * 1000)) {
          after = id;
          const entry = parseIn(fields);
          if (entry?.kind === 'open') hub.open(entry.peer, entry.role, entry.session, entry.room);
          else if (entry?.kind === 'data') hub.message(entry.peer, entry.data);
          else if (entry?.kind === 'resync') hub.resync(entry.peer);
          else if (entry?.kind === 'close') hub.close(entry.peer);
        }
        beatIfRecordingsChanged();
      } catch (error) {
        if (!running) return;
        console.error('live:in', error);
        await sleep(1000);
      }
    }
  }

  /** A queue entry: a capture id to train, or `pause:`, `resume:` or `cancel:` and the id (see control/route.ts). */
  function act(entry: string) {
    const [, verb, id] = /^(pause|resume|cancel):(.+)$/.exec(entry) ?? [];
    if (verb === 'pause') trainer.pause(id);
    else if (verb === 'resume') trainer.resume(id);
    else if (verb === 'cancel') trainer.cancel(id);
    else trainer.enqueue(entry);
  }

  async function readQueue() {
    // Anything queued or interrupted while the agent was away trains now, newest first: list() is newest first and
    // each enqueue goes to the front of the line, so they go in oldest first.
    for (const job of (await store.list()).reverse()) {
      if (job.state === 'queued' || job.state === 'training') trainer.enqueue(job.id);
    }
    while (running) {
      try {
        const popped = await queueReader.blpop(k.queue, BLOCK_SECONDS);
        if (popped) act(popped[1]);
      } catch (error) {
        if (!running) return;
        console.error('queue', error);
        await sleep(1000);
      }
    }
  }

  const loops = Promise.all([readLive(), readQueue()]);

  return {
    hub,
    trainer,
    store,
    keys: k,
    /** Stops training (the job trains again next time) and the live reconstruction. */
    async stop() {
      running = false;
      clearInterval(heartbeat);
      liveReader.disconnect();
      queueReader.disconnect();
      await loops;
      await trainer.close();
      hub.stop();
      if ((JSON.parse((await redis.get(k.agent)) ?? '{}') as Partial<AgentInfo>).id === id) await redis.del(k.agent);
      redis.disconnect();
    },
  };
}
