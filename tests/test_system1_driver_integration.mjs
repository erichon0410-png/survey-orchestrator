// tests/test_system1_driver_integration.mjs — Integration test for System 1 Fast-Path & Survey Driver
//
// Verifies:
// 1. attemptFastPath(port, options) handles eligible questions, emits formatted ACTION log,
//    publishes telemetry event system1_fastpath_executed, and returns pacedMs and decision.
// 2. attemptFastPath(port, options) falls back cleanly when unhandled without blocking or throwing.
// 3. Active questionnaire page detection distinguishes partner/screener URLs from platform dashboards.
// 4. Driver turn loop avoids spawning heavy LLM turns when fast-path handles active survey questions.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  attemptFastPath,
  ENABLE_FASTPATH,
  isActiveQuestionnaire,
} from "../scripts/survey_driver.mjs";

console.log("Running test_system1_driver_integration...");

// ---------------------------------------------------------------------------
// 1. attemptFastPath - Handled Case
// ---------------------------------------------------------------------------
console.log("[test] 1. attemptFastPath handles question, emits log, publishes event, and returns result");
{
  const published = [];
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logged.push(args.join(" "));
    originalLog(...args);
  };

  const mockPublisher = {
    publish(ev) {
      published.push(ev);
    },
  };

  try {
    const mockRunner = async (port, opts) => ({
      handled: true,
      action: "fastpath_completed",
      optionClicked: "Female",
      nextClicked: true,
      pacedMs: 4250,
      decision: {
        canHandle: true,
        type: "choice",
        confidence: 0.95,
      },
    });

    const res = await attemptFastPath(3013, {
      runner: mockRunner,
      publisher: mockPublisher,
    });

    assert.equal(res.handled, true, "res.handled must be true");
    assert.equal(res.pacedMs, 4250, "res.pacedMs must match");
    assert.equal(res.optionClicked, "Female", "res.optionClicked must match");
    assert.equal(res.nextClicked, true, "res.nextClicked must match");
    assert.ok(res.decision, "res.decision must be returned");

    // Verify log output: ACTION: system1_fastpath | TARGET: <label> | PACED_MS: <ms>
    const actionLog = logged.find((l) =>
      l.includes("ACTION: system1_fastpath | TARGET: Female | PACED_MS: 4250")
    );
    assert.ok(
      actionLog,
      `Driver must emit formatted action log. Found logs:\n${logged.join("\n")}`
    );

    // Verify published telemetry event: system1_fastpath_executed
    assert.equal(published.length, 1, "Must publish exactly 1 telemetry event");
    const ev = published[0];
    assert.equal(ev.event, "system1_fastpath_executed");
    assert.equal(ev.port, 3013);
    assert.equal(ev.optionClicked, "Female");
    assert.equal(ev.nextClicked, true);
    assert.equal(ev.pacedMs, 4250);
    assert.deepEqual(ev.decision, {
      canHandle: true,
      type: "choice",
      confidence: 0.95,
    });
  } finally {
    console.log = originalLog;
  }
}

// ---------------------------------------------------------------------------
// 2. attemptFastPath - Unhandled Case (Fallback to System 2)
// ---------------------------------------------------------------------------
console.log("[test] 2. attemptFastPath falls back cleanly when unhandled without blocking");
{
  const published = [];
  const mockPublisher = {
    publish(ev) {
      published.push(ev);
    },
  };

  const mockRunner = async () => ({
    handled: false,
    reason: "needs_system2",
  });

  const res = await attemptFastPath(3013, {
    runner: mockRunner,
    publisher: mockPublisher,
  });

  assert.equal(res.handled, false, "res.handled must be false");
  assert.equal(res.reason, "needs_system2", "res.reason must be returned");
  assert.equal(published.length, 0, "Must NOT publish fastpath event when unhandled");
}

// ---------------------------------------------------------------------------
// 3. attemptFastPath - Error Resilience
// ---------------------------------------------------------------------------
console.log("[test] 3. attemptFastPath catches runner exceptions gracefully without crashing");
{
  const failingRunner = async () => {
    throw new Error("CDP transport disconnected unexpectedly");
  };

  const res = await attemptFastPath(3015, { runner: failingRunner });
  assert.equal(res.handled, false, "Must return handled: false on thrown exception");
  assert.ok(
    res.reason.includes("CDP transport disconnected unexpectedly"),
    `Reason must describe error: ${res.reason}`
  );
}

// ---------------------------------------------------------------------------
// 4. attemptFastPath - End-to-end CDP simulation with real tryExecuteFastPath
// ---------------------------------------------------------------------------
console.log("[test] 4. attemptFastPath works with real tryExecuteFastPath over CDP send mock");
{
  const mouseEvents = [];
  const published = [];
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logged.push(args.join(" "));
    originalLog(...args);
  };

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: [
            { role: "radio", label: "Female", x: 120, y: 220, w: 20, h: 20, isSubmitOrNext: false },
            { role: "radio", label: "Male", x: 120, y: 260, w: 20, h: 20, isSubmitOrNext: false },
            { role: "button", label: "Next", x: 250, y: 380, w: 80, h: 30, isSubmitOrNext: true },
          ],
        },
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      mouseEvents.push(params);
      return {};
    }
    return {};
  };

  try {
    const res = await attemptFastPath(3014, {
      send: mockSend,
      publisher: {
        publish(ev) {
          published.push(ev);
        },
      },
      sleepFn: async () => {}, // Instant sleep for tests
    });

    assert.equal(res.handled, true);
    assert.equal(res.optionClicked, "Female");
    assert.equal(res.nextClicked, true);
    assert.ok(res.pacedMs > 0, `Paced duration must be positive: ${res.pacedMs}`);
    assert.equal(published.length, 1);
    assert.equal(published[0].event, "system1_fastpath_executed");
    assert.equal(published[0].port, 3014);

    const actionLog = logged.find((l) =>
      l.includes("ACTION: system1_fastpath | TARGET: Female")
    );
    assert.ok(actionLog, "Action log must be emitted for real fastpath run");
  } finally {
    console.log = originalLog;
  }
}

// ---------------------------------------------------------------------------
// 5. Active Questionnaire Detection
// ---------------------------------------------------------------------------
console.log("[test] 5. isActiveQuestionnaire correctly classifies URLs");
{
  assert.equal(typeof isActiveQuestionnaire, "function", "isActiveQuestionnaire must be exported");

  // Platform dashboards are NOT active questionnaires
  assert.equal(isActiveQuestionnaire({ url: "https://app.surveyjunkie.com/" }), false);
  assert.equal(isActiveQuestionnaire({ url: "https://app.surveyjunkie.com/dashboard" }), false);
  assert.equal(isActiveQuestionnaire({ url: "https://app.surveyjunkie.com/surveys" }), false);
  assert.equal(isActiveQuestionnaire({ url: "https://www.swagbucks.com/surveys" }), false);
  assert.equal(isActiveQuestionnaire({ url: "https://www.swagbucks.com/dashboard" }), false);
  assert.equal(isActiveQuestionnaire({ url: "about:blank" }), false);
  assert.equal(isActiveQuestionnaire({ url: "" }), false);
  assert.equal(isActiveQuestionnaire(null), false);

  // Active survey / partner / router URLs ARE active questionnaires
  assert.equal(isActiveQuestionnaire({ url: "https://surveys.samplicio.us/s?id=12345" }), true);
  assert.equal(isActiveQuestionnaire({ url: "https://decipherinc.com/survey/selfserve/9d3/2301" }), true);
  assert.equal(isActiveQuestionnaire({ url: "https://survey.alchemer.com/s3/9999" }), true);
  assert.equal(isActiveQuestionnaire({ url: "https://www.swagbucks.com/surveys/prescreener-v2?tid=456" }), true);
  assert.equal(isActiveQuestionnaire({ url: "https://researchsurv.com/questionnaire/100" }), true);
  assert.equal(isActiveQuestionnaire({ url: "https://example.org/poll", title: "Consumer Research Study" }), true);
}

// ---------------------------------------------------------------------------
// 6. Driver Turn Loop Integration & Configuration
// ---------------------------------------------------------------------------
console.log("[test] 6. Driver exports ENABLE_FASTPATH and integrates fast-path into turn flow");
{
  assert.equal(typeof ENABLE_FASTPATH, "boolean", "ENABLE_FASTPATH must be exported boolean");
  assert.equal(ENABLE_FASTPATH, true, "ENABLE_FASTPATH must default to true");

  // Code inspection to ensure driver invokes attemptFastPath before spawning LLM turn
  const driverSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "survey_driver.mjs"), "utf-8");

  assert.ok(
    driverSrc.includes('import { tryExecuteFastPath } from "./system1_runner.mjs";') ||
    driverSrc.includes("import { tryExecuteFastPath } from './system1_runner.mjs';"),
    "Driver must import tryExecuteFastPath from ./system1_runner.mjs"
  );

  assert.ok(
    driverSrc.includes("export async function attemptFastPath") ||
    driverSrc.includes("export function attemptFastPath"),
    "Driver must export attemptFastPath function"
  );

  assert.ok(
    driverSrc.includes("system1_fastpath_executed"),
    "Driver must publish system1_fastpath_executed telemetry event"
  );

  assert.ok(
    driverSrc.includes("ACTION: system1_fastpath"),
    "Driver must log ACTION: system1_fastpath"
  );

  assert.ok(
    driverSrc.includes("ENABLE_FASTPATH") && driverSrc.includes("attemptFastPath"),
    "Driver main turn loop must check ENABLE_FASTPATH and call attemptFastPath"
  );
}

console.log("PASS test_system1_driver_integration");
