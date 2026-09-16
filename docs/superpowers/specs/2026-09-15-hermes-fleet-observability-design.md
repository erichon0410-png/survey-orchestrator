# Hermes Multi-Agent Fleet Observability & Interactive Discord Bots Design Specification

- **Date:** 2026-09-15
- **Status:** Approved
- **Target Repository:** `survey-orchestrator` (`/home/erich/workspace/survey-orchestrator`)

---

## 1. Problem Statement & Motivation

Previously, monitoring the survey automation fleet (`SurveyCompleter-gmail-03` through `07` on ports `3013–3017`) required opening a terminal in WSL, tailing JSONL log files, or manually executing CLI watcher scripts (`fleet_watch.mjs`). Operators were "sitting in the blind" unless actively interacting with a terminal.

This specification designs a comprehensive Hermes integration that:
1. Dispatches automated **5-minute activity digests** to dedicated Discord channels (`#agent-3013` through `#agent-3017`) and an executive rollup to `#survey-reports`.
2. Equips Hermes with an **interactive two-way skill** (`survey-fleet-agent`) allowing users to check status, request live screenshots, read balances, and nudge containers directly within Discord.
3. Provides a **turnkey setup script** (`scripts/setup_hermes_fleet.mjs`) so that any user or fresh clone can configure the Hermes integration with a single command without modifying core supervisor or driver backend execution.

---

## 2. Channel Architecture & Port Mapping

| Port | Platform | Discord Target | Role / Container |
| :--- | :--- | :--- | :--- |
| **3013** | OpinionOutpost | `discord:#agent-3013` | Agent 03 dedicated live feed & interactive control |
| **3014** | Swagbucks | `discord:#agent-3014` | Agent 04 dedicated live feed & interactive control |
| **3015** | Eureka | `discord:#agent-3015` | Agent 05 dedicated live feed & interactive control |
| **3016** | SurveyJunkie | `discord:#agent-3016` | Agent 06 dedicated live feed & interactive control |
| **3017** | Swagbucks (2) | `discord:#agent-3017` | Agent 07 dedicated live feed & interactive control |
| **All** | Fleet-wide | `discord:#survey-reports` | 5-minute executive summary & milestone rollups |

---

## 3. Core Subsystems

### 3.1 5-Minute Live Activity Reporter (`scripts/hermes_fleet_reporter.mjs`)

* **Execution Modes:** Can run as a standalone continuous daemon (`node scripts/hermes_fleet_reporter.mjs --daemon --interval 300`) or via a scheduled Hermes Cron job (`*/5 * * * *`).
* **State Tracking:** Tracks an event cursor in `logs/fleet_events.jsonl` and parses `logs/agent_<PORT>_status.jsonl`.
* **Digest Generation:**
  - **Per-Agent Channel Digest:** Emitted to `discord:#agent-<PORT>`. Contains:
    - Current survey provider & title (e.g. *PureSpectrum*, *Repdata*)
    - Actions taken in the last 5 minutes (questions answered, forms submitted)
    - Payout gained ($USD and raw units)
    - Disqualification / screen-out notices
    - Blocker / CAPTCHA notices if any
  - **Fleet Rollup Digest:** Emitted to `discord:#survey-reports`. Summarizes:
    - Active vs. idle containers
    - Total fleet earnings delta over last 5 minutes & today's cumulative earnings
    - Completed surveys count
    - Fleet health status
* **Immediate Milestone Alerts:** Immediate dispatches for `survey_done` (+earnings) and `tech_issue` alerts without waiting for the 5-minute timer.
* **Hermes Transport:** Emits notifications using `hermes send --to discord:<target> --file <path>`.

### 3.2 Hermes Interactive Skill (`skills/survey-fleet-agent/`)

A standard Hermes skill located in `skills/survey-fleet-agent/` (and symlinked or installed to `~/.hermes/skills/survey-fleet-agent/`):

* **Context Awareness:** Automatically extracts the channel from the session context (e.g. `#agent-3013` binds to port `3013`).
* **Available Intent Actions:**
  1. **Status Query (`status` / "what are you doing?"):**
     - Queries `http://127.0.0.1:<PORT>/cdp/json` for live URL and page title.
     - Reads latest status event from `logs/agent_<PORT>_status.jsonl`.
     - Returns formatted markdown with container health, platform, current survey, and today's total.
  2. **Screenshot Query (`screenshot` / "show me your screen"):**
     - Executes `node scripts/cdp_control.mjs screenshot <PORT> -o /tmp/shot_<PORT>.png`.
     - Uploads the PNG directly to the Discord channel using Hermes's attachment pipeline.
  3. **Balance Query (`balance`):**
     - Reads balance directly from CDP or ledger.
  4. **Nudge / Recovery Query (`nudge` / "restart"):**
     - Writes a nudge or signals the supervisor to restart the container's turn.

### 3.3 Turnkey Setup & Installation Script (`scripts/setup_hermes_fleet.mjs`)

A single command setup utility:
* Verifies `hermes` CLI exists on the system path.
* Verifies Discord platform connection and confirms `#agent-3013` through `#agent-3017` and `#survey-reports` are registered.
* Installs `skills/survey-fleet-agent` into Hermes (`~/.hermes/skills/`).
* Schedules the 5-minute cron job in Hermes (`hermes cron create ...`).
* Sends a test greeting message to each channel confirming end-to-end delivery.

### 3.4 Invariant: Non-Breaking Backend

* `scripts/survey_driver.mjs`, `scripts/fleet_supervisor.mjs`, and the container fleet operate autonomously.
* If Hermes is offline, the gateway is stopped, or Discord credentials are not present, all survey automation runs without errors or interruption.

---

## 4. Verification & Testing Plan

1. **Unit Tests:**
   - Test reporter event parser: feeds simulated `fleet_events.jsonl` entries and verifies correct grouping by port and accurate earnings calculation.
   - Test channel routing: verifies `#agent-3013` binds to `3013`, `#survey-reports` binds to `all`.
2. **End-to-End Live Verification:**
   - Run `node scripts/hermes_fleet_reporter.mjs --dry-run` to verify formatted markdown output.
   - Dispatch a test payload via `hermes send --to discord:#agent-3013` and `discord:#survey-reports` to confirm live Discord receipt.
   - Test interactive skill commands (`status`, `screenshot`) with a live container.
