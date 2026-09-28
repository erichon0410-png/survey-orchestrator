import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setupCodexStreams } from "../scripts/survey_driver.mjs";

console.log("Running test_stream_and_single_survey_prompt...");

const promptPath = path.resolve("prompts/survey_agent_prompt.txt");
const patchPath = path.resolve("scripts/survey_agent.patch.yml");

const promptContent = fs.readFileSync(promptPath, "utf8");
const patchContent = fs.readFileSync(patchPath, "utf8");

// Requirement a: single-survey turn contract
const contractSnippet = "DISCRETE SURVEY TURNS: Each turn is bounded to completing one questionnaire or resolving a terminal screener outcome. Once a questionnaire reaches a terminal state (completion payout, screenout, or disqualification), report the outcome in status and exit your turn cleanly with status 0. The driver will verify platform balance updates and immediately launch your next survey with a clean context.";

assert.ok(
  promptContent.includes(contractSnippet) || promptContent.includes("DISCRETE SURVEY TURNS: Each turn is bounded to completing one questionnaire"),
  "survey_agent_prompt.txt must contain the discrete single-survey turn contract"
);
assert.ok(
  patchContent.includes(contractSnippet) || patchContent.includes("DISCRETE SURVEY TURNS: Each turn is bounded to completing one questionnaire"),
  "survey_agent.patch.yml must contain the discrete single-survey turn contract"
);

// Requirement b: progress logging rule requiring ACTION: <inspect|click|answer> | TARGET: <selector>
assert.ok(
  promptContent.includes("REAL-TIME ACTION STREAMING") && promptContent.includes("ACTION: <inspect|click|answer> | TARGET: <selector>"),
  "survey_agent_prompt.txt must contain the real-time action streaming requirement"
);
assert.ok(
  patchContent.includes("REAL-TIME ACTION STREAMING") && patchContent.includes("ACTION: <inspect|click|answer> | TARGET: <selector>"),
  "survey_agent.patch.yml must contain the real-time action streaming requirement"
);

// Requirement c: obsolete infinite 10-minute poll loop within a single turn must be removed
assert.ok(!promptContent.includes("keep polling every ~10 minutes"), "prompt must not contain obsolete 10-minute polling loop");
assert.ok(!promptContent.includes("re-check for new surveys every ~10 minutes"), "prompt must not contain obsolete 10-minute polling loop");
assert.ok(!promptContent.includes("poll every ~10 minutes"), "prompt must not contain obsolete 10-minute polling loop");

// Invariants: test_prompt_mouse_rules.mjs rules must be preserved
assert.ok(promptContent.includes("PRESCREENER & ZERO SELF-EXIT MANDATE"), "Prescreener mandate must be preserved in prompt");
assert.ok(promptContent.includes("UNDER NO CIRCUMSTANCES SHOULD THE MODEL DECIDE TO EXIT ON ITS OWN"), "Model zero self-exit rule must be preserved");
assert.ok(promptContent.includes("ALWAYS use `await mouseClick"), "Mouse click rule must be preserved");
assert.ok(patchContent.includes("TERMINAL SCREENOUTS & COMPLETION ONLY (ZERO SELF-EXIT)"), "Zero self-exit rule must be preserved in patch");

// Requirement d: setupCodexStreams detects ACTION: lines and immediately flushes and publishes agent_action
const tmpDir = path.resolve("logs", `_test_stream_${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const stdoutLog = path.join(tmpDir, "agent_3013.log");
const stderrLog = path.join(tmpDir, "agent_3013.stderr.log");

try {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const published = [];
  const mockPublisher = {
    publish(ev) {
      published.push(ev);
    },
    flush() {
      mockPublisher.flushed = true;
    },
    flushed: false,
  };

  const streams = setupCodexStreams({
    child,
    stdoutPath: stdoutLog,
    stderrPath: stderrLog,
    port: 3013,
    publisher: mockPublisher,
    onThreadId: () => {},
  });

  // Emit an ACTION line
  child.stdout.emit("data", Buffer.from("ACTION: click | TARGET: button[type='submit']\n"));
  // Emit an AGENT_ACTION line
  child.stdout.emit("data", Buffer.from("AGENT_ACTION: answer | TARGET: @e5\n"));

  // Check that stdout file was written immediately
  const stdoutDisk = fs.readFileSync(stdoutLog, "utf8");
  assert.ok(stdoutDisk.includes("ACTION: click | TARGET: button[type='submit']"), "ACTION line must be written to log");
  assert.ok(stdoutDisk.includes("AGENT_ACTION: answer | TARGET: @e5"), "AGENT_ACTION line must be written to log");

  // Check publisher events
  const actionEvents = published.filter(ev => ev.event === "agent_action");
  assert.equal(actionEvents.length, 2, "Expected 2 agent_action events published");
  assert.ok(actionEvents[0].message.includes("ACTION: click | TARGET: button[type='submit']"));
  assert.equal(actionEvents[0].port, 3013);
  assert.ok(actionEvents[1].message.includes("AGENT_ACTION: answer | TARGET: @e5"));

  streams.close();
  console.log("PASS test_stream_and_single_survey_prompt");
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
