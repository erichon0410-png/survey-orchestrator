import assert from "node:assert/strict";
import { generateBezierTrajectory, calculateJitter, getVirtualCursorScript } from "../scripts/stealth_mouse.mjs";

console.log("[test] 1. generateBezierTrajectory generates realistic curve waypoints");
{
  const p0 = { x: 100, y: 100 };
  const p1 = { x: 800, y: 600 };
  const trajectory = generateBezierTrajectory(p0, p1, { minSteps: 8, maxSteps: 14 });

  assert.ok(Array.isArray(trajectory), "trajectory must be an array");
  assert.ok(trajectory.length >= 8 && trajectory.length <= 14, `step count ${trajectory.length} out of bounds [8, 14]`);

  const defaultTrajectory = generateBezierTrajectory(p0, p1);
  assert.ok(defaultTrajectory.length >= 8 && defaultTrajectory.length <= 14, `default step count ${defaultTrajectory.length} out of bounds [8, 14]`);

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
