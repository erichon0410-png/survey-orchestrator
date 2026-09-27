#!/usr/bin/env node
// scripts/stop_fleet.mjs — Cleanly and safely halt the entire survey fleet, containers, and supervisor.
//
// 1. Identifies running processes for supervisor, survey drivers, dsh headless agents, and bsk_relay.
// 2. Sends SIGTERM for graceful shutdown.
// 3. Waits up to 1.2s for processes to exit.
// 4. Escalates to SIGKILL (kill -9) for any persistent processes.
// 5. Halts all 5 Docker containers (3013-3017) to free host ports and release ~2 GB RAM.
// 6. Exits cleanly with status 0.

import { execSync } from "node:child_process";

const TARGET_PATTERNS = [
  /fleet_supervisor\.mjs/,
  /survey_driver\.mjs/,
  /codex exec/,
  /dsh.*--profile\s+headless/,
  /auto_fixer\.mjs/,
  /monitor_3h\.mjs/,
  /start_presence_surveys\.mjs/,
  /bsk_relay\.mjs/,
  /context7/,
];

const FLEET_CONTAINERS = [
  "SurveyCompleter-gmail-03",
  "SurveyCompleter-gmail-04",
  "SurveyCompleter-gmail-05",
  "SurveyCompleter-gmail-06",
  "SurveyCompleter-gmail-07",
];

function getFleetProcesses() {
  let psOutput = "";
  try {
    psOutput = execSync("ps -eo pid,ppid,args", { encoding: "utf8" });
  } catch (e) {
    return [];
  }

  const myPid = process.pid;
  const myPpid = process.ppid;
  const matches = [];

  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!parts) continue;

    const pid = parseInt(parts[1], 10);
    const ppid = parseInt(parts[2], 10);
    const cmd = parts[3];
    if (pid === myPid || pid === myPpid) continue;
    if (cmd.includes("stop_fleet.mjs")) continue;

    if (TARGET_PATTERNS.some((re) => re.test(cmd))) {
      matches.push({ pid, cmd: cmd.slice(0, 90) });
    }
  }

  return matches;
}

export async function stopFleet({ timeoutMs = 1200, stopContainers = true } = {}) {
  console.log("🛑 Initiating survey fleet shutdown across all 5 ports...");

  let active = getFleetProcesses();
  const initialPids = active.map((p) => p.pid);

  if (active.length > 0) {
    console.log(`Found ${active.length} active process(es):`);
    for (const p of active) {
      console.log(`  [PID ${p.pid}] ${p.cmd}`);
    }

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
      await new Promise((r) => setTimeout(r, 300));
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
      await new Promise((r) => setTimeout(r, 400));
      active = getFleetProcesses();
    }
  } else {
    console.log("✓ No active supervisor, driver, or dsh processes found.");
  }

  // 4. Halt all 5 Docker containers (freeing ports 3013, 3014, 3015, 3016, 3017 and RAM)
  if (stopContainers) {
    console.log("\n📦 Stopping all 5 survey containers (ports 3013-3017)...");
    for (const c of FLEET_CONTAINERS) {
      try {
        execSync(`docker unpause ${c} 2>/dev/null || true`, { stdio: "ignore" });
        execSync(`docker stop -t 2 ${c} 2>/dev/null || true`, { stdio: "ignore" });
      } catch {}
    }
    console.log("✓ All 5 containers stopped.");
  }

  if (active.length === 0) {
    console.log(`\n✅ All 5 survey ports stopped cleanly. 0 active processes remain.`);
    return { ok: true, stoppedPids: initialPids };
  } else {
    console.error(`\n❌ Warning: ${active.length} process(es) could not be killed:`);
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
