import assert from "node:assert/strict";
import { stealthClick, stealthMove, injectVirtualCursor } from "../scripts/stealth_mouse.mjs";

console.log("[test] 1. injectVirtualCursor calls Page.addScriptToEvaluateOnNewDocument and Runtime.evaluate");
{
  const sentMethods = [];
  const fakeSend = async (method, params) => {
    sentMethods.push({ method, params });
    return { result: { value: true } };
  };

  await injectVirtualCursor(fakeSend);
  const addScriptCall = sentMethods.find(m => m.method === "Page.addScriptToEvaluateOnNewDocument");
  const evalCall = sentMethods.find(m => m.method === "Runtime.evaluate");

  assert.ok(addScriptCall, "must call Page.addScriptToEvaluateOnNewDocument");
  assert.ok(evalCall, "must call Runtime.evaluate for immediate injection");
  assert.ok(addScriptCall.params.source.includes("codex-virtual-cursor"), "script includes virtual cursor");
  assert.ok(addScriptCall.params.source.includes("navigator, 'webdriver'"), "script overrides navigator.webdriver");
  assert.ok(evalCall.params.expression.includes("codex-virtual-cursor"), "eval script includes virtual cursor");

  // Error resilience test
  const throwingSend = async () => { throw new Error("CDP disconnected"); };
  await assert.doesNotReject(async () => {
    await injectVirtualCursor(throwingSend);
  }, "injectVirtualCursor should handle CDP errors gracefully");
}

console.log("[test] 2. stealthMove traverses waypoints and emits mouseMoved events");
{
  const events = [];
  const fakeSend = async (method, params) => {
    if (method === "Input.dispatchMouseEvent") {
      events.push(params);
    }
    return {};
  };

  const endPos = await stealthMove(fakeSend, { x: 300, y: 250 }, {
    lastPos: { x: 100, y: 100 },
    stepDelayMs: 1,
    minSteps: 8,
    maxSteps: 14,
  });

  assert.equal(endPos.x, 300);
  assert.equal(endPos.y, 250);
  assert.ok(events.length >= 8 && events.length <= 14, `expected 8-14 moves, got ${events.length}`);
  assert.ok(events.every(e => e.type === "mouseMoved"), "all events must be mouseMoved");
  assert.equal(events[events.length - 1].x, 300);
  assert.equal(events[events.length - 1].y, 250);
}

console.log("[test] 3. stealthClick executes trajectory, dwell, press, hold, and release for selector");
{
  const events = [];
  let evaluatedSelector = null;

  const fakeSend = async (method, params) => {
    if (method === "Runtime.evaluate" && params.expression && params.expression.includes("getBoundingClientRect")) {
      evaluatedSelector = params.expression;
      return {
        result: {
          value: { x: 300, y: 400, w: 120, h: 40, tag: "BUTTON", text: "Submit" }
        }
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      events.push({ ...params, timestamp: Date.now() });
      return {};
    }
    return {};
  };

  const startTime = Date.now();
  const res = await stealthClick(fakeSend, "button.submit-btn", {
    lastPos: { x: 50, y: 50 },
    stepDelayMs: 1,
    dwellMs: 20,
    holdMs: 25,
    settleMs: 15,
  });
  const duration = Date.now() - startTime;

  assert.equal(res.ok, true);
  assert.ok(evaluatedSelector.includes("button.submit-btn"), "selector evaluated");

  // Destination point must be within bounding box bounds
  assert.ok(res.x >= 300 && res.x <= 420, `res.x ${res.x} within button width`);
  assert.ok(res.y >= 400 && res.y <= 440, `res.y ${res.y} within button height`);

  // Verify mouseMoved trajectory events
  const moveEvents = events.filter(e => e.type === "mouseMoved");
  assert.ok(moveEvents.length >= 8 && moveEvents.length <= 14, `expected 8-14 trajectory steps, got ${moveEvents.length}`);

  // Verify press and release events
  const pressEvent = events.find(e => e.type === "mousePressed");
  const releaseEvent = events.find(e => e.type === "mouseReleased");

  assert.ok(pressEvent, "must emit mousePressed");
  assert.ok(releaseEvent, "must emit mouseReleased");
  assert.equal(pressEvent.button, "left");
  assert.equal(releaseEvent.button, "left");
  assert.equal(pressEvent.clickCount, 1);
  assert.equal(releaseEvent.clickCount, 1);

  // Press and release coordinates match final target
  assert.equal(pressEvent.x, res.x);
  assert.equal(pressEvent.y, res.y);
  assert.equal(releaseEvent.x, res.x);
  assert.equal(releaseEvent.y, res.y);

  // Timing: dwell (20ms) + hold (25ms) + settle (15ms) = at least 60ms
  assert.ok(duration >= 50, `duration ${duration}ms must reflect dwell, hold, settle delays`);
  assert.ok(releaseEvent.timestamp >= pressEvent.timestamp + 20, "release must occur after hold delay");
}

console.log("[test] 4. stealthClick with explicit coordinate target");
{
  const events = [];
  const fakeSend = async (method, params) => {
    if (method === "Input.dispatchMouseEvent") {
      events.push(params);
      return {};
    }
    return {};
  };

  const res = await stealthClick(fakeSend, { x: 450, y: 350 }, {
    stepDelayMs: 1,
    dwellMs: 10,
    holdMs: 10,
    settleMs: 10,
  });

  assert.equal(res.ok, true);
  assert.equal(res.x, 450);
  assert.equal(res.y, 350);

  const pressEvent = events.find(e => e.type === "mousePressed");
  const releaseEvent = events.find(e => e.type === "mouseReleased");
  assert.equal(pressEvent.x, 450);
  assert.equal(pressEvent.y, 350);
  assert.equal(releaseEvent.x, 450);
  assert.equal(releaseEvent.y, 350);
}

console.log("[test] 5. stealthClick error handling for missing elements and invalid targets");
{
  const fakeSendMissing = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: null } };
    }
    return {};
  };

  await assert.rejects(async () => {
    await stealthClick(fakeSendMissing, ".not-found");
  }, /Element not found for selector: .not-found/);

  const fakeSendZeroDim = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: { x: 0, y: 0, w: 0, h: 0 } } };
    }
    return {};
  };

  await assert.rejects(async () => {
    await stealthClick(fakeSendZeroDim, ".hidden-zero");
  }, /Element has 0 dimensions: .hidden-zero/);

  await assert.rejects(async () => {
    await stealthClick(async () => {}, null);
  }, /Invalid target/);
}

console.log("PASS: test_stealth_mouse_cdp");
