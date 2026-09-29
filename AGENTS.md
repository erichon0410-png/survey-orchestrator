# Agent Guidelines: Survey Orchestrator

## 1. Overview & Purpose
`survey-orchestrator` is a multi-agent automation framework that operates autonomous browser workers inside Docker containers to complete paid surveys on platforms like **Survey Junkie** and **Swagbucks**.
- **Respondent Persona**: Mei Lin Chen (`personas/mei_lin_chen.md`).
- **Harness**: `dsh` (headless) driving OpenAI-compatible LLM endpoints.
- **Stealth & Kinematics**: Humanized Bézier mouse trajectories, jitter, and virtual cursor overlays via CDP (`scripts/stealth_mouse.mjs`).

---

## 2. Active Fleet Policy (CRITICAL)
- **Active Ports**:
  - `3013`: Survey Junkie (`SurveyCompleter-gmail-03`)
  - `3014`: Swagbucks (`SurveyCompleter-gmail-04`)
- **Inactive / Reserved Ports**:
  - Ports `3015`, `3016`, and `3017` are **STRICTLY INACTIVE**.
  - **Rule**: Never deploy, monitor, or attempt to auto-repair ports 3015–3017.

---

## 3. Directory Layout
```
survey-orchestrator/
├── AGENTS.md                  # This file: Architecture, guidelines, and cheatsheet
├── README.md                  # Human-facing project overview
├── config/                    # Configuration (conversion rates, earnings targets)
│   └── earnings_rates.yaml    # Authoritative point-to-USD conversion rates
├── docker/                    # Dockerfile and container startup scripts
│   ├── Dockerfile.chromium    # Container image definition
│   └── entrypoint.sh          # Container entrypoint
├── docker-compose.yml         # Container definitions for ports 3013–3017
├── docs/                      # Architectural designs, specs, and implementation plans
│   └── superpowers/           # SDD design specs and implementation plans
├── personas/                  # Demographic profile for survey answers
│   └── mei_lin_chen.md        # Single authoritative persona
├── prompts/                   # Model system prompts and directives
│   └── survey_agent_prompt.txt# Core system prompt with anti-refusal and navigation rules
├── reports/                   # Earnings telemetry, reports, and target markers
│   ├── inbox/                 # Incoming status, tech_issue, and target_reached markers
│   └── processed/             # Archived reports
├── scripts/                   # Core operational scripts (see Section 4)
├── tests/                     # Automated unit and integration test suite
└── archive/                   # Preserved historical scratch files & exploratory probes
    ├── scratch/               # One-off test scripts and manual solvers (git-ignored)
    └── data/                  # Heavy binary artifacts (e.g. OCR model weights)
```

---

## 4. Key Executable Scripts
| Script | Description |
|---|---|
| [`scripts/deploy_fleet.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/deploy_fleet.mjs) | CLI launcher for active ports (`node scripts/deploy_fleet.mjs 3013 3014`). |
| [`scripts/fleet_supervisor.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/fleet_supervisor.mjs) | Resident daemon monitoring agent heartbeats, tracking earnings, and self-healing. |
| [`scripts/survey_driver.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/survey_driver.mjs) | Per-port driver executing multi-turn LLM loops and CDP actions. |
| [`scripts/stop_fleet.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/stop_fleet.mjs) | Safe, clean halt of all driver processes and Docker containers. |
| [`scripts/fleet_status.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/fleet_status.mjs) | Real-time CLI table showing container status, CDP connectivity, and earnings. |
| [`scripts/cdp_control.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/cdp_control.mjs) | CDP CLI helper for clicking, typing, navigating, and taking screenshots. |
| [`scripts/stealth_mouse.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/stealth_mouse.mjs) | Cubic Bézier trajectory generator and virtual cursor overlay injector. |
| [`scripts/harvest_controls.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/harvest_controls.mjs) | Atomic in-page extractor for interactive radio, checkbox, and button elements. |
| [`scripts/auto_fixer.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/auto_fixer.mjs) | Auto-repair engine used by supervisor to recover frozen or crashed containers. |
| [`scripts/human_pacer.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/human_pacer.mjs) | Anti-flagging human reading speed calculator (~220 WPM) and randomized dwell pacing regulator. |
| [`scripts/system1_decision.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/system1_decision.mjs) | Non-autoregressive decision engine (`Choice`, `Score`, `Noul` primitives) matching Mei Lin Chen persona. |
| [`scripts/system1_runner.mjs`](file:///home/erich/workspace/survey-orchestrator/scripts/system1_runner.mjs) | Sub-50ms fast-path execution engine over CDP integrating harvesting, classification, pacing, and mouse clicks. |

---

## 5. Operational Constraints & Autostart Rules
1. **No Automated Autostarts**:
   - `scripts/morning_trigger.sh` and `scripts/autostart_fleet.sh` are intentionally disabled with early `exit 0` guards. Do not remove these guards unless specifically instructed by the operator.
   - All Windows Task Scheduler tasks and WSL crontabs for morning startup have been deleted.
2. **Always Run Tests**:
   - Before finishing any task, run `npm test` to verify all 22 test suites pass.
3. **Keep the Workspace Clean**:
   - Never create scratch scripts in the root directory or directly under `scripts/`. Place any temporary debugging experiments in `archive/scratch/`.

---

## 6. Anti-Stall Architecture & Watchdogs
1. **15-Minute Watchdog Cap**:
   - `TURNS_TIMEOUT_MS = 15 * 60 * 1000` (15 minutes). No agent turn can ever hang for 90 minutes.
2. **In-Flight CDP DOM Liveness Heartbeat**:
   - `createDomLivenessHeartbeat` runs every 30s during active turns.
   - If the active survey page URL and title remain completely static for > 3 minutes (180s), it records a stall and dispatches a CDP recovery action.
   - If the stall persists for 4.5 minutes (2 consecutive checks), it escalates with `SIGTERM` to cleanly cycle the turn.
3. **Discrete Single-Survey Turn Contract**:
   - Each turn is strictly bounded to completing one questionnaire or resolving a terminal screener outcome.
   - Upon survey completion or terminal disqualification, the agent exits its turn with status 0, allowing the driver to capture fresh baseline balances and immediately relaunch.
   - Pre-interaction action streaming: the agent emits `ACTION: <inspect|click|answer> | TARGET: <selector>` before every browser action for real-time visibility.
4. **Supervisor Standby & Cooldowns**:
   - The supervisor never calls `process.exit(0)` on `isFleetTerminal`. When all ports reach terminal or idle state, it logs `fleet_standby` and enters a 15-minute resident sleep before re-checking dashboards.
   - Idle timeouts trigger temporary 15-minute cooldowns (`idleCooldowns`) rather than permanent 24-hour ban files.
5. **Automated Modal & Prescreener Unstuck Handler**:
   - `detectAndDismissStallModals` in `scripts/auto_fixer.mjs` automatically detects and clears "Missing Answer(s)" validation prompts, cookie banners, and stuck prescreener continue buttons.
6. **System 1 Fast-Path Decision & Anti-Speeding Pacing**:
   - Non-autoregressive decision engine (`scripts/system1_decision.mjs`) handles standard demographic and multiple-choice questions in sub-15ms without LLM latency.
   - Pacing regulator (`scripts/human_pacer.mjs`) enforces realistic reading duration (~220 WPM + 300ms/option, min 3.5s floor) and randomized dwell times before clicking options and submitting to prevent platform speeder bans.
   - Seamless fallback: Unhandled open textareas or complex ranking pages cleanly defer to System 2 (`dsh`).
