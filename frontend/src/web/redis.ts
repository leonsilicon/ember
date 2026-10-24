import type Redis from 'ioredis';

import { connect, keys, type AgentInfo } from '../bus';
import { JobStore } from '../jobs';

export const k = keys();

let client: Redis | null = null;

/** This function instance's Redis connection for ordinary commands. */
export function redis() {
  client ??= connect();
  return client;
}

export const jobStore = () => new JobStore(redis(), k.jobs);

/** The Mac agent's heartbeat, or null when it isn't running. */
export async function agentInfo(): Promise<AgentInfo | null> {
  const json = await redis().get(k.agent);
  return json ? (JSON.parse(json) as AgentInfo) : null;
}
