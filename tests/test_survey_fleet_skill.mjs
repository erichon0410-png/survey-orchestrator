import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// 1. Verify SKILL.md exists and contains required specifications
const skillPath = "skills/survey-fleet-agent/SKILL.md";
assert.ok(fs.existsSync(skillPath), "SKILL.md must exist at skills/survey-fleet-agent/SKILL.md");
const skillText = fs.readFileSync(skillPath, "utf8");

// YAML frontmatter check
assert.match(skillText, /^---\s*[\r\n]+[\s\S]*?name:\s*survey-fleet-agent[\s\S]*?---/, "Must have valid YAML frontmatter with name: survey-fleet-agent");

// Discord channels: #agent-3013 through #agent-3017 and #survey-reports
for (let port = 3013; port <= 3017; port++) {
  assert.ok(skillText.includes(`#agent-${port}`), `SKILL.md must reference #agent-${port}`);
}
assert.ok(skillText.includes("#survey-reports"), "SKILL.md must reference #survey-reports");

// Platform mappings
assert.ok(skillText.includes("3013") && skillText.includes("OpinionOutpost"), "Must map 3013 to OpinionOutpost");
assert.ok(skillText.includes("3014") && skillText.includes("Swagbucks"), "Must map 3014 to Swagbucks");
assert.ok(skillText.includes("3015") && skillText.includes("Eureka"), "Must map 3015 to Eureka");
assert.ok(skillText.includes("3016") && skillText.includes("SurveyJunkie"), "Must map 3016 to SurveyJunkie");
assert.ok(skillText.includes("3017") && (skillText.includes("Swagbucks 2") || skillText.includes("Swagbucks (2)")), "Must map 3017 to Swagbucks 2");

// 2. Verify agent_control.mjs CLI behavior via child_process
const scriptPath = "skills/survey-fleet-agent/scripts/agent_control.mjs";

// Missing args should exit 2
const noArgs = spawnSync("node", [scriptPath], { encoding: "utf8" });
assert.equal(noArgs.status, 2, `Expected exit 2 on missing args, got ${noArgs.status}`);

const missingPort = spawnSync("node", [scriptPath, "status"], { encoding: "utf8" });
assert.equal(missingPort.status, 2, `Expected exit 2 on missing port, got ${missingPort.status}`);

// status 3013
const statusRun = spawnSync("node", [scriptPath, "status", "3013"], { encoding: "utf8" });
assert.equal(statusRun.status, 0, `agent_control status failed: ${statusRun.stderr}`);
const statusJson = JSON.parse(statusRun.stdout.trim());
assert.equal(statusJson.ok, true);
assert.equal(statusJson.port, 3013);
assert.equal(statusJson.platform, "OpinionOutpost");
assert.ok("pageTitle" in statusJson, "Status must include pageTitle");
assert.ok("pageUrl" in statusJson, "Status must include pageUrl");
assert.ok("lastEvent" in statusJson, "Status must include lastEvent");
assert.ok("totalUsd" in statusJson, "Status must include totalUsd");
assert.ok("totalRaw" in statusJson, "Status must include totalRaw");
assert.ok("ts" in statusJson, "Status must include ts");

// nudge 3013
const nudgeRun = spawnSync("node", [scriptPath, "nudge", "3013"], { encoding: "utf8" });
assert.equal(nudgeRun.status, 0, `agent_control nudge failed: ${nudgeRun.stderr}`);
const nudgeJson = JSON.parse(nudgeRun.stdout.trim());
assert.equal(nudgeJson.ok, true);
assert.equal(nudgeJson.port, 3013);
assert.equal(nudgeJson.action, "nudged");

// balance 3013
const balanceRun = spawnSync("node", [scriptPath, "balance", "3013"], { encoding: "utf8" });
assert.equal(balanceRun.status, 0, `agent_control balance failed: ${balanceRun.stderr}`);
const balanceJson = JSON.parse(balanceRun.stdout.trim());
assert.equal(balanceJson.ok, true);
assert.equal(balanceJson.port, 3013);
assert.equal(balanceJson.platform, "OpinionOutpost");
assert.ok("totalUsd" in balanceJson, "Balance must include totalUsd");
assert.ok("totalRaw" in balanceJson, "Balance must include totalRaw");

console.log("PASS test_survey_fleet_skill");
