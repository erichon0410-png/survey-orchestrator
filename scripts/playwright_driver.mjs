#!/usr/bin/env node
// scripts/playwright_driver.mjs — Playwright-based survey driver for ONE port.
// Connects to the existing Chromium instance via CDP (port 9222) and controls it.

import { chromium } from 'playwright';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Exit code constants (match original driver)
const EXIT_OK = 0;
const EXIT_TECH_ISSUE = 3;
const EXIT_IDLE_NO_SURVEYS = 4;

// Parse arguments
function parseArgs(argv) {
  const out = { port: null, marker: "", promptFile: null, maxNudges: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--marker") out.marker = String(argv[++i] ?? "");
    else if (a === "--prompt-file") out.promptFile = String(argv[++i]);
    else if (a === "--max-nudges") out.maxNudges = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number.isFinite(args.port) ? args.port : null;
const MAX_NUDGES = Number.isFinite(args.maxNudges) && args.maxNudges > 0
  ? Math.floor(args.maxNudges)
  : (Number.isFinite(Number(process.env.SURVEY_MAX_NUDGES)) ? Number(process.env.SURVEY_MAX_NUDGES) : 3);

if (!PORT) {
  console.error("Usage: playwright_driver.mjs --port <port> [--marker <marker>]");
  process.exit(1);
}

// Platform URL mapping (from original driver)
const PORT_TO_PLATFORM = {
  3013: "opinionoutpost",
  3014: "swagbucks",
  3015: "eureka",
  3016: "surveyjunkie",
  3017: "swagbucks"
};

const PLATFORM_URLS = {
  opinionoutpost: "https://www.opinionoutpost.com",
  swagbucks: "https://www.swagbucks.com/surveys",
  surveyjunkie: "https://app.surveyjunkie.com/",
  primeopinion: "https://app.primeopinion.com/app-login",
  eureka: "https://eurekapoints.com/"
};

// Workspace paths
const WS = process.cwd();
const LOGS_DIR = path.join(WS, "logs");
const INBOX = path.join(WS, "reports", "inbox");
const PROCESSED = path.join(WS, "reports", "processed");
const STATUS_JSONL = path.join(LOGS_DIR, `agent_${PORT}_status.jsonl`);
const AGENT_LOG = path.join(LOGS_DIR, `driver_playwright_${PORT}.log`);

// Ensure directories exist
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(PROCESSED, { recursive: true });

let state = {
  turn: 0,
  nudgesUsed: 0,
  browser: null,
  page: null,
  child: null
};

function log(level, msg, detail) {
  const entry = { ts: new Date().toISOString(), level, port: PORT, msg, detail };
  console.log(JSON.stringify(entry));
}

async function finishClean(code) {
  if (state.browser) {
    try { await state.browser.close(); } catch (e) {}
  }
  process.exit(code);
}

// Target reached detection (same as original)
function targetReached() {
  const markerPath = path.join(INBOX, `${PORT}_target_reached.json`);
  return fs.existsSync(markerPath);
}

// Write idle today marker (same as original)
function writeIdleTodayMarker() {
  const today = new Date().toISOString().split('T')[0];
  const markerPath = path.join(INBOX, `${PORT}_idle_today_${today}.json`);
  fs.writeFileSync(markerPath, JSON.stringify({ port: PORT, ts: new Date().toISOString(), type: "idle_today" }));
}

// Write tech issue report (same as original)
function writeTechIssue(type, note) {
  const now = new Date();
  const filename = `${PORT}_tech_issue_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.json`;
  const reportPath = path.join(INBOX, filename);
  fs.writeFileSync(reportPath, JSON.stringify({ port: PORT, ts: now.toISOString(), type, note }));
}

// Main driver loop
async function runDriver() {
  log("info", "playwright_driver starting", { port: PORT });

  const platform = PORT_TO_PLATFORM[PORT];
  if (!platform) {
    log("error", `unknown platform for port ${PORT}`);
    process.exit(1);
  }

  const url = PLATFORM_URLS[platform];
  log("info", "navigating to platform", { platform, url });

  // Connect to existing Chromium via CDP (port 9222)
  try {
    // Use connectOverCDP for Chromium's remote debugging protocol
    state.browser = await chromium.connectOverCDP(`http://localhost:9222`);
    
    // Get the first available page or create a new one
    const context = state.browser.contexts()[0] || await state.browser.newContext();
    let pages = context.pages();
    if (pages.length > 0) {
      state.page = pages[0];
    } else {
      state.page = await context.newPage();
    }

    // Navigate to platform
    await state.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    log("info", "page loaded successfully");

    // Keep browser open and responsive
    // The supervisor will manage the lifecycle
    while (true) {
      if (targetReached()) {
        log("info", "target reached, exiting cleanly");
        finishClean(EXIT_OK);
      }
      
      // Check for idle condition periodically
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

  } catch (error) {
    log("error", "driver error", { err: String(error) });
    writeTechIssue("playwright_error", String(error));
    finishClean(EXIT_TECH_ISSUE);
  }
}

// Signal handling
process.on('SIGTERM', () => {
  log("info", "received SIGTERM, shutting down");
  finishClean(0);
});

process.on('SIGINT', () => {
  log("info", "received SIGINT, shutting down");
  finishClean(0);
});

runDriver().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(EXIT_TECH_ISSUE);
});