import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const ORCHESTRATOR_PATH = "/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js";
const DRIVER_PATH = path.join(ROOT, "scripts", "survey_driver.mjs");

console.log("=== Running Performance Optimizations Tests ===");

// ---------------------------------------------------------------------------
// 1. Thread ID extraction: Bounded log reading (survey_driver.mjs)
// ---------------------------------------------------------------------------
const { extractThreadId } = await import(DRIVER_PATH);
assert.equal(typeof extractThreadId, "function", "extractThreadId must be exported from survey_driver.mjs");

const tmpDir = path.join(__dirname, ".tmp_perf_test");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const largeLogHead = path.join(tmpDir, "large_log_head.log");
const largeLogTail = path.join(tmpDir, "large_log_tail.log");
const emptyLog = path.join(tmpDir, "empty.log");
const nonexistentLog = path.join(tmpDir, "nonexistent.log");

try {
  // 1a. Generate synthetic 100KB+ file with thread_id at the head
  const headLine = JSON.stringify({ type: "thread.started", thread_id: "th_perf_bound_test_12345" }) + "\n";
  const fillerLine = JSON.stringify({ type: "event.filler", payload: "A".repeat(200) }) + "\n";
  const targetBytes = 100 * 1024; // 100KB
  let currentBytes = Buffer.byteLength(headLine, "utf-8");

  const fdHead = fs.openSync(largeLogHead, "w");
  fs.writeSync(fdHead, headLine);
  while (currentBytes < targetBytes) {
    fs.writeSync(fdHead, fillerLine);
    currentBytes += Buffer.byteLength(fillerLine, "utf-8");
  }
  fs.closeSync(fdHead);

  const headStats = fs.statSync(largeLogHead);
  assert.ok(headStats.size >= 100 * 1024, `Test file should be at least 100KB, got ${headStats.size} bytes`);

  const extractedHeadId = extractThreadId(largeLogHead);
  assert.equal(
    extractedHeadId,
    "th_perf_bound_test_12345",
    "extractThreadId must find thread_id when present in the first 8KB of a 100KB file"
  );
  console.log("✓ extractThreadId extracts thread_id from head of 100KB synthetic log");

  // 1b. Generate synthetic 100KB+ file where thread_id is placed BEYOND the 8192 byte window
  const fdTail = fs.openSync(largeLogTail, "w");
  let tailBytes = 0;
  // Write 10KB of filler before the thread_id
  while (tailBytes < 10 * 1024) {
    fs.writeSync(fdTail, fillerLine);
    tailBytes += Buffer.byteLength(fillerLine, "utf-8");
  }
  const lateLine = JSON.stringify({ type: "thread.started", thread_id: "th_late_should_not_be_found" }) + "\n";
  fs.writeSync(fdTail, lateLine);
  tailBytes += Buffer.byteLength(lateLine, "utf-8");
  while (tailBytes < targetBytes) {
    fs.writeSync(fdTail, fillerLine);
    tailBytes += Buffer.byteLength(fillerLine, "utf-8");
  }
  fs.closeSync(fdTail);

  const extractedTailId = extractThreadId(largeLogTail);
  assert.equal(
    extractedTailId,
    null,
    "extractThreadId must return null if thread_id is beyond the 8192-byte head buffer"
  );
  console.log("✓ extractThreadId bounds reading to first 8192 bytes (ignores matches past window)");

  // 1c. Edge cases: empty file, non-existent file
  fs.writeFileSync(emptyLog, "");
  assert.equal(extractThreadId(emptyLog), null, "extractThreadId returns null on empty file");
  assert.equal(extractThreadId(nonexistentLog), null, "extractThreadId returns null on non-existent file");
  assert.equal(extractThreadId(null), null, "extractThreadId returns null on null input");
  console.log("✓ extractThreadId handles empty, non-existent, and null files cleanly");
} finally {
  if (fs.existsSync(largeLogHead)) fs.unlinkSync(largeLogHead);
  if (fs.existsSync(largeLogTail)) fs.unlinkSync(largeLogTail);
  if (fs.existsSync(emptyLog)) fs.unlinkSync(emptyLog);
  if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
}

// ---------------------------------------------------------------------------
// 2. relaunchChromium: Non-blocking async execution (orchestrator.js)
// ---------------------------------------------------------------------------
const { relaunchChromium } = await import(ORCHESTRATOR_PATH);
assert.equal(typeof relaunchChromium, "function", "relaunchChromium must be exported from orchestrator.js");

const launchPromise = relaunchChromium("SurveyCompleter-dummy-nonexistent-999");
assert.ok(
  launchPromise instanceof Promise || (launchPromise && typeof launchPromise.then === "function"),
  "relaunchChromium must return a Promise"
);
console.log("✓ relaunchChromium returns a Promise");

const result = await launchPromise;
assert.equal(typeof result, "object", "relaunchChromium Promise must resolve to an object");
assert.equal(result.ok, false, "relaunchChromium on nonexistent container must resolve ok: false");
assert.ok(typeof result.error === "string" && result.error.length > 0, "relaunchChromium error must be non-empty string");
console.log("✓ relaunchChromium resolves with failure object on invalid container without throwing");

// ---------------------------------------------------------------------------
// 3. Static contract assertions: event loop non-blocking & memory safety
// ---------------------------------------------------------------------------
const orchCode = fs.readFileSync(ORCHESTRATOR_PATH, "utf-8");
assert.ok(
  !orchCode.match(/function\s+relaunchChromium[^{]*\{[^}]*execSync/s),
  "relaunchChromium in orchestrator.js must NOT use execSync"
);
assert.ok(
  orchCode.includes("await relaunchChromium"),
  "checkFleetHealth in orchestrator.js must await relaunchChromium"
);
console.log("✓ orchestrator.js non-blocking contract verified (async exec + await in checkFleetHealth)");

const driverCode = fs.readFileSync(DRIVER_PATH, "utf-8");
assert.ok(
  !driverCode.match(/function\s+extractThreadId[^{]*\{[^}]*fs\.readFileSync/s),
  "extractThreadId in survey_driver.mjs must NOT use fs.readFileSync"
);
assert.ok(
  driverCode.includes("fs.readSync") && driverCode.includes("8192"),
  "extractThreadId in survey_driver.mjs must read bounded 8192-byte buffer via fs.readSync"
);
console.log("✓ survey_driver.mjs bounded reading contract verified");

console.log("\n=== ALL PERFORMANCE OPTIMIZATION TESTS PASSED ===");
