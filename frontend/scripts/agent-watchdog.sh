#!/bin/bash
# Every couple of minutes (a launchd agent installed by install-agent-service.sh): if no Mac agent has a heartbeat in
# Redis, restart the pm2 process `soon2026-agent`. The agent restarts itself when it notices a dead connection
# (agent.ts), and pm2 restarts it when it crashes; this catches an agent that is up but silent. A process that started
# in the last three minutes is left alone (it may still be connecting, or a deploy is in progress), and so is a
# heartbeat from another Mac (a second agent would only refuse to start). Appends to ~/.soon2026/agent/watchdog.log.
set -uo pipefail

FRONTEND="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.soon2026/agent/watchdog.log"
export RUNNER_TRACKING_ID=
cd "$FRONTEND"

if bun scripts/agent-status.ts > /dev/null 2>&1; then
  exit 0
fi

now=$(date +%s)
started=$(pm2 jlist 2> /dev/null | bun -e '
  const [app] = JSON.parse(await Bun.stdin.text()).filter((p) => p.name === "soon2026-agent");
  console.log(app ? Math.round(app.pm2_env.pm_uptime / 1000) : 0);
' 2> /dev/null || echo 0)
if [ "$started" -gt 0 ] && [ $((now - started)) -lt 180 ]; then
  exit 0
fi

mkdir -p "$(dirname "$LOG")"
echo "$(date -u +%FT%TZ) no agent heartbeat; restarting soon2026-agent" >> "$LOG"
pm2 restart soon2026-agent >> "$LOG" 2>&1
