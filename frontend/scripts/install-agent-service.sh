#!/bin/bash
# Runs the Mac agent as the pm2 process `soon2026-agent` from this checkout (pm2.config.cjs), saves pm2's process list,
# and installs a launchd agent that runs `pm2 resurrect` at login, so the agent is back after a reboot. Idempotent:
# .github/workflows/agent.yml runs it on every deploy, and it can be run by hand. Needs pm2 (`bun add -g pm2`).
set -euo pipefail

FRONTEND="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.soon2026.pm2-resurrect
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.soon2026/agent"

# The GitHub Actions runner ends a job by killing every process that still carries the job's id; the pm2 daemon
# (started by the first pm2 command) and the agent inherit this environment.
export RUNNER_TRACKING_ID=

# Delete + start rather than restart, so a changed pm2.config.cjs applies in full.
cd "$FRONTEND"
pm2 delete soon2026-agent 2> /dev/null || true
pm2 start pm2.config.cjs
pm2 save

# pm2's own `pm2 startup launchd` insists on sudo, so this is the same thing as a user launch agent: pm2 on the PATH
# runs on the Mac's node (`#!/usr/bin/env node`), through the version manager's shim when there is one.
pm2_bin="$(command -v pm2)"
mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
tmp="$(mktemp)"
cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$pm2_bin</string>
    <string>resurrect</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$pm2_bin"):$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PM2_HOME</key>
    <string>${PM2_HOME:-$HOME/.pm2}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.log</string>
</dict>
</plist>
PLIST
if [ -f "$PLIST" ] && cmp -s "$tmp" "$PLIST"; then
  rm -f "$tmp"
  echo "Login hook $LABEL is installed"
else
  mv "$tmp" "$PLIST"
  # Reload it if launchd has an older version; `pm2 resurrect` runs right away, which is harmless with pm2 running.
  launchctl bootout "gui/$(id -u)/$LABEL" 2> /dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed login hook $LABEL ($PLIST)"
fi
