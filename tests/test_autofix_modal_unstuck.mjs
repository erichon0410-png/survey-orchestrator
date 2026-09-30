import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { detectAndDismissStallModals, getStallModalScript, createAutoFixer } from "../scripts/auto_fixer.mjs";

// --- Mock DOM Framework for In-Page CDP Script Execution ---

class MockElement {
  constructor({ tag = "div", id = "", className = "", text = "", attrs = {}, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this.innerText = text;
    this.textContent = text;
    this.attrs = { ...attrs };
    if (id) this.attrs.id = id;
    if (className) this.attrs.class = className;
    this.children = [];
    this.parentElement = null;
    this.clicked = false;
    this.clickCount = 0;
    for (const child of children) {
      this.appendChild(child);
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }

  setAttribute(name, val) {
    this.attrs[name] = val;
  }

  click() {
    this.clicked = true;
    this.clickCount++;
    if (typeof this.onclick === "function") {
      this.onclick();
    }
  }

  checkVisibility() {
    return true;
  }

  getBoundingClientRect() {
    return { x: 100, y: 100, width: 200, height: 50, top: 100, bottom: 150, left: 100, right: 300 };
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (matches(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

function matches(el, sel) {
  if (!sel || !el) return false;
  const s = sel.trim();
  if (s.includes(",")) {
    return s.split(",").some((part) => matches(el, part.trim()));
  }
  if (s === "body" && el.tagName === "BODY") return true;
  if (s.startsWith(".")) {
    const cls = s.slice(1);
    return el.className.split(/\s+/).includes(cls);
  }
  if (s.startsWith("#")) {
    return el.id === s.slice(1);
  }
  if (s.includes(".")) {
    const [tag, cls] = s.split(".");
    return (tag === "" || el.tagName === tag.toUpperCase()) && el.className.split(/\s+/).includes(cls);
  }
  const attrMatch = s.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)([\*\^\$]?=)?["']?([^"']*)["']?\s*(i)?\]$/);
  if (attrMatch) {
    const [, tag, attrName, op, expectedVal, flag] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const actualVal = el.getAttribute(attrName);
    if (actualVal === null) return false;
    const isInsensitive = flag === "i";
    const v1 = isInsensitive ? actualVal.toLowerCase() : actualVal;
    const v2 = isInsensitive ? expectedVal.toLowerCase() : expectedVal;
    if (!op) return true;
    if (op === "=") return v1 === v2;
    if (op === "*=") return v1.includes(v2);
    if (op === "^=") return v1.startsWith(v2);
    if (op === "$=") return v1.endsWith(v2);
  }
  if (/^[a-zA-Z0-9_-]+$/.test(s)) {
    return el.tagName === s.toUpperCase();
  }
  return false;
}

function queryAll(root, selector) {
  const matched = [];
  function walk(node) {
    for (const child of node.children) {
      if (matches(child, selector)) {
        matched.push(child);
      }
      walk(child);
    }
  }
  walk(root);
  return matched;
}

function createMockEnvironment(elements) {
  const body = new MockElement({ tag: "body" });
  for (const el of elements) {
    body.appendChild(el);
  }
  const document = {
    body,
    querySelector: (sel) => queryAll(body, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(body, sel),
  };
  const window = {
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  return { document, window };
}

function makeEvaluator(elements) {
  const env = createMockEnvironment(elements);
  return async (script) => {
    const code = typeof script === "object" && script?.expression ? script.expression : String(script);
    const context = vm.createContext(env);
    return vm.runInContext(code, context);
  };
}

console.log("[test] 1. detectAndDismissStallModals exports and signature validation");
{
  assert.equal(typeof detectAndDismissStallModals, "function", "must export detectAndDismissStallModals");
  assert.equal(typeof getStallModalScript, "function", "must export getStallModalScript");
  const script = getStallModalScript();
  assert.ok(typeof script === "string" && script.length > 200, "getStallModalScript returns JS snippet");
}

console.log("[test] 2. Validation error modals");
{
  // 2a: Element with .validation-error class and OK button
  const okBtn = new MockElement({ tag: "button", text: "OK" });
  const errorContainer = new MockElement({
    tag: "div",
    className: "validation-error modal-dialog",
    text: "Please select an answer",
    children: [okBtn],
  });
  const res2a = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([errorContainer]),
  });
  assert.equal(res2a.detected, true, "must detect validation error modal");
  assert.equal(res2a.type, "validation_error", "type must be validation_error");
  assert.ok(typeof res2a.actionTaken === "string", "actionTaken must be specified");
  assert.equal(okBtn.clicked, true, "OK button in validation modal must be clicked");

  // 2b: Text "Missing Answer"
  const dismissBtn = new MockElement({ tag: "button", text: "Dismiss" });
  const missingAnswerModal = new MockElement({
    tag: "div",
    className: "modal-box",
    children: [
      new MockElement({ tag: "p", text: "Missing Answer: Question 3 requires a response." }),
      dismissBtn,
    ],
  });
  const res2b = await detectAndDismissStallModals(3015, {
    cdpEvaluate: makeEvaluator([missingAnswerModal]),
  });
  assert.equal(res2b.detected, true, "must detect 'Missing Answer' text");
  assert.equal(res2b.type, "validation_error");
  assert.equal(dismissBtn.clicked, true, "Dismiss button must be clicked");

  // 2c: Text "Please answer this question"
  const closeBtn = new MockElement({ tag: "button", text: "Close", attrs: { "aria-label": "Close" } });
  const pleaseAnswerModal = new MockElement({
    tag: "div",
    className: "alert-dialog",
    children: [
      new MockElement({ tag: "span", text: "Please answer this question to proceed." }),
      closeBtn,
    ],
  });
  const res2c = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([pleaseAnswerModal]),
  });
  assert.equal(res2c.detected, true, "must detect 'Please answer this question' text");
  assert.equal(res2c.type, "validation_error");
  assert.equal(closeBtn.clicked, true, "Close button must be clicked");
}

console.log("[test] 3. Cookie banners and dialog overlays");
{
  // 3a: #onetrust-accept-btn-handler
  const onetrustBtn = new MockElement({ tag: "button", id: "onetrust-accept-btn-handler", text: "Accept All Cookies" });
  const res3a = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([onetrustBtn]),
  });
  assert.equal(res3a.detected, true, "must detect onetrust accept button");
  assert.equal(res3a.type, "cookie_banner");
  assert.equal(onetrustBtn.clicked, true, "OneTrust button must be clicked");

  // 3b: button[aria-label="Close"] overlay
  const ariaCloseBtn = new MockElement({ tag: "button", attrs: { "aria-label": "Close" } });
  const overlay = new MockElement({
    tag: "div",
    className: "modal-overlay",
    children: [ariaCloseBtn],
  });
  const res3b = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([overlay]),
  });
  assert.equal(res3b.detected, true, "must detect close button in overlay");
  assert.equal(res3b.type, "dialog_overlay");
  assert.equal(ariaCloseBtn.clicked, true, "Aria-close button must be clicked");

  // 3c: button:has-text("Accept All")
  const acceptAllBtn = new MockElement({ tag: "button", text: "Accept All" });
  const res3c = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([acceptAllBtn]),
  });
  assert.equal(res3c.detected, true, "must detect 'Accept All' button");
  assert.equal(res3c.type, "cookie_banner");
  assert.equal(acceptAllBtn.clicked, true, "Accept All button must be clicked");
}

console.log("[test] 4. Stuck prescreener continue buttons");
{
  // 4a: .continue-btn
  const continueBtn = new MockElement({ tag: "button", className: "continue-btn", text: "Continue" });
  const res4a = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([continueBtn]),
  });
  assert.equal(res4a.detected, true, "must detect .continue-btn");
  assert.equal(res4a.type, "prescreener_continue");
  assert.equal(continueBtn.clicked, true, "continue-btn must be clicked");

  // 4b: input[value="Continue"]
  const continueInput = new MockElement({
    tag: "input",
    attrs: { type: "submit", value: "Continue" },
  });
  const res4b = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([continueInput]),
  });
  assert.equal(res4b.detected, true, "must detect input[value='Continue']");
  assert.equal(res4b.type, "prescreener_continue");
  assert.equal(continueInput.clicked, true, "Continue input must be clicked");

  // 4c: button.next-btn
  const nextBtn = new MockElement({ tag: "button", className: "next-btn", text: "Next" });
  const res4c = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([nextBtn]),
  });
  assert.equal(res4c.detected, true, "must detect button.next-btn");
  assert.equal(res4c.type, "prescreener_continue");
  assert.equal(nextBtn.clicked, true, "next-btn must be clicked");
}

console.log("[test] 5. Negative test — returns { detected: false } when no stall modal present");
{
  const normalPage = new MockElement({
    tag: "div",
    className: "survey-content",
    children: [
      new MockElement({ tag: "h1", text: "Welcome to the research survey" }),
      new MockElement({ tag: "p", text: "Please read each item carefully." }),
    ],
  });
  const res5 = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([normalPage]),
  });
  assert.equal(res5.detected, false, "must return detected: false on clean page");
}

console.log("[test] 6. Dispatches resolution action and returns structured result");
{
  // Direct structured result verification
  const okBtn = new MockElement({ tag: "button", text: "OK" });
  const modal = new MockElement({ tag: "div", className: "validation-error", children: [okBtn] });
  const res = await detectAndDismissStallModals({
    port: 3015,
    cdpEvaluate: makeEvaluator([modal]),
  });
  assert.ok(typeof res.detected === "boolean", "detected must be boolean");
  assert.ok(typeof res.type === "string", "type must be string");
  assert.ok(typeof res.actionTaken === "string", "actionTaken must be string");
}

console.log("[test] 7. createAutoFixer tick loop unstuck integration and logging");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-unstuck-test-"));
  const logFile = path.join(tmpDir, "logs", "autofix.log");
  const continueBtn = new MockElement({ tag: "button", className: "continue-btn", text: "Continue" });
  const evaluator = makeEvaluator([continueBtn]);

  const fixer = createAutoFixer({
    fleet: [{ port: 3015, container: "survey-3015" }],
    root: tmpDir,
    logFile,
    cdpEvaluate: evaluator,
    probes: {
      isContainerRunning: async () => true,
      checkCdp: async () => ({ ok: true }),
      isPortAlive: () => true,
      hasTargetMarker: () => false,
    },
  });

  const tickRes = await fixer.tick(["survey_driver.mjs bound port 3015"]);
  assert.ok(tickRes.healthy.includes(3015), "port is healthy");
  assert.equal(continueBtn.clicked, true, "stuck continue button must be clicked during tick");
  assert.ok(tickRes.unstuck && tickRes.unstuck.length === 1, "unstuck port reported in tick output");
  assert.equal(tickRes.unstuck[0].port, 3015);
  assert.equal(tickRes.unstuck[0].type, "prescreener_continue");

  const logContent = fs.readFileSync(logFile, "utf-8");
  assert.ok(logContent.includes("autofix_modal_unstuck"), "unstuck action logged to autofix.log");
  assert.ok(logContent.includes("prescreener_continue"), "modal type logged");
}

console.log("PASS: test_autofix_modal_unstuck");
