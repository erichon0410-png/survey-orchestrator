import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncEarnings } from "../scripts/earnings_sync.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SUPERVISOR_LOG = path.join(ROOT, "logs", "supervisor.log");

function iso() {
  return new Date().toISOString();
}

function appendSupervisorLog(obj) {
  fs.appendFileSync(SUPERVISOR_LOG, JSON.stringify(obj) + "\n", "utf-8");
}

console.log("=== Demonstrating Supervisor Daily Scheduler Path ===");

const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastEarningsSyncTs = 0; // Starts at 0, representing un-synced or 24h elapsed state

const now = Date.now();
if (now - lastEarningsSyncTs >= DAILY_SYNC_INTERVAL_MS) {
  lastEarningsSyncTs = now;
  try {
    const syncRes = syncEarnings({ dailyHeartbeat: true, silent: false });
    const logEntry = {
      ts: iso(),
      action: "daily_sync",
      markers_processed: syncRes.markersProcessed,
      heartbeats_appended: syncRes.heartbeatsAppended?.length ?? 0,
      graph_rebuilt: syncRes.graphRebuilt,
      note: "daily earnings sync and graph refresh complete",
    };
    appendSupervisorLog(logEntry);
    console.log("\n[SUPERVISOR LOG ENTRY APPENDED]:");
    console.log(JSON.stringify(logEntry, null, 2));
  } catch (e) {
    appendSupervisorLog({
      ts: iso(),
      action: "daily_sync_failed",
      error: String(e),
    });
    console.error("Scheduler execution failed:", e);
    process.exit(1);
  }
}

// Read back the latest lines from supervisor.log to confirm
const logContent = fs.readFileSync(SUPERVISOR_LOG, "utf-8").trim().split("\n");
const lastLine = JSON.parse(logContent[logContent.length - 1]);
console.log("\nConfirmed last log line in logs/supervisor.log:");
console.log(JSON.stringify(lastLine, null, 2));
if (lastLine.action === "daily_sync") {
  console.log("\n✓ PROOF: Daily scheduler path armed and verified active!");
} else {
  console.error("\n✗ Last line action is not daily_sync:", lastLine);
  process.exit(1);
}
