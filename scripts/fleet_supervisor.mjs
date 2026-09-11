#!/usr/bin/env node
// fleet_supervisor.mjs — keep the 5-agent survey fleet alive (Node ESM, stdlib only).
//
// Polls every 30 s. For each FLEET port (ascending):
//   a. target-reached marker present (reports/inbox/ or anywhere under
//      reports/processed/) -> never restart that port again this process's life
//   b. no live `codex exec` process for the port -> redeploy via deployAgent()
//   c. alive -> do nothing
// Restart cap: max 4 restarts per port in any rolling 60-minute window; on the
// 5th needed restart the port is paused for repair (repair-pending, bounded cooldown),
// a supervisor_restart_cap line is appended to the agent status stream, and a
// reports/inbox/<PORT>_restart_cap_active.json file is written. After the cooldown,
// the hold clears and deployment resumes automatically.
//
// Before the deploy loop, each tick runs a bounded auto-fix pass
// (scripts/auto_fixer.mjs): container-down / CDP-offline / driver-dead detection with
// idempotent runtime remediation, attempt caps, backoff cooldowns, and fail-closed
// reports/inbox/<PORT>_autofix_failed.json markers. Fail-closed ports are skipped by
// the deploy loop so they do not burn restart budget. The auto-fixer writes only
// reports/ and logs/ — never core source files.
//
// Logs: logs/supervisor.log (append-only JSON lines).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { syncEarnings } from "./earnings_sync.mjs";
import { createAutoFixer } from "./auto_fixer.mjs";
import { driverKillPattern } from "./driver_kill.mjs";

// Portable root: this file lives in <root>/scripts/, so the repo root is its parent.
// Override with SURVEY_ROOT if the checkout lives elsewhere.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SURVEY_ROOT || path.resolve(__dirname, "..");

// The orchestrator plugin lives under the user's home (~/.dsh/...). Resolve it from
// $HOME so this works on any machine; override with DSH_ORCHESTRATOR if relocated.
const ORCH_PATH = process.env.DSH_ORCHESTRATOR || path.join(os.homedir(), ".dsh", "plugins", "dsh-survey-orchestrator", "lib", "orchestrator.js");
const { FLEET, deployAgent, ensureFleetRunning, isContainerRunning, checkCdp, relaunchChromium } = await import(ORCH_PATH);
const LOGS_DIR = path.join(ROOT, "logs");
const INBOX = path.join(ROOT, "reports", "inbox");
const PROCESSED = path.join(ROOT, "reports", "processed");
const SUPERVISOR_LOG = path.join(LOGS_DIR, "supervisor.log");

// Bounded runtime self-heal (scripts/auto_fixer.mjs): container-down / CDP-offline /
// driver-dead detection with idempotent remediation, attempt caps, backoff cooldowns,
// and fail-closed markers. Writes only reports/ and logs/ — never core source files.
const autoFixer = createAutoFixer({
  fleet: FLEET,
  root: ROOT,
  inboxDir: INBOX,
  logFile: path.join(LOGS_DIR, "autofix.log"),
  probes: { isContainerRunning, checkCdp, relaunchChromium, deployAgent, isPortAlive, hasTargetMarker },
});

const POLL_MS = 30_000;
const WINDOW_MS = 60 * 60 * 1000; // rolling 60-minute window
const MAX_RESTARTS_PER_WINDOW = 4; // 5th needed restart within the window -> cap
const COOLDOWN_MS = Number(process.env.SUPERVISOR_COOLDOWN_MS) || 5 * 60 * 1000; // bounded cooldown before re-attempting a paused port (default 5 min)
const DAILY_SYNC_HOUR = 7; // trigger at 7:00 AM local time each day

// Earnings efficiency tracking - terminate agents that don't earn within 1 hour
const IDLE_TIMEOUT_MS = Number(process.env.AGENT_IDLE_TIMEOUT_MS) || 60 * 60 * 1000; // 1 hour default

// Authentication timeout - terminate agents stuck on sign-in for too long
const AUTH_TIMEOUT_MS = Number(process.env.AGENT_AUTH_TIMEOUT_MS) || 30 * 60 * 1000; // 30 minutes default

// --- state (in-memory, this process's life) ---
let lastEarningsSyncDate = null; // YYYY-MM-DD string of last sync date
const restarts = new Map(); // port -> [timestamp ms, ...]
const pausedPorts = new Map(); // port -> { pausedAt: number, resumeAt: number, status: "repair_pending" }
const targetPorts = new Set(); // target-reached marker found: never restart again

// --- helpers ---
function iso() {
  return new Date().toISOString();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf-8");
}

function appendSupervisorLog(obj) {
  try {
    appendJsonl(SUPERVISOR_LOG, obj);
  } catch (e) {
    console.error(`supervisor: failed to append to supervisor.log: ${String(e)}`);
  }
}

// --- process detection (fact 2): a line containing BOTH `codex exec` and the
// exact substring `bound port <N>` in `ps -eo pid,args` output.
function isPortAlive(port, psLines) {
  const needle = `bound port ${port}`;
  return psLines.some(
    (line) => line.includes("codex exec") && line.includes(needle)
  );
}

// --- target-reached marker (fact 3): `${port}_target_reached_*.json` in
// reports/inbox/ or anywhere under reports/processed/.
function findMarker(dir, re) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (findMarker(p, re)) return true;
    } else if (re.test(name)) {
      return true;
    }
  }
  return false;
}

function hasTargetMarker(port) {
  const re = new RegExp(`^${port}_target_reached_.*\\.json$`);
  return findMarker(INBOX, re) || findMarker(PROCESSED, re);
}

// --- restart cap: pause port for repair instead of holding indefinitely ---
function capPort(port) {
  const ts = iso();
  const now = Date.now();
  const resumeAt = now + COOLDOWN_MS;
  const cooldownMin = Math.round(COOLDOWN_MS / 60000);

  // 1. one line in the agent status stream (append only, never rewrite).
  try {
    appendJsonl(path.join(LOGS_DIR, `agent_${port}_status.jsonl`), {
      ts,
      port,
      event: "supervisor_restart_cap",
      status: "repair_pending",
      note: `restart cap reached; paused for repair (cooldown ${cooldownMin}m)`,
      resume_at: new Date(resumeAt).toISOString(),
    });
  } catch (e) {
    appendSupervisorLog({ ts, port, action: "cap_status_write_failed", error: String(e) });
  }
  // 2. inbox file for the orchestrator/watcher to pick up.
  try {
    // Remove older restart cap markers for this port to prevent accumulation
    try {
      if (fs.existsSync(INBOX)) {
        const legacyPattern = new RegExp(`^${port}_restart_cap_.*\\.json$`);
        for (const file of fs.readdirSync(INBOX)) {
          if (file !== `${port}_restart_cap_active.json` && legacyPattern.test(file)) {
            try {
              fs.unlinkSync(path.join(INBOX, file));
            } catch {}
          }
        }
      }
    } catch {}

    const fname = `${port}_restart_cap_active.json`;
    fs.writeFileSync(
      path.join(INBOX, fname),
      JSON.stringify({
        port,
        ts,
        type: "tech_issue",
        symptom: "supervisor restart cap reached (5+ exits in 60 min)",
        evidence: "see logs/supervisor.log",
        attempts: 5,
        resumable: true,
        status: "repair_pending",
        cooldown_ms: COOLDOWN_MS,
        resume_at: new Date(resumeAt).toISOString(),
      }) + "\n",
      "utf-8"
    );
  } catch (e) {
    appendSupervisorLog({ ts, port, action: "cap_inbox_write_failed", error: String(e) });
  }
  // 3. supervisor log line.
  appendSupervisorLog({
    ts,
    port,
    action: "cap_paused",
    status: "repair_pending",
    cooldown_ms: COOLDOWN_MS,
    resume_at: new Date(resumeAt).toISOString(),
  });
  pausedPorts.set(port, { pausedAt: now, resumeAt, status: "repair_pending" });
}

// --- auth timeout: terminate agents stuck on sign-in for too long ---
function checkAuthTimeouts(psLines) {
  const now = Date.now();
  
  for (const item of FLEET) {
    const port = item.port;
    
    // Skip ports that are paused, completed, or not running
    if (pausedPorts.has(port)) continue;
    if (targetPorts.has(port)) continue;
    if (!isPortAlive(port, psLines)) continue;
    
    // Read recent status log entries and check for auth issues
    const statusLog = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
    let lastAuthIssueMs = 0;
    let authIssueCount = 0;
    
    try {
      if (fs.existsSync(statusLog)) {
        const content = fs.readFileSync(statusLog, "utf8");
        const lines = content.split("\n");
        
        // Scan from the end (most recent) looking for auth issues
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          
          try {
            const entry = JSON.parse(line);
            
            // Check if this is an auth-related issue
            const note = (entry.note || "").toLowerCase();
            const event = (entry.event || "").toLowerCase();
            
            const isAuthIssue = 
              note.includes("unauthenticated") ||
              note.includes("login page") ||
              note.includes("requires login") ||
              note.includes("session_bounced_to_login") ||
              note.includes("authentication remains") ||
              note.includes("lost authenticated state") ||
              note.includes("dashboard route still requires login") ||
              event === "tech_issue_reported" && (
                note.includes("auth") || 
                note.includes("login") ||
                note.includes("session")
              );
            
            if (isAuthIssue) {
              authIssueCount++;
              // Try to extract timestamp
              const ts = entry.ts ? new Date(entry.ts).getTime() : 0;
              if (ts > lastAuthIssueMs) {
                lastAuthIssueMs = ts;
              }
            }
            
            // Stop scanning after finding enough recent entries or going back too far
            if (i < lines.length - 100) break;
          } catch (e) {
            // Ignore malformed lines
          }
        }
        
        // If we found auth issues and the last one was recent but long ago overall, terminate
        if (authIssueCount >= 3 && lastAuthIssueMs > 0) {
          const timeSinceLastAuthIssue = now - lastAuthIssueMs;
          
          // Only terminate if the auth issue persisted for more than AUTH_TIMEOUT_MS
          // Check when the agent started vs when auth issues began
          const agentStartedMs = getAgentStartTime(port);
          if (agentStartedMs > 0) {
            const timeSinceStart = now - agentStartedMs;
            
            // If agent has been running longer than auth timeout and still having auth issues
            if (timeSinceStart > AUTH_TIMEOUT_MS && timeSinceLastAuthIssue < 5 * 60 * 1000) {
              const stuckMinutes = Math.round(timeSinceStart / 60000);
              appendSupervisorLog({
                ts: iso(),
                port,
                action: "auth_timeout_terminate",
                stuck_minutes: stuckMinutes,
                auth_issue_count: authIssueCount,
                note: `Agent terminated: stuck on authentication for ${stuckMinutes} minutes (${authIssueCount} auth issues reported)`,
              });
              
              // Kill the agent process
              try {
                execSync(`pkill -f "${driverKillPattern(port)}" || true`);
              } catch (e) {
                appendSupervisorLog({ ts: iso(), port, action: "auth_kill_failed", error: String(e) });
              }
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors reading status log
    }
  }
}

// Helper: get agent start time from status log
function getAgentStartTime(port) {
  const statusLog = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
  try {
    if (fs.existsSync(statusLog)) {
      const content = fs.readFileSync(statusLog, "utf8");
      const lines = content.split("\n");
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        try {
          const entry = JSON.parse(trimmed);
          if (entry.event === "start") {
            return new Date(entry.ts).getTime();
          }
        } catch (e) {
          // Ignore malformed lines
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return 0;
}

// --- idle timeout: terminate agents that haven't earned in 1 hour ---
function checkIdleTimeouts(psLines) {
  const now = Date.now();
  
  for (const item of FLEET) {
    const port = item.port;
    
    // Skip ports that are paused, completed, or not running
    if (pausedPorts.has(port)) continue;
    if (targetPorts.has(port)) continue;
    if (!isPortAlive(port, psLines)) continue;
    
    // Check last activity: look for recent target_reached markers or status log entries
    const statusLog = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
    let lastActivityMs = 0;
    
    try {
      if (fs.existsSync(statusLog)) {
        const stat = fs.statSync(statusLog);
        lastActivityMs = stat.mtimeMs;
      }
    } catch (e) {
      // Ignore errors checking log file
    }
    
    // Also check for recent target_reached markers in inbox/processed
    try {
      const markerRe = new RegExp(`^${port}_target_reached_.*\\.json$`);
      for (const dir of [INBOX, PROCESSED]) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (markerRe.test(file)) {
            try {
              const stat = fs.statSync(path.join(dir, file));
              if (stat.mtimeMs > lastActivityMs) {
                lastActivityMs = stat.mtimeMs;
              }
            } catch (e) {
              // Ignore
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors scanning for markers
    }
    
    if (lastActivityMs === 0) {
      // No activity recorded at all — agent just started or log missing
      continue;
    }
    
    const idleMs = now - lastActivityMs;
    if (idleMs > IDLE_TIMEOUT_MS) {
      const idleMinutes = Math.round(idleMs / 60000);
      appendSupervisorLog({
        ts: iso(),
        port,
        action: "idle_timeout_terminate",
        idle_minutes: idleMinutes,
        note: `Agent terminated: no earnings activity for ${idleMinutes} minutes (threshold: ${Math.round(IDLE_TIMEOUT_MS / 60000)} min)`,
      });
      
      // Kill the agent process
      try {
        execSync(`pkill -f "${driverKillPattern(port)}" || true`);
      } catch (e) {
        appendSupervisorLog({ ts: iso(), port, action: "idle_kill_failed", error: String(e) });
      }
    }
  }
}

// --- one tick: check every FLEET port in ascending order ---
async function tick() {
  const alivePorts = [];
  const restartedPorts = [];
  try {
    // --- Daily earnings sync & graph refresh at 7:00 AM ---
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    
    // Trigger sync once per day at or after 7:00 AM local time
    if (lastEarningsSyncDate !== todayStr && now.getHours() >= DAILY_SYNC_HOUR) {
      lastEarningsSyncDate = todayStr;
      try {
        const syncRes = syncEarnings({ dailyHeartbeat: true });
        appendSupervisorLog({
          ts: iso(),
          action: "daily_sync",
          markers_processed: syncRes.markersProcessed,
          heartbeats_appended: syncRes.heartbeatsAppended?.length ?? 0,
          graph_rebuilt: syncRes.graphRebuilt,
          note: "daily earnings sync and graph refresh complete",
        });
      } catch (e) {
        appendSupervisorLog({
          ts: iso(),
          action: "daily_sync_failed",
          error: String(e),
        });
      }
    }

    const psLines = execSync("ps -eo pid,args", { encoding: "utf8" }).split("\n");

    // Check for idle agents that haven't earned in 1 hour — terminate them to save Codex budget
    checkIdleTimeouts(psLines);

    // Check for agents stuck on authentication screens — terminate after 30 minutes
    checkAuthTimeouts(psLines);

    // Bounded auto-fix pass: detect container-down / CDP-offline / driver-dead ports and
    // apply idempotent runtime remediation (docker start, chromium relaunch, agent redeploy).
    // Fail-closed ports (attempt cap exhausted, in backoff) are skipped by the deploy loop.
    let fixBlocked = new Set();
    try {
      const autofix = await autoFixer.tick(psLines);
      fixBlocked = new Set([...autofix.failed, ...autofix.cooldown]);
      appendSupervisorLog({
        ts: iso(),
        event: "autofix_tick",
        repaired: autofix.repaired,
        failed: autofix.failed,
        cooldown: autofix.cooldown,
      });
    } catch (e) {
      appendSupervisorLog({ ts: iso(), event: "autofix_tick_failed", error: String(e) });
    }

    // If the auto-fixer redeployed drivers this tick, refresh the process snapshot so the
    // deploy loop below does not double-deploy on a stale ps capture.
    let fleetPsLines = psLines;
    try {
      fleetPsLines = execSync("ps -eo pid,args", { encoding: "utf8" }).split("\n");
    } catch {}

    // If any uncompleted port has no alive agent, ensure Docker fleet is running first
    const hasDeadPorts = FLEET.some((item) => !targetPorts.has(item.port) && !isPortAlive(item.port, fleetPsLines));
    if (hasDeadPorts) {
      try {
        await ensureFleetRunning(ROOT);
      } catch (e) {
        appendSupervisorLog({ ts: iso(), event: "ensure_fleet_running_failed", error: String(e) });
      }
    }

    for (const item of [...FLEET].sort((a, b) => a.port - b.port)) {
      const port = item.port;

      // (a) target-reached marker? skip forever (log once).
      if (!targetPorts.has(port) && hasTargetMarker(port)) {
        targetPorts.add(port);
        appendSupervisorLog({
          ts: iso(),
          port,
          action: "skipped_target_reached",
          note: "target-reached marker present; never restarting this port",
        });
        try {
          syncEarnings();
        } catch (e) {
          appendSupervisorLog({ ts: iso(), port, action: "sync_earnings_failed", error: String(e) });
        }
      }
      if (targetPorts.has(port)) continue;

      // (b0) fail-closed auto-fix state (attempt cap exhausted / backoff): do not burn
      // restart budget on a port the auto-fixer is already pacing.
      if (fixBlocked.has(port)) {
        continue;
      }

      // (b) alive? do nothing for this port.
      if (isPortAlive(port, fleetPsLines)) {
        alivePorts.push(port);
        continue;
      }

      // (c) dead. Paused for repair?
      const now = Date.now();
      if (pausedPorts.has(port)) {
        const pauseInfo = pausedPorts.get(port);
        if (now < pauseInfo.resumeAt) {
          // Still in cooldown period; wait for repair
          continue;
        }
        // Cooldown elapsed: clear pause and allow resume deployment attempt.
        pausedPorts.delete(port);
        const resumeTs = iso();
        appendSupervisorLog({
          ts: resumeTs,
          port,
          action: "repair_resumed",
          status: "resuming",
          note: "repair cooldown elapsed; resuming deployment",
        });
        try {
          appendJsonl(path.join(LOGS_DIR, `agent_${port}_status.jsonl`), {
            ts: resumeTs,
            port,
            event: "supervisor_resume",
            note: "repair cooldown elapsed; repair-pending cleared, resuming deployment",
          });
        } catch (e) {
          appendSupervisorLog({ ts: resumeTs, port, action: "resume_status_write_failed", error: String(e) });
        }
        // Reset restarts history on resume to give a clean trial deployment
        // instead of leaving it 1 failure away from an immediate re-cap:
        restarts.set(port, []);
      }

      // Restart cap: max 4 restarts per port in any rolling 60-minute window.
      const recent = (restarts.get(port) ?? []).filter((t) => now - t <= WINDOW_MS);
      if (recent.length >= MAX_RESTARTS_PER_WINDOW) {
        capPort(port); // this would be the 5th restart within the window
        continue;
      }
      recent.push(now);
      restarts.set(port, recent);

      // Redeploy. Count every attempt against the cap (already pushed above),
      // success or failure.
      let res;
      try {
        res = await deployAgent(item);
      } catch (e) {
        appendSupervisorLog({ ts: iso(), port, action: "restart_failed", error: String(e) });
        continue;
      }
      if (res && res.ok === true) {
        appendSupervisorLog({ ts: iso(), port, action: "restarted", pid: res.pid });
        restartedPorts.push(port);
      } else {
        const err = res && (res.error ?? res);
        appendSupervisorLog({
          ts: iso(),
          port,
          action: "restart_failed",
          error: String(err === undefined ? "deployAgent returned no result" : err),
        });
      }
    }
  } catch (e) {
    // One bad tick never kills the loop.
    appendSupervisorLog({ ts: iso(), event: "tick_error", error: String(e) });
  }
  try {
    console.log(
      `supervisor tick ${iso()} alive:[${alivePorts.join(",")}] restarted:[${restartedPorts.join(",")}]`
    );
  } catch {}
}

// --- startup ---
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(INBOX, { recursive: true });
appendSupervisorLog({ ts: iso(), event: "supervisor_started", pid: process.pid });

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    appendSupervisorLog({ ts: iso(), event: "supervisor_stopped" });
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", () => {});

process.on("uncaughtException", (e) => {
  if (e && (e.code === "EPIPE" || String(e).includes("EPIPE"))) return;
  appendSupervisorLog({ ts: iso(), event: "uncaught_exception", error: String(e) });
});
process.on("unhandledRejection", (e) => {
  appendSupervisorLog({
    ts: iso(),
    event: "unhandled_rejection",
    error: String(e && e.stack ? e.stack : e),
  });
});

// First tick immediately, then every POLL_MS. A tick that is still running when
// the interval fires is skipped (never two overlapping ticks).
let ticking = false;
async function guardedTick() {
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } finally {
    ticking = false;
  }
}

await guardedTick();
setInterval(() => {
  guardedTick().catch((e) => {
    appendSupervisorLog({ ts: iso(), event: "tick_error", error: String(e) });
  });
}, POLL_MS);
