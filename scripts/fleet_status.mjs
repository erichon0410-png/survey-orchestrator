#!/usr/bin/env node
// scripts/fleet_status.mjs — Comprehensive status inspector for the 5-port survey fleet.
//
// Inspects and reports:
// 1. Supervisor status & PID
// 2. Fleet-wide Codex API quota circuit breaker status
// 3. Per-port breakdown:
//    - Port & platform
//    - Docker container health
//    - CDP endpoint availability
//    - Active driver / codex process PID
//    - Status markers (target-reached, idle-today, restart-capped)
//    - Last recorded event, timestamp, and balance

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const INBOX = path.join(ROOT, "reports", "inbox");
const PROCESSED = path.join(ROOT, "reports", "processed");
const USAGE_LIMIT_FILE = path.join(INBOX, "FLEET_USAGE_LIMIT_EXHAUSTED.json");

const FLEET_CONFIG = [
  { port: 3013, platform: "SurveyJunkie", container: "SurveyCompleter-gmail-03" },
  { port: 3014, platform: "Swagbucks", container: "SurveyCompleter-gmail-04" },
  { port: 3015, platform: "SurveyJunkie", container: "SurveyCompleter-gmail-05" },
  { port: 3016, platform: "SurveyJunkie", container: "SurveyCompleter-gmail-06" },
  { port: 3017, platform: "Swagbucks 2", container: "SurveyCompleter-gmail-07" },
];

function getPsLines() {
  try {
    return execSync("ps -eo pid,args", { encoding: "utf8" }).split("\n");
  } catch {
    return [];
  }
}

function getSupervisorProcess(psLines) {
  for (const line of psLines) {
    if (line.includes("fleet_supervisor.mjs") && !line.includes("grep")) {
      const match = line.trim().match(/^(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

function getDriverPid(port, psLines) {
  const marker = `bound port ${port}`;
  const scriptArg = `survey_driver.mjs --port ${port}`;
  for (const line of psLines) {
    if ((line.includes(marker) || line.includes(scriptArg)) && !line.includes("grep")) {
      const match = line.trim().match(/^(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

function isContainerRunning(containerName) {
  try {
    const res = execSync(`docker inspect -f '{{.State.Running}}' ${containerName} 2>/dev/null`, { encoding: "utf8" }).trim();
    return res === "true";
  } catch {
    return false;
  }
}

async function checkCdpOnline(port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function findFileMarker(port, prefix, dirs = [INBOX, PROCESSED]) {
  const re = new RegExp(`^${port}_${prefix}_.*\\.json$`);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (re.test(f)) return { found: true, file: f, path: path.join(dir, f) };
      }
    } catch {}
  }
  return { found: false };
}

function readAgentStatusLog(port) {
  const statusLog = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
  let lastEvent = null;
  let lastTs = null;
  let totalUsd = 0;
  let totalRaw = 0;
  let balance = null;

  if (fs.existsSync(statusLog)) {
    try {
      const lines = fs.readFileSync(statusLog, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (!lastEvent && entry.event) {
            lastEvent = entry.event;
            lastTs = entry.ts;
          }
          if (balance === null && entry.balance !== undefined) {
            balance = entry.balance;
          }
          if (!totalUsd && (entry.total_usd !== undefined || entry.totalUsd !== undefined)) {
            totalUsd = entry.total_usd ?? entry.totalUsd ?? 0;
          }
          if (lastEvent && balance !== null) break;
        } catch {}
      }
    } catch {}
  }
  return { lastEvent, lastTs, balance, totalUsd };
}

export async function getFleetStatus() {
  const psLines = getPsLines();
  const supervisorPid = getSupervisorProcess(psLines);

  let circuitBreaker = { active: false };
  if (fs.existsSync(USAGE_LIMIT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USAGE_LIMIT_FILE, "utf8"));
      circuitBreaker = {
        active: true,
        reason: data.reason || "usage_limit",
        detail: data.detail || "",
        ts: data.ts || "",
      };
    } catch {
      circuitBreaker = { active: true, reason: "usage_limit" };
    }
  }

  const ports = [];
  for (const cfg of FLEET_CONFIG) {
    const containerRunning = isContainerRunning(cfg.container);
    const cdpAlive = containerRunning ? await checkCdpOnline(cfg.port) : false;
    const driverPid = getDriverPid(cfg.port, psLines);
    const targetReached = findFileMarker(cfg.port, "target_reached");
    const idleToday = findFileMarker(cfg.port, "idle_today", [INBOX]);
    const restartCap = findFileMarker(cfg.port, "restart_cap_active", [INBOX]);
    const { lastEvent, lastTs, balance, totalUsd } = readAgentStatusLog(cfg.port);

    let state = "stopped";
    if (targetReached.found) state = "TARGET_REACHED";
    else if (idleToday.found) state = "IDLE_TODAY";
    else if (restartCap.found) state = "RESTART_CAPPED";
    else if (driverPid) state = "ACTIVE";

    ports.push({
      port: cfg.port,
      platform: cfg.platform,
      container: cfg.container,
      containerRunning,
      cdpAlive,
      driverPid,
      state,
      targetReached: targetReached.found,
      idleToday: idleToday.found,
      restartCap: restartCap.found,
      balance,
      totalUsd,
      lastEvent,
      lastTs,
    });
  }

  return {
    ts: new Date().toISOString(),
    supervisorPid,
    circuitBreaker,
    ports,
  };
}

function printStatusTable(status) {
  console.log("================================================================================");
  console.log("                           SURVEY FLEET STATUS                                 ");
  console.log("================================================================================");
  console.log(`Timestamp:  ${status.ts}`);
  console.log(`Supervisor: ${status.supervisorPid ? `🟢 ACTIVE (PID ${status.supervisorPid})` : "⚪ STOPPED"}`);

  if (status.circuitBreaker.active) {
    console.log(`⚠️  CIRCUIT BREAKER: TRIPPED (FLEET_USAGE_LIMIT_EXHAUSTED.json present)`);
    console.log(`   Reason: ${status.circuitBreaker.reason} - ${status.circuitBreaker.detail}`);
  } else {
    console.log(`Circuit Breaker: Normal (Quota OK)`);
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(
    "Port  Platform        Container  CDP   PID      State           Balance   Last Event"
  );
  console.log(
    "----  --------------  ---------  ----  -------  --------------  --------  ----------------"
  );

  for (const p of status.ports) {
    const portStr = String(p.port).padEnd(4);
    const platStr = p.platform.padEnd(14).slice(0, 14);
    const contStr = (p.containerRunning ? "UP" : "DOWN").padEnd(9);
    const cdpStr = (p.cdpAlive ? "OK" : "--").padEnd(4);
    const pidStr = (p.driverPid ? String(p.driverPid) : "--").padEnd(7);
    const stateStr = p.state.padEnd(14);
    const balStr = (p.balance !== null ? `$${Number(p.balance).toFixed(2)}` : "--").padEnd(8);
    const evStr = (p.lastEvent || "--").slice(0, 16);

    console.log(`${portStr}  ${platStr}  ${contStr}  ${cdpStr}  ${pidStr}  ${stateStr}  ${balStr}  ${evStr}`);
  }
  console.log("================================================================================");
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));
if (isDirectRun || process.argv[1]?.includes("fleet_status.mjs")) {
  const jsonMode = process.argv.includes("--json");
  const status = await getFleetStatus();
  if (jsonMode) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printStatusTable(status);
  }
  process.exit(0);
}
