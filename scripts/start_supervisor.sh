#!/usr/bin/env bash
DIR="/home/erich/workspace/survey-orchestrator"
cd "$DIR"

SUPERVISOR_PID=$(pgrep -f "scripts/fleet_supervisor.mjs" | head -n 1)
if [ -n "$SUPERVISOR_PID" ]; then
  echo "Supervisor is already running with PID $SUPERVISOR_PID"
  exit 0
fi

mkdir -p logs
setsid node scripts/fleet_supervisor.mjs >> logs/supervisor.stdout 2>> logs/supervisor.stderr < /dev/null &
PID=$!
disown "$PID" 2>/dev/null || true
echo "Supervisor successfully started in background with PID $PID"
