#!/usr/bin/env bash
# Boot-time / autostart bring-up for the survey fleet.
# Idempotent + safe to run repeatedly (Startup-folder hook or manually).
# Sequence: wait for Docker daemon -> ensure survey containers up -> start host supervisor.
set -u
# Resolve the repo root from this script's location (<root>/scripts/) so it is portable.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
mkdir -p logs
LOG="logs/autostart.log"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

# 1) Wait for the Docker daemon to be reachable (Docker Desktop auto-starts at logon).
i=0
until docker info >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 36 ]; then log "WARN: docker daemon not reachable after ~180s; proceeding anyway"; break; fi
  sleep 5
done
log "docker daemon reachable (after $((i*5))s of waiting)"

# 2) Ensure the survey containers are running (idempotent no-op if already up).
#    Retired -01/-02 are intentionally excluded so they stay down.
for c in SurveyCompleter-gmail-03 SurveyCompleter-gmail-04 SurveyCompleter-gmail-05 SurveyCompleter-gmail-06 SurveyCompleter-gmail-07; do
  if docker start "$c" >/dev/null 2>&1; then log "ensured up: $c"; else log "note: could not start $c (stopped/absent)"; fi
done

# 3) Start the host supervisor (idempotent via pgrep guard in start_supervisor.sh).
if bash scripts/start_supervisor.sh >>"$LOG" 2>&1; then
  log "supervisor started (or already running)"
else
  log "WARN: start_supervisor.sh returned non-zero"
fi
log "autostart_fleet complete"
