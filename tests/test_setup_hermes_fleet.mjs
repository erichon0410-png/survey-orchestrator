import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// 1. Run setup in verify-only mode
const res = spawnSync("node", ["scripts/setup_hermes_fleet.mjs", "--verify-only"], { encoding: "utf8" });
assert.equal(res.status, 0, `Verify failed with code ${res.status}: ${res.stderr || res.stdout}`);
assert.ok(res.stdout.includes("Hermes CLI: available"), "Should verify Hermes CLI is available");
assert.ok(res.stdout.includes("Discord channels"), "Should check Discord channels");

// 2. Verify package.json exists and includes script "setup:hermes"
assert.ok(fs.existsSync("package.json"), "package.json must exist");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(pkg.scripts, "package.json must have scripts field");
assert.equal(
  pkg.scripts["setup:hermes"],
  "node scripts/setup_hermes_fleet.mjs",
  "package.json scripts must include 'setup:hermes': 'node scripts/setup_hermes_fleet.mjs'"
);
assert.equal(
  pkg.scripts["report:hermes"],
  "node scripts/hermes_fleet_reporter.mjs --once",
  "package.json scripts must include 'report:hermes': 'node scripts/hermes_fleet_reporter.mjs --once'"
);

console.log("PASS setup_hermes_fleet.mjs validation checks");
