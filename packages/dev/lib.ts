/** What the `vpx _…` scripts in this package share: the app's location, Metro's port and port probes. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dir, '../..');
export const APP_DIR = path.join(REPO_ROOT, 'mobile');
/** The splat server: the Next.js app on Vercel, and the Mac agent `vpx _dev` runs. */
export const NEXT_APP_DIR = path.join(REPO_ROOT, 'apps/next-app');
export const DEFAULT_METRO_PORT = 8081;

/** A command's trimmed stdout, or null if it is missing or fails. */
export function run(command: string, args: string[], cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Stim's `metro.port` for the app (committed in mobile/.stim.json), which `vpx _dev` runs Metro on. */
export function stimMetroPort() {
  const port = Number(run('stim', ['settings', 'get', 'metro.port'], APP_DIR));
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * The pid listening on a port, or null if it is free. Uses lsof rather than connecting: mprocs 0.9
 * crashes when a probe opens and closes its control port.
 */
export function listenerPid(port: number) {
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])?.split('\n')[0] || null;
}
