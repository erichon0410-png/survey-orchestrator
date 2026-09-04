#!/usr/bin/env node
// fleet_watcher.mjs — survey-fleet event watcher (Node 18+, stdlib only, ESM).
//
// Watches reports/inbox/ for terminal event files written by the codex agents
// and watches the startup snapshot of running "codex exec" PIDs for clean exits.
//
// Exit conditions (first one to fire wins):
//   (a) a new file appears in reports/inbox/ -> move ALL new inbox files to
//       reports/processed/<YYYYmmdd_HHMMSS>/ preserving names, print "EVENTS:"
//       then each moved file's full JSON content (pretty-printed), exit 0.
//   (b) a snapshot PID is no longer running AND its port has no target_reached
//       file in inbox/processed -> print {"type":"agent_exited",...} exit 0.
// Heartbeat to stderr every 5 minutes: "watcher alive, <n> agents".

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = path.join(ROOT, "reports", "inbox");
const PROCESSED = path.join(ROOT, "reports", "processed");
const POLL_MS = 30_000;
const HEARTBEAT_MS = 5 * 60 * 1000;

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

// --- agent process snapshot (same heuristic as getRunningAgents in orchestrator.js) ---
function listCodexAgents() {
  let out = "";
  try {
    out = execSync(`ps -eo pid,args | grep -E "codex exec" | grep -v grep`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return [];
  }
  if (!out) return [];
  const agents = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    const cmd = parts.slice(1).join(" ");
    const m = cmd.match(/bound port (\d+)|agent_(\d+)\.log/);
    if (!m || !Number.isFinite(pid)) continue;
    agents.push({ pid, port: parseInt(m[1] || m[2], 10) });
  }
  return agents;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours to signal
  }
}

// --- startup state ---
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(PROCESSED, { recursive: true });

const snapshot = listCodexAgents();
// Baseline of files already in the inbox at start (recorded per spec). Files are
// still delivered once each: anything still sitting in the inbox at a poll tick is
// an unprocessed event and gets moved on that tick.
const seenAtStartup = new Set(
  fs.readdirSync(INBOX).filter((f) => fs.statSync(path.join(INBOX, f)).isFile())
);
const handled = new Set(); // filenames this run already moved successfully

let lastHeartbeat = Date.now();
function heartbeat() {
  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    const alive = snapshot.filter((a) => pidAlive(a.pid)).length;
    process.stderr.write(`watcher alive, ${alive} agents\n`);
  }
}

function hasTerminalReport(port) {
  const re = new RegExp(`^${port}_target_reached_.*\\.json$`);
  for (const dir of [INBOX, PROCESSED]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (re.test(e)) return true; // inbox file, or processed/<ts>/ subdir holding it
      const p = path.join(dir, e);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      if (fs.readdirSync(p).some((f) => re.test(f))) return true;
    }
  }
  return false;
}

function tick() {
  heartbeat();

  // (a) new files in inbox?
  let inboxFiles = [];
  try {
    inboxFiles = fs
      .readdirSync(INBOX)
      .filter((f) => fs.statSync(path.join(INBOX, f)).isFile())
      .sort();
  } catch {
    return; // EEXIST/IO race: retry next tick
  }
  const toMove = inboxFiles.filter((f) => !handled.has(f));

  if (toMove.length > 0) {
    const destDir = path.join(PROCESSED, stamp());
    const moved = [];
    for (const f of toMove) {
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(path.join(INBOX, f), path.join(destDir, f));
        handled.add(f);
        moved.push(f);
      } catch {
        // EEXIST/ENOENT race: leave it in inbox, retry next tick.
      }
    }
    if (moved.length === toMove.length) {
      console.log("EVENTS:");
      for (const f of moved) {
        const raw = fs.readFileSync(path.join(destDir, f), "utf-8");
        try {
          console.log(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          console.log(raw);
        }
      }
      process.exit(0);
    }
    return; // partial move: retry the rest next tick
  }

  // (b) snapshot PID gone without a terminal report?
  for (const a of snapshot) {
    if (!pidAlive(a.pid) && !hasTerminalReport(a.port)) {
      console.log(JSON.stringify({ type: "agent_exited", port: a.port, hadTerminalReport: false }));
      process.exit(0);
    }
  }
}

setInterval(tick, POLL_MS);
tick();
