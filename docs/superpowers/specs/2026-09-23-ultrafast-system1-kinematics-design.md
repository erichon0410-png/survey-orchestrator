# Ultrafast System 1 Navigation & Kinematics Turbo Engine Design Specification

- **Date:** 2026-09-23
- **Status:** Approved
- **Target Repository:** `survey-orchestrator` (`/home/erich/workspace/survey-orchestrator`)
- **Git Branch:** `stealth-browser`

---

## 1. Executive Summary & Problem Statement

Surveys on ports 3013 (SurveyJunkie) and 3014 (Swagbucks) suffer from two distinct compounding latency bottlenecks:

1. **Slow Mechanical Kinematics (~1,000ms–1,400ms per click):**
   - The initial stealth cursor implementation used 20–38 intermediate Bézier steps with 9–17ms delay each (~400ms).
   - Combined with 150–350ms pre-click hover dwell, 60–110ms button hold, and 120–240ms trailing settle delay, a single click consumes ~1.2 seconds.
   - While effective for anti-bot heuristics, human rapid aim (Fitts's Law ballistic saccades) naturally achieves 120–180ms transit times without triggering bot alarms.

2. **Perception & Decision Latency (~8–15s per question):**
   - **Accessibility Tree Bloat:** `browser_inspect({ action: "snapshot" })` serializes the full accessibility tree, pushing 15,000–30,000 tokens into the prompt per turn. Processing this on local/remote LLMs consumes 2–5 seconds of prefill compute per step.
   - **Mandatory Double-Snapshot Round Trip:** Prompts strictly enforced:
     > *"CRITICAL MANDATORY SNAPSHOT: Dynamic survey engines ... ALWAYS re-run `browser_inspect({ action: 'snapshot' })` to obtain fresh @eN refs before clicking Next!"*
     This forced two complete LLM turns (two full snapshot dumps) for a single question: Turn 1 for the radio button, Turn 2 for the Next button.
   - **Chain-of-Thought Overhead:** Reasoning models output hundreds of thinking tokens before selecting obvious demographic options.

3. **Inspirations from `browser-use/jev-ultrafast` & `convaiinnovations/laya`:**
   - `jev-ultrafast` demonstrated completing Google Flights in 7.07s by replacing full accessibility tree reads with atomic in-page visible control harvesting (`snapshot.js`, <1,000 tokens) and disabling reasoning.
   - `convaiinnovations/laya` (ModernBERT-large 421M parameter bidirectional encoder, Apache 2.0) demonstrates **~25–33ms single-forward-pass typed decision-making**, providing an open-source, self-hostable System 1 reflex engine.

---

## 2. Goals & System Invariants

1. **Kinematics Turbo:**
   - Reduce transit time to 70–110ms across 8–12 Bézier waypoints.
   - Tighten pre-click dwell to 35–65ms, button hold to 30–45ms, and settle to 25–40ms.
   - Total mechanical click duration: **~200–260ms** (5x speedup), preserving the visible gliding cursor (`#codex-virtual-cursor`) and Box-Muller jitter.
2. **Lightweight Perception (<1,500 tokens):**
   - Replace heavy `action: "snapshot"` with `action: "observe"` and native in-page control harvesting.
   - Remove the mandatory double-snapshot constraint from all driver prompts.
   - Enable direct CSS selector targets for standard Next/Submit buttons (`button[type="submit"]`, `input[value="Next"]`, `.next-btn`).
3. **System 1 / System 2 Hybrid Architecture:**
   - **System 1 (Reflex Layer):** Rapid candidate-matching reflex policy for standard demographic questions and single-choice forms (25–40ms decision).
   - **System 2 (Cognitive Layer):** Generative LLM fallback (Ornith 9B / GPT-6 Luna) reserved for free-text inputs, complex screeners, or low-confidence choices.
4. **Safety & Test Invariants:**
   - Zero regressions across existing test suites (`npm test` 13/13 passing).
   - Strict container isolation on ports 3013 and 3014.

---

## 3. System Architecture & Components

```
                              [ Webpage State (CDP Port 3013/3014) ]
                                                │
                                                ▼
                             [ Lightweight Control Harvester / Observe ]
                             - Filters visible & actionable controls only
                             - Emits compact element table (<1,200 tokens)
                                                │
                       ┌────────────────────────┴────────────────────────┐
                       ▼                                                 ▼
        [ System 1: Fast Reflex Policy ]                      [ System 2: Cognitive LLM ]
         (Laya / Rule-Based Reflex Matcher)                    (Ornith-1.5-9B / GPT-6 Luna)
         • Latency: ~25ms                                      • Latency: ~1.5–3.0s
         • High-confidence demographic choice                  • Complex multi-step reasoning
         • Direct Next / Submit triggers                       • Free-text essay generation
                       │                                                 │
                       └────────────────────────┬────────────────────────┘
                                                │ Target Coordinates {x, y}
                                                ▼
                                [ Turbo Kinematics Engine ]
                                 scripts/stealth_mouse.mjs
                                 - 8-12 Bézier Steps (70-110ms)
                                 - 35-65ms Hover Dwell
                                 - 30-45ms Hold, 25-40ms Settle
                                                │
                                                ▼
                           [ Chromium Viewport & #codex-virtual-cursor ]
                                 - Rapid, smooth glide across screen
                                 - Crisp click ripple & DOM dispatch
```

---

## 4. Component Details & Interfaces

### Component 1: Turbo Kinematics Engine (`scripts/stealth_mouse.mjs`)
- `generateBezierTrajectory(from, to, options)`:
  - Default `minSteps`: `8` (was 18).
  - Default `maxSteps`: `14` (was 45).
  - Step formula: `Math.max(8, Math.min(14, Math.round(distance / 45)))`.
  - Delay formula: `Math.round(6 + Math.random() * 4)` (~7ms per step).
- `stealthClick(send, target, options)`:
  - Default `dwellMs`: `35 + Math.floor(Math.random() * 30)` (35–65ms).
  - Default `holdMs`: `30 + Math.floor(Math.random() * 15)` (30–45ms).
  - Default `settleMs`: `25 + Math.floor(Math.random() * 15)` (25–40ms).

### Component 2: Container Extension Background Patch (`scripts/patch_container_stealth.mjs`)
- Update `stealthBezierDispatch(cdp, tabId, targetCoords, modifiers)`:
  - Steps: `Math.max(8, Math.min(14, Math.round(dist / 45)))`.
  - Delay: `6 + Math.floor(Math.random() * 4)` ms.
  - Trailing pause: `35 + Math.floor(Math.random() * 25)` ms (down from 120–240ms).

### Component 3: Prompt & Rule Streamlining (`prompts/survey_agent_prompt.txt`, `scripts/survey_agent.patch.yml`)
- Update instructions from `browser_inspect(action="snapshot")` to `browser_inspect(action="observe")`.
- Remove the "ALWAYS re-run browser_inspect({ action: 'snapshot' }) before clicking Next" rule.
- Add permission to click Next/Continue buttons in the same turn or via CSS selectors.
- Configure `reasoningEfforts: off` (or low) for fast tool-call generation.

### Component 4: System 1 Fast Control Harvester (`scripts/harvest_controls.mjs`)
- In-page script running via `Runtime.evaluate` (inspired by `jev-ultrafast/snapshot.js`):
  - Queries `a, button, input, select, textarea, [role]`.
  - Checks `e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })`.
  - Extracts labels and current values into a compact table.
  - Automatically identifies candidate demographic inputs and primary submission buttons.

---

## 5. Implementation Phases & Task Decomposition

1. **Task 1: Turbo Kinematics in `scripts/stealth_mouse.mjs` & Tests**
   - Update trajectory step count and delay calculations.
   - Update dwell, hold, and settle timings.
   - Run `tests/test_stealth_mouse.mjs` and `tests/test_stealth_mouse_cdp.mjs`.
2. **Task 2: Container Extension Kinematics Update & Live Patching**
   - Update `scripts/patch_container_stealth.mjs` with fast Bézier parameters.
   - Apply patch to `SurveyCompleter-gmail-03` and `SurveyCompleter-gmail-04`.
   - Run `tests/test_container_stealth_patch.mjs`.
3. **Task 3: Driver Prompts & Perception Streamlining**
   - Update `prompts/survey_agent_prompt.txt` and `scripts/survey_agent.patch.yml`.
   - Update `tests/test_prompt_mouse_rules.mjs` to reflect optimized prompt invariants.
   - Run full repository test suite (`npm test`).
4. **Task 4: Fast Control Harvester Module**
   - Implement `scripts/harvest_controls.mjs` and unit tests in `tests/test_harvest_controls.mjs`.
5. **Task 5: Live Verification & Deployment**
   - Verify on live containers 3013 and 3014.
   - Restart agents on ports 3013 and 3014.
