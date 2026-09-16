import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// 1. Verify that usage output includes 'click'
const usageRun = spawnSync("node", ["scripts/cdp_control.mjs"], { encoding: "utf8" });
assert.equal(usageRun.status, 2);
assert.ok(usageRun.stderr.includes("click"), `Usage message should mention 'click', got: ${usageRun.stderr}`);

// 2. Verify argument validation for click without selector or coords
const clickNoTarget = spawnSync("node", ["scripts/cdp_control.mjs", "click", "3013"], { encoding: "utf8" });
assert.equal(clickNoTarget.status, 2);
assert.ok(clickNoTarget.stderr.includes("missing --selector or --coords"), `Should require selector or coords, got: ${clickNoTarget.stderr}`);

console.log("PASS cdp_control.mjs usage and argument checks for click command");
