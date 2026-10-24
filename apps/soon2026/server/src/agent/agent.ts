import { setTimeout as sleep } from 'node:timers/promises';

import {
  AGENT_BEAT_SECONDS,
  AGENT_TTL_SECONDS,
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
    return Promise.reject(new Error('The depth worker is not installed on the Mac; run server/scripts/install-depth.sh'));
  }
  return DepthWorker.start(config.depthWorkerBin, config.depthModel);
}

/**
 * The Mac's half of the splat server. It trains the captures the app queues, and runs the live
 * reconstruction for the phones and viewers whose sockets the app relays to it (see bus.ts).
 */
export async function startAgent({ config, redisUrl, prefix, storage, startEstimator }: AgentOptions) {
  const k = keys(prefix);
  // Blocking reads tie up a connection, so the live stream and the queue get their own.
  const redis = connect(redisUrl);
  const liveReader = connect(redisUrl);
  const queueReader = connect(redisUrl);
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
  const store = new JobStore(redis, k.jobs);
  const trainer = new Trainer(store, storage, config);

  const beat = () => {
    const info: AgentInfo = {
      brush: Boolean(config.brushBin),
      depthWorker: Boolean(config.depthWorkerBin && config.depthModel),
      steps: config.steps,
      maxResolution: config.maxResolution,
      sessions: hub.list(),
    };
    return redis.set(k.agent, JSON.stringify(info), 'EX', AGENT_TTL_SECONDS);
  };
  await beat();
  const heartbeat = setInterval(() => beat().catch((error) => console.error('heartbeat', error)), AGENT_BEAT_SECONDS * 1000);

  async function readLive() {
    let after = await latestId(redis, k.liveIn);
    // Relays announce the sockets they hold, so phones and viewers already connected join in.
    publish({ kind: 'agent' });
    while (running) {
      try {
        for (const { id, fields } of await readStream(liveReader, k.liveIn, after, 30_000)) {
          after = id;
          const entry = parseIn(fields);
          if (entry?.kind === 'open') hub.open(entry.peer, entry.role, entry.session);
          else if (entry?.kind === 'data') hub.message(entry.peer, entry.data);
          else if (entry?.kind === 'resync') hub.resync(entry.peer);
          else if (entry?.kind === 'close') hub.close(entry.peer);
        }
      } catch (error) {
        if (!running) return;
        console.error('live:in', error);
        await sleep(1000);
      }
    }
  }

  async function readQueue() {
    // Anything queued or interrupted while the agent was away trains now.
    for (const job of await store.list()) {
      if (job.state === 'queued' || job.state === 'training') trainer.enqueue(job.id);
    }
    while (running) {
      try {
        const popped = await queueReader.blpop(k.queue, 30);
        if (popped) trainer.enqueue(popped[1]);
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
      await redis.del(k.agent);
      redis.disconnect();
    },
  };
}
