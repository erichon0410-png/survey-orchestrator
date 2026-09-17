import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HARNESS } from "../scripts/survey_driver.mjs";

console.log("Testing survey_driver DSH integration...");

// 1. Check HARNESS export and default
assert.equal(typeof HARNESS, "string", "HARNESS must be exported as string");
assert.equal(HARNESS, "dsh", "HARNESS must default to 'dsh'");

// 2. Check driver code structure
const driverSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "survey_driver.mjs"), "utf-8");
assert.ok(driverSrc.includes('HARNESS === "dsh"'), "Driver must have HARNESS === 'dsh' branch");
assert.ok(driverSrc.includes('spawn("dsh"'), "Driver must spawn 'dsh' in dsh branch");
assert.ok(driverSrc.includes('SPARK_API_KEY: "spark-local"'), "Driver must pass SPARK_API_KEY to dsh");
assert.ok(driverSrc.includes('DSH_PERMISSION_MODE: "danger-full-access"'), "Driver must pass danger-full-access to dsh");
assert.ok(driverSrc.includes('survey_agent.patch.yml'), "Driver must reference survey_agent.patch.yml");

// 3. Verify patch file exists and contains respondent profile
const patchSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "survey_agent.patch.yml"), "utf-8");
assert.ok(patchSrc.includes("Mei Lin Chen"), "Patch must contain respondent persona Mei Lin Chen");
assert.ok(patchSrc.includes("Columbus, Ohio"), "Patch must contain Columbus, Ohio location");
assert.ok(patchSrc.includes("survey-cdp"), "Patch must reference survey-cdp tool/skill");

console.log("PASS test_survey_driver_dsh");
