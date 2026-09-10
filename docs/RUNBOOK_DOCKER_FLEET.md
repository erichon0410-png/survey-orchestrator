# Fleet Docker Compose Operations Runbook

This runbook documents how to operate the survey automation browser fleet (ports 3013–3017) using Docker Compose and the custom s6-supervised Chromium image (`survey-orchestrator-chromium:latest`).

---

## 1. Fast Toggle (Save RAM / Resume)

To save ~2 GB of system RAM when surveys are not actively running, use the convenience toggle scripts from WSL or Windows:

```bash
# In WSL:
cd ~/workspace/survey-orchestrator   # your repo checkout
./fleet.sh stop      # Stops all 5 containers -> instantly releases ~2 GB RAM (sessions 100% safe)
./fleet.sh start     # Starts all 5 containers, clears locks, waits for CDP readiness (~3s)
./fleet.sh status    # Checks container state, memory footprint, and CDP port responsiveness
./fleet.sh probe     # Inspects current page titles and URLs via CDP
```

From Windows PowerShell:
```powershell
# In PowerShell:
cd \\wsl$\Ubuntu\home\erich\workspace\survey-orchestrator
.\fleet.ps1 stop     # Free RAM
.\fleet.ps1 start    # Resume fleet
.\fleet.ps1 status   # Check health
```

---

## 2. Docker Compose Commands Reference

| Operation | Command | Notes |
|---|---|---|
| **Stop Fleet (Free RAM)** | `docker compose stop` | Frees all RAM immediately. State & external volumes remain intact. |
| **Start Fleet (Resume)** | `docker compose start` | Resumes existing containers in ~2-3 seconds. |
| **Launch Entire Fleet** | `docker compose up -d` | Starts or creates all 5 browser services |
| **Restart Fleet Containers** | `docker compose restart` | Graceful restart of container services |
| **Unload Containers** | `docker compose down` | **DO NOT USE `-v`**. Volumes are external and remain safe. |
| **Inspect Logs** | `docker logs -f <container_name>` | e.g. `docker logs -f SurveyCompleter-gmail-06` |

---

## 3. Safety Invariants & Profile Persistence

> [!CAUTION]
> **NEVER run `docker compose down -v` or `docker volume rm` on fleet volumes.**
> All 5 browser profile directories (`/config/.config/chromium`) live inside persistent Docker named volumes:
> - `moneyprinterturbo-gmail_mpt-gmail-03-config` (Port 3013 / `browser-03`)
> - `moneyprinterturbo-gmail_mpt-gmail-04-config` (Port 3014 / `browser-04`)
> - `moneyprinterturbo-gmail_mpt-gmail-05-config` (Port 3015 / `browser-05`)
> - `moneyprinterturbo-gmail_mpt-gmail-06-config` (Port 3016 / `browser-06`)
> - `moneyprinterturbo-gmail_mpt-gmail-07-config` (Port 3017 / `browser-07`)
> In `docker-compose.yml`, each volume is configured with `external: true`.

---

## 4. Host Reboot Behavior & Recovery

### What happens when the computer restarts:
1. Docker Desktop boots (configured with `AutoStart: true` and Windows HKCU Run startup entry).
2. Because every service in `docker-compose.yml` specifies `restart: unless-stopped`:
   - If containers were **running** before reboot, Docker starts them back up automatically.
   - If containers were **stopped** via `./fleet.sh stop` or `docker compose stop` before reboot, Docker honors the explicit stop and leaves them stopped (preserving your RAM until you run `./fleet.sh start`).
3. Inside each container upon startup:
   - s6-overlay boots Wayland (`labwc`) and Nginx.
   - Nginx listens on port 3000 (mapped to host `3013..3017`) and reverse-proxies `/cdp/` to `127.0.0.1:9222`.
   - s6 service `svc-chromium` detects `/config/.XDG/wayland-0`, clears stale `Singleton*` locks, and launches Chromium with `--remote-debugging-port=9222`.
   - If Chromium ever crashes during an autonomous run, s6 automatically cleans locks and relaunches it in <1 second.

---

## 5. Converted Fleet Status

All 5 browser containers are managed under Docker Compose:

| Service | Container Name | Host Port | Target Platform / Login Baseline | External Volume Name |
|---|---|---|---|---|
| `browser-03` | `SurveyCompleter-gmail-03` | 3013 | Opinion Outpost | `moneyprinterturbo-gmail_mpt-gmail-03-config` |
| `browser-04` | `SurveyCompleter-gmail-04` | 3014 | Swagbucks | `moneyprinterturbo-gmail_mpt-gmail-04-config` |
| `browser-05` | `SurveyCompleter-gmail-05` | 3015 | Eureka | `moneyprinterturbo-gmail_mpt-gmail-05-config` |
| `browser-06` | `SurveyCompleter-gmail-06` | 3016 | SurveyJunkie | `moneyprinterturbo-gmail_mpt-gmail-06-config` |
| `browser-07` | `SurveyCompleter-gmail-07` | 3017 | Swagbucks | `moneyprinterturbo-gmail_mpt-gmail-07-config` |

---

## 6. Daily 07:00 AM Automated Startup Architecture

To guarantee the entire Docker Compose fleet turns on every morning at 7:00 AM (even after being shut down the previous night to reclaim RAM), four synchronized layers ensure deterministic execution:

### Layer 1: Windows Task Scheduler (`\Survey Fleet Morning Startup`)
- **Trigger**: Daily at 07:00 AM America/New_York.
- **Power Policy**: `WakeToRun = True` (wakes the host machine if sleeping/suspended).
- **Command**: `wsl.exe -d Ubuntu -e bash -lc "<WSL repo path>/scripts/morning_trigger.sh"` (point it at your checkout, e.g. `/home/<you>/workspace/survey-orchestrator`)

### Layer 2: WSL System Cron (`cron.service`)
- **Schedule**: `0 7 * * *` in user `erich` crontab.
- **Script**: Invokes [`scripts/morning_trigger.sh`](../scripts/morning_trigger.sh).

### Layer 3: Unified Entrypoint ([`scripts/morning_trigger.sh`](../scripts/morning_trigger.sh))
- Executes `./fleet.sh start` to spin up `docker compose up -d` and verify all 5 CDP endpoints are online (HTTP 200).
- Executes `./scripts/start_supervisor.sh` using `setsid` so the supervisor daemon detaches cleanly.
- Logs full startup telemetry to [`logs/morning_trigger.log`](../logs/morning_trigger.log).

### Layer 4: Self-Healing Orchestrator Code (`orchestrator.js` & `fleet_supervisor.mjs`)
- `ensureFleetRunning()` is called at the beginning of `deployAll()`, `checkFleetHealth()`, and `fleet_supervisor.mjs:tick()`.
- If any container is stopped or CDP is unreachable, Docker Compose is automatically brought up and polled for readiness before any agents are launched.
- Supervisor daemon ignores `SIGHUP` to prevent termination when parent scripts exit.