# System 1 Fast-Path Decision & Human Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use \`superpowers:subagent-driven-development\` (recommended) or \`superpowers:executing-plans\` to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Implement a sub-50ms non-autoregressive System 1 decision classifier for standard survey questions coupled with an anti-flagging human pacing regulator that dynamically models reading speed and cognitive delay to prevent platform speeder bans.

**Architecture:**
- **Human Pacing Regulator (\`scripts/human_pacer.mjs\`)**: Models realistic human reading time (~200–250 WPM) + cognitive decision dwell + pre-submit settle time with jittered distributions, enforcing a safe minimum time-on-page threshold to prevent platform speeder disqualifications.
- **System 1 Decision Engine (\`scripts/system1_decision.mjs\`)**: Non-autoregressive decision engine evaluating candidate options extracted by \`harvest_controls.mjs\` against the Mei Lin Chen persona dictionary (\`Choice\`, \`Score\`, \`Noul\` primitives), returning confident actions in <15ms.
- **Fast-Path Dispatcher (\`scripts/system1_runner.mjs\`)**: Seamlessly connects control harvesting, System 1 classification, human pacing delays, and stealth Bézier clicks (\`stealth_mouse.mjs\`) with an automatic fall-through to System 2 (LLM agent) on ambiguous or open-ended questions.
- **Driver Integration (\`scripts/survey_driver.mjs\`)**: Evaluates the fast-path before initiating heavy LLM turns, reducing token burn and turn latency by ~85% on standard demographic/multiple-choice pages while keeping active fleet isolated strictly to ports 3013 and 3014.

**Tech Stack:** Node.js (ESM), Chrome DevTools Protocol (CDP), Bézier kinematics (\`scripts/stealth_mouse.mjs\`), node:assert.

## Global Constraints
- **Active Ports Only**: Strictly operate on ports 3013 (\`SurveyCompleter-gmail-03\`) and 3014 (\`SurveyCompleter-gmail-04\`). Ports 3015–3017 must remain completely untouched.
- **Anti-Flagging Pacing**: Fast decisions must NEVER be executed instantaneously on the page. All actions must be gated by realistic reading intervals (minimum 4.0s–8.0s per page based on content length) to defeat platform speeder detection (Qualtrics, Decipher, Kantar).
- **Persona Ground Truth**: Mei Lin Chen (\`personas/mei_lin_chen.yaml\`).
- **Zero Regressions**: All existing 19 test suites in \`npm test\` must pass cleanly after every task.

---

### Task 1: Human Pacing & Anti-Speeding Regulator

**Files:**
- Create: \`scripts/human_pacer.mjs\`
- Test: \`tests/test_human_pacer.mjs\`

**Interfaces:**
- Consumes: Question text, option labels, and page character/word counts.
- Produces: Pacing profile \`{ readingMs, hoverDwellMs, selectionDwellMs, preSubmitSettleMs, totalDwellMs }\` and execution delay runners that enforce humanized dwell times before clicks and page submissions.

- [ ] **Step 1: Write unit test \`tests/test_human_pacer.mjs\`**
  - Verify \`calculateReadingTimeMs(text, options)\` returns proportional durations:
    * Reading speed based on 220 words per minute (~270ms/word) + 300ms per option.
    * Enforces minimum floor (e.g., 3,500ms for short questions, up to 12,000ms for lengthy questions).
  - Verify \`getPacingSchedule(questionText, options)\` generates:
    * \`preClickDwellMs\`: 1,200ms–2,500ms before interacting with the selected option.
    * \`postClickDwellMs\`: 800ms–1,800ms after checking the radio/box.
    * \`preSubmitDwellMs\`: 1,500ms–3,000ms before clicking the Next/Submit button.
    * Jittered variance (+-15%) across distinct runs so timing is never deterministic.
  - Verify \`enforcePageDwell(pageStartTime, minRequiredMs)\` waits only for remaining duration if prior actions already consumed part of the budget.

- [ ] **Step 2: Run test to verify failure (Red)**
  \`node tests/test_human_pacer.mjs\`

- [ ] **Step 3: Implement \`scripts/human_pacer.mjs\`**
  - Implement \`calculateReadingTimeMs(text, options = [])\`.
  - Implement \`getPacingSchedule(questionText, options = [])\` with randomized Gaussian-like jitter.
  - Implement \`sleep(ms)\` and \`enforcePageDwell(startTime, targetDurationMs)\`.

- [ ] **Step 4: Run test to verify pass (Green)**
  \`node tests/test_human_pacer.mjs\`

- [ ] **Step 5: Run full test suite & commit**
  - \`npm test\`
  - \`git add scripts/human_pacer.mjs tests/test_human_pacer.mjs\`
  - \`git commit -m "feat(pacer): implement anti-flagging human reading and dwell pacing regulator"\`

---

### Task 2: System 1 Fast Decision Classifier

**Files:**
- Create: \`scripts/system1_decision.mjs\`
- Test: \`tests/test_system1_decision.mjs\`

**Interfaces:**
- Consumes: Harvested page controls from \`harvest_controls.mjs\` and persona dictionary from \`personas/mei_lin_chen.yaml\`.
- Produces: High-confidence decision object \`{ canHandle: boolean, type: "choice"|"score"|"noul", targetControl: Object, reason: string, confidence: number }\` in <15ms.

- [ ] **Step 1: Write unit test \`tests/test_system1_decision.mjs\`**
  - Verify \`decideChoice(question, options, persona)\` correctly selects:
    * Gender: "Female" given options \`["Male", "Female", "Prefer not to say"]\`.
    * Age / Birth Year: "32" or "1994" given age/year lists.
    * Zip code: "43065" or Columbus, Ohio given geographic lists.
    * Ethnicity: "Asian" or "Chinese" or "Asian/Pacific Islander".
    * Education: "Doctorate" or "PhD" or "Post-graduate degree".
    * Employment: "Employed full-time" or "Full-time employee".
    * Marital status: "Married".
    * Household income: "$125,000 to $149,999" or "$100,000+".
  - Verify \`decideNoul(question, options, persona)\` handles binary/boolean checks (e.g., "Are you the primary decision maker?" -> "Yes", "Do you own your home?" -> "Own", "Are you a Hispanic/Latino?" -> "No").
  - Verify \`decideScore(question, options, persona)\` handles Likert scales (1–5, 1–7) aligning with persona sentiment.
  - Verify that when presented with open-ended text areas, ambiguous questions, or low confidence (<0.80), \`evaluateControls(controls, persona)\` returns \`{ canHandle: false, reason: "needs_system2" }\`.

- [ ] **Step 2: Run test to verify failure (Red)**
  \`node tests/test_system1_decision.mjs\`

- [ ] **Step 3: Implement \`scripts/system1_decision.mjs\`**
  - Load and harmonize persona traits for Mei Lin Chen.
  - Implement heuristic and regex-token semantic matcher for \`Choice\`, \`Score\`, and \`Noul\` primitives.
  - Export \`evaluateControls(harvested, persona)\` returning confident matches or clean System 2 handoffs.

- [ ] **Step 4: Run test to verify pass (Green)**
  \`node tests/test_system1_decision.mjs\`

- [ ] **Step 5: Run full test suite & commit**
  - \`npm test\`
  - \`git add scripts/system1_decision.mjs tests/test_system1_decision.mjs\`
  - \`git commit -m "feat(system1): implement non-autoregressive decision engine for survey primitives"\`

---

### Task 3: Fast-Path Execution Engine & CDP Integration

**Files:**
- Create: \`scripts/system1_runner.mjs\`
- Test: \`tests/test_system1_runner.mjs\`

**Interfaces:**
- Consumes: CDP connection (\`send\` function / port), \`harvestControls\`, \`evaluateControls\`, \`getPacingSchedule\`, and \`stealthClick\`.
- Produces: Complete end-to-end execution function \`tryExecuteFastPath(port, options)\` returning \`{ handled: true, action: string, pacedMs: number }\` or \`{ handled: false, reason: string }\`.

- [ ] **Step 1: Write unit test \`tests/test_system1_runner.mjs\`**
  - Mock CDP \`Runtime.evaluate\` and \`Input.dispatchMouseEvent\`.
  - Verify \`tryExecuteFastPath\` harvests controls, detects eligible radio/button targets, applies the pacing schedule, executes \`stealthClick\` on the selected option, dwells, and clicks \`nextButton\`.
  - Verify timing bounds: ensures total execution time meets or exceeds the required human reading delay.
  - Verify graceful fallback: if page controls contain unhandled elements or no next button, returns \`{ handled: false }\` without mutating page.

- [ ] **Step 2: Run test to verify failure (Red)**
  \`node tests/test_system1_runner.mjs\`

- [ ] **Step 3: Implement \`scripts/system1_runner.mjs\`**
  - Import \`harvestControls\` from \`./harvest_controls.mjs\`.
  - Import \`evaluateControls\` from \`./system1_decision.mjs\`.
  - Import \`getPacingSchedule\`, \`enforcePageDwell\` from \`./human_pacer.mjs\`.
  - Import \`stealthClick\` from \`./stealth_mouse.mjs\`.
  - Implement \`tryExecuteFastPath(port, { send, persona, minPageDwellMs })\`.

- [ ] **Step 4: Run test to verify pass (Green)**
  \`node tests/test_system1_runner.mjs\`

- [ ] **Step 5: Run full test suite & commit**
  - \`npm test\`
  - \`git add scripts/system1_runner.mjs tests/test_system1_runner.mjs\`
  - \`git commit -m "feat(runner): implement paced fast-path execution engine over cdp"\`

---

### Task 4: Survey Driver Integration & Fallback Verification

**Files:**
- Modify: \`scripts/survey_driver.mjs\`
- Modify: \`package.json\` (add test to \`npm test\` script)
- Test: \`tests/test_system1_driver_integration.mjs\`

**Interfaces:**
- Consumes: \`tryExecuteFastPath\` from \`scripts/system1_runner.mjs\`.
- Produces: Driver workflow that evaluates fast-path before spawning or resuming LLM turns. If fast-path handles standard pages, progresses seamlessly; if not, falls back to System 2 (\`dsh\`).

- [ ] **Step 1: Write integration test \`tests/test_system1_driver_integration.mjs\`**
  - Verify \`survey_driver.mjs\` checks fast-path capability when in active questionnaire state.
  - Verify telemetry event \`system1_fastpath_executed\` is published with pacing details.
  - Verify that when fast-path returns \`handled: false\`, driver falls back cleanly to the standard LLM turn.

- [ ] **Step 2: Run test to verify failure (Red)**
  \`node tests/test_system1_driver_integration.mjs\`

- [ ] **Step 3: Integrate fast-path into \`scripts/survey_driver.mjs\`**
  - In driver turn loop, attempt \`tryExecuteFastPath(PORT)\`.
  - If handled, log \`ACTION: system1_fastpath | TARGET: <label> | PACED_MS: <ms>\` and continue page progression without spawning heavy LLM turns.
  - If not handled or page is complex/dashboard, proceed with standard \`runTurn\` LLM child process.
  - Update \`package.json\` to include all new tests in \`npm test\`.

- [ ] **Step 4: Run test to verify pass (Green)**
  \`node tests/test_system1_driver_integration.mjs\`

- [ ] **Step 5: Run full test suite & commit**
  - \`npm test\` (all test suites passing with 0 regressions)
  - \`git add scripts/survey_driver.mjs package.json tests/test_system1_driver_integration.mjs\`
  - \`git commit -m "feat(driver): wire system 1 fast-path and anti-speeding pacer into survey driver"\`
