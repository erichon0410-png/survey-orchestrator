#!/usr/bin/env node
// scripts/setup_hermes_fleet.mjs — Turnkey setup for Hermes fleet integration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SKILL_SOURCE = path.join(ROOT, "skills", "survey-fleet-agent");
const HERMES_SKILLS = path.join(os.homedir(), ".hermes", "skills");
const TARGET_SKILL = path.join(HERMES_SKILLS, "survey-fleet-agent");

const verifyOnly = process.argv.includes("--verify-only");

console.log("=== Hermes Survey Fleet Integration Setup ===");

// 1. Check Hermes CLI
try {
  execSync("hermes --version", { stdio: "ignore" });
  console.log("✓ Hermes CLI: available");
} catch {
  console.error("✗ Hermes CLI not found in PATH. Please install or activate hermes.");
  process.exit(1);
}

// 2. Check Discord channels
let channelList = "";
try {
  channelList = execSync("hermes send --list discord", { encoding: "utf8" });
  const required = ["agent-3013", "agent-3014", "agent-3015", "agent-3016", "agent-3017", "survey-reports"];
  const hasAgents = required.every((ch) => channelList.includes(ch) || channelList.includes(`#${ch}`));
  if (hasAgents) {
    console.log("✓ Discord channels: all 5 agent channels + #survey-reports registered");
  } else {
    console.log("! Discord channels: some channels not yet registered in gateway");
  }
} catch (e) {
  console.log("! Discord channels: gateway check skipped");
}

if (verifyOnly) {
  console.log("Verification complete.");
  process.exit(0);
}

// 3. Install skill into ~/.hermes/skills/
fs.mkdirSync(HERMES_SKILLS, { recursive: true });
try {
  try {
    const stat = fs.lstatSync(TARGET_SKILL);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(TARGET_SKILL);
    } else {
      fs.rmSync(TARGET_SKILL, { recursive: true, force: true });
    }
  } catch {
    // Target does not exist
  }
  fs.symlinkSync(SKILL_SOURCE, TARGET_SKILL);
  console.log(`✓ Installed Hermes skill: ${TARGET_SKILL} -> ${SKILL_SOURCE}`);
} catch (e) {
  console.log(`! Skill link warning: ${e.message}`);
}

// 4. Register 5-minute cron job in Hermes
try {
  const cronList = execSync("hermes cron list", { encoding: "utf8" });
  if (cronList.includes("survey-fleet-5m-reporter")) {
    console.log("✓ Hermes cron job: survey-fleet-5m-reporter already scheduled");
  } else {
    try {
      execSync(
        `hermes cron create --name "survey-fleet-5m-reporter" "*/5 * * * *" --script "scripts/hermes_fleet_reporter.mjs" --no-agent --workdir "${ROOT}"`,
        { cwd: ROOT, stdio: "ignore" }
      );
    } catch {
      execSync(
        `hermes cron create --name "survey-fleet-5m-reporter" --cron "*/5 * * * *" --script "scripts/hermes_fleet_reporter.mjs" --no-agent`,
        { cwd: ROOT, stdio: "ignore" }
      );
    }
    console.log("✓ Hermes cron job: registered survey-fleet-5m-reporter (every 5 minutes)");
  }
} catch (e) {
  console.log(`! Hermes cron registration: ${e.message}`);
}

console.log("\nSetup complete! The survey fleet is connected to Hermes and Discord.");
