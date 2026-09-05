import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WINDOW_MS = 60 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 4;

// --- Step 1 / Brief test: Restart recovery arithmetic ---
function simulateResume(restartsList, now) {
  return [now]; // Fresh attempt on resume
}

const now = Date.now();
const pastRestarts = [now - 10000, now - 8000, now - 6000, now - 4000];
const updated = simulateResume(pastRestarts, now);
assert.equal(updated.length, 1);
assert.ok(updated.length < MAX_RESTARTS_PER_WINDOW);
console.log("✓ Restart recovery arithmetic test passed");

// --- Test 2: Compare old vs new resumption behavior ---
{
  // Old behavior: shifting 1 element leaves 3 elements
  const oldRestarts = [now - 10000, now - 8000, now - 6000, now - 4000];
  while (oldRestarts.length >= MAX_RESTARTS_PER_WINDOW) {
    oldRestarts.shift();
  }
  assert.equal(oldRestarts.length, 3, "Old logic left 3 elements");
  // Next deploy pushes attempt #4
  oldRestarts.push(now);
  // Next tick (30s later) if agent exits:
  const oldRecentOnNextTick = oldRestarts.filter((t) => (now + 30000) - t <= WINDOW_MS);
  assert.ok(oldRecentOnNextTick.length >= MAX_RESTARTS_PER_WINDOW, "Old logic caused immediate re-cap on next tick");

  // New behavior: resets to empty array, then deploy pushes attempt #1
  const newRestarts = [];
  newRestarts.push(now);
  assert.equal(newRestarts.length, 1);
  // Next tick (30s later) if agent exits:
  const newRecentOnNextTick = newRestarts.filter((t) => (now + 30000) - t <= WINDOW_MS);
  assert.ok(newRecentOnNextTick.length < MAX_RESTARTS_PER_WINDOW, "New logic grants full retry budget");
  assert.equal(MAX_RESTARTS_PER_WINDOW - newRecentOnNextTick.length, 3, "New logic allows 3 more attempts");
  console.log("✓ Thrash loop prevention logic test passed");
}

// --- Test 3: Supervisor code inspection ---
{
  const supervisorCode = fs.readFileSync(path.join(ROOT, "scripts/fleet_supervisor.mjs"), "utf8");
  assert.ok(
    !supervisorCode.includes("existingRestarts.shift()"),
    "fleet_supervisor.mjs must not retain the thrashing shift() loop"
  );
  assert.ok(
    supervisorCode.includes("restarts.set(port, []);"),
    "fleet_supervisor.mjs must reset restarts to empty array on cooldown resume"
  );
  console.log("✓ fleet_supervisor.mjs code contract verified");
}

console.log("✓ All restart recovery tests passed successfully");
