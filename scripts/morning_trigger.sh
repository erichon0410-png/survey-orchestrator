#!/usr/bin/env bash
set -eo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="/home/erich"

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

# 2. Start Fleet Supervisor daemon (auto-deploys agents on tick)
echo "[$(date -Iseconds)] Starting Fleet Supervisor daemon..." >> "$LOG_FILE"
./scripts/start_supervisor.sh >> "$LOG_FILE" 2>&1

echo "[$(date -Iseconds)] 07:00 AM Morning Survey Fleet Trigger Finished Successfully." >> "$LOG_FILE"
