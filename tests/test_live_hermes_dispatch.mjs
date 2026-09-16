import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

// 1. Verify Hermes skill symlink exists in ~/.hermes/skills
const skillPath = path.join(os.homedir(), ".hermes", "skills", "survey-fleet-agent");
assert.ok(fs.existsSync(skillPath), `Hermes skill should be installed at ${skillPath}`);

// 2. Verify cron schedule
const cronList = execSync("hermes cron list", { encoding: "utf8" });
assert.ok(cronList.includes("survey-fleet-5m-reporter"), "survey-fleet-5m-reporter should be in hermes cron list");

// 3. Verify reporter dry run
const reporterRes = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run"], { encoding: "utf8" });
assert.equal(reporterRes.status, 0, `Dry run reporter failed: ${reporterRes.stderr}`);
assert.ok(reporterRes.stdout.includes("DRY-RUN: discord:#survey-reports"), "Dry run should report to #survey-reports");
assert.ok(reporterRes.stdout.includes("Survey Fleet Summary"), "Dry run output should include summary header");

console.log("PASS test_live_hermes_dispatch");
