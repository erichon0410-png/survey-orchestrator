#!/usr/bin/env node
// scripts/stop_fleet.mjs — Cleanly and safely halt the entire survey fleet and supervisor.
//
// 1. Identifies running processes for supervisor, survey drivers, and codex execs.
// 2. Sends SIGTERM for graceful shutdown (giving drivers time to flush status/logs).
// 3. Waits up to 4 seconds for processes to exit.
// 4. Escalates to SIGKILL (kill -9) for any persistent processes.
// 5. Exits cleanly with status 0.

import { execSync } from "node:child_process";

const TARGET_PATTERNS = [
  /fleet_supervisor\.mjs/,
  /survey_driver\.mjs/,
  /codex exec/,
  /auto_fixer\.mjs/,
];

function getFleetProcesses() {
  let psOutput = "";
  try {
    psOutput = execSync("ps -eo pid,args", { encoding: "utf8" });
  } catch (e) {
    return [];
  }

  const myPid = process.pid;
  const matches = [];

  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!parts) continue;

    const pid = parseInt(parts[1], 10);
    const cmd = parts[2];
    if (pid === myPid) continue;

    if (TARGET_PATTERNS.some((re) => re.test(cmd))) {
      matches.push({ pid, cmd: cmd.slice(0, 90) });
    }
  }

  return matches;
}

export async function stopFleet({ timeoutMs = 4000 } = {}) {
  console.log("🛑 Initiating survey fleet shutdown...");

  let active = getFleetProcesses();
  if (active.length === 0) {
    console.log("✓ No active supervisor, driver, or codex processes found. Fleet is already stopped.");
    return { ok: true, stoppedPids: [] };
  }

  console.log(`Found ${active.length} active process(es):`);
  for (const p of active) {
    console.log(`  [PID ${p.pid}] ${p.cmd}`);
  }

  const initialPids = active.map((p) => p.pid);

  // 1. Send SIGTERM (graceful shutdown)
  console.log("\nSending SIGTERM (graceful shutdown)...");
  for (const p of active) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {}
  }

  // 2. Wait up to timeoutMs for processes to terminate
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400));
    active = getFleetProcesses();
    if (active.length === 0) break;
  }

  // 3. Escalate to SIGKILL if any processes remain
  if (active.length > 0) {
    console.log(`\n⚠️  ${active.length} process(es) still alive after ${timeoutMs}ms. Sending SIGKILL (kill -9)...`);
    for (const p of active) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
    active = getFleetProcesses();
  }

  if (active.length === 0) {
    console.log(`\n✅ Fleet halted cleanly. ${initialPids.length} process(es) terminated. 0 active processes remain.`);
    return { ok: true, stoppedPids: initialPids };
  } else {
    console.error(`\n❌ Error: ${active.length} process(es) could not be killed:`);
    for (const p of active) {
      console.error(`  [PID ${p.pid}] ${p.cmd}`);
    }
    return { ok: false, remainingPids: active.map((p) => p.pid) };
  }
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));
if (isDirectRun || process.argv[1]?.includes("stop_fleet.mjs")) {
  stopFleet()
    .then((res) => {
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("Failed to stop fleet:", err);
      process.exit(1);
    });
}
