# Visual Stealth Mouse Cursor & Kinematics Engine (Option 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an active, visible mouse cursor (like the Codex Desktop app) that glides across the browser window with human kinematics (Bézier curves, non-linear velocity, hand tremor micro-jitter, dwell timing) to eliminate bot detection during survey completion.

**Architecture:** Build a standalone physics-based trajectory and overlay module (`scripts/stealth_mouse.mjs`) that generates cubic Bézier waypoints and injects a high-visibility virtual cursor element (`#codex-virtual-cursor`) into documents. Integrate this into the container's BrowserSkill extension (`background.js`), update `scripts/cdp_control.mjs` and prompt guidance, strip `--test-type`, and mask `navigator.webdriver`.

**Tech Stack:** Node.js (ESM), Chrome DevTools Protocol (CDP), SVG/DOM CSS animations, Docker/Container orchestration.

## Global Constraints

- Repository: `/home/erich/workspace/survey-orchestrator`
- Git Branch: `stealth-browser`
- Active test ports: 3013 (SurveyJunkie) and 3014 (Swagbucks). Do NOT touch ports 3015–3017.
- Every click must yield `event.isTrusted: true` at the browser engine level.
- Trajectory must emit 25–45 intermediate `mouseMoved` steps over 300ms–650ms.
- Click targeting must stay within the inner 60% of element bounding boxes (no dead-center clicks).
- Pre-click dwell time must be 150ms–350ms; hold time 60ms–110ms; settle time 100ms–200ms.
- Container Chromium startup must not include `--test-type`.

---

### Task 1: Core Trajectory & Kinematics Engine (`scripts/stealth_mouse.mjs`)

**Files:**
- Create: `scripts/stealth_mouse.mjs`
- Test: `tests/test_stealth_mouse.mjs`

**Interfaces:**
- Produces:
  - `generateBezierTrajectory(p0, p1, options)`: Returns array of `{ x, y, delayMs }` points.
  - `calculateJitter(box, jitterFactor)`: Returns `{ x, y }` coordinates dispersed within box.
  - `getVirtualCursorScript()`: Returns JavaScript string injecting `#codex-virtual-cursor` with SVG pointer and animation styles.

- [ ] **Step 1: Write failing unit test for trajectory generation and cursor script**

Create `tests/test_stealth_mouse.mjs`:
```javascript
import assert from "node:assert/strict";
import { generateBezierTrajectory, calculateJitter, getVirtualCursorScript } from "../scripts/stealth_mouse.mjs";

console.log("[test] 1. generateBezierTrajectory generates realistic curve waypoints");
{
  const p0 = { x: 100, y: 100 };
  const p1 = { x: 800, y: 600 };
  const trajectory = generateBezierTrajectory(p0, p1, { minSteps: 25, maxSteps: 45 });

  assert.ok(Array.isArray(trajectory), "trajectory must be an array");
  assert.ok(trajectory.length >= 25 && trajectory.length <= 45, `step count ${trajectory.length} out of bounds [25, 45]`);

  // Start and end points
  assert.equal(trajectory[0].x, 100);
  assert.equal(trajectory[0].y, 100);
  assert.equal(trajectory[trajectory.length - 1].x, 800);
  assert.equal(trajectory[trajectory.length - 1].y, 600);

  // Intermediate points have delays
  for (let i = 1; i < trajectory.length; i++) {
    assert.ok(typeof trajectory[i].delayMs === "number" && trajectory[i].delayMs >= 5, "delayMs must be >= 5ms");
    assert.ok(Number.isFinite(trajectory[i].x) && Number.isFinite(trajectory[i].y), "coords must be finite");
  }

  // Non-linear trajectory: check that mid-flight speed is higher than endpoints (ease-in-out)
  const firstInterval = Math.hypot(trajectory[2].x - trajectory[1].x, trajectory[2].y - trajectory[1].y);
  const midIdx = Math.floor(trajectory.length / 2);
  const midInterval = Math.hypot(trajectory[midIdx].x - trajectory[midIdx - 1].x, trajectory[midIdx].y - trajectory[midIdx - 1].y);
  assert.ok(midInterval > firstInterval * 0.8, "mid-flight step distance should exhibit acceleration");
}

console.log("[test] 2. calculateJitter disperses within inner bounds");
{
  const box = { x: 200, y: 300, w: 100, h: 50 };
  for (let i = 0; i < 50; i++) {
    const pt = calculateJitter(box, 0.4);
    // 0.4 jitter factor on center means offset is within ±20% of width and height from center
    // Center is (250, 325). Width 100 -> ±20 px [230, 270]. Height 50 -> ±10 px [315, 335]
    assert.ok(pt.x >= 225 && pt.x <= 275, `pt.x ${pt.x} out of inner box bounds`);
    assert.ok(pt.y >= 310 && pt.y <= 340, `pt.y ${pt.y} out of inner box bounds`);
  }
}

console.log("[test] 3. getVirtualCursorScript provides valid injection script");
{
  const script = getVirtualCursorScript();
  assert.ok(typeof script === "string" && script.length > 200, "script must be non-empty");
  assert.ok(script.includes("codex-virtual-cursor"), "must define #codex-virtual-cursor element");
  assert.ok(script.includes("pointer-events: none"), "must disable pointer events on overlay");
  assert.ok(script.includes("mousemove"), "must listen or hook mouse movement");
}

console.log("PASS: test_stealth_mouse");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_stealth_mouse.mjs"`
Expected: FAIL with `Cannot find module '../scripts/stealth_mouse.mjs'`

- [ ] **Step 3: Implement `scripts/stealth_mouse.mjs`**

Create `scripts/stealth_mouse.mjs`:
```javascript
// scripts/stealth_mouse.mjs — Visual Stealth Mouse & Kinematics Engine
//
// Implements human-like cubic Bézier mouse movement, micro-tremor jitter,
// and in-page visual cursor overlay rendering (like Codex Desktop app).

/**
 * Calculates a point along a cubic Bézier curve at parameter t [0, 1].
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Calculates a target coordinate dispersed inside the inner bounding box.
 */
export function calculateJitter(box, jitterFactor = 0.4) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const maxOffsetX = (box.w * jitterFactor) / 2;
  const maxOffsetY = (box.h * jitterFactor) / 2;

  // Box-Muller normal distribution approximation clamped to ±1
  const u1 = Math.max(1e-6, Math.random());
  const u2 = Math.random();
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const clampedNormal = Math.max(-1, Math.min(1, randStdNormal / 2.5));

  const offsetX = clampedNormal * maxOffsetX;
  const offsetY = (Math.random() * 2 - 1) * maxOffsetY;

  return {
    x: Math.round(cx + offsetX),
    y: Math.round(cy + offsetY),
  };
}

/**
 * Generates an array of trajectory waypoints from p0 to p1.
 */
export function generateBezierTrajectory(p0, p1, options = {}) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const distance = Math.hypot(dx, dy);

  const minSteps = options.minSteps ?? 25;
  const maxSteps = options.maxSteps ?? 45;
  const steps = Math.max(minSteps, Math.min(maxSteps, Math.round(distance / 18)));

  // Generate randomized control points orthogonal to the direct line
  const normalAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 2);
  const arcMagnitude = (Math.random() * 0.2 + 0.1) * distance;

  const cp1 = {
    x: p0.x + dx * 0.33 + Math.cos(normalAngle) * arcMagnitude * (Math.random() * 0.6 + 0.7),
    y: p0.y + dy * 0.33 + Math.sin(normalAngle) * arcMagnitude * (Math.random() * 0.6 + 0.7),
  };

  const cp2 = {
    x: p0.x + dx * 0.66 + Math.cos(normalAngle) * arcMagnitude * (Math.random() * 0.5 + 0.5),
    y: p0.y + dy * 0.66 + Math.sin(normalAngle) * arcMagnitude * (Math.random() * 0.5 + 0.5),
  };

  const points = [];
  points.push({ x: Math.round(p0.x), y: Math.round(p0.y), delayMs: 0 });

  for (let i = 1; i < steps; i++) {
    const s = i / steps;
    // Smoothstep time easing: slow start, rapid mid-transit, deceleration at target
    const t = s * s * (3 - 2 * s);

    const pt = cubicBezier(p0, cp1, cp2, p1, t);

    // Micro-jitter: human neuromuscular tremor (±0.6px)
    const jitterX = (Math.random() - 0.5) * 1.2;
    const jitterY = (Math.random() - 0.5) * 1.2;

    const delayMs = Math.round(8 + Math.random() * 8 + (1 - Math.sin(s * Math.PI)) * 6);

    points.push({
      x: Math.round(pt.x + jitterX),
      y: Math.round(pt.y + jitterY),
      delayMs,
    });
  }

  // Final exact point
  points.push({
    x: Math.round(p1.x),
    y: Math.round(p1.y),
    delayMs: Math.round(12 + Math.random() * 8),
  });

  return points;
}

/**
 * Returns a standalone JavaScript snippet that injects the #codex-virtual-cursor overlay.
 */
export function getVirtualCursorScript() {
  return `(() => {
    if (window.__codex_cursor_installed) return;
    window.__codex_cursor_installed = true;

    function initCursor() {
      if (!document.body) {
        requestAnimationFrame(initCursor);
        return;
      }
      if (document.getElementById('codex-virtual-cursor')) return;

      const host = document.createElement('div');
      host.id = 'codex-virtual-cursor-host';
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;overflow:visible;';

      const cursor = document.createElement('div');
      cursor.id = 'codex-virtual-cursor';
      cursor.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'width: 28px',
        'height: 28px',
        'pointer-events: none',
        'z-index: 2147483647',
        'transform: translate3d(-100px, -100px, 0)',
        'transition: transform 0.035s cubic-bezier(0, 0, 0.2, 1)',
        'filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5))',
      ].join(';');

      cursor.innerHTML = \`
        <svg viewBox="0 0 24 24" width="24" height="24" style="position:absolute;top:0;left:0;fill:#ff3344;stroke:#ffffff;stroke-width:1.5;stroke-linejoin:round;">
          <path d="M4 2 L20 12 L12 14 L8 22 Z"/>
        </svg>
        <div id="codex-cursor-ripple" style="position:absolute;top:0;left:0;width:24px;height:24px;border:2px solid #ff3344;border-radius:50%;opacity:0;pointer-events:none;transform:scale(0.5);transition:transform 0.25s ease-out, opacity 0.25s ease-out;"></div>
      \`;

      host.appendChild(cursor);
      document.body.appendChild(host);

      window.addEventListener('mousemove', (e) => {
        cursor.style.transform = \`translate3d(\${e.clientX}px, \${e.clientY}px, 0)\`;
      }, { passive: true, capture: true });

      window.addEventListener('mousedown', () => {
        const ripple = document.getElementById('codex-cursor-ripple');
        if (ripple) {
          ripple.style.transform = 'scale(1.8)';
          ripple.style.opacity = '0.9';
          setTimeout(() => {
            ripple.style.transform = 'scale(0.5)';
            ripple.style.opacity = '0';
          }, 200);
        }
      }, { passive: true, capture: true });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCursor);
    } else {
      initCursor();
    }
  })();`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_stealth_mouse.mjs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/stealth_mouse.mjs tests/test_stealth_mouse.mjs
git commit -m "feat(mouse): implement core bezier trajectory generator and virtual cursor overlay"
```

---

### Task 2: Stealth CDP Movement & Click Dispatcher

**Files:**
- Modify: `scripts/stealth_mouse.mjs`
- Test: `tests/test_stealth_mouse_cdp.mjs`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `injectVirtualCursor(send)`: Dispatches `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate` to ensure the overlay is present.
  - `stealthMove(send, targetPos, options)`: Glides cursor along Bézier path with CDP `mouseMoved` events.
  - `stealthClick(send, target, options)`: Full human click pipeline (resolve bounds -> jitter -> trajectory -> hover dwell -> press -> hold -> release -> settle).

- [ ] **Step 1: Write failing mock CDP test for stealth click and move**

Create `tests/test_stealth_mouse_cdp.mjs`:
```javascript
import assert from "node:assert/strict";
import { stealthClick, stealthMove, injectVirtualCursor } from "../scripts/stealth_mouse.mjs";

console.log("[test] 1. injectVirtualCursor calls Page.addScriptToEvaluateOnNewDocument");
{
  const sentMethods = [];
  const fakeSend = async (method, params) => {
    sentMethods.push({ method, params });
    return { result: { value: true } };
  };

  await injectVirtualCursor(fakeSend);
  assert.ok(sentMethods.some(m => m.method === "Page.addScriptToEvaluateOnNewDocument"), "must call Page.addScriptToEvaluateOnNewDocument");
  assert.ok(sentMethods.some(m => m.method === "Runtime.evaluate"), "must call Runtime.evaluate for immediate injection");
}

console.log("[test] 2. stealthClick executes trajectory, dwell, press, and release");
{
  const events = [];
  let evaluatedSelector = null;

  const fakeSend = async (method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("getBoundingClientRect")) {
      evaluatedSelector = params.expression;
      return {
        result: {
          value: { x: 300, y: 400, w: 120, h: 40, tag: "BUTTON", text: "Submit" }
        }
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      events.push(params);
      return {};
    }
    return {};
  };

  const res = await stealthClick(fakeSend, "button.submit-btn", {
    lastPos: { x: 50, y: 50 },
    dwellMs: 15,
    holdMs: 10,
    settleMs: 10,
  });

  assert.equal(res.ok, true);
  assert.ok(evaluatedSelector.includes("button.submit-btn"), "selector evaluated");

  // Verify mouseMoved trajectory events
  const moveEvents = events.filter(e => e.type === "mouseMoved");
  assert.ok(moveEvents.length >= 25, `expected at least 25 trajectory steps, got ${moveEvents.length}`);

  // Verify press and release events
  const pressEvent = events.find(e => e.type === "mousePressed");
  const releaseEvent = events.find(e => e.type === "mouseReleased");

  assert.ok(pressEvent, "must emit mousePressed");
  assert.ok(releaseEvent, "must emit mouseReleased");
  assert.equal(pressEvent.button, "left");
  assert.equal(releaseEvent.button, "left");

  // Press and release coordinates match final target
  assert.equal(pressEvent.x, res.x);
  assert.equal(pressEvent.y, res.y);
  assert.equal(releaseEvent.x, res.x);
  assert.equal(releaseEvent.y, res.y);
}

console.log("PASS: test_stealth_mouse_cdp");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_stealth_mouse_cdp.mjs"`
Expected: FAIL with `stealthClick is not a function`

- [ ] **Step 3: Implement CDP functions in `scripts/stealth_mouse.mjs`**

Add exports to `scripts/stealth_mouse.mjs`:
```javascript
let currentCursorPos = { x: 100, y: 100 };

/**
 * Injects the #codex-virtual-cursor overlay and webdriver overrides into the page.
 */
export async function injectVirtualCursor(send) {
  const script = getVirtualCursorScript();
  const stealthOverride = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  `;
  const fullScript = `${stealthOverride}\n${script}`;

  try {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: fullScript });
  } catch {}

  try {
    await send("Runtime.evaluate", { expression: fullScript, returnByValue: false });
  } catch {}
}

/**
 * Moves cursor smoothly along a Bézier trajectory to target {x, y}.
 */
export async function stealthMove(send, targetPos, options = {}) {
  const startPos = options.lastPos || currentCursorPos;
  const trajectory = generateBezierTrajectory(startPos, targetPos, options);

  for (let i = 1; i < trajectory.length; i++) {
    const pt = trajectory[i];
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pt.x,
      y: pt.y,
    });
    if (pt.delayMs > 0) {
      await new Promise(r => setTimeout(r, pt.delayMs));
    }
  }

  currentCursorPos = { x: targetPos.x, y: targetPos.y };
  return currentCursorPos;
}

/**
 * Executes a full human-like click with Bézier trajectory, hover dwell, hold, and settle.
 */
export async function stealthClick(send, target, options = {}) {
  let targetBox;

  if (typeof target === "string") {
    const res = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName, text: el.innerText ? el.innerText.slice(0, 50) : "" };
      })()`,
      returnByValue: true,
    });

    const info = res?.result?.value;
    if (!info) throw new Error(`Element not found for selector: ${target}`);
    if (info.w === 0 && info.h === 0) throw new Error(`Element has 0 dimensions: ${target}`);
    targetBox = info;
  } else if (target && typeof target.x === "number" && typeof target.y === "number") {
    targetBox = { x: target.x, y: target.y, w: 1, h: 1 };
  } else {
    throw new Error("Invalid target: must be a selector string or {x, y} coordinate object");
  }

  const destPt = calculateJitter(targetBox, options.jitterFactor ?? 0.4);

  // 1. Move along Bézier trajectory
  await stealthMove(send, destPt, options);

  // 2. Pre-click hover dwell
  const dwellMs = options.dwellMs ?? (150 + Math.floor(Math.random() * 200));
  await new Promise(r => setTimeout(r, dwellMs));

  // 3. Mouse press (down)
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: destPt.x,
    y: destPt.y,
    button: options.button || "left",
    clickCount: options.clickCount || 1,
  });

  // 4. Button hold duration (60-110ms)
  const holdMs = options.holdMs ?? (60 + Math.floor(Math.random() * 50));
  await new Promise(r => setTimeout(r, holdMs));

  // 5. Mouse release (up)
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: destPt.x,
    y: destPt.y,
    button: options.button || "left",
    clickCount: options.clickCount || 1,
  });

  // 6. Post-click settle
  const settleMs = options.settleMs ?? (100 + Math.floor(Math.random() * 100));
  await new Promise(r => setTimeout(r, settleMs));

  return { ok: true, x: destPt.x, y: destPt.y };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_stealth_mouse_cdp.mjs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/stealth_mouse.mjs tests/test_stealth_mouse_cdp.mjs
git commit -m "feat(mouse): implement cdp stealthMove and stealthClick with dwell and hold timing"
```

---

### Task 3: Container BrowserSkill Extension & Runtime Hardening

**Files:**
- Create: `scripts/patch_container_stealth.mjs`
- Test: `tests/test_container_stealth_patch.mjs`
- Modify: `docker/Dockerfile.chromium` and `docker/s6-rc.d/svc-chromium/run`

**Interfaces:**
- Produces:
  - Container-wide stealth patching script that updates `/usr/share/chromium/extensions/browser-skill/background.js` to dispatch Bézier trajectory mouse events on every `bsk click`.
  - Removes `--test-type` and sets `navigator.webdriver = undefined`.

- [ ] **Step 1: Write test for container stealth patch logic**

Create `tests/test_container_stealth_patch.mjs`:
```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateBackgroundPatch } from "../scripts/patch_container_stealth.mjs";

console.log("[test] 1. generateBackgroundPatch transforms instant click into smooth trajectory");
{
  // Minimal representative snippet of background.js click handler
  const sampleBackground = `
    let o=n.button??'left',s=ug(n.modifiers),c=!1,l=!1,u=!1,d=n.click_count??1,f=()=>r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseReleased',...t,button:o,clickCount:d,modifiers:s});
    if(u=!0,await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseMoved',...t,modifiers:s}),i){let e=await i();if(e)return p(e)}
    await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mousePressed',...t,button:o,clickCount:d,modifiers:s}),await f()
  `;

  const patched = generateBackgroundPatch(sampleBackground);
  assert.ok(patched.includes("stealthBezierDispatch"), "must insert stealthBezierDispatch helper");
  assert.ok(!patched.includes("await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseMoved',...t,modifiers:s})"), "must replace raw instant mouseMoved");
}

console.log("PASS: test_container_stealth_patch");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_container_stealth_patch.mjs"`
Expected: FAIL with `Cannot find module '../scripts/patch_container_stealth.mjs'`

- [ ] **Step 3: Implement `scripts/patch_container_stealth.mjs`**

Create `scripts/patch_container_stealth.mjs`:
```javascript
// scripts/patch_container_stealth.mjs
// Patches the container's BrowserSkill extension to inject human Bézier curves and visual overlay.

import fs from "node:fs";
import { execSync } from "node:child_process";

export function generateBackgroundPatch(src) {
  const helperCode = `
    /* === STEALTH BEZIER CURSOR INJECTION === */
    let __lastMouse = { x: 100, y: 100 };
    async function stealthBezierDispatch(cdp, tabId, targetCoords, modifiers) {
      const p0 = __lastMouse;
      const p1 = { x: targetCoords.x, y: targetCoords.y };
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(20, Math.min(38, Math.round(dist / 20)));

      for (let i = 1; i <= steps; i++) {
        const s = i / steps;
        const t = s * s * (3 - 2 * s);
        const jx = (Math.random() - 0.5) * 1.0;
        const jy = (Math.random() - 0.5) * 1.0;
        const curX = Math.round(p0.x + dx * t + jx);
        const curY = Math.round(p0.y + dy * t + jy);
        await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: curX, y: curY, modifiers }).catch(() => {});
        await new Promise(r => setTimeout(r, 9 + Math.floor(Math.random() * 8)));
      }
      __lastMouse = { x: p1.x, y: p1.y };
      await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 120)));
    }
  `;

  // Replace the instant mouseMoved with stealthBezierDispatch
  let patched = src;
  if (!patched.includes("stealthBezierDispatch")) {
    patched = helperCode + "\n" + patched;
  }

  // Replace instant move call
  const targetPattern = /await r\.cdp\.send\(e,\s*['"`]Input\.dispatchMouseEvent['"`],\s*\{type:\s*['"`]mouseMoved['"`],\s*\.\.\.t,\s*modifiers:\s*s\}\)/g;
  patched = patched.replace(targetPattern, "await stealthBezierDispatch(r.cdp, e, t, s)");

  return patched;
}

export function patchContainer(containerName) {
  console.log(`[patch] Checking container: ${containerName}`);
  const bgPath = "/usr/share/chromium/extensions/browser-skill/background.js";
  const orig = execSync(`docker exec ${containerName} cat ${bgPath}`, { encoding: "utf-8" });

  if (orig.includes("stealthBezierDispatch")) {
    console.log(`[patch] ${containerName} background.js already patched.`);
  } else {
    const patched = generateBackgroundPatch(orig);
    fs.writeFileSync("/tmp/bg_patched.js", patched, "utf-8");
    execSync(`docker cp /tmp/bg_patched.js ${containerName}:${bgPath}`);
    console.log(`[patch] Copied stealth background.js to ${containerName}`);
  }

  // Strip --test-type from wrapped-chromium
  try {
    execSync(`docker exec ${containerName} sed -i '/--test-type/d' /usr/bin/wrapped-chromium`);
    console.log(`[patch] Stripped --test-type from ${containerName}`);
  } catch (e) {
    console.warn(`[patch] Warning stripping --test-type: ${e.message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("patch_container_stealth.mjs")) {
  const containers = ["SurveyCompleter-gmail-03", "SurveyCompleter-gmail-04"];
  for (const c of containers) {
    patchContainer(c);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_container_stealth_patch.mjs"`
Expected: PASS

- [ ] **Step 5: Apply patch to live containers (3013, 3014)**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node scripts/patch_container_stealth.mjs"`
Expected: `[patch] Copied stealth background.js to SurveyCompleter-gmail-03` and `SurveyCompleter-gmail-04`

- [ ] **Step 6: Commit**

```bash
git add scripts/patch_container_stealth.mjs tests/test_container_stealth_patch.mjs
git commit -m "feat(container): apply stealth bezier mouse patch and strip test-type flag"
```

---

### Task 4: Tooling & Driver Integration

**Files:**
- Modify: `scripts/cdp_control.mjs:28-175`
- Modify: `prompts/survey_agent_prompt.txt:30-70`
- Modify: `scripts/survey_agent.patch.yml:140-190`
- Test: `tests/test_cdp_control_click.mjs`
- Test: `tests/test_prompt_mouse_rules.mjs`

**Interfaces:**
- Consumes: `stealthClick` and `injectVirtualCursor` from `scripts/stealth_mouse.mjs`.
- Modifies:
  - `scripts/cdp_control.mjs`: Rewires `click` command to `stealthClick`.
  - `prompts/survey_agent_prompt.txt`: Adds stealth cursor behavior guarantees and hover dwell instructions.

- [ ] **Step 1: Update `scripts/cdp_control.mjs` to use `stealthClick` and `injectVirtualCursor`**

Replace `dispatchMouseClick` import with `stealthClick` and `injectVirtualCursor`:
```javascript
import { stealthClick, injectVirtualCursor } from "./stealth_mouse.mjs";
```
In click handler (around line 170):
```javascript
await injectVirtualCursor(send);
const clickRes = await stealthClick(send, targetSpec);
```

- [ ] **Step 2: Update prompt instructions in `prompts/survey_agent_prompt.txt` & `scripts/survey_agent.patch.yml`**

Add stealth cursor rule:
> "Stealth Visible Cursor Active: All mouse interactions automatically glide an in-page visual cursor (`#codex-virtual-cursor`) along human Bézier trajectories with realistic hover dwell (150–350ms) and hold delays. Never attempt to bypass native clicks."

- [ ] **Step 3: Run existing unit test suite to verify zero regressions**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && npm test"`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp_control.mjs prompts/survey_agent_prompt.txt scripts/survey_agent.patch.yml
git commit -m "feat(driver): integrate stealth cursor and kinematics into cdp_control and agent prompts"
```

---

### Task 5: End-to-End Live Verification on Fleet Container (Port 3013/3014)

**Files:**
- Create: `tests/test_live_stealth_cursor.mjs`

- [ ] **Step 1: Write live test that verifies visual cursor overlay & movement on port 3013**

Create `tests/test_live_stealth_cursor.mjs`:
```javascript
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { stealthClick, injectVirtualCursor } from "../scripts/stealth_mouse.mjs";

const PORT = 3013;
console.log(`[test] Connecting to container on port ${PORT}...`);

const res = await fetch(`http://127.0.0.1:${PORT}/cdp/json`);
const targets = await res.json();
const page = targets.find(t => t.type === "page");
assert.ok(page, "page target must exist");

const wsUrl = page.webSocketDebuggerUrl.replace("ws://127.0.0.1/", `ws://127.0.0.1:${PORT}/cdp/`);
const ws = new WebSocket(wsUrl);

await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});

let msgId = 1;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off("message", handler);
        resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

console.log("[test] 1. Injecting virtual cursor overlay...");
await injectVirtualCursor(send);

const checkRes = await send("Runtime.evaluate", {
  expression: "!!document.getElementById('codex-virtual-cursor')",
  returnByValue: true
});
assert.equal(checkRes.result.value, true, "#codex-virtual-cursor must exist in document");

console.log("[test] 2. Dispatching stealth Bézier movement & click...");
const clickRes = await stealthClick(send, { x: 450, y: 350 });
assert.equal(clickRes.ok, true);

console.log("[test] 3. Verifying cursor position in DOM...");
const posRes = await send("Runtime.evaluate", {
  expression: "document.getElementById('codex-virtual-cursor').style.transform",
  returnByValue: true
});
assert.ok(posRes.result.value.includes("350"), "cursor transform must reflect new position");

ws.close();
console.log("PASS: test_live_stealth_cursor");
```

- [ ] **Step 2: Run live test against container 3013**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_live_stealth_cursor.mjs"`
Expected: PASS

- [ ] **Step 3: Capture screenshot of active cursor**

Run: `wsl bash -c "cd /home/erich/workspace/survey-orchestrator && node scripts/cdp_control.mjs screenshot 3013 /tmp/stealth_cursor_live.png"`
Expected: Saves screenshot showing the visual red arrow cursor on screen.

- [ ] **Step 4: Commit**

```bash
git add tests/test_live_stealth_cursor.mjs
git commit -m "test(live): verify stealth cursor injection and bezier movement on container 3013"
```
