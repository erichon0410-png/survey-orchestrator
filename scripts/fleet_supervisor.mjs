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
// reports/inbox/<PORT>_restart_cap_<ts>.json file is written. After the cooldown,
// the hold clears and deployment resumes automatically.
//
// Logs: logs/supervisor.log (append-only JSON lines).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { FLEET, deployAgent } from "/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js";
import { syncEarnings } from "./earnings_sync.mjs";

const ROOT = "/home/erich/workspace/survey-orchestrator";
const LOGS_DIR = path.join(ROOT, "logs");
const INBOX = path.join(ROOT, "reports", "inbox");
const PROCESSED = path.join(ROOT, "reports", "processed");
const SUPERVISOR_LOG = path.join(LOGS_DIR, "supervisor.log");

const POLL_MS = 30_000;
const WINDOW_MS = 60 * 60 * 1000; // rolling 60-minute window
const MAX_RESTARTS_PER_WINDOW = 4; // 5th needed restart within the window -> cap
const COOLDOWN_MS = Number(process.env.SUPERVISOR_COOLDOWN_MS) || 5 * 60 * 1000; // bounded cooldown before re-attempting a paused port (default 5 min)
const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily schedule (24h)

// --- state (in-memory, this process's life) ---
let lastEarningsSyncTs = 0; // 0 ensures first tick triggers initial sync
const restarts = new Map(); // port -> [timestamp ms, ...]
const pausedPorts = new Map(); // port -> { pausedAt: number, resumeAt: number, status: "repair_pending" }
const targetPorts = new Set(); // target-reached marker found: never restart again
const loggedTargetPorts = new Set(); // ports already announced as skipped (log once)

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
    const fname = `${port}_restart_cap_${stamp()}.json`;
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

// --- one tick: check every FLEET port in ascending order ---
async function tick() {
  const alivePorts = [];
  const restartedPorts = [];
  try {
    // --- Daily earnings sync & graph refresh ---
    const now = Date.now();
    if (now - lastEarningsSyncTs >= DAILY_SYNC_INTERVAL_MS) {
      lastEarningsSyncTs = now;
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

      // (b) alive? do nothing for this port.
      if (isPortAlive(port, psLines)) {
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
        // Cooldown elapsed: clear pause and allow 1 resume deployment attempt,
        // while preserving recent crash history so repeated failures pause again.
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
  console.log(
    `supervisor tick ${iso()} alive:[${alivePorts.join(",")}] restarted:[${restartedPorts.join(",")}]`
  );
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

process.on("uncaughtException", (e) => {
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
