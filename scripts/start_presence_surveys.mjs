#!/usr/bin/env node
// scripts/start_presence_surveys.mjs — Launch autonomous survey monitor on presence departure.
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const MONITOR_SCRIPT = path.join(ROOT, "scripts", "monitor_3h.mjs");
const LOG_FILE = path.join(LOGS_DIR, "monitor_3h.log");

// 1. Check if already running
let existingPid = null;
try {
  const p = execSync("pgrep -f '[m]onitor_3h\\.mjs' || true", { encoding: "utf-8" }).trim();
  if (p) {
    const pids = p.split("\n").map(x => x.trim()).filter(Boolean);
    if (pids.length > 0) existingPid = pids[0];
  }
} catch {}

if (existingPid) {
  console.log(`[presence_start] Survey monitor is already running (PID ${existingPid}). No-op.`);
  process.exit(0);
}

// 2. Ensure docker containers for 3013 and 3014 are running
for (const container of ["SurveyCompleter-gmail-03", "SurveyCompleter-gmail-04"]) {
  try {
    const running = execSync(`docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
    if (running !== "true") {
      console.log(`[presence_start] Starting container ${container}...`);
      execSync(`docker start ${container}`, { timeout: 15000, stdio: "ignore" });
    }
  } catch (e) {
    console.warn(`[presence_start] Warning checking ${container}: ${e.message}`);
  }
}

// 3. Ensure bsk_relay is running
try {
  const p = execSync("pgrep -f '[b]sk_relay\\.mjs' || true", { encoding: "utf-8" }).trim();
  if (!p) {
    const relayScript = path.join(ROOT, "scripts", "bsk_relay.mjs");
    if (fs.existsSync(relayScript)) {
      const child = spawn("node", [relayScript], { detached: true, stdio: "ignore" });
      child.unref();
    }
  }
} catch {}

// 4. Spawn monitor_3h.mjs detached in background
const out = fs.openSync(LOG_FILE, "a");
const child = spawn("node", [MONITOR_SCRIPT], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", out, out],
  env: {
    ...process.env,
    MONITOR_DURATION_MS: String(24 * 60 * 60 * 1000), // 24 hours
  },
});
fs.closeSync(out);
child.unref();

console.log(`✅ [presence_start] Successfully launched autonomous survey monitor (PID ${child.pid}).`);
process.exit(0);
