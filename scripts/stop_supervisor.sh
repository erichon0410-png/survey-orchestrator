#!/usr/bin/env bash
# Stop the fleet supervisor cleanly via SIGTERM. Idempotent: a no-op when nothing is running.
#
# A FRESH supervisor process is required after clearing target_reached markers, because a
# running supervisor caches "target reached" ports in its in-memory `targetPorts` map (see
# scripts/fleet_supervisor.mjs) and will keep skipping those ports for the life of the process
# even after the on-disk markers are gone. SIGTERM is handled cleanly by the supervisor
# (shutdown -> process.exit(0)).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

PATTERN="fleet_supervisor\.mjs"

# PIDs of ACTUAL node processes running the supervisor. We filter on /proc/<pid>/comm == "node"
# so a caller shell that merely mentions the pattern in its own command line (e.g. a wrapper or
# this very script) is never signalled.
sup_pids() {
  local p comm
  for p in $(pgrep -f "$PATTERN" 2>/dev/null || true); do
    [ -r "/proc/$p/comm" ] || continue
    comm="$(cat "/proc/$p/comm" 2>/dev/null || true)"
    [ "$comm" = "node" ] && printf '%s\n' "$p"
  done
}

if [ -z "$(sup_pids)" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] stop_supervisor: not running (nothing to stop)."
  exit 0
fi

kill $(sup_pids) 2>/dev/null || true
for _ in $(seq 1 20); do
  [ -z "$(sup_pids)" ] && break
  sleep 0.5
done

if [ -n "$(sup_pids)" ]; then
  echo "stop_supervisor: still running after SIGTERM; sending SIGKILL." >&2
  kill -9 $(sup_pids) 2>/dev/null || true
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] stop_supervisor: stopped cleanly (SIGTERM)."
fi
exit 0
