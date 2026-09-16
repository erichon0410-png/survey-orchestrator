#!/usr/bin/env node
// skills/survey-fleet-agent/scripts/agent_control.mjs — Control bridge for Hermes survey fleet agents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const LOGS_DIR = path.join(ROOT, "logs");
const CDP_CONTROL = path.join(ROOT, "scripts", "cdp_control.mjs");

const PLATFORMS = {
  3013: "OpinionOutpost",
  3014: "Swagbucks",
  3015: "Eureka",
  3016: "SurveyJunkie",
  3017: "Swagbucks 2",
};

const [cmd, portArg] = process.argv.slice(2);
const port = Number(portArg);

if (!cmd || !Number.isFinite(port) || port <= 0) {
  console.error("usage: agent_control.mjs <status|screenshot|balance|nudge> <port>");
  process.exit(2);
}

const platform = PLATFORMS[port] || `Port ${port}`;

function readLastStatus(port) {
  const statusFile = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
  let lastEvent = "unknown";
  let totalUsd = 0;
  let totalRaw = 0;
  let lastTs = null;

  if (fs.existsSync(statusFile)) {
    const lines = fs.readFileSync(statusFile, "utf8").trim().split("\n");
    let foundEvent = false;
    let foundTotals = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!foundEvent) {
          lastEvent = parsed.event || "unknown";
          lastTs = parsed.ts;
          foundEvent = true;
        }
        if (!foundTotals && (parsed.total_usd !== undefined || parsed.totalRaw !== undefined)) {
          totalUsd = parsed.total_usd ?? parsed.totalUsd ?? 0;
          totalRaw = parsed.total_raw ?? parsed.totalRaw ?? 0;
          foundTotals = true;
        }
        if (foundEvent && foundTotals) break;
      } catch {}
    }
  }
  return { lastEvent, totalUsd, totalRaw, lastTs };
}

async function getPageInfo(port) {
  let pageTitle = "Unknown";
  let pageUrl = "Unknown";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const targets = await res.json();
      if (Array.isArray(targets)) {
        const page = targets.find((t) => t.type === "page") || targets[0];
        if (page) {
          pageTitle = page.title || "Unknown";
          pageUrl = page.url || "Unknown";
          return { pageTitle, pageUrl };
        }
      }
    }
  } catch {}

  try {
    const res = spawnSync("node", [CDP_CONTROL, "targets", String(port)], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (res.status === 0) {
      const targets = JSON.parse(res.stdout.trim());
      if (Array.isArray(targets) && targets.length > 0) {
        pageTitle = targets[0].title || "Unknown";
        pageUrl = targets[0].url || "Unknown";
      }
    }
  } catch {}

  return { pageTitle, pageUrl };
}

if (cmd === "status") {
  const { lastEvent, totalUsd, totalRaw } = readLastStatus(port);
  const { pageTitle, pageUrl } = await getPageInfo(port);

  console.log(
    JSON.stringify({
      ok: true,
      port,
      platform,
      pageTitle,
      pageUrl,
      lastEvent,
      totalUsd,
      totalRaw,
      ts: new Date().toISOString(),
    })
  );
  process.exit(0);
}

if (cmd === "screenshot") {
  const outPath = path.join(os.tmpdir(), `hermes_shot_${port}_${Date.now()}.png`);
  const res = spawnSync(
    "node",
    [CDP_CONTROL, "screenshot", String(port), "-o", outPath],
    { encoding: "utf8", timeout: 20000 }
  );
  if (res.status === 0) {
    console.log(JSON.stringify({ ok: true, port, platform, imagePath: outPath }));
    process.exit(0);
  } else {
    console.error(
      JSON.stringify({
        ok: false,
        port,
        platform,
        error: res.stderr || res.stdout || "screenshot failed",
      })
    );
    process.exit(1);
  }
}

if (cmd === "balance") {
  const { totalUsd, totalRaw } = readLastStatus(port);
  console.log(
    JSON.stringify({
      ok: true,
      port,
      platform,
      totalUsd,
      totalRaw,
    })
  );
  process.exit(0);
}

if (cmd === "nudge") {
  const nudgeEntry = {
    ts: new Date().toISOString(),
    port,
    event: "nudge",
    note: `Nudge issued to container port ${port} via Hermes agent_control`,
  };
  try {
    const statusFile = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
    if (fs.existsSync(LOGS_DIR)) {
      fs.appendFileSync(statusFile, JSON.stringify(nudgeEntry) + "\n", "utf8");
    }
  } catch {}

  console.log(
    JSON.stringify({
      ok: true,
      port,
      action: "nudged",
      message: `Nudge issued to container port ${port}`,
    })
  );
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
