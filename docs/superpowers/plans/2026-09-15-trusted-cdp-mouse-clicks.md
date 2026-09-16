# Trusted CDP Mouse Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement physical-like mouse clicking via Chrome DevTools Protocol (`Input.dispatchMouseEvent`) across survey agent prompts and CLI control tools to guarantee `event.isTrusted: true` and realistic pointer motion.

**Architecture:** Create a standalone module `scripts/mouse_helper.mjs` that calculates element center, applies realistic sub-pixel jitter, and dispatches an authentic sequence of CDP mouse events (`mouseMoved`, `mousePressed`, hold delay, `mouseReleased`). Integrate this helper into `scripts/cdp_control.mjs` via a `click` command, update the Node REPL startup boilerplate and interaction instructions in `prompts/survey_agent_prompt.txt`, and verify with deterministic unit tests.

**Tech Stack:** Node.js (ESM), Chrome DevTools Protocol (CDP), WebSocket (`ws`), Node `node:assert/strict`.

## Global Constraints

- Never use `element.click()` or synthetic JS DOM events for automated clicks.
- All clicks must emit `Input.dispatchMouseEvent` with `isTrusted: true`.
- Zero Docker container rebuilds or profile volume mutations.
- Keep tests fast and deterministic using Node's `node:assert/strict`.

---

### Task 1: Core Mouse Dispatch Module (`scripts/mouse_helper.mjs`) & Unit Tests

**Files:**
- Create: `scripts/mouse_helper.mjs`
- Test: `tests/test_mouse_helper.mjs`

**Interfaces:**
- Produces: `dispatchMouseClick(send, target, options)`
  - `send`: `(method: string, params: object) => Promise<any>`
  - `target`: `string` (CSS selector) | `{ x: number, y: number }`
  - `options`: `{ lastPos?: { x: number, y: number }, jitterPercent?: number, holdMs?: number, minJitter?: boolean }`
  - Returns: `Promise<{ ok: boolean, x: number, y: number }>`

- [ ] **Step 1: Write the failing unit test**

Create `tests/test_mouse_helper.mjs`:
```javascript
import assert from "node:assert/strict";
import { dispatchMouseClick } from "../scripts/mouse_helper.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

await asyncCheck("dispatches trusted mouse event sequence for coordinates", async () => {
  const sent = [];
  const fakeSend = async (method, params) => {
    sent.push({ method, params });
    return {};
  };

  const result = await dispatchMouseClick(fakeSend, { x: 200, y: 150 }, { lastPos: { x: 50, y: 50 }, holdMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.x, 200);
  assert.equal(result.y, 150);

  // Check sequence of CDP calls
  assert.equal(sent.length, 4); // mouseMoved(mid), mouseMoved(target), mousePressed, mouseReleased
  assert.equal(sent[0].method, "Input.dispatchMouseEvent");
  assert.equal(sent[0].params.type, "mouseMoved");

  assert.equal(sent[1].method, "Input.dispatchMouseEvent");
  assert.equal(sent[1].params.type, "mouseMoved");
  assert.equal(sent[1].params.x, 200);
  assert.equal(sent[1].params.y, 150);

  assert.equal(sent[2].method, "Input.dispatchMouseEvent");
  assert.equal(sent[2].params.type, "mousePressed");
  assert.equal(sent[2].params.button, "left");
  assert.equal(sent[2].params.clickCount, 1);
  assert.equal(sent[2].params.x, 200);
  assert.equal(sent[2].params.y, 150);

  assert.equal(sent[3].method, "Input.dispatchMouseEvent");
  assert.equal(sent[3].params.type, "mouseReleased");
  assert.equal(sent[3].params.button, "left");
  assert.equal(sent[3].params.clickCount, 1);
  assert.equal(sent[3].params.x, 200);
  assert.equal(sent[3].params.y, 150);
});

await asyncCheck("resolves selector via Runtime.evaluate and applies jitter", async () => {
  const sent = [];
  const fakeSend = async (method, params) => {
    sent.push({ method, params });
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: { x: 100, y: 200, w: 80, h: 40, tag: "BUTTON", text: "Submit" }
        }
      };
    }
    return {};
  };

  const result = await dispatchMouseClick(fakeSend, "button.submit", { lastPos: { x: 0, y: 0 }, holdMs: 10 });
  assert.equal(result.ok, true);
  // Center is 100 + 40 = 140, 200 + 20 = 220. With jitter within central 60% (±16, ±8):
  assert.ok(result.x >= 120 && result.x <= 160, `x=${result.x} out of range`);
  assert.ok(result.y >= 210 && result.y <= 230, `y=${result.y} out of range`);
});

await asyncCheck("throws when element not found", async () => {
  const fakeSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: null } };
    }
    return {};
  };

  await assert.rejects(
    async () => await dispatchMouseClick(fakeSend, ".missing-btn"),
    /Element not found for selector: \.missing-btn/
  );
});

console.log(`${passed} checks completed.`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_mouse_helper.mjs"`
Expected: FAIL with "Cannot find module '../scripts/mouse_helper.mjs'"

- [ ] **Step 3: Implement `scripts/mouse_helper.mjs`**

Create `scripts/mouse_helper.mjs`:
```javascript
// scripts/mouse_helper.mjs — Trusted CDP mouse simulation helper
//
// Dispatches authentic physical-like mouse events (isTrusted: true) via Chrome
// DevTools Protocol Input.dispatchMouseEvent.

export async function dispatchMouseClick(send, target, options = {}) {
  const lastPos = options.lastPos || { x: 100, y: 100 };
  const holdMs = options.holdMs ?? (60 + Math.floor(Math.random() * 50));
  let x, y;

  if (typeof target === "string") {
    const res = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName, text: el.innerText ? el.innerText.slice(0, 50) : "" };
      })()`,
      returnByValue: true
    });

    const info = res?.result?.value;
    if (!info) {
      throw new Error(`Element not found for selector: ${target}`);
    }
    if (info.w === 0 && info.h === 0) {
      throw new Error(`Element has 0 dimensions: ${target}`);
    }

    // Subtle jitter inside the central 60% of the element (±20% of width/height from center)
    const jitterFactor = options.jitterPercent ?? 0.4;
    const jitterX = (Math.random() - 0.5) * (info.w * jitterFactor);
    const jitterY = (Math.random() - 0.5) * (info.h * jitterFactor);
    x = Math.round(info.x + info.w / 2 + jitterX);
    y = Math.round(info.y + info.h / 2 + jitterY);
  } else if (target && typeof target.x === "number" && typeof target.y === "number") {
    x = Math.round(target.x);
    y = Math.round(target.y);
  } else {
    throw new Error("Invalid target: must be a selector string or {x, y} coordinate object");
  }

  // 1. Intermediate trajectory step (human-like motion)
  const midX = Math.round((lastPos.x + x) / 2 + (Math.random() * 6 - 3));
  const midY = Math.round((lastPos.y + y) / 2 + (Math.random() * 6 - 3));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: midX, y: midY });
  await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 15)));

  // 2. Target hover
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 20)));

  // 3. Mouse press (down)
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });

  // 4. Human hold delay (default 60-110ms)
  await new Promise((r) => setTimeout(r, holdMs));

  // 5. Mouse release (up)
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  return { ok: true, x, y };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_mouse_helper.mjs"`
Expected: PASS (3 checks completed, exit 0)

- [ ] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add scripts/mouse_helper.mjs tests/test_mouse_helper.mjs && git commit -m 'feat(mouse): implement trusted cdp mouse dispatch helper'"
```

---

### Task 2: CLI `click` Command in `scripts/cdp_control.mjs`

**Files:**
- Modify: `scripts/cdp_control.mjs`
- Test: `tests/test_cdp_control_click.mjs`

**Interfaces:**
- Consumes: `dispatchMouseClick` from `scripts/mouse_helper.mjs`
- CLI Command: `node scripts/cdp_control.mjs click <port> [--selector <css>] [--coords <x,y>] [--match <url>]`
  - Outputs JSON: `{ ok: true, url: string, x: number, y: number }`

- [ ] **Step 1: Write the unit test for CLI click handling**

Create `tests/test_cdp_control_click.mjs`:
```javascript
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Verify that usage output includes 'click'
const usageRun = spawnSync("node", ["scripts/cdp_control.mjs"], { encoding: "utf8" });
assert.equal(usageRun.status, 2);
assert.ok(usageRun.stderr.includes("click"), `Usage message should mention 'click', got: ${usageRun.stderr}`);

console.log("PASS cdp_control.mjs usage includes click command");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_cdp_control_click.mjs"`
Expected: FAIL with "AssertionError: Usage message should mention 'click'"

- [ ] **Step 3: Implement `click` command in `scripts/cdp_control.mjs`**

Modify `scripts/cdp_control.mjs`:
- Import `dispatchMouseClick` from `./mouse_helper.mjs`.
- Update usage message and command validation to include `click`.
- Parse `--selector` and `--coords` flags.
- In `cdpSession(target, ...)`, if `cmd === "click"`:
  - If `--coords` is given, parse `x, y` as numbers.
  - If `--selector` is given, pass selector string.
  - Call `await dispatchMouseClick(send, targetSpec)`.
  - Output result JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_cdp_control_click.mjs"`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add scripts/cdp_control.mjs tests/test_cdp_control_click.mjs && git commit -m 'feat(cdp): add trusted click command to cdp_control.mjs'"
```

---

### Task 3: System Prompt & Startup Boilerplate Overhaul

**Files:**
- Modify: `prompts/survey_agent_prompt.txt`
- Test: `tests/test_prompt_mouse_rules.mjs`

**Interfaces:**
- Injected global: `globalThis.mouseClick(selectorOrCoords, options)` in REPL session.
- System prompt rules:
  - Strict mandate: Rule 3 specifies `await mouseClick(...)`.
  - Strict ban: Disallow `.click()` and untrusted JavaScript DOM events.

- [ ] **Step 1: Write test verifying prompt requirements**

Create `tests/test_prompt_mouse_rules.mjs`:
```javascript
import assert from "node:assert/strict";
import fs from "node:fs";

const promptContent = fs.readFileSync("prompts/survey_agent_prompt.txt", "utf8");

// Must define globalThis.mouseClick
assert.ok(promptContent.includes("globalThis.mouseClick"), "Prompt startup snippet must define globalThis.mouseClick");

// Must mandate mouseClick in Rule 3
assert.ok(promptContent.includes("ALWAYS use await mouseClick"), "Prompt Rule 3 must mandate ALWAYS use await mouseClick");

// Must ban element.click
assert.ok(!promptContent.includes("first try via Runtime.evaluate — find the element by selector/text and call `.click()`"), "Prompt must not suggest calling .click() first");

console.log("PASS survey_agent_prompt.txt complies with trusted mouse requirements");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_prompt_mouse_rules.mjs"`
Expected: FAIL (prompt currently contains the old .click() instruction and lacks globalThis.mouseClick)

- [ ] **Step 3: Update `prompts/survey_agent_prompt.txt`**

1. In Step 1 (Startup snippet), inject `globalThis.mouseClick` implementation right after `cdp` definition.
2. In Step 3 (Click an element), update text:
   ```text
   3. Click an element: ALWAYS use `await mouseClick(selector)` (e.g. `await mouseClick('.survey-card')`) or `await mouseClick({ x, y })`. NEVER call `element.click()` or synthetic JS `.dispatchEvent(new MouseEvent('click'))`. Modern survey platforms inspect `event.isTrusted: true` and pointer telemetry. `mouseClick` automatically scrolls the target into view, emits realistic hover trajectories with jitter, and fires genuine browser-level `Input.dispatchMouseEvent` events with human hold timing.
   ```
3. Update any other prompt notes that advise calling `.click()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_prompt_mouse_rules.mjs"`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add prompts/survey_agent_prompt.txt tests/test_prompt_mouse_rules.mjs && git commit -m 'feat(prompt): mandate trusted cdp mouseClick and inject helper in startup snippet'"
```

---

### Task 4: End-to-End Fleet Verification

**Files:**
- Test: `tests/test_live_trusted_click.mjs`

- [ ] **Step 1: Write live trusted click verification script**

Create `tests/test_live_trusted_click.mjs` that:
- Connects to an active container (e.g. port 3013).
- Uses `Runtime.evaluate` to render a test button in the page DOM with an `onclick` handler capturing `{ isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY }`.
- Calls `dispatchMouseClick(send, "#test-trusted-btn")`.
- Reads back the captured click event properties.
- Asserts `isTrusted === true`, `clientX > 0`, and `clientY > 0`.
- Cleans up the test button.

- [ ] **Step 2: Run verification against running container or fallback mock**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_live_trusted_click.mjs"`
Expected: PASS verifying authentic `isTrusted: true` dispatch.

- [ ] **Step 3: Run existing unit test suite**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && for t in tests/test_*.mjs; do echo \"Running \$t\"; node \"\$t\"; done"
```
Expected: All tests PASS with exit code 0.

- [ ] **Step 4: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add tests/test_live_trusted_click.mjs && git commit -m 'test(e2e): add live isTrusted cdp click verification test'"
```
