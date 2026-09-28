# Anti-Stall & Supervisor Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate agent browser stalls, 90-minute dead hangs, and premature supervisor termination so survey agents actively progress without stalling on active ports 3013 and 3014.

**Architecture:**
- **Supervisor Resilience**: Constrain active fleet strictly to ports 3013 & 3014. Replace permanent 24h `idle_today` bans with a 15-minute cooldown and remove supervisor self-exit (`process.exit(0)`).
- **Driver Watchdog**: Lower per-turn timeout from 90m to 15m. Add an in-flight CDP DOM liveness heartbeat that detects 3-minute static page stalls and dispatches recovery actions before timeout.
- **Turn Lifecycle & Prompt Optimization**: Align the agent prompt with a discrete single-survey turn contract so turns exit cleanly upon survey completion or platform disqualification.
- **Modal Unstuck Engine**: Extend `auto_fixer.mjs` and `cdp_control.mjs` to auto-detect and resolve stuck prescreeners or "Missing Answer(s)" validation prompts.

**Tech Stack:** Node.js (ESM), Chrome DevTools Protocol (CDP), DSH headless harness, node:assert.

## Global Constraints
- **Active Ports Only**: Strictly operate on ports 3013 (`SurveyCompleter-gmail-03`) and 3014 (`SurveyCompleter-gmail-04`). Ports 3015–3017 must remain completely inactive.
- **Persona Ground Truth**: Mei Lin Chen (`personas/mei_lin_chen.md`).
- **All 15 Tests Must Pass**: Run `npm test` after every task.

---

### Task 1: Supervisor Resilience & Cooldown Engine

**Files:**
- Modify: `scripts/fleet_supervisor.mjs`
- Test: `tests/test_supervisor_resilience.mjs`

**Interfaces:**
- Consumes: `FLEET` from `~/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js`
- Produces: Resilient supervisor loop that filters to ports 3013 & 3014, enters a 15-minute standby sleep instead of exiting `process.exit(0)` when all ports are idle, and uses temporary cooldowns instead of 24h bans.

- [ ] **Step 1: Write unit test `tests/test_supervisor_resilience.mjs`**
  - Verify that `FLEET` in `fleet_supervisor.mjs` only contains ports 3013 and 3014.
  - Verify that `checkIdleTimeouts` places an agent in temporary cooldown without writing an immutable daily ban file when configured with `useCooldown: true`.
  - Verify that when all active ports are terminal/idle, the supervisor does NOT call `process.exit(0)` but triggers a standby cycle.

- [ ] **Step 2: Run test to verify failure (Red)**
  `node tests/test_supervisor_resilience.mjs`

- [ ] **Step 3: Implement supervisor resilience in `scripts/fleet_supervisor.mjs`**
  - Filter imported `FLEET` strictly to `[3013, 3014]`.
  - In `isFleetTerminal` / main tick: remove `await shutdown()` / `process.exit(0)`. Instead, enter a standby delay (15 min) and log standby status.
  - In `checkIdleTimeouts`: replace `idle_today` marker writing with a 15-minute cooldown entry in `idleCooldowns` map unless explicitly capped.

- [ ] **Step 4: Run test to verify pass (Green)**
  `node tests/test_supervisor_resilience.mjs`

- [ ] **Step 5: Run full test suite & commit**
  - `npm test`
  - `git add scripts/fleet_supervisor.mjs tests/test_supervisor_resilience.mjs`
  - `git commit -m "feat(supervisor): make fleet supervisor resident with 15m cooldown and port 3013/3014 isolation"`

---

### Task 2: 15-Minute Watchdog & In-Flight DOM Liveness Heartbeat

**Files:**
- Modify: `scripts/survey_driver.mjs`
- Test: `tests/test_dom_liveness_heartbeat.mjs`

**Interfaces:**
- Consumes: `http://127.0.0.1:<PORT>/cdp/json`
- Produces: In-flight heartbeat function `startDomLivenessHeartbeat({ port, maxStallMs, onStall })` and reduced `TURNS_TIMEOUT_MS = 15 * 60 * 1000`.

- [ ] **Step 1: Write unit test `tests/test_dom_liveness_heartbeat.mjs`**
  - Mock CDP endpoints returning identical URL + title for > `maxStallMs` and verify `onStall` callback is invoked.
  - Verify that when URL changes or DOM changes, the stall timer resets.
  - Verify `TURNS_TIMEOUT_MS` defaults to 15 minutes (900,000 ms).

- [ ] **Step 2: Run test to verify failure (Red)**
  `node tests/test_dom_liveness_heartbeat.mjs`

- [ ] **Step 3: Implement DOM Liveness Heartbeat in `scripts/survey_driver.mjs`**
  - Set `TURNS_TIMEOUT_MS = Number(process.env.SURVEY_TURN_TIMEOUT_MS) || 15 * 60 * 1000`.
  - Implement `startDomLivenessHeartbeat(port, child)`:
    * Runs every 30 seconds.
    * Queries `http://127.0.0.1:<port>/cdp/json` to find the active survey tab.
    * Tracks `lastUrl` and `lastHash`. If identical for > 3 minutes (180,000 ms) while on an active questionnaire/screener, trigger stall recovery:
      1. Attempt pressing Enter or clicking any visible "Next" / "Continue" / "Dismiss" buttons via CDP.
      2. If still unchanged after 4.5 minutes, send SIGTERM to the child to rotate turn without burning 15m.

- [ ] **Step 4: Run test to verify pass (Green)**
  `node tests/test_dom_liveness_heartbeat.mjs`

- [ ] **Step 5: Run full test suite & commit**
  - `npm test`
  - `git add scripts/survey_driver.mjs tests/test_dom_liveness_heartbeat.mjs`
  - `git commit -m "feat(driver): reduce turn timeout to 15m and add 3m cdp dom liveness heartbeat"`

---

### Task 3: Real-Time Action Streaming & Single-Survey Turn Contract

**Files:**
- Modify: `scripts/survey_driver.mjs`
- Modify: `prompts/survey_agent_prompt.txt`
- Modify: `scripts/survey_agent.patch.yml`
- Test: `tests/test_stream_and_single_survey_prompt.mjs`

**Interfaces:**
- Consumes: `setupCodexStreams` and prompt templates
- Produces: Prompt guidelines directing the model to complete or terminate the current questionnaire and cleanly conclude the turn rather than polling in an infinite loop.

- [ ] **Step 1: Write unit test `tests/test_stream_and_single_survey_prompt.mjs`**
  - Test prompt assertions verifying the single-survey turn contract (exit turn on survey completion/screenout).
  - Verify that `setupCodexStreams` flushes stdout and logs actions in real-time.

- [ ] **Step 2: Run test to verify failure (Red)**
  `node tests/test_stream_and_single_survey_prompt.mjs`

- [ ] **Step 3: Implement prompt and stream updates**
  - In `prompts/survey_agent_prompt.txt`:
    * Update rule: When a questionnaire finishes (payout awarded, screenout message, or terminal disqualification), exit the turn cleanly so the driver can capture the fresh balance delta.
    * Instruct the model to emit a progress line before each interaction: `ACTION: <inspect|click|answer> | TARGET: <selector>`.
  - In `scripts/survey_agent.patch.yml`:
    * Synchronize prompt and tool configuration.
  - In `scripts/survey_driver.mjs`:
    * Ensure `setupCodexStreams` writes every line immediately to `agent_<PORT>_driver.log` and status streams.

- [ ] **Step 4: Run test to verify pass (Green)**
  `node tests/test_stream_and_single_survey_prompt.mjs`

- [ ] **Step 5: Run full test suite & commit**
  - `npm test`
  - `git add prompts/survey_agent_prompt.txt scripts/survey_agent.patch.yml scripts/survey_driver.mjs tests/test_stream_and_single_survey_prompt.mjs`
  - `git commit -m "feat(prompt): implement single-survey turn contract and real-time action streaming"`

---

### Task 4: Automated Modal & Prescreener Unstuck Handler

**Files:**
- Modify: `scripts/auto_fixer.mjs`
- Test: `tests/test_autofix_modal_unstuck.mjs`

**Interfaces:**
- Consumes: CDP evaluation on active page
- Produces: `detectAndDismissStallModals(port)` in `auto_fixer.mjs`

- [ ] **Step 1: Write unit test `tests/test_autofix_modal_unstuck.mjs`**
  - Mock DOM containing "Missing Answer(s)", unhandled modal backdrop, or cookie consent banners.
  - Verify `detectAndDismissStallModals` detects the modal and dispatches dismissal / resolution clicks via CDP.

- [ ] **Step 2: Run test to verify failure (Red)**
  `node tests/test_autofix_modal_unstuck.mjs`

- [ ] **Step 3: Implement `detectAndDismissStallModals` in `scripts/auto_fixer.mjs`**
  - Add CDP script checking for:
    * Standard validation error banners (`.validation-error`, `text*="Missing Answer"`, `text*="Please answer"`).
    * Cookie / GDPR banners (`#onetrust-accept-btn-handler`, `button:has-text('Accept All')`).
    * Prescreener continue buttons (`button.continue-btn`, `input[value="Continue"]`).
  - Automatically click to resolve or advance.

- [ ] **Step 4: Run test to verify pass (Green)**
  `node tests/test_autofix_modal_unstuck.mjs`

- [ ] **Step 5: Run full test suite & commit**
  - `npm test`
  - `git add scripts/auto_fixer.mjs tests/test_autofix_modal_unstuck.mjs`
  - `git commit -m "feat(autofix): add automated modal and validation error unstuck handler"`

---

### Task 5: End-to-End Verification & Documentation Update

**Files:**
- Modify: `package.json`
- Modify: `AGENTS.md`
- Test: Full repository test suite (`npm test`)

- [ ] **Step 1: Add new test suites to `package.json`**
  - Include `test_supervisor_resilience.mjs`, `test_dom_liveness_heartbeat.mjs`, `test_stream_and_single_survey_prompt.mjs`, `test_autofix_modal_unstuck.mjs`.

- [ ] **Step 2: Run full test suite**
  - `npm test` (all 19 test suites must pass).

- [ ] **Step 3: Update `AGENTS.md`**
  - Document the 15m timeout, 3m DOM liveness watchdog, and 15m supervisor cooldown behavior.

- [ ] **Step 4: Commit and finalize**
  - `git commit -am "chore(docs): document anti-stall heartbeat, 15m timeouts, and updated test suite"`
