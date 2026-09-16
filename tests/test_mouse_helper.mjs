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
