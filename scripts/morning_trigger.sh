#!/usr/bin/env bash
set -eo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# Keep $HOME portable: only set it if the environment didn't already provide one.
export HOME="${HOME:-$(cd ~ && pwd)}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$DIR/.." && pwd)"
cd "$WORKSPACE"

mkdir -p logs

LOG_FILE="$WORKSPACE/logs/morning_trigger.log"
echo "" >> "$LOG_FILE"
echo "==================================================================" >> "$LOG_FILE"
echo "[$(date -Iseconds)] 07:00 AM Morning Survey Fleet Trigger Initiated" >> "$LOG_FILE"
echo "==================================================================" >> "$LOG_FILE"

# 1. Start Docker Compose Stack & Wait for CDP Readiness
echo "[$(date -Iseconds)] Bringing up Docker Compose containers..." >> "$LOG_FILE"
./fleet.sh start >> "$LOG_FILE" 2>&1

# 2. Reset target_reached markers for a fresh day (earnings sync first, then clear) so the
#    supervisor re-drives ALL ports instead of skipping yesterday's "target reached" ports.
echo "[$(date -Iseconds)] Resetting target_reached markers for a fresh day..." >> "$LOG_FILE"
./scripts/reset_target_markers.sh >> "$LOG_FILE" 2>&1

# 3. Restart the Fleet Supervisor FRESH: a running supervisor caches "target reached" ports in
#    memory, so stop any stale instance and start a clean one that redeploys all agents on tick.
echo "[$(date -Iseconds)] Restarting Fleet Supervisor daemon (fresh)..." >> "$LOG_FILE"
./scripts/stop_supervisor.sh >> "$LOG_FILE" 2>&1
./scripts/start_supervisor.sh >> "$LOG_FILE" 2>&1

echo "[$(date -Iseconds)] 07:00 AM Morning Survey Fleet Trigger Finished Successfully." >> "$LOG_FILE"
