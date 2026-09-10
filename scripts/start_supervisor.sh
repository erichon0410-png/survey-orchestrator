#!/usr/bin/env bash
# Resolve the repo root from this script's location (<root>/scripts/) so it is portable.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Detect a running node supervisor. Filter on /proc/<pid>/comm == "node" so a caller shell that
# merely mentions the pattern in its command line is not mistaken for the supervisor.
SUPERVISOR_PID=""
for _p in $(pgrep -f "fleet_supervisor\.mjs" 2>/dev/null || true); do
  [ "$(cat "/proc/$_p/comm" 2>/dev/null)" = "node" ] && { SUPERVISOR_PID="$_p"; break; }
done
if [ -n "$SUPERVISOR_PID" ]; then
  echo "Supervisor is already running with PID $SUPERVISOR_PID"
  exit 0
fi

mkdir -p logs
setsid node scripts/fleet_supervisor.mjs >> logs/supervisor.stdout 2>> logs/supervisor.stderr < /dev/null &
PID=$!
disown "$PID" 2>/dev/null || true
echo "Supervisor successfully started in background with PID $PID"
