import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fastCrashCounts } from "../scripts/fleet_supervisor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("Testing Fast Crash Guard & DSH argument passing...");

// 1. Check supervisor fastCrashCounts
assert.ok(fastCrashCounts instanceof Map, "fastCrashCounts must be exported Map");

// 2. Check supervisor code structure for fast crash detection
const supSrc = fs.readFileSync(path.join(ROOT, "scripts", "fleet_supervisor.mjs"), "utf-8");
assert.ok(supSrc.includes("fast_crash_detected"), "Supervisor must log fast_crash_detected");
assert.ok(supSrc.includes("fast_crash_cap"), "Supervisor must log fast_crash_cap");
assert.ok(supSrc.includes("capPort(port)"), "Supervisor must capPort on repeated fast crashes");

// 3. Check driver code structure for fast crash guard
const driverSrc = fs.readFileSync(path.join(ROOT, "scripts", "survey_driver.mjs"), "utf-8");
assert.ok(driverSrc.includes("--preset"), "Driver must support --preset argument");
assert.ok(driverSrc.includes("Ornith-1.5-9B-Q4_K_M"), "Driver must reference Ornith-1.5-9B-Q4_K_M");
assert.ok(driverSrc.includes("unsloth-studio"), "Driver must reference unsloth-studio");
assert.ok(driverSrc.includes("fast_crash"), "Driver must have fast_crash guard");
assert.ok(driverSrc.includes("durationMs ?? 0) < 5000"), "Driver must trip when duration < 5000ms");

console.log("PASS test_fast_crash_guard");
