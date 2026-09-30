# Ultrafast System 1 Navigation & Kinematics Turbo Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate the survey agent's end-to-end execution speed by 4x–6x by:
1. Turbocharging mouse kinematics from ~1,200ms down to ~200–250ms (Fitts's Law 8–12 Bézier steps, 35–65ms dwell, 30–45ms hold).
2. Streamlining perception from 25k-token `snapshot` accessibility trees to <1.5k-token `observe` and atomic control harvesting.
3. Eliminating the mandatory double-snapshot constraint so options and Next buttons can be clicked in rapid succession.

**Tech Stack:** Node.js (ESM), Chrome DevTools Protocol (CDP), Modern Web Animations, Docker Container Orchestration.

## Global Constraints

- Repository: `/home/erich/workspace/survey-orchestrator`
- Git Branch: `stealth-browser`
- Active test ports: 3013 (SurveyJunkie) and 3014 (Swagbucks). Do NOT touch ports 3015–3017.
- Every click must maintain `event.isTrusted: true` and visible `#codex-virtual-cursor` animation.
- All existing repository test suites in `npm test` must continue passing.

---

### Task 1: Turbo Kinematics in `scripts/stealth_mouse.mjs`

**Files:**
- Modify: `scripts/stealth_mouse.mjs`
- Test: `tests/test_stealth_mouse.mjs`
- Test: `tests/test_stealth_mouse_cdp.mjs`

- [ ] **Step 1: Update trajectory and timing defaults in `scripts/stealth_mouse.mjs`**
  - Set default `minSteps` to 8 and `maxSteps` to 14.
  - Step formula: `Math.max(minSteps, Math.min(maxSteps, Math.round(distance / 45)))`.
  - Step delay formula: `Math.round(6 + Math.random() * 4)`.
  - In `stealthClick`:
    - `dwellMs = options.dwellMs ?? (35 + Math.floor(Math.random() * 30))` (35–65ms).
    - `holdMs = options.holdMs ?? (30 + Math.floor(Math.random() * 15))` (30–45ms).
    - `settleMs = options.settleMs ?? (25 + Math.floor(Math.random() * 15))` (25–40ms).
- [ ] **Step 2: Update unit tests in `tests/test_stealth_mouse.mjs` and `tests/test_stealth_mouse_cdp.mjs`**
  - Verify waypoint count is between 8 and 14 for long distances.
  - Verify total duration of movement is ~70–120ms.
- [ ] **Step 3: Run unit tests**
  ```bash
  node tests/test_stealth_mouse.mjs && node tests/test_stealth_mouse_cdp.mjs
  ```
- [ ] **Step 4: Commit changes**
  ```bash
  git add scripts/stealth_mouse.mjs tests/test_stealth_mouse.mjs tests/test_stealth_mouse_cdp.mjs
  git commit -m "feat(mouse): implement turbo kinematics with fitts law trajectory and micro-delays"
  ```

---

### Task 2: Container Extension Turbo Patch & Live Rollout

**Files:**
- Modify: `scripts/patch_container_stealth.mjs`
- Test: `tests/test_container_stealth_patch.mjs`

- [ ] **Step 1: Update `stealthBezierDispatch` in `scripts/patch_container_stealth.mjs`**
  - Steps: `Math.max(8, Math.min(14, Math.round(dist / 45)))`.
  - Step delay: `6 + Math.floor(Math.random() * 4)`.
  - Trailing pause: `35 + Math.floor(Math.random() * 25)`.
- [ ] **Step 2: Run container patch unit test**
  ```bash
  node tests/test_container_stealth_patch.mjs
  ```
- [ ] **Step 3: Apply patch to live containers**
  ```bash
  node scripts/patch_container_stealth.mjs
  ```
- [ ] **Step 4: Commit changes**
  ```bash
  git add scripts/patch_container_stealth.mjs tests/test_container_stealth_patch.mjs
  git commit -m "feat(container): apply turbo kinematics patch to browser-skill extension"
  ```

---

### Task 3: Perception Streamlining & Prompt Tuning

**Files:**
- Modify: `prompts/survey_agent_prompt.txt`
- Modify: `scripts/survey_agent.patch.yml`
- Test: `tests/test_prompt_mouse_rules.mjs`

- [ ] **Step 1: Update prompt rules**
  - Change primary inspection from `browser_inspect(action="snapshot")` to `browser_inspect(action="observe")`.
  - Remove mandatory double-snapshot rule before clicking Next.
  - Permit clicking Next/Submit via direct selectors (`button[type="submit"]`, `input[value="Next"]`, `.next-btn`).
  - In `scripts/survey_agent.patch.yml`, configure `reasoningEfforts` to `off` (or low) for fast tool-call generation.
- [ ] **Step 2: Update `tests/test_prompt_mouse_rules.mjs` to verify prompt invariants**
- [ ] **Step 3: Run full repository test suite**
  ```bash
  npm test
  ```
- [ ] **Step 4: Commit changes**
  ```bash
  git add prompts/survey_agent_prompt.txt scripts/survey_agent.patch.yml tests/test_prompt_mouse_rules.mjs
  git commit -m "feat(prompt): streamline perception to observe mode and enable fast next targeting"
  ```

---

### Task 4: Fast Control Harvester Module (`scripts/harvest_controls.mjs`)

**Files:**
- Create: `scripts/harvest_controls.mjs`
- Test: `tests/test_harvest_controls.mjs`

- [ ] **Step 1: Write `tests/test_harvest_controls.mjs`**
  - Mock CDP session testing extraction of visible buttons, inputs, and radios.
- [ ] **Step 2: Implement `scripts/harvest_controls.mjs`**
  - Implement `getHarvestScript()` and `harvestControls(send)` inspired by `jev-ultrafast/snapshot.js`.
  - Returns compact table of actionable elements with coordinates `{ x, y }`, role, and label.
- [ ] **Step 3: Run test**
  ```bash
  node tests/test_harvest_controls.mjs
  ```
- [ ] **Step 4: Commit changes**
  ```bash
  git add scripts/harvest_controls.mjs tests/test_harvest_controls.mjs
  git commit -m "feat(harvester): add jev-inspired atomic control harvester module"
  ```

---

### Task 5: Live Fleet Verification & Agent Deployment

**Files:**
- Test: `tests/test_live_stealth_cursor.mjs`

- [ ] **Step 1: Run live container verification on ports 3013 and 3014**
  ```bash
  PORT=3013 node tests/test_live_stealth_cursor.mjs
  PORT=3014 node tests/test_live_stealth_cursor.mjs
  ```
- [ ] **Step 2: Run full repository test suite**
  ```bash
  npm test
  ```
- [ ] **Step 3: Deploy ports 3013 and 3014 agents**
  ```bash
  node scripts/deploy_fleet.mjs 3013 3014
  ```
- [ ] **Step 4: Push all changes to GitHub**
  ```bash
  git push origin stealth-browser
  ```
