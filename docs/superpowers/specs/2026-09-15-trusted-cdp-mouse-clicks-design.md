# Trusted CDP Mouse Emulation Design Specification

- **Date:** 2026-09-15
- **Status:** Approved
- **Target Repository:** `survey-orchestrator` (`/home/erich/workspace/survey-orchestrator`)

---

## 1. Problem Statement & Motivation

The `survey-orchestrator` drives containerized Chromium instances (ports `3013–3017`) using Codex survey agents and helper scripts. Previously, interaction instructions in `prompts/survey_agent_prompt.txt` directed agents to "first try via Runtime.evaluate ... and call `.click()` on it".

### Issues with Code-Based Clicks:
1. **`event.isTrusted === false`:** JavaScript-invoked clicks (`element.click()`, `dispatchEvent()`) are flagged by Chromium as untrusted.
2. **Missing Pointer Telemetry:** Synthetically evaluated clicks lack screen coordinates (`clientX = 0, clientY = 0`), hover states, and prior pointer trajectories.
3. **Bot Detection Screening:** Modern survey providers (Qualtrics, Opinion Outpost, Swagbucks, Prime Opinion) and anti-fraud systems (DataDome, Cloudflare Turnstile, reCAPTCHA Enterprise, Research Defender) actively flag untrusted events, screening out the persona or disqualifying runs.

---

## 2. Goals & Invariants

1. **Trusted Events Everywhere:** All clicks executed by Codex agents or supervisor tools must be emitted via Chrome DevTools Protocol (`Input.dispatchMouseEvent`), ensuring `event.isTrusted: true` at the Chromium engine level.
2. **Realistic Movement & Hold Timings:** Mouse actions must simulate micro-trajectories (`mouseMoved`), subtle coordinate jitter within element bounding boxes, and realistic button hold durations (60–110ms) before release.
3. **No Container or Profile Disruptions:** Changes must operate purely at the agent harness and driver layers without requiring Docker image rebuilds or volume wipes.

---

## 3. Architecture & Implementation

### 3.1 Session Startup Helper (`mouseClick`) in `prompts/survey_agent_prompt.txt`

The initial Node REPL connection snippet in `prompts/survey_agent_prompt.txt` will expose a global `mouseClick` function alongside `cdp`:

```javascript
let lastMousePos = { x: 100, y: 100 };
globalThis.mouseClick = async (target, opts = {}) => {
  let x, y;
  if (typeof target === "string") {
    const res = await cdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName, text: el.innerText.slice(0, 50) };
      })()`,
      returnByValue: true
    });
    const info = res?.result?.value;
    if (!info) throw new Error(`Element not found for selector: ${target}`);
    if (info.w === 0 || info.h === 0) throw new Error(`Element has 0 dimensions: ${target}`);

    // Subtle coordinate jitter in the central 60% of the element
    const jitterX = (Math.random() - 0.5) * (info.w * 0.4);
    const jitterY = (Math.random() - 0.5) * (info.h * 0.4);
    x = Math.round(info.x + info.w / 2 + jitterX);
    y = Math.round(info.y + info.h / 2 + jitterY);
  } else if (target && typeof target.x === "number" && typeof target.y === "number") {
    x = Math.round(target.x);
    y = Math.round(target.y);
  } else {
    throw new Error("Invalid target: must be a selector string or {x, y} coordinate object");
  }

  // 1. Intermediate trajectory step (human-like motion)
  const midX = Math.round((lastMousePos.x + x) / 2 + (Math.random() * 6 - 3));
  const midY = Math.round((lastMousePos.y + y) / 2 + (Math.random() * 6 - 3));
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: midX, y: midY });
  await new Promise(r => setTimeout(r, 15 + Math.floor(Math.random() * 20)));

  // 2. Target hover
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 25)));

  // 3. Mouse press (down)
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  
  // 4. Human hold delay (60-110ms)
  await new Promise(r => setTimeout(r, 60 + Math.floor(Math.random() * 50)));

  // 5. Mouse release (up)
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  lastMousePos = { x, y };
  return { ok: true, x, y };
};
```

### 3.2 Strict Prompt Instructions

In `prompts/survey_agent_prompt.txt`:
1. Remove all instructions mentioning `element.click()` or `Runtime.evaluate` `.click()`.
2. Rule 3 will mandate:
   > "3. Click an element: ALWAYS use `await mouseClick(selector)` (e.g. `await mouseClick('.survey-card')`) or `await mouseClick({ x, y })`. NEVER call `element.click()` or synthetic JS `.dispatchEvent(new MouseEvent('click'))`. Modern survey platforms inspect `event.isTrusted: true` and pointer telemetry. `mouseClick` automatically scrolls the target into view, emits realistic hover trajectories with jitter, and fires genuine browser-level `Input.dispatchMouseEvent` events with human hold timing."

### 3.3 Upgrading `scripts/cdp_control.mjs`

Add a first-class `click` command:
- Syntax: `node scripts/cdp_control.mjs click <port> --selector "<css>" [--match <url-substring>]` or `node scripts/cdp_control.mjs click <port> --coords "<x,y>"`
- Shares the same CDP mouse dispatch logic so watchdog scripts and manual tests emit trusted clicks.

---

## 4. Verification & Testing Plan

1. **Unit / Functional Verification:**
   - Run a standalone test against an active container or local test page verifying that an attached listener receives a click event where:
     - `event.isTrusted === true`
     - `event.clientX > 0 && event.clientY > 0`
     - Intermediate `mousemove` events were observed.
2. **Regression Check:**
   - Validate `cdp_control.mjs` commands (`targets`, `eval`, `click`, `screenshot`).
   - Run `pytest` / test suite in `survey-orchestrator` to confirm zero unintended regressions.
