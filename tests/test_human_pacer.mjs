// tests/test_human_pacer.mjs — Human Pacing & Dwell Regulator Unit Tests
import assert from "node:assert/strict";
import {
  calculateReadingTimeMs,
  getPacingSchedule,
  sleep,
  enforcePageDwell,
} from "../scripts/human_pacer.mjs";

console.log("[test] 1. calculateReadingTimeMs WPM calculation, options count, floor and cap");
{
  // Short question: 4 words, 2 options
  // 4 words @ ~272ms = ~1090ms + 2*300ms = 600ms => 1690ms.
  // Must be clamped to minimum floor (default 3500ms).
  const shortReadingTime = calculateReadingTimeMs("What is your gender?", ["Male", "Female"]);
  assert.equal(typeof shortReadingTime, "number");
  assert.ok(shortReadingTime >= 3500, `Short reading time (${shortReadingTime}) should be >= 3500ms floor`);
  assert.equal(shortReadingTime, 3500, "Default floor should be 3500ms for short question");

  // Medium/long question
  // 50 words + 6 options
  const words = Array(50).fill("word").join(" ");
  const options = ["Option 1", "Option 2", "Option 3", "Option 4", "Option 5", "Option 6"];
  const medReadingTime = calculateReadingTimeMs(words, options);
  assert.ok(medReadingTime >= 3500, "Reading time must exceed floor");
  assert.ok(medReadingTime <= 15000, `Reading time (${medReadingTime}) must not exceed 15000ms cap`);
  assert.ok(medReadingTime > 10000, `Reading time (${medReadingTime}) should scale with word count`);

  // Very long text exceeding cap
  const longWords = Array(200).fill("lengthyword").join(" ");
  const longReadingTime = calculateReadingTimeMs(longWords, options);
  assert.equal(longReadingTime, 15000, `Reading time (${longReadingTime}) must be capped at 15000ms`);

  // Custom config override
  const customTime = calculateReadingTimeMs("Hello world", [], { minFloorMs: 2000, maxCapMs: 8000 });
  assert.equal(customTime, 2000, "Custom floor of 2000ms should be respected");
}

console.log("[test] 2. getPacingSchedule structure and randomized bounds");
{
  const question = "Please select the primary industry in which you are employed:";
  const options = ["Technology", "Healthcare", "Education", "Retail", "Other"];

  const schedule1 = getPacingSchedule(question, options);
  const schedule2 = getPacingSchedule(question, options);

  assert.equal(typeof schedule1, "object");
  assert.ok("readingMs" in schedule1, "schedule must include readingMs");
  assert.ok("preClickDwellMs" in schedule1, "schedule must include preClickDwellMs");
  assert.ok("postClickDwellMs" in schedule1, "schedule must include postClickDwellMs");
  assert.ok("preSubmitDwellMs" in schedule1, "schedule must include preSubmitDwellMs");
  assert.ok("totalDwellMs" in schedule1, "schedule must include totalDwellMs");

  // Also check aliases for plan compatibility
  assert.ok("hoverDwellMs" in schedule1, "schedule should include hoverDwellMs alias");
  assert.ok("selectionDwellMs" in schedule1, "schedule should include selectionDwellMs alias");
  assert.ok("preSubmitSettleMs" in schedule1, "schedule should include preSubmitSettleMs alias");

  // Check bounds for preClickDwellMs (roughly 1200ms–2500ms)
  assert.ok(schedule1.preClickDwellMs >= 1100 && schedule1.preClickDwellMs <= 2600,
    `preClickDwellMs (${schedule1.preClickDwellMs}) out of expected range 1200-2500ms`);

  // Check bounds for postClickDwellMs (roughly 800ms–1800ms)
  assert.ok(schedule1.postClickDwellMs >= 750 && schedule1.postClickDwellMs <= 1900,
    `postClickDwellMs (${schedule1.postClickDwellMs}) out of expected range 800-1800ms`);

  // Check bounds for preSubmitDwellMs (roughly 1500ms–3000ms)
  assert.ok(schedule1.preSubmitDwellMs >= 1400 && schedule1.preSubmitDwellMs <= 3100,
    `preSubmitDwellMs (${schedule1.preSubmitDwellMs}) out of expected range 1500-3000ms`);

  // Check totalDwellMs equals sum of parts
  const expectedTotal = schedule1.readingMs + schedule1.preClickDwellMs + schedule1.postClickDwellMs + schedule1.preSubmitDwellMs;
  assert.equal(schedule1.totalDwellMs, expectedTotal, "totalDwellMs must equal sum of reading + dwell segments");

  // Verify non-determinism across multiple runs
  const samples = Array.from({ length: 10 }, () => getPacingSchedule(question, options));
  const uniquePreClicks = new Set(samples.map(s => s.preClickDwellMs));
  assert.ok(uniquePreClicks.size > 1, "Pacing schedule must be non-deterministic with randomized jitter");
}

console.log("[test] 3. sleep utility");
{
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 40, `sleep(50) should pause execution (elapsed: ${elapsed}ms)`);
}

console.log("[test] 4. enforcePageDwell budget enforcement");
{
  let mockSleepTime = 0;
  const mockSleep = async (ms) => {
    mockSleepTime = ms;
  };

  // Case A: Elapsed time already satisfies or exceeds required dwell
  const now = Date.now();
  const resAlreadyMet = await enforcePageDwell(now - 5000, 4000, mockSleep);
  assert.equal(resAlreadyMet.waited, false, "Should not wait if elapsed >= minRequiredMs");
  assert.equal(resAlreadyMet.remainingMs, 0, "Remaining wait time should be 0");
  assert.equal(mockSleepTime, 0, "mockSleep should not have been called");

  // Case B: Elapsed time is less than required dwell
  const resNeedsWait = await enforcePageDwell(now - 1500, 4000, mockSleep);
  assert.equal(resNeedsWait.waited, true, "Should wait if elapsed < minRequiredMs");
  assert.ok(resNeedsWait.remainingMs >= 2400 && resNeedsWait.remainingMs <= 2600,
    `remainingMs (${resNeedsWait.remainingMs}) should be roughly 2500ms`);
  assert.equal(mockSleepTime, resNeedsWait.remainingMs, "sleep should be called with remainingMs");
}

console.log("PASS: test_human_pacer");