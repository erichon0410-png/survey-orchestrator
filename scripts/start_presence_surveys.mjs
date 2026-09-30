#!/usr/bin/env node
// scripts/start_presence_surveys.mjs — Launch autonomous AI survey fleet on presence departure.
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = path.join(LOGS_DIR, "presence_start.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] [presence_start] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

log("Starting autonomous survey fleet deployment across all 5 ports...");

// 1. Ensure all 5 docker containers are running
const CONTAINERS = [
  "SurveyCompleter-gmail-03",
  "SurveyCompleter-gmail-04",
  "SurveyCompleter-gmail-05",
  "SurveyCompleter-gmail-06",
  "SurveyCompleter-gmail-07",
];

for (const container of CONTAINERS) {
  try {
    const running = execSync(`docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
    if (running !== "true") {
      log(`Starting container ${container}...`);
      execSync(`docker start ${container}`, { timeout: 15000, stdio: "ignore" });
    }
  } catch (e) {
    log(`Warning checking container ${container}: ${e.message}`);
  }
}

// 2. Ensure bsk_relay is running
try {
  const p = execSync("pgrep -f 'scripts/bsk_relay\\.mjs' || true", { encoding: "utf-8" }).trim();
  if (!p) {
    const relayScript = path.join(ROOT, "scripts", "bsk_relay.mjs");
    if (fs.existsSync(relayScript)) {
      const child = spawn("node", [relayScript], { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      log(`Auto-started bsk relay daemon (PID ${child.pid})`);
    }
  }
} catch (e) {
  log(`Warning checking bsk_relay: ${e.message}`);
}

// 3. Ensure supervisor daemon is running to maintain the fleet
try {
  let supPid = null;
  const p = execSync("pgrep -f 'fleet_supervisor\\.mjs' || true", { encoding: "utf-8" }).trim();
  if (p) {
    const pids = p.split("\n").map(x => x.trim()).filter(Boolean);
    if (pids.length > 0) supPid = pids[0];
  }
  if (!supPid) {
    log("Supervisor not running. Launching start_supervisor.sh...");
    execSync("bash scripts/start_supervisor.sh", { cwd: ROOT, timeout: 10000, stdio: "ignore" });
    log("Supervisor started.");
  } else {
    log(`Supervisor is already active (PID ${supPid}).`);
  }
} catch (e) {
  log(`Warning starting supervisor: ${e.message}`);
}

// 4. Deploy fleet survey agents across all 5 ports immediately
try {
  log("Deploying AI model survey agents via deploy_fleet.mjs...");
  const deployOut = execSync("node scripts/deploy_fleet.mjs", { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
  log(`Deployment summary:\n${deployOut.trim()}`);
} catch (e) {
  log(`Error during deploy_fleet: ${e.message}`);
}

log("✅ All fleet survey agents deployed successfully.");
process.exit(0);
