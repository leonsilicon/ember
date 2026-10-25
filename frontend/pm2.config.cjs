// The Mac agent (src/agent) as a pm2 process, `soon2026-agent`: `pm2 start pm2.config.cjs` here, `pm2 logs
// soon2026-agent`, `pm2 ls`. On Leon's MacBook, .github/workflows/agent.yml starts it from the service's own checkout
// and restarts it on every push to main (README.md → "The Mac agent as a service"). Bun loads .env.local from this
// directory, as it does for `bun run agent`, so the process needs no env of its own.
const { execFileSync } = require('node:child_process');
const { accessSync, constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The bun binary itself rather than a version manager's PATH shim, so pm2's signals reach the agent and the path
 * `pm2 save` records keeps working at the next login: SOON_BUN if set, else the bun installer's own binary
 * (~/.bun/bin/bun, a stable path), else whatever `bun` on the PATH really runs.
 */
function bunBinary() {
  if (process.env.SOON_BUN) return process.env.SOON_BUN;
  const installed = path.join(os.homedir(), '.bun', 'bin', 'bun');
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {}
  return execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim();
}

module.exports = {
  apps: [
    {
      name: 'soon2026-agent',
      cwd: __dirname,
      script: bunBinary(),
      args: ['src/agent/main.ts'],
      interpreter: 'none',
      exec_mode: 'fork',
      // A restart means the agent crashed. Back off, and after enough of them stop in the visible `errored` state
      // rather than looping; the next deploy (pm2 delete + start) clears it.
      autorestart: true,
      min_uptime: 30_000,
      max_restarts: 10,
      exp_backoff_restart_delay: 2000,
      // SIGINT, then this long for the agent to stop Brush and close its sockets before SIGKILL.
      kill_timeout: 20_000,
      time: true,
      merge_logs: true,
      env: {
        // The GitHub Actions runner ends a job by killing every process that still carries the job's id.
        RUNNER_TRACKING_ID: '',
      },
    },
  ],
};
