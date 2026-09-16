// tests/test_live_trusted_click.mjs — Live verification of trusted CDP mouse clicks
//
// Injects a test button with an event listener into a live browser container (port 3013),
// triggers a click via cdp_control.mjs / dispatchMouseClick, and verifies:
// 1. event.isTrusted === true (Chromium native hardware flag)
// 2. Realistic clientX and clientY coordinates are recorded
// 3. Test element is cleaned up

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PORT = 3013;

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

// 1. Check if container is reachable
let list;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/cdp/json`);
  if (res.ok) list = await res.json();
} catch (e) {
  console.log(`Port ${PORT} not reachable (${e.message}), skipping live container test.`);
  process.exit(0);
}

const pageTarget = list?.find((t) => t && t.type === "page" && /^https?:\/\//i.test(String(t.url)));
if (!pageTarget) {
  console.log(`No active http(s) page target on port ${PORT}, skipping live container test.`);
  process.exit(0);
}

console.log(`Testing against live page: ${pageTarget.url}`);

// 2. Inject test button and listener via cdp_control.mjs eval
const setupExpr = `(() => {
  const existing = document.getElementById("test-trusted-cdp-btn");
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = "test-trusted-cdp-btn";
  btn.innerText = "Trusted Click Probe";
  btn.style.cssText = "position:fixed; top:20px; left:20px; z-index:999999; width:120px; height:40px; background:blue; color:white;";
  window.__trusted_click_events = [];
  btn.addEventListener("click", (e) => {
    window.__trusted_click_events.push({
      isTrusted: e.isTrusted,
      clientX: e.clientX,
      clientY: e.clientY,
      type: e.type
    });
  });
  document.body.appendChild(btn);
  return { ok: true };
})()`;

const setupRes = spawnSync("node", ["scripts/cdp_control.mjs", "eval", String(PORT), "--js", setupExpr], { encoding: "utf8" });
assert.equal(setupRes.status, 0, `Setup failed: ${setupRes.stderr}`);

// 3. Click the test button using our new click command
const clickRes = spawnSync("node", ["scripts/cdp_control.mjs", "click", String(PORT), "--selector", "#test-trusted-cdp-btn"], { encoding: "utf8" });
assert.equal(clickRes.status, 0, `Click failed: ${clickRes.stderr}`);
const clickJson = JSON.parse(clickRes.stdout);
assert.equal(clickJson.ok, true);
console.log(`Click dispatched at (${clickJson.x}, ${clickJson.y})`);

// 4. Verify recorded click event in browser DOM
const checkExpr = `(() => {
  const evts = window.__trusted_click_events || [];
  const btn = document.getElementById("test-trusted-cdp-btn");
  if (btn) btn.remove();
  delete window.__trusted_click_events;
  return evts;
})()`;

const checkRes = spawnSync("node", ["scripts/cdp_control.mjs", "eval", String(PORT), "--js", checkExpr], { encoding: "utf8" });
assert.equal(checkRes.status, 0, `Check failed: ${checkRes.stderr}`);
const checkJson = JSON.parse(checkRes.stdout);
const recordedEvents = checkJson.value;

assert.ok(Array.isArray(recordedEvents), "Expected array of recorded events");
assert.equal(recordedEvents.length, 1, `Expected exactly 1 click event, got: ${JSON.stringify(recordedEvents)}`);

const evt = recordedEvents[0];
console.log("Recorded browser click event:", evt);

// Critical verification: isTrusted MUST be true
assert.equal(evt.isTrusted, true, "CRITICAL: event.isTrusted MUST be true!");
assert.ok(evt.clientX >= 20 && evt.clientX <= 140, `clientX ${evt.clientX} should be within button bounds`);
assert.ok(evt.clientY >= 20 && evt.clientY <= 60, `clientY ${evt.clientY} should be within button bounds`);

console.log("PASS: Live click verified with event.isTrusted === true and authentic coordinates!");
