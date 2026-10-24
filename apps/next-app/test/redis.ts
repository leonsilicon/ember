import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { connect } from '../src/bus';

/**
 * A throwaway redis-server for a test file (Homebrew's `redis`), or TEST_REDIS_URL's. Each test
 * uses its own key prefix, so tests can share it.
 */
export async function startRedis() {
  if (process.env.TEST_REDIS_URL) return { url: process.env.TEST_REDIS_URL, stop() {} };
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const url = `redis://127.0.0.1:${port}`;
  const probe = connect(url);
  probe.on('error', () => {});
  for (let i = 0; i < 100; i++) {
    if (await probe.ping().then(() => true, () => false)) break;
    await sleep(50);
  }
  probe.disconnect();
  return { url, stop: () => server.kill() };
}

export const testPrefix = () => `test:${randomUUID()}:`;
