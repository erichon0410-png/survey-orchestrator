#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORTS=(3013 3014 3015 3016 3017)
CONTAINERS=(
  "SurveyCompleter-gmail-03:3013"
  "SurveyCompleter-gmail-04:3014"
  "SurveyCompleter-gmail-05:3015"
  "SurveyCompleter-gmail-06:3016"
  "SurveyCompleter-gmail-07:3017"
)

case "$1" in
  start|up)
    echo "=========================================="
    echo " Starting Survey Browser Fleet (Compose)  "
    echo "=========================================="
    docker compose up -d
    echo ""
    echo "Waiting for Chromium and CDP to initialize..."
    for i in {1..30}; do
      ready=0
      for p in "${PORTS[@]}"; do
        if curl -sf --max-time 1 "http://127.0.0.1:$p/cdp/json/version" >/dev/null 2>&1; then
          ready=$((ready + 1))
        fi
      done
      if [ "$ready" -eq 5 ]; then
        echo "All 5 CDP endpoints online and responding ($i s)!"
        break
      fi
      sleep 1
    done

    if [ "$ready" -lt 5 ]; then
      echo "Some CDP endpoints did not respond in 30s; healing unresponsive containers..."
      for entry in "${CONTAINERS[@]}"; do
        c="${entry%%:*}"
        p="${entry##*:}"
        if ! curl -sf --max-time 1 "http://127.0.0.1:$p/cdp/json/version" >/dev/null 2>&1; then
          echo "  Relaunching Chromium in $c (port $p)..."
          docker exec "$c" sh -c "setsid env XDG_RUNTIME_DIR=/config/.XDG WAYLAND_DISPLAY=wayland-0 DISPLAY=:1 HOME=/config wrapped-chromium --enable-features=UseOzonePlatform --ozone-platform=wayland --remote-debugging-port=9222 >/dev/null 2>&1 &" 2>/dev/null || true
        fi
      done
      sleep 3
    fi

    echo ""
    node scripts/probe_all.mjs
    echo ""
    echo "Fleet is ready."
    ;;

  stop|down)
    echo "=========================================="
    echo " Stopping Survey Browser Fleet (Freeing RAM)"
    echo "=========================================="
    echo "Terminating supervisor and agent worker processes..."
    pkill -f "scripts/fleet_supervisor.mjs" 2>/dev/null || true
    pkill -f "scripts/survey_driver.mjs" 2>/dev/null || true
    pkill -f "codex exec" 2>/dev/null || true
    sleep 1
    docker compose stop
    echo ""
    echo "Fleet stopped. Profiles and session tokens remain safe in external volumes."
    echo "Current Docker RAM usage:"
    docker stats --no-stream --format "table {{.Name}}	{{.MemUsage}}	{{.CPUPerc}}"
    ;;

  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;

  status)
    echo "=========================================="
    echo " Fleet Container & CDP Status             "
    echo "=========================================="
    docker compose ps -a
    echo ""
    echo "CDP Connectivity:"
    for p in "${PORTS[@]}"; do
      if curl -sf --max-time 1 "http://127.0.0.1:$p/cdp/json/version" >/dev/null 2>&1; then
        echo "  Port $p: [ONLINE]  CDP responding"
      else
        echo "  Port $p: [OFFLINE] not listening"
      fi
    done
    echo ""
    echo "Memory Usage:"
    docker stats --no-stream --format "table {{.Name}}	{{.MemUsage}}	{{.CPUPerc}}"
    ;;

  probe)
    node scripts/probe_all.mjs
    ;;

  *)
    echo "Usage: ./fleet.sh {start|stop|restart|status|probe}"
    echo ""
    echo "Commands:"
    echo "  start   - Starts all 5 browser containers and waits for CDP initialization"
    echo "  stop    - Safely stops containers to immediately free ~2 GB RAM"
    echo "  restart - Gracefully restarts the fleet"
    echo "  status  - Displays container state, memory footprint, and CDP liveness"
    echo "  probe   - Queries current browser page titles and URLs via CDP"
    exit 1
    ;;
esac
