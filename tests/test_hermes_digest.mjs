import assert from "node:assert/strict";
import { generateFleetDigests, PORT_TO_CHANNEL, PORT_TO_PLATFORM } from "../scripts/hermes_digest.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 1. Port mapping checks
check("maps ports to correct discord channels and platforms", () => {
  assert.equal(PORT_TO_CHANNEL[3013], "discord:#agent-3013");
  assert.equal(PORT_TO_CHANNEL[3014], "discord:#agent-3014");
  assert.equal(PORT_TO_CHANNEL[3015], "discord:#agent-3015");
  assert.equal(PORT_TO_CHANNEL[3016], "discord:#agent-3016");
  assert.equal(PORT_TO_CHANNEL[3017], "discord:#agent-3017");
  assert.equal(PORT_TO_PLATFORM[3013], "SurveyJunkie");
  assert.equal(PORT_TO_PLATFORM[3014], "Swagbucks");
  assert.equal(PORT_TO_PLATFORM[3015], "SurveyJunkie");
  assert.equal(PORT_TO_PLATFORM[3016], "SurveyJunkie");
  assert.equal(PORT_TO_PLATFORM[3017], "Swagbucks (2)");
});

// 2. Digest generation with simulated events
check("generates per-agent markdown digest and fleet rollup", () => {
  const sampleEvents = [
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3013,
      event: "acting",
      message: "acting: Answer question 4 about insurance",
      detail: { title: "Answer question 4 about insurance" }
    },
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3013,
      event: "item_completed",
      message: "completed: Answer question 4 about insurance"
    },
    {
      ts: new Date().toISOString(),
      source: "driver",
      port: 3013,
      event: "survey_done",
      message: "survey completed",
      detail: { payout_usd: 1.25, payout_raw: "1.25", title: "Auto Insurance Study" }
    },
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3016,
      event: "acting",
      message: "acting: Launch PureSpectrum 842",
      detail: { title: "Launch PureSpectrum 842" }
    }
  ];

  const digest = generateFleetDigests(sampleEvents, { windowMinutes: 5 });

  // Check 3013 digest
  const d3013 = digest.perPort.get(3013);
  assert.ok(d3013, "Should have digest for 3013");
  assert.equal(d3013.channel, "discord:#agent-3013");
  assert.equal(d3013.hasActivity, true);
  assert.ok(d3013.markdown.includes("SurveyJunkie"), "Should mention platform");
  assert.ok(d3013.markdown.includes("Auto Insurance Study"), "Should mention survey title");
  assert.ok(d3013.markdown.includes("$1.25"), "Should mention earnings");

  // Check rollup
  assert.equal(digest.rollup.channel, "discord:#survey-reports");
  assert.ok(digest.rollup.markdown.includes("Survey Fleet Summary"), "Rollup should have title");
  assert.ok(digest.rollup.markdown.includes("$1.25"), "Rollup should include total 5m earnings");
  assert.ok(digest.rollup.markdown.includes("| Port | Platform | 5m Earnings | Status |"), "Rollup should include summary table");
});

// 3. Edge case handling: screenouts, errors/blockers, unknown ports, empty events
check("handles screenouts, errors, unknown ports and empty events", () => {
  const emptyDigest = generateFleetDigests([], { windowMinutes: 5 });
  assert.equal(emptyDigest.perPort.get(3013).hasActivity, false);
  assert.ok(emptyDigest.perPort.get(3013).markdown.includes("Idle / Polling for surveys"));
  assert.ok(emptyDigest.rollup.markdown.includes("+$0.00 USD"));

  const mixedEvents = [
    { port: 9999, event: "acting", message: "unknown port event" },
    { port: 3014, event: "screened_out", detail: { title: "Beverage Consumer screener" } },
    { port: 3015, event: "error", detail: { symptom: "Cloudflare Turnstile captcha loop" } }
  ];

  const mixedDigest = generateFleetDigests(mixedEvents, { windowMinutes: 5 });
  const d3014 = mixedDigest.perPort.get(3014);
  assert.equal(d3014.hasActivity, true);
  assert.ok(d3014.markdown.includes("Screenouts / Disqualifications"));
  assert.ok(d3014.markdown.includes("1"));

  const d3015 = mixedDigest.perPort.get(3015);
  assert.equal(d3015.hasActivity, true);
  assert.ok(d3015.markdown.includes("Blockers / Tech Issues"));
  assert.ok(d3015.markdown.includes("Cloudflare Turnstile captcha loop"));
  assert.ok(mixedDigest.rollup.markdown.includes("⚠️ Blocker"));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log(`${passed} checks completed.`);
