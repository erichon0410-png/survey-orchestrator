#!/usr/bin/env bash
# Reset (clear) target_reached markers so the fleet supervisor re-drives ALL ports for a
# fresh day. Idempotent + safe to run repeatedly; designed to run every morning before
# agents launch (see scripts/morning_trigger.sh).
#
# WHY: a `*_target_reached_*.json` marker in reports/inbox or reports/processed tells the
# supervisor that its port is "done" and to skip it (checked recursively, on disk AND cached
# in memory). Clearing the markers unblocks every port so a FRESH supervisor process
# redeploys all agents. (The fresh-process part is handled by the caller: stop + start.)
#
# EARNINGS SAFETY: current balances are read from the append-only ledger, NOT by re-reading
# marker files (see scripts/earnings_ledger.mjs latestBalances). Markers are just triggers:
# once earnings_sync has processed a marker it is recorded in the ledger + seen set. So
# clearing is safe as long as each marker was already synced into the ledger. We therefore
# run earnings sync FIRST (best-effort) before moving any marker out. A sync failure does not
# block the clear, because the next day's marker re-captures the current cumulative balance;
# it is logged loudly regardless.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

mkdir -p logs
LOG="logs/marker_reset.log"
log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG"
}

log "reset_target_markers: start"

# 1. Best-effort earnings sync so any pending markers are captured into the ledger + seen set
#    BEFORE they are cleared (see EARNINGS SAFETY above).
if node scripts/earnings_sync.mjs >> "$LOG" 2>&1; then
  log "earnings sync completed before clearing markers."
else
  rc=$?
  log "WARN: earnings sync exited non-zero (rc=${rc}); continuing to clear markers."
fi

# 2. Move every target_reached marker out of inbox + processed into a dated archive dir.
#    Recursive (matches the supervisor's recursive hasTargetMarker scan). Files are MOVED, not
#    deleted, so they are preserved as evidence. The source-dir prefix avoids an inbox/processed
#    filename collision; any subpath is flattened with underscores.
STAMP="$(date -u +%Y%m%d_%H%M%S)"
ARCHIVE="reports/archive/target_reached/${STAMP}"
moved=0
for d in reports/inbox reports/processed; do
  [ -d "$d" ] || continue
  src_tag="$(basename "$d")"
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    mkdir -p "$ARCHIVE"
    rel="${f#"$d"/}"
    dest="$ARCHIVE/${src_tag}_${rel//\//_}"
    if mv -n "$f" "$dest"; then
      moved=$((moved+1))
    else
      log "WARN: failed to move $f -> $dest"
    fi
  done < <(find "$d" -type f -name '*_target_reached_*.json' 2>/dev/null)
done

log "reset_target_markers: cleared ${moved} marker(s) -> reports/archive/target_reached/${STAMP}"
exit 0
