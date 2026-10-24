#!/usr/bin/env bun
/**
 * `vpx _dev` (from anywhere in the repo): the whole dev stack in mprocs, one pane per long-lived
 * process. Pane order is the index mprocs' remote control uses:
 *
 *   0  metro         Expo dev server for apps/soon2026, on Stim's `metro.port` (committed in
 *                    apps/soon2026/.stim.json; 8081 without Stim), so `stim ios` reuses it.
 *                    Always `--dev-client`: the app runs as a development build, never in Expo Go
 *   1  splat-server  the Brush splat preview server in apps/soon2026/server (SPLAT_PORT, 8899)
 *
 * `--force` replaces a running stack and frees both ports, through `stim stop` when Stim's own dev
 * server holds Metro's. `--port <n>` overrides the Metro port; every other argument goes to
 * `expo start` (`--clear`, …).
 *
 * Each pane's output is mirrored to `.mprocs-logs/<pane>.log` (truncated every session), and mprocs
 * takes commands on 127.0.0.1:8898, so another shell or an agent can restart a pane:
 *
 *   vpx mprocs --server 127.0.0.1:8898 --ctl '{c: select-proc, index: 0}'
 *   vpx mprocs --server 127.0.0.1:8898 --ctl '{c: restart-proc}'
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { configFromEnv } from 'soon2026/server/src/config';

import { APP_DIR, DEFAULT_METRO_PORT, listenerPid, REPO_ROOT, run, stimMetroPort } from './lib';

const CONTROL_PORT = 8898;
const LOG_DIR = path.join(REPO_ROOT, '.mprocs-logs');
// JSON is valid YAML, so the generated config needs no YAML library.
const CONFIG_PATH = path.join(REPO_ROOT, 'node_modules/.cache/_dev/mprocs.yaml');
// The npm package's main export is the path of its native binary for this platform.
const MPROCS: string = createRequire(import.meta.url)('mprocs');

function fail(message: string): never {
  console.error(`_dev: ${message}`);
  process.exit(1);
}

function describePid(pid: string) {
  return `pid ${pid}: ${run('ps', ['-o', 'command=', '-p', pid]) ?? 'unknown'}`;
}

async function waitForRelease(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (listenerPid(port)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(100);
  }
  return true;
}

/** For --force: stops whatever listens on a port, gracefully first. */
async function freePort(port: number) {
  const pid = listenerPid(port);
  if (!pid) return;
  // Stim's dev server runs under its supervisor; `stim stop` stops both and keeps Stim's state right.
  const parent = run('ps', ['-o', 'ppid=', '-p', pid]);
  if (parent && run('ps', ['-o', 'comm=', '-p', parent]) === 'stim-supervisor') {
    spawnSync('stim', ['stop'], { cwd: APP_DIR, stdio: 'inherit' });
    if (await waitForRelease(port, 10_000)) return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const holder = listenerPid(port);
    if (!holder) return;
    process.kill(Number(holder), signal);
    if (await waitForRelease(port, 5000)) return;
  }
  fail(`could not free port ${port} (${describePid(listenerPid(port) ?? '?')})`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: vpx _dev [--force] [--port <metro port>] [expo start args…]');
  process.exit(0);
}

let force = false;
let metroPort: number | null = null;
const expoArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--force') force = true;
  else if (arg === '--port') metroPort = Number(args[++i]);
  else if (arg.startsWith('--port=')) metroPort = Number(arg.slice('--port='.length));
  else expoArgs.push(arg);
}
if (expoArgs.includes('--go')) {
  fail('the app only runs as a development build; Expo Go (--go) is not supported');
}
metroPort ??= stimMetroPort() ?? DEFAULT_METRO_PORT;
if (!Number.isInteger(metroPort) || metroPort < 1 || metroPort > 65_535) {
  fail('--port needs a port number, e.g. --port 8081');
}

// mprocs prints "Stdin is not a tty" and exits 0 without one, which would look like a clean start.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail('mprocs is a terminal UI; run `vpx _dev` in an interactive terminal. Pane logs: .mprocs-logs/');
}

const splatPort = configFromEnv().port;

if (force) {
  if (listenerPid(CONTROL_PORT)) {
    // Quitting mprocs stops its panes with their SIGINT first.
    spawnSync(MPROCS, ['--server', `127.0.0.1:${CONTROL_PORT}`, '--ctl', '{c: quit}']);
    await waitForRelease(CONTROL_PORT, 15_000);
  }
  for (const port of [CONTROL_PORT, metroPort, splatPort]) await freePort(port);
}

const running = listenerPid(CONTROL_PORT);
if (running) {
  fail(
    `a dev stack is probably running: the mprocs control port ${CONTROL_PORT} is taken (${describePid(running)}).\n` +
      'Replace it with `vpx _dev --force`, or quit it with q in its terminal. Its pane logs are in .mprocs-logs/.',
  );
}

const busy = [
  { name: 'Metro', port: metroPort },
  { name: 'splat server', port: splatPort },
].flatMap(({ name, port }) => {
  const pid = listenerPid(port);
  return pid ? [`${name} port ${port} is in use (${describePid(pid)})`] : [];
});
if (busy.length > 0) {
  fail(`${busy.join('\n')}\nRun \`vpx _dev --force\` to stop them (\`stim stop\` for Stim's own dev server).`);
}

// The real binary rather than a version manager's PATH shim, so mprocs' SIGINT reaches Expo itself.
const node = run('node', ['-p', 'process.execPath']) ?? fail('node is not on PATH');
const expoCli = path.join(path.dirname(createRequire(path.join(APP_DIR, 'package.json')).resolve('expo/package.json')), 'bin/cli');

const config = {
  server: `127.0.0.1:${CONTROL_PORT}`,
  proc_log: { dir: LOG_DIR, file: '{name}.log', mode: 'truncate' },
  procs: {
    metro: {
      cmd: [node, expoCli, 'start', '--dev-client', '--port', String(metroPort), ...expoArgs],
      cwd: APP_DIR,
      // The development build's identity (apps/soon2026/app.config.ts) in the manifest it loads.
      env: { EXPO_PUBLIC_APP_VARIANT: 'development' },
      stop: 'SIGINT',
    },
    'splat-server': {
      cmd: [process.execPath, 'server/index.ts'],
      cwd: APP_DIR,
      stop: 'SIGINT',
    },
  },
};
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);

const child = Bun.spawn([MPROCS, '--config', CONFIG_PATH], { cwd: REPO_ROOT, stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(await child.exited);
