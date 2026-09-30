#!/usr/bin/env node
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("================================================================");
console.log("Running Supervisor Resilience & Cooldown Engine Test Suite");
console.log("================================================================");

import {
  FLEET,
  checkIdleTimeouts,
  isFleetTerminal,
  idleCooldowns,
  idleTodayPorts,
  targetPorts,
  pausedPorts,
  standbyActive,
  tick,
} from "../scripts/fleet_supervisor.mjs";

// [Test 1] FLEET isolation: verify FLEET exported from fleet_supervisor.mjs contains ONLY ports 3013 and 3014
console.log("\n[Test 1] FLEET port isolation...");
{
  assert.ok(Array.isArray(FLEET), "FLEET must be an array");
  assert.strictEqual(FLEET.length, 2, "FLEET must contain exactly 2 ports");
  const ports = FLEET.map((f) => f.port).sort((a, b) => a - b);
  assert.deepStrictEqual(ports, [3013, 3014], "FLEET must contain ONLY ports 3013 and 3014");
  console.log("  ✓ FLEET contains ONLY active ports 3013 and 3014");
}

// [Test 2] checkIdleTimeouts supports temporary 15m cooldowns rather than writing permanent idle_today ban files
console.log("\n[Test 2] checkIdleTimeouts with useCooldown: true...");
{
  const testDir = path.join(os.tmpdir(), "test_sup_resilience_" + Date.now());
  const testLogs = path.join(testDir, "logs");
  const testInbox = path.join(testDir, "inbox");
  fs.mkdirSync(testLogs, { recursive: true });
  fs.mkdirSync(testInbox, { recursive: true });

  const port = 3013;
  const now = Date.now();
  // Agent started 2 hours ago with zero earnings
  const tStart = new Date(now - 2 * 3600 * 1000).toISOString();
  const statusLog = path.join(testLogs, `agent_${port}_status.jsonl`);
  fs.writeFileSync(statusLog, JSON.stringify({ ts: tStart, port, event: "start" }) + "\n", "utf8");

  const psLines = [`12345 /usr/bin/node scripts/survey_driver.mjs --port ${port} --marker codex exec bound port ${port}`];

  idleTodayPorts.clear();
  targetPorts.clear();
  pausedPorts.clear();
  if (idleCooldowns) idleCooldowns.clear();

  const terminated = checkIdleTimeouts(psLines, {
    logsDir: testLogs,
    inboxDir: testInbox,
    now,
    idleTimeoutMs: 60 * 60 * 1000,
    useCooldown: true,
    cooldownMs: 15 * 60 * 1000,
  });

  assert.ok(terminated.includes(port), "Port 3013 should be terminated on idle timeout");
  assert.ok(!idleTodayPorts.has(port), "Port 3013 must NOT be added to permanent idleTodayPorts when useCooldown is true");

  // Verify NO idle_today marker file was written to inbox
  const inboxFiles = fs.readdirSync(testInbox);
  const idleMarker = inboxFiles.find((f) => f.startsWith(`${port}_idle_today_`));
  assert.strictEqual(idleMarker, undefined, "No permanent idle_today marker file should be written to inbox");

  // Verify temporary 15m cooldown was recorded in idleCooldowns
  assert.ok(idleCooldowns && idleCooldowns.has(port), "idleCooldowns map must contain port 3013");
  const cdInfo = idleCooldowns.get(port);
  const resumeAt = typeof cdInfo === "object" ? cdInfo.resumeAt : cdInfo;
  assert.ok(resumeAt >= now + 14 * 60 * 1000, "resumeAt must be at least 14 minutes in the future");

  // Verify second pass skips already cooled-down port
  const secondPass = checkIdleTimeouts(psLines, {
    logsDir: testLogs,
    inboxDir: testInbox,
    now,
    idleTimeoutMs: 60 * 60 * 1000,
    useCooldown: true,
  });
  assert.strictEqual(secondPass.length, 0, "Second pass must skip port currently in idleCooldowns");

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log("  ✓ checkIdleTimeouts successfully sets 15m cooldown without permanent ban files");
}

// [Test 3] Supervisor standby state: when all ports reach terminal/idle state, supervisor does NOT process.exit(0)
console.log("\n[Test 3] Supervisor standby on terminal fleet...");
{
  // Test isFleetTerminal detection with 3013 and 3014
  const tPorts = new Set([3013]);
  const iPorts = new Set([3014]);
  const pPorts = new Map();
  const cPorts = new Map();

  assert.strictEqual(
    isFleetTerminal({ targetPorts: tPorts, idleTodayPorts: iPorts, pausedPorts: pPorts, idleCooldowns: cPorts, alivePorts: [] }),
    true,
    "Should return true when ports 3013 and 3014 are completed or idle and alivePorts is empty"
  );

  assert.strictEqual(
    isFleetTerminal({ targetPorts: tPorts, idleTodayPorts: iPorts, pausedPorts: pPorts, idleCooldowns: cPorts, alivePorts: [3013] }),
    false,
    "Should return false when an active agent port remains alive"
  );

  // Verify code contract: fleet_supervisor.mjs must NOT call shutdown() or process.exit on terminal fleet
  const supSource = fs.readFileSync(path.join(ROOT, "scripts/fleet_supervisor.mjs"), "utf8");
  const terminalBlockMatch = supSource.match(/isFleetTerminal\([\s\S]*?\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(terminalBlockMatch, "Must contain isFleetTerminal check block in fleet_supervisor.mjs");
  assert.ok(
    !terminalBlockMatch[1].includes("shutdown()") && !terminalBlockMatch[1].includes("process.exit("),
    "isFleetTerminal block must NOT call shutdown() or process.exit(); it must enter standby instead"
  );

  // Verify standby execution does not exit process
  let exitCalled = false;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCalled = true;
  };

  try {
    targetPorts.clear();
    targetPorts.add(3013);
    targetPorts.add(3014);

    await tick({ standbyDelayMs: 10, now: Date.now() });

    assert.strictEqual(exitCalled, false, "Supervisor tick must NOT call process.exit when all ports are terminal");
  } finally {
    process.exit = originalExit;
    targetPorts.clear();
  }

  console.log("  ✓ Supervisor enters standby without exiting process when all ports are terminal");
}

console.log("\n================================================================");
console.log("PASS: All supervisor resilience tests passed!");
console.log("================================================================");
