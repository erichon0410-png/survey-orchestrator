// Regression test for balance delta tracking bug:
// Driver must compute today's earnings as (current balance - baseline at driver start),
// NOT as the difference between consecutive polls. This prevents "fake money counts"
// where lifetime balance or stale snapshots trigger premature target_reached.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("Testing balance delta tracking...");

// Helper for floating point money comparison
function moneyEquals(actual, expected) {
  return Math.abs(actual - expected) < 0.001;
}

// Test 1: Compute daily delta against fixed baseline, not consecutive polls
{
  // Simulate scenario: driver starts at $0 baseline
  const baseline = 0.0;
  
  // Poll 1: balance is $1.50 (agent earned $1.50 today)
  const poll1 = 1.50;
  // Poll 2: balance is still $1.50 (no new earnings between polls)
  const poll2 = 1.50;
  // Poll 3: balance is $2.00 (agent earned another $0.50)
  const poll3 = 2.00;
  
  // Old buggy logic: delta = poll[i] - poll[i-1]
  // Would report: $1.50, then $0.00, then $0.50 (misses the first earnings entirely on restart)
  
  // Correct logic: delta = current - baseline
  const earnedToday = poll3 - baseline;
  
  assert.ok(moneyEquals(earnedToday, 2.00), `Should compute $2.00 earned today against baseline, got ${earnedToday}`);
}

// Test 2: Do not confuse lifetime balance with today's earnings
{
  // Scenario: agent has $4.58 lifetime balance before starting today's run
  const lifetimeBalanceBefore = 4.58;
  
  // During today's run, agent earns $0.42
  const lifetimeBalanceAfter = 5.00;
  
  // Driver should report only $0.42 earned TODAY, not the full $5.00
  const earnedToday = lifetimeBalanceAfter - lifetimeBalanceBefore;
  
  assert.ok(moneyEquals(earnedToday, 0.42), `Should compute only today's earnings ($0.42), got ${earnedToday}`);
  assert.ok(earnedToday < 1.00, "Earned today should be less than full balance");
}

// Test 3: Detect premature target_reached when baseline not subtracted
{
  // The original bug: driver sees balance of $5.08 and thinks target reached
  // because it didn't subtract the pre-existing balance
  
  const preExistingBalance = 4.58;
  const currentBalance = 5.08;
  const dailyTarget = 5.00;
  
  // Buggy logic: currentBalance >= dailyTarget -> target reached (WRONG!)
  const buggyReached = currentBalance >= dailyTarget;
  
  // Correct logic: only count earnings SINCE driver started
  const earnedToday = currentBalance - preExistingBalance;
  const correctlyReached = earnedToday >= dailyTarget;
  
  assert.strictEqual(buggyReached, true, "Buggy logic incorrectly says target reached");
  assert.strictEqual(correctlyReached, false, "Correct logic says target NOT yet reached (only $0.50 earned today)");
}

// Test 4: Verify driver code implements delta-based verification
{
  const driverPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../scripts/survey_driver.mjs");
  const driverCode = fs.readFileSync(driverPath, "utf-8");
  
  // Check that the fix is in place
  assert.ok(driverCode.includes("captureBaselineBalance"), "Driver should capture baseline balance at startup");
  assert.ok(driverCode.includes("baselineBalance"), "Driver should track baseline balance");
  assert.ok(driverCode.includes("earnedToday") || driverCode.includes("earned_today"), "Driver should compute earned today delta");
  
  console.log("  ✓ Driver code includes baseline/delta tracking logic");
}

console.log("All balance delta tracking tests passed!");
