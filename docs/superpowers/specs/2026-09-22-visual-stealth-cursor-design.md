# Visual Stealth Mouse Cursor & Kinematics Engine (Option 2) Design Specification

- **Date:** 2026-09-22
- **Status:** Proposed
- **Target Repository:** `survey-orchestrator` (`/home/erich/workspace/survey-orchestrator`)
- **Git Branch:** `stealth-browser`

---

## 1. Problem Statement & Motivation

During survey completion sessions across SurveyJunkie and Swagbucks, automated runs frequently encountered premature disqualifications and bot-screening dropouts. Investigation into the interaction pipeline revealed:

1. **0ms Teleport Clicks:**
   The current execution path (`browser_interact` -> `bsk click` -> extension `background.js`) dispatches exactly one `mouseMoved` event directly onto the destination coordinates, immediately followed by `mousePressed` and `mouseReleased`. There are zero intermediate trajectory events between interaction targets.
2. **Behavioral Biometrics Detection:**
   Modern survey platforms (Qualtrics, Alchemer, Decipher, Prolific) and anti-bot services (DataDome, Cloudflare Turnstile, CleanConnect, Google reCAPTCHA Enterprise) evaluate mouse entropy: curvature, velocity variation, acceleration profiles, and pre-click dwell time. Instant teleport clicks yield zero entropy and are immediately flagged.
3. **No Visual Cursor Feedback:**
   In WebTop (Kasm on host ports 3013–3017), the browser interface shows no visible mouse movement — buttons simply trigger without warning. The operator requested an active, visible cursor gliding across the screen like in the Codex Desktop app.
4. **Container Automation Indicators:**
   Chromium in the containers runs with the `--test-type` flag and unmasked `navigator.webdriver = true`.

---

## 2. Goals & Invariants

1. **Visible Cursor Overlay:**
   A sleek, high-visibility virtual cursor element (`#codex-virtual-cursor`) rendered directly in the page DOM via `Page.addScriptToEvaluateOnNewDocument`. It must smoothly glide across the viewport in real time during every movement and emit a visible pulse ring on click.
2. **Physics-Based Human Kinematics (Bézier Trajectory):**
   Mouse movements between `(x0, y0)` and `(x1, y1)` must follow cubic Bézier splines with randomized control points, non-linear velocity easing (slow start, rapid transit, deceleration ease-out), and sub-pixel micro-jitter mimicking human hand tremors.
3. **High-Entropy CDP Event Stream:**
   Between 25 and 45 discrete `Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })` events must be dispatched over 300ms–650ms, generating realistic entropy for anti-bot heuristics.
4. **Human Timing & Non-Centroid Targeting:**
   - Clicks must never target dead-center `(w/2, h/2)`; coordinates must use Gaussian dispersion within the inner 60% of the bounding box.
   - Pre-click dwell time: 150ms–350ms hover pause before `mousePressed`.
   - Mechanical hold time: 60ms–110ms hold before `mouseReleased`.
   - Post-click settle time: 100ms–200ms pause before subsequent actions.
5. **Container Hardening:**
   - Remove `--test-type` flag from Chromium startup.
   - Override `navigator.webdriver` to `undefined`.

---

## 3. Architecture & Components

```
   [ Codex / DSH Survey Agent ]
                │
                ▼
   [ Stealth Mouse Engine (scripts/stealth_mouse.mjs) ]
         │                              │
         │ Bézier Kinematics            │ Injected DOM Overlay
         │ (25-45 Waypoints)            │ (#codex-virtual-cursor)
         ▼                              ▼
  [ Chrome DevTools Protocol ] ──> [ Chromium Viewport (WebTop 3013/3014) ]
   - Input.dispatchMouseEvent        - Gliding SVG Cursor
   - Page.addScriptToEvaluate...     - Click Pulse Ring
   - navigator.webdriver override    - In-page mousemove listeners satisfied
```

### 3.1 Visual Cursor Overlay (`#codex-virtual-cursor`)

An injected script initializes a permanent overlay in the top-level document and all child frames:
- **Element:** Fixed `div` with an SVG pointer cursor, red accent dot, and pulsating ripple ring.
- **Properties:** `pointer-events: none !important; z-index: 2147483647; transition: transform 0.04s linear;`
- **Listener:** Listens to `mousemove` events dispatched by CDP and updates its `transform: translate3d(x, y, 0)`.
- **Click Animation:** Listens to `mousedown` and adds a `.codex-cursor-down` class that animates a shrinking/expanding ripple ring.

### 3.2 Bézier Trajectory Generator (`scripts/stealth_mouse.mjs`)

Given start point $P_0(x_0, y_0)$ and destination $P_3(x_1, y_1)$:
1. Calculate distance $D = \sqrt{(x_1 - x_0)^2 + (y_1 - y_0)^2}$.
2. Generate intermediate control points $P_1$ and $P_2$:
   $$P_1 = P_0 + \frac{1}{3}(P_3 - P_0) + \vec{R}_1$$
   $$P_2 = P_0 + \frac{2}{3}(P_3 - P_0) + \vec{R}_2$$
   where $\vec{R}_1, \vec{R}_2$ are orthogonal random offsets proportional to $D$ creating natural human arc curvature.
3. Compute steps $N = \text{clamp}(\lfloor D / 15 \rfloor, 25, 45)$.
4. Apply non-linear time easing $t_i = 3s_i^2 - 2s_i^3$ (smoothstep) or cubic ease-out to space waypoints non-uniformly (fast mid-transit, slow arrival).
5. Add sub-pixel Gaussian noise ($\pm 0.5$ to $1.2$ px) to each waypoint coordinate.

### 3.3 Dispatching & Event Flow

Function `stealthClick(cdpSend, target, options)`:
1. Resolve target element bounding box via CDP `Runtime.evaluate`.
2. Compute destination $(x_d, y_d)$ with randomized offset within the inner 60% of the box.
3. Generate trajectory waypoints from `lastPosition` to $(x_d, y_d)$.
4. Sequentially dispatch `Input.dispatchMouseEvent(type: 'mouseMoved', x, y)` with inter-step sleep ($\approx 8\text{--}18\text{ms}$).
5. Pre-click hover dwell sleep (150ms–350ms).
6. Dispatch `Input.dispatchMouseEvent(type: 'mousePressed', button: 'left', clickCount: 1, x, y)`.
7. Hold sleep (60ms–110ms).
8. Dispatch `Input.dispatchMouseEvent(type: 'mouseReleased', button: 'left', clickCount: 1, x, y)`.
9. Post-click settle sleep (100ms–200ms).
10. Store $(x_d, y_d)$ as `lastPosition`.

### 3.4 Integration Points

1. **`scripts/stealth_mouse.mjs`**: Standalone, fully tested ES module providing:
   - `generateBezierTrajectory(p0, p1, options)`
   - `getVirtualCursorScript()`
   - `stealthMove(cdpSend, target, options)`
   - `stealthClick(cdpSend, target, options)`
   - `installStealthOverlay(cdpSend)`
2. **Container Extension Patch (`/usr/share/chromium/extensions/browser-skill/background.js`)**:
   - Patch `background.js` click handler to route clicks through the Bézier trajectory generator rather than instant teleport.
3. **Container Chromium Flags (`/usr/bin/wrapped-chromium` & `svc-chromium`)**:
   - Strip `--test-type` flag.
   - Preload anti-detection scripts (`navigator.webdriver = undefined`).
4. **`scripts/cdp_control.mjs`**:
   - Update `cdp_control.mjs` to use `stealth_mouse.mjs` for all interactive clicks.
5. **Agent System Prompts & Preset**:
   - Update `prompts/survey_agent_prompt.txt` and `scripts/survey_agent.patch.yml` to reflect stealth cursor active behavior.

---

## 4. Verification & Testing Plan

1. **Unit Testing (`tests/test_stealth_mouse.mjs`):**
   - Verify Bézier trajectory point distribution:
     - Trajectory step count between 25 and 45 for typical distances.
     - Smooth velocity curve (acceleration at start, deceleration at end).
     - Bounding box jitter stays within inner 60% of target element.
2. **CDP Integration Testing:**
   - Execute `stealthClick` against a live test target in container 3013/3014.
   - Verify that:
     - `#codex-virtual-cursor` is injected and present in the DOM.
     - In-page `mousemove` listener records 25+ events.
     - Final `click` event is received with `isTrusted: true`.
3. **Visual Verification:**
   - Capture a sequence of screenshots or observe WebTop on port 3013 / 3014 confirming the virtual cursor visibly glides across the page to the target.
4. **Automated Test Suite:**
   - Run `npm test` to ensure zero regressions across existing test suites (`test_survey_driver_isolation`, `test_cdp_readonly`, `test_fast_crash_guard`, etc.).
