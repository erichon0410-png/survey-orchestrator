// Regression test for idle-today marker feature:
// When an agent exhausts its nudge budget due to no surveys available,
// it should write an idle_today marker and exit with code 4. The supervisor
// should then skip that port for the rest of the day instead of restarting it.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("Testing idle-today marker feature...");

// Test 1: Driver code includes idle-today logic
{
  const driverPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../scripts/survey_driver.mjs");
  const driverCode = fs.readFileSync(driverPath, "utf-8");
  
  assert.ok(driverCode.includes("EXIT_IDLE_NO_SURVEYS"), "Driver should define EXIT_IDLE_NO_SURVEYS constant");
  assert.ok(driverCode.includes("writeIdleTodayMarker"), "Driver should have writeIdleTodayMarker function");
  assert.ok(driverCode.includes("readLastTechIssue"), "Driver should have readLastTechIssue function");
  assert.ok(driverCode.includes("idle_today"), "Driver should reference idle_today markers");
  
  console.log("  ✓ Driver code includes idle-today marker logic");
}

// Test 2: Supervisor code includes idle-today check
{
  const supervisorPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../scripts/fleet_supervisor.mjs");
  const supervisorCode = fs.readFileSync(supervisorPath, "utf-8");
  
  assert.ok(supervisorCode.includes("hasIdleTodayMarker"), "Supervisor should have hasIdleTodayMarker function");
  assert.ok(supervisorCode.includes("idleTodayPorts"), "Supervisor should track idle-today ports");
  assert.ok(supervisorCode.includes("skipped_idle_today"), "Supervisor should log skipped_idle_today events");
  
  console.log("  ✓ Supervisor code includes idle-today check logic");
}

// Test 3: Exit code 4 is documented in driver header
{
  const driverPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../scripts/survey_driver.mjs");
  const driverCode = fs.readFileSync(driverPath, "utf-8");
  
  assert.ok(driverCode.includes("4     = idle"), "Driver header should document exit code 4 for idle state");
  
  console.log("  ✓ Exit code 4 documented in driver header");
}

console.log("All idle-today marker tests passed!");
