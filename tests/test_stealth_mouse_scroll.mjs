// tests/test_stealth_mouse_scroll.mjs — Verify auto-scroll & center coordinates in stealthClick
import assert from "node:assert/strict";
import { stealthClick, calculateJitter } from "../scripts/stealth_mouse.mjs";

console.log("[test] 1. calculateJitter respects isCenter flag");
{
  const centerBox = { x: 350, y: 520, w: 100, h: 40, isCenter: true };
  for (let i = 0; i < 30; i++) {
    const pt = calculateJitter(centerBox, 0.4);
    // Center is 350, 520. Width 100 -> max offset ±20. Height 40 -> max offset ±8.
    assert.ok(pt.x >= 330 && pt.x <= 370, `pt.x ${pt.x} shifted off center 350`);
    assert.ok(pt.y >= 510 && pt.y <= 530, `pt.y ${pt.y} shifted off center 520`);
  }

  const topLeftBox = { x: 300, y: 500, w: 100, h: 40, isCenter: false };
  for (let i = 0; i < 30; i++) {
    const pt = calculateJitter(topLeftBox, 0.4);
    // Center is 350, 520. Width 100 -> max offset ±20. Height 40 -> max offset ±8.
    assert.ok(pt.x >= 330 && pt.x <= 370, `pt.x ${pt.x} shifted off center 350`);
    assert.ok(pt.y >= 510 && pt.y <= 530, `pt.y ${pt.y} shifted off center 520`);
  }
}

console.log("[test] 2. stealthClick auto-scrolls harvested control below the fold and clicks fresh coordinates");
{
  const mouseEvents = [];
  let evaluatedScript = null;

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      evaluatedScript = params.expression;
      // Simulate element scrolled from y=1249 to viewport center y=350
      return {
        result: {
          value: {
            x: 100,
            y: 350,
            w: 400,
            h: 60,
            tag: "INPUT",
            isCenter: false
          }
        }
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      mouseEvents.push(params);
      return {};
    }
    return {};
  };

  const targetControl = {
    role: "checkbox",
    label: "None of the above",
    selector: "#question-121969-option-none-of-the-above",
    x: 956,
    y: 1249, // Initially below the fold
    w: 400,
    h: 60,
    isCenter: true
  };

  const res = await stealthClick(mockSend, targetControl, {
    stepDelayMs: 1,
    dwellMs: 5,
    holdMs: 5,
    settleMs: 5
  });

  assert.equal(res.ok, true);
  assert.ok(evaluatedScript.includes("scrollIntoView"), "must evaluate script with scrollIntoView");
  assert.ok(evaluatedScript.includes("#question-121969-option-none-of-the-above"), "must query selector");

  // Coordinates should be centered around (100 + 400/2 = 300, 350 + 60/2 = 380), NOT off-screen y=1249!
  assert.ok(res.x >= 220 && res.x <= 380, `res.x ${res.x} not within scrolled element bounds`);
  assert.ok(res.y >= 350 && res.y <= 410, `res.y ${res.y} not within scrolled viewport bounds`);

  const pressEvent = mouseEvents.find(e => e.type === "mousePressed");
  assert.ok(pressEvent, "must emit mousePressed");
  assert.equal(pressEvent.x, res.x);
  assert.equal(pressEvent.y, res.y);
}

console.log("PASS: test_stealth_mouse_scroll");
