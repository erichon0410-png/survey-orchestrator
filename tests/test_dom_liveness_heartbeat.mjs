import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TURNS_TIMEOUT_MS, createDomLivenessHeartbeat } from "../scripts/survey_driver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("Testing DOM Liveness Heartbeat & TURNS_TIMEOUT_MS...");

// [Test 1] TURNS_TIMEOUT_MS defaults to 15m and is configurable via SURVEY_TURN_TIMEOUT_MS
console.log("[Test 1] Verifying TURNS_TIMEOUT_MS default and environment override...");
assert.equal(
  TURNS_TIMEOUT_MS,
  15 * 60 * 1000,
  "TURNS_TIMEOUT_MS must default to 15 minutes (900000 ms)"
);

const customTimeout = execSync(
  'node --input-type=module -e \'process.env.SURVEY_TURN_TIMEOUT_MS="450000"; import("./scripts/survey_driver.mjs").then(m => console.log(m.TURNS_TIMEOUT_MS))\'',
  { cwd: ROOT }
).toString().trim();
assert.equal(
  customTimeout,
  "450000",
  "TURNS_TIMEOUT_MS must be configurable via process.env.SURVEY_TURN_TIMEOUT_MS"
);
console.log("  ✓ TURNS_TIMEOUT_MS defaults to 15m and respects SURVEY_TURN_TIMEOUT_MS");

// [Test 2] Heartbeat detects unchanged page URL + title > maxStallMs and invokes onStall
console.log("[Test 2] Verifying stall detection when URL & title are unchanged...");
const stalls = [];
const staticPages = [
  { id: "tab-1", type: "page", url: "https://survey.example.com/screener", title: "Screener Question 1" },
];

const hbStall = createDomLivenessHeartbeat({
  port: 3013,
  maxStallMs: 50,
  pollIntervalMs: 15,
  fetchJson: async () => staticPages,
  onStall: async (telemetry) => {
    stalls.push(telemetry);
  },
});

await new Promise((r) => setTimeout(r, 120));
hbStall.stop();

assert.ok(stalls.length >= 1, "onStall must be invoked when page state remains identical for > maxStallMs");
assert.equal(stalls[0].port, 3013, "Telemetry must include port");
assert.equal(stalls[0].url, "https://survey.example.com/screener", "Telemetry must include page url");
assert.equal(stalls[0].title, "Screener Question 1", "Telemetry must include page title");
assert.ok(stalls[0].stalledMs >= 50, `stalledMs (${stalls[0].stalledMs}) must be >= maxStallMs (50)`);
console.log("  ✓ DOM stall detected and telemetry reported correctly");

// [Test 3] URL or page title change within maxStallMs resets timer, onStall is NOT called
console.log("[Test 3] Verifying stall timer resets when URL or title changes...");
const resetStalls = [];
let dynamicPages = [
  { id: "tab-1", type: "page", url: "https://survey.example.com/q1", title: "Question 1" },
];

const hbReset = createDomLivenessHeartbeat({
  port: 3014,
  maxStallMs: 80,
  pollIntervalMs: 15,
  fetchJson: async () => dynamicPages,
  onStall: async (telemetry) => {
    resetStalls.push(telemetry);
  },
});

// Change page URL before maxStallMs expires
await new Promise((r) => setTimeout(r, 35));
dynamicPages = [
  { id: "tab-1", type: "page", url: "https://survey.example.com/q2", title: "Question 2" },
];

// Change page title before maxStallMs expires
await new Promise((r) => setTimeout(r, 35));
dynamicPages = [
  { id: "tab-1", type: "page", url: "https://survey.example.com/q2", title: "Question 2 - Selected Option" },
];

// Wait another interval < maxStallMs
await new Promise((r) => setTimeout(r, 35));
hbReset.stop();

assert.equal(
  resetStalls.length,
  0,
  "onStall must NOT be called when url or title changes within maxStallMs"
);
console.log("  ✓ Timer resets properly on DOM state transitions");

// [Test 4] .stop() clears timers and halts polling
console.log("[Test 4] Verifying .stop() halts polling and clears timers...");
let pollCount = 0;
const hbStop = createDomLivenessHeartbeat({
  port: 3013,
  maxStallMs: 40,
  pollIntervalMs: 15,
  fetchJson: async () => {
    pollCount++;
    return [{ id: "tab-1", type: "page", url: "https://example.com", title: "Title" }];
  },
  onStall: () => {},
});

await new Promise((r) => setTimeout(r, 50));
const countAtStop = pollCount;
assert.ok(countAtStop >= 1, "Should have polled at least once before stopping");
hbStop.stop();

await new Promise((r) => setTimeout(r, 60));
assert.equal(pollCount, countAtStop, "Polling must halt completely after stop()");
console.log("  ✓ .stop() cleanly stops timers and halts polling");

console.log("PASS: test_dom_liveness_heartbeat");
