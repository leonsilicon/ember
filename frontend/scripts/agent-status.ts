#!/usr/bin/env bun
/**
 * The Mac agent's heartbeat from Redis (see bus.ts): whether one is running, on which Mac, with which tools. Run it
 * in frontend, where Bun loads REDIS_URL from .env.local. With `--wait` it polls for up to `--timeout` seconds
 * (default 120) until there is a heartbeat, from `--host <name>` if given and not the agent `--not <id>`, and fails
 * otherwise; `--require-tools` also fails unless that agent found Brush and the depth worker; `--id` prints only the
 * agent's id. .github/workflows/agent.yml uses it to check that a restart took.
 */
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';

import { type AgentInfo, connect, keys } from '../src/bus';

const { values: options } = parseArgs({
  options: {
    wait: { type: 'boolean', default: false },
    not: { type: 'string' },
    host: { type: 'string' },
    timeout: { type: 'string', default: '120' },
    'require-tools': { type: 'boolean', default: false },
    id: { type: 'boolean', default: false },
    'this-host': { type: 'boolean', default: false },
  },
});
const host = options['this-host'] ? hostname() : options.host;
const timeout = Number(options.timeout);
if (!Number.isFinite(timeout) || timeout < 0) {
  console.error('--timeout needs a number of seconds');
  process.exit(2);
}

const redis = connect();
const key = keys().agent;
const deadline = Date.now() + timeout * 1000;
let info: AgentInfo | null = null;
const wanted = (agent: AgentInfo) => (!host || agent.host === host) && (!options.not || agent.id !== options.not);
for (;;) {
  const json = await redis.get(key);
  info = json ? (JSON.parse(json) as AgentInfo) : null;
  if ((info && wanted(info)) || !options.wait || Date.now() > deadline) break;
  await Bun.sleep(2000);
}
redis.disconnect();

if (!info || !wanted(info)) {
  console.error(
    info
      ? `The agent heartbeat is still ${info.id} on ${info.host}`
      : 'No agent heartbeat: no agent is running (or it has not reached Redis yet)',
  );
  process.exit(1);
}
if (options.id) {
  console.log(info.id);
  process.exit(0);
}
const tools = `Brush ${info.brush ? 'yes' : 'NO'}, depth worker ${info.depthWorker ? 'yes' : 'NO'}`;
console.log(
  `Agent ${info.id} on ${info.host}: ${tools}, ${info.steps} steps @ ${info.maxResolution}px, ${info.sessions.length} live session(s)`,
);
if (options['require-tools'] && !(info.brush && info.depthWorker)) {
  console.error('Brush or the depth worker is missing; see frontend/scripts/install-*.sh');
  process.exit(1);
}
