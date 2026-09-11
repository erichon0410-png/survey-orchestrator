# Fleet Live Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide real-time live terminal streaming of fleet activity (supervisor actions, per-port codex subagent actions, survey navigation, questions answered, earnings updates, and errors) via a non-blocking Unix domain socket EventHub without breaking existing log files or corrupting the codex JSONL protocol.

**Architecture:**
1. Protocol Boundary & Normalizer (`scripts/fleet_events.mjs`): Standardized JSON event envelope and normalizer converting raw codex JSONL chunks (`item.started`, `item.completed`, `thread.started`, earnings strings, tool titles) and supervisor actions into human-readable event messages.
2. Transport & Fanout (`scripts/observability_hub.mjs`): Unix domain socket (`logs/fleet-observability.sock`) EventHub with reconnectable publisher (bounded drop-oldest buffer so telemetry failure never kills workers), subscriber fanout, and unified journal sink (`logs/fleet_events.jsonl`).
3. Survey Driver Stdio Separation (`scripts/survey_driver.mjs`): Spawn codex with separated `stdio: ["ignore", "pipe", "pipe"]`, streaming raw JSONL to `agent_<port>.log` while simultaneously parsing and publishing normalized events, routing stderr to `agent_<port>.stderr.log`.
4. Supervisor Event Integration (`scripts/fleet_supervisor.mjs`): Host the EventHub, emit supervisor lifecycle events (ticks, autofix passes, idle timeouts, restart caps, daily sync).
5. Terminal Watcher CLI (`scripts/fleet_watch.mjs` and updated `scripts/fleet_watcher.mjs`): Line-oriented, colored, pipe-friendly terminal watcher streaming live activity formatted per user requirements (`[port 3015] opened survey...`, `port 3015 earned $0.15!`, `[supervisor] ...`).

**Tech Stack:** Node.js (v18+, ESM, stdlib only: `node:net`, `node:fs`, `node:path`, `node:child_process`, `node:readline`), Linux Unix Domain Sockets.

## Global Constraints
- Target Workspace: `/home/erich/workspace/survey-orchestrator`
- Zero external dependencies: stdlib only (`node:fs`, `node:net`, `node:path`, `node:child_process`, `node:readline`).
- Zero GPU consumption: Local models or CUDA tasks must not be invoked during testing or runtime.
- Telemetry failure must never kill or block drivers or supervisor (fire-and-forget, bounded queues).
- Never break or corrupt existing logs (`agent_<port>.log`, `supervisor.log`, `agent_<port>_status.jsonl`).
- All tests must pass: `tests/test_fleet_events.mjs`, `tests/test_observability_hub.mjs`, and existing test suites.

---

### Task 1: Event Envelope & Codex Protocol Normalizer (`scripts/fleet_events.mjs`)

**Files:**
- Create: `scripts/fleet_events.mjs`
- Test: `tests/test_fleet_events.mjs`

**Interfaces:**
- Produces:
  - `createEventEnvelope({ source, port, event, message, detail, ts }) -> FleetEvent`
  - `normalizeCodexLine(line, port) -> FleetEvent | null`
  - `formatTerminalLine(event, { noColor } = {}) -> string`
  - `parseEarningsFromText(text) -> { earnedUsd: number, rawMatch: string } | null`

- [ ] **Step 1: Write failing test for event normalization and terminal formatting**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `scripts/fleet_events.mjs`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: Unix Domain Socket Transport & EventHub (`scripts/observability_hub.mjs`)

**Files:**
- Create: `scripts/observability_hub.mjs`
- Test: `tests/test_observability_hub.mjs`

**Interfaces:**
- Produces:
  - `createEventHub({ sockPath, journalPath }) -> { start(), stop(), publish(event), getSubscriberCount() }`
  - `createEventPublisher({ sockPath, port, maxBuffer }) -> { publish(event), close() }`
  - `createEventSubscriber({ sockPath, onEvent, onError }) -> { close() }`

- [ ] **Step 1: Write failing test for EventHub, publisher, subscriber, and journal persistence**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `scripts/observability_hub.mjs`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Driver Stdio Separation & Live Normalization (`scripts/survey_driver.mjs`)

**Files:**
- Modify: `scripts/survey_driver.mjs`
- Test: `tests/test_survey_driver_observability.mjs`

**Interfaces:**
- Consumes:
  - `normalizeCodexLine` from `scripts/fleet_events.mjs`
  - `createEventPublisher` from `scripts/observability_hub.mjs`
- Guarantees:
  - `agent_<port>.log` continues to receive uncorrupted JSONL stdout from codex.
  - `agent_<port>.stderr.log` captures stderr independently.
  - Live codex output chunks are parsed line-by-line in real-time and published to the EventHub.
  - Driver lifecycle events (start, turn start/end, nudges, tech_issue, target reached) are published.

- [ ] **Step 1: Write integration test for driver stdio separation and event emission**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Modify `scripts/survey_driver.mjs`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run existing driver kill test to verify no regressions**
- [ ] **Step 6: Commit**

---

### Task 4: Supervisor EventHub Hosting & Event Broadcasting (`scripts/fleet_supervisor.mjs`)

**Files:**
- Modify: `scripts/fleet_supervisor.mjs`
- Test: `tests/test_supervisor_observability.mjs`

**Interfaces:**
- Consumes: `createEventHub` from `scripts/observability_hub.mjs`
- Guarantees:
  - Supervisor initializes `EventHub` on startup (`logs/fleet-observability.sock`, `logs/fleet_events.jsonl`).
  - Broadcasts supervisor events: `tick_start`, `ports_alive`, `agent_redeploy`, `idle_timeout_terminate`, `autofix_summary`, `restart_cap`, `daily_sync`.
  - Cleanly closes `EventHub` on SIGTERM / SIGINT.

- [ ] **Step 1: Write unit test verifying supervisor EventHub integration**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Modify `scripts/fleet_supervisor.mjs`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run existing auto-fixer and restart recovery tests to verify no regressions**
- [ ] **Step 6: Commit**

---

### Task 5: Live Terminal Watcher CLI (`scripts/fleet_watch.mjs`)

**Files:**
- Create: `scripts/fleet_watch.mjs`
- Modify: `scripts/fleet_watcher.mjs` (support `--live` or delegate to `fleet_watch.mjs`)
- Test: `tests/test_fleet_watch.mjs`

**Interfaces:**
- Consumes:
  - `createEventSubscriber` from `scripts/observability_hub.mjs`
  - `formatTerminalLine` from `scripts/fleet_events.mjs`
- CLI features:
  - `node scripts/fleet_watch.mjs` -> streams live events across all ports and supervisor.
  - `--port 3015` -> filter to specific port.
  - `--errors-only` -> filter to errors and tech_issues.
  - `--replay N` -> show last N events from `fleet_events.jsonl` before streaming live.
  - Graceful fallback: If socket is not yet created, tail `logs/fleet_events.jsonl` until socket appears.

- [ ] **Step 1: Write test for terminal watcher formatting and filtering**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `scripts/fleet_watch.mjs`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 6: Full End-to-End Verification

- [ ] **Step 1: Run complete test suite**
- [ ] **Step 2: Verify git status and clean working tree**
- [ ] **Step 3: Provide DSH handoff prompt**
