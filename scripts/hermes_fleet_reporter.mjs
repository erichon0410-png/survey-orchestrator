#!/usr/bin/env node
// scripts/hermes_fleet_reporter.mjs — 5-minute Hermes live updater for the survey fleet.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateFleetDigests, PORT_TO_CHANNEL } from "./hermes_digest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");

// Parse args
const argv = process.argv.slice(2);
const once = argv.includes("--once");
const daemon = argv.includes("--daemon");
const dryRun = argv.includes("--dry-run");

const portFilter = (() => {
  const i = argv.indexOf("--port");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null;
})();

const intervalSec = (() => {
  const i = argv.indexOf("--interval");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 300;
})();

const journalArg = (() => {
  const i = argv.indexOf("--journal");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

const JOURNAL_PATH = journalArg || process.env.FLEET_EVENTS_PATH || path.join(LOGS_DIR, "fleet_events.jsonl");

export function readRecentEvents(windowMinutes = 5) {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const content = fs.readFileSync(JOURNAL_PATH, "utf8").trim();
  if (!content) return [];
  const lines = content.split("\n");
  const events = [];

  // Read lines from bottom up for efficiency
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const ev = JSON.parse(l);
      const evTime = new Date(ev.ts).getTime();
      // Allow a 60s buffer for slight out-of-order clock skews before breaking early
      if (!isNaN(evTime) && evTime < cutoff - 60000) break;
      if (!isNaN(evTime) && evTime >= cutoff) {
        events.unshift(ev);
      }
    } catch {}
  }
  return events;
}

export function sendToHermes(target, markdown) {
  if (dryRun) {
    console.log(`\n=== DRY-RUN: ${target} ===\n${markdown}\n`);
    return;
  }
  const tmpFile = path.join(os.tmpdir(), `hermes_msg_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  try {
    fs.writeFileSync(tmpFile, markdown, "utf8");
    execSync(`hermes send --to "${target}" --file "${tmpFile}"`, { stdio: "ignore" });
  } catch (e) {
    console.error(`Failed to send to ${target}: ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

export async function runReporterCycle() {
  const windowMinutes = Math.max(1, Math.round(intervalSec / 60));
  const events = readRecentEvents(windowMinutes);
  const digest = generateFleetDigests(events, { windowMinutes });

  // 1. Send per-port updates
  for (const [port, data] of digest.perPort.entries()) {
    if (portFilter && port !== portFilter) continue;
    if (data.hasActivity || (portFilter && port === portFilter)) {
      sendToHermes(data.channel, data.markdown);
    }
  }

  // 2. Send executive rollup
  if (!portFilter) {
    sendToHermes(digest.rollup.channel, digest.rollup.markdown);
  }
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  import.meta.url === `file://${process.argv[1]}`
);

if (isMain) {
  if (once) {
    await runReporterCycle();
  } else {
    console.log(`[hermes-reporter] Started daemon mode (interval: ${intervalSec}s, dry-run: ${dryRun})`);
    await runReporterCycle();
    setInterval(runReporterCycle, intervalSec * 1000);
  }
}
