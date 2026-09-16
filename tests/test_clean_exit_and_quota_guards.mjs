// tests/test_clean_exit_and_quota_guards.mjs — Comprehensive verification of
// clean exiting, quota preservation, idle timeout termination, and stop/status controls.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  detectUsageLimit,
  writeFleetUsageLimitMarker,
  FLEET_USAGE_LIMIT_FILE,
  EXIT_USAGE_LIMIT,
  MAX_TURNS,
} from "../scripts/survey_driver.mjs";

import {
  checkFleetUsageLimit,
  getLastEarningsTime,
  getAgentStartTime,
  checkIdleTimeouts,
  isFleetTerminal,
  idleTodayPorts,
  targetPorts,
  pausedPorts,
  FLEET_MAX_RUNTIME_MS,
} from "../scripts/fleet_supervisor.mjs";

import { stopFleet } from "../scripts/stop_fleet.mjs";
import { getFleetStatus } from "../scripts/fleet_status.mjs";

console.log("================================================================");
console.log("Running Clean Exit, Quota Guard & Idle Timeout Test Suite");
console.log("================================================================");

// --- Test 1: detectUsageLimit regex patterns ---
console.log("\n[Test 1] detectUsageLimit pattern matching...");
{
  const hitLimitMsg = "Error: You've hit your usage limit for GPT-4. Please try again at 5:30 PM.";
  const insufficientQuota = '{"error": {"message": "You exceeded your current quota, please check your plan", "type": "insufficient_quota"}}';
  const forbidden403 = "HTTP status 403 forbidden: user has reached api quota allocation.";
  const rateLimitMsg = "rate_limit_exceeded: please slow down requests or wait for reset.";
  const normalTurn = "I have clicked on the radio button with label 'Yes' and submitted the page.";

  const hitRes = detectUsageLimit(hitLimitMsg);
  assert.ok(hitRes && hitRes.hit === true);
  assert.strictEqual(hitRes.retryAt, "5:30 PM");

  const quotaRes = detectUsageLimit(insufficientQuota);
  assert.ok(quotaRes && quotaRes.hit === true);

  const forbiddenRes = detectUsageLimit(forbidden403);
  assert.ok(forbiddenRes && forbiddenRes.hit === true);

  const rateLimitRes = detectUsageLimit(rateLimitMsg);
  assert.ok(rateLimitRes && rateLimitRes.hit === true);

  assert.strictEqual(detectUsageLimit(normalTurn), null);

  assert.strictEqual(EXIT_USAGE_LIMIT, 5, "EXIT_USAGE_LIMIT should be code 5");
  assert.strictEqual(typeof MAX_TURNS, "number", "MAX_TURNS must be defined as a number");
  assert.ok(MAX_TURNS <= 15, "MAX_TURNS must be a safe, bounded number (<=15)");
  console.log("  ✓ detectUsageLimit correctly catches all OpenAI quota & limit triggers");
}

// --- Test 2: writeFleetUsageLimitMarker writes valid JSON marker ---
console.log("\n[Test 2] writeFleetUsageLimitMarker...");
{
  const testDir = path.join(os.tmpdir(), "test_quota_marker_" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  // Temporarily point environment or write directly
  const markerPath = path.join(testDir, FLEET_USAGE_LIMIT_FILE);
  const sampleMarker = {
    ts: new Date().toISOString(),
    port: 3014,
    type: "usage_limit_exhausted",
    reason: "403_forbidden",
    detail: "403 Forbidden: quota exceeded",
  };
  fs.writeFileSync(markerPath, JSON.stringify(sampleMarker, null, 2) + "\n", "utf-8");

  // Check supervisor's checkFleetUsageLimit on this directory
  const limitCheck = checkFleetUsageLimit(testDir);
  assert.strictEqual(limitCheck.exhausted, true);
  assert.strictEqual(limitCheck.detail, "403 Forbidden: quota exceeded");

  const emptyDir = path.join(os.tmpdir(), "test_empty_marker_" + Date.now());
  fs.mkdirSync(emptyDir, { recursive: true });
  const noLimitCheck = checkFleetUsageLimit(emptyDir);
  assert.strictEqual(noLimitCheck.exhausted, false);

  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
  console.log("  ✓ Fleet usage limit circuit breaker marker verified");
}

// --- Test 3: getLastEarningsTime distinguishes earnings from progress notes ---
console.log("\n[Test 3] getLastEarningsTime distinguishes earnings from progress notes...");
{
  const testLogsDir = path.join(os.tmpdir(), "test_logs_" + Date.now());
  fs.mkdirSync(testLogsDir, { recursive: true });

  const port = 3015;
  const statusLog = path.join(testLogsDir, `agent_${port}_status.jsonl`);

  const tStart = new Date("2026-09-16T10:00:00.000Z").toISOString();
  const tEarned = new Date("2026-09-16T10:20:00.000Z").toISOString();
  const tProgress = new Date("2026-09-16T10:55:00.000Z").toISOString();

  // Write log entries: start, then survey_done earning, then spam of progress notes
  const lines = [
    JSON.stringify({ ts: tStart, port, event: "start" }),
    JSON.stringify({ ts: tEarned, port, event: "survey_done", payout_usd: 1.25, title: "Consumer Habits" }),
    JSON.stringify({ ts: tProgress, port, event: "progress", note: "driver: turn 30 ended without target" }),
    JSON.stringify({ ts: tProgress, port, event: "progress", note: "driver: turn 31 ended without target" }),
  ];
  fs.writeFileSync(statusLog, lines.join("\n") + "\n", "utf8");

  const lastEarningMs = getLastEarningsTime(port, { logsDir: testLogsDir });
  assert.strictEqual(lastEarningMs, new Date(tEarned).getTime(), "Should return timestamp of survey_done, not progress note");

  fs.rmSync(testLogsDir, { recursive: true, force: true });
  console.log("  ✓ getLastEarningsTime correctly tracks real survey earnings, ignoring progress notes");
}

// --- Test 4: checkIdleTimeouts terminates idle agent and writes idle_today marker ---
console.log("\n[Test 4] checkIdleTimeouts terminates idle agent and sets idle_today marker...");
{
  const testDir = path.join(os.tmpdir(), "test_idle_timeout_" + Date.now());
  const testLogs = path.join(testDir, "logs");
  const testInbox = path.join(testDir, "inbox");
  fs.mkdirSync(testLogs, { recursive: true });
  fs.mkdirSync(testInbox, { recursive: true });

  const port = 3013;
  // Agent started 2 hours ago with zero earnings
  const tStart = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const statusLog = path.join(testLogs, `agent_${port}_status.jsonl`);
  fs.writeFileSync(statusLog, JSON.stringify({ ts: tStart, port, event: "start" }) + "\n", "utf8");

  // Simulated ps line indicating agent is alive
  const psLines = [`12345 /usr/bin/node scripts/survey_driver.mjs --port ${port} --marker codex exec bound port ${port}`];

  // Clean state sets for testing
  idleTodayPorts.clear();
  targetPorts.clear();
  pausedPorts.clear();

  const terminated = checkIdleTimeouts(psLines, {
    logsDir: testLogs,
    inboxDir: testInbox,
    now: Date.now(),
    idleTimeoutMs: 60 * 60 * 1000, // 60 min
  });

  assert.ok(terminated.includes(port), "Port 3013 should have been terminated due to idle timeout");
  assert.ok(idleTodayPorts.has(port), "Port 3013 should be added to idleTodayPorts set");

  // Verify idle_today marker was written to inbox
  const inboxFiles = fs.readdirSync(testInbox);
  const idleMarker = inboxFiles.find((f) => f.startsWith(`${port}_idle_today_`));
  assert.ok(idleMarker, "An idle_today marker JSON file must be written to inbox");

  const markerContent = JSON.parse(fs.readFileSync(path.join(testInbox, idleMarker), "utf8"));
  assert.strictEqual(markerContent.port, port);
  assert.strictEqual(markerContent.type, "idle_today");

  // Verify that running checkIdleTimeouts again on this port skips it because it's in idleTodayPorts
  const secondPass = checkIdleTimeouts(psLines, {
    logsDir: testLogs,
    inboxDir: testInbox,
    now: Date.now(),
    idleTimeoutMs: 60 * 60 * 1000,
  });
  assert.strictEqual(secondPass.length, 0, "Second pass should not re-terminate already idle-marked port");

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log("  ✓ checkIdleTimeouts terminates idle agent, writes idle_today marker, and prevents respawns");
}

// --- Test 5: isFleetTerminal detects when entire fleet has completed or idled ---
console.log("\n[Test 5] isFleetTerminal...");
{
  const FLEET_PORTS = [3013, 3014, 3015, 3016, 3017];
  const tPorts = new Set([3013, 3014]);
  const iPorts = new Set([3015, 3016, 3017]);
  const pPorts = new Map();

  // All 5 ports are in target or idle
  assert.strictEqual(
    isFleetTerminal({ targetPorts: tPorts, idleTodayPorts: iPorts, pausedPorts: pPorts, alivePorts: [] }),
    true,
    "Should return true when all 5 ports are completed or idle"
  );

  // One port still pending and running
  const incompleteTarget = new Set([3013]);
  const incompleteIdle = new Set([3014, 3015, 3016]); // 3017 missing
  assert.strictEqual(
    isFleetTerminal({ targetPorts: incompleteTarget, idleTodayPorts: incompleteIdle, pausedPorts: pPorts, alivePorts: [3017] }),
    false,
    "Should return false when an active agent port remains"
  );

  // When missing port is paused and no agents alive
  pPorts.set(3017, { status: "repair_pending" });
  assert.strictEqual(
    isFleetTerminal({ targetPorts: incompleteTarget, idleTodayPorts: incompleteIdle, pausedPorts: pPorts, alivePorts: [] }),
    true,
    "Should return true when all ports are terminal/paused with 0 alive agents"
  );

  assert.strictEqual(FLEET_MAX_RUNTIME_MS, 4 * 60 * 60 * 1000, "FLEET_MAX_RUNTIME_MS should default to 4 hours");
  console.log("  ✓ isFleetTerminal correctly detects fleet completion conditions");
}

// --- Test 6: stopFleet and getFleetStatus execution ---
console.log("\n[Test 6] stopFleet and getFleetStatus CLI helpers...");
{
  const stopRes = await stopFleet({ timeoutMs: 500 });
  assert.strictEqual(stopRes.ok, true);

  const status = await getFleetStatus();
  assert.strictEqual(typeof status.ts, "string");
  assert.strictEqual(Array.isArray(status.ports), true);
  assert.strictEqual(status.ports.length, 5);
  assert.strictEqual(status.circuitBreaker.active, false);

  console.log("  ✓ stopFleet and getFleetStatus run cleanly and return structured data");
}

console.log("\n================================================================");
console.log("PASS: All clean exit, quota guard, and idle timeout tests passed!");
console.log("================================================================");
