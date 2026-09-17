import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { preparePrompt, buildNudgePrompt, PORT_TO_PLATFORM, pruneExcessTabs } from "../scripts/survey_driver.mjs";
import { cleanupScreenshots } from "../scripts/cleanup_screenshots.mjs";

console.log("Testing survey_driver port isolation & prompt preparation...");

// 1. Check 3/2 split PORT_TO_PLATFORM
assert.equal(PORT_TO_PLATFORM[3013], "surveyjunkie", "Port 3013 must map to surveyjunkie");
assert.equal(PORT_TO_PLATFORM[3014], "swagbucks", "Port 3014 must map to swagbucks");
assert.equal(PORT_TO_PLATFORM[3015], "surveyjunkie", "Port 3015 must map to surveyjunkie");
assert.equal(PORT_TO_PLATFORM[3016], "surveyjunkie", "Port 3016 must map to surveyjunkie");
assert.equal(PORT_TO_PLATFORM[3017], "swagbucks", "Port 3017 must map to swagbucks");

// 2. Test preparePrompt for port 3013
const rawPrompt = fs.readFileSync("prompts/survey_agent_prompt.txt", "utf8");
const prepared3013 = preparePrompt({ rawPrompt, port: 3013 });

assert.ok(!prepared3013.includes("<PORT>"), "Must replace all <PORT> with 3013");
assert.ok(prepared3013.includes("http://127.0.0.1:3013/cdp/json"), "Must contain port 3013 CDP URL");
assert.ok(prepared3013.includes("=== STRICT PORT BINDING & ISOLATION (MANDATORY) ==="), "Must include strict isolation block");
assert.ok(prepared3013.includes("NEVER fetch, scan, query, or connect to port 3015"), "Must forbid connecting to 3015");
assert.ok(prepared3013.includes("Start survey"), "Must include SurveyJunkie Start survey selector");
assert.ok(prepared3013.includes("=== TAB HYGIENE & STRICT 3-TAB CEILING ==="), "Must include tab hygiene block");
assert.ok(prepared3013.includes("Maximum 3 tabs open"), "Must specify max 3 tabs ceiling");

// 3. Test preparePrompt for port 3017
const prepared3017 = preparePrompt({ rawPrompt, port: 3017 });
assert.ok(prepared3017.includes("http://127.0.0.1:3017/cdp/json"), "Must contain port 3017 CDP URL");
assert.ok(prepared3017.includes("Start Survey"), "Must include Swagbucks Start Survey selector");
assert.ok(prepared3017.includes("Issue B Resolution"), "Must include Issue B resolution instructions");

// 4. Test buildNudgePrompt
const nudge3013 = buildNudgePrompt(3013);
assert.ok(nudge3013.includes("Port 3013"), "Nudge must mention Port 3013");
assert.ok(nudge3013.includes("http://127.0.0.1:3013/cdp/json"), "Nudge must remind of bound CDP endpoint");
assert.ok(nudge3013.includes("NEVER connect to other ports (3014, 3015, 3016, 3017)"), "Nudge must reinforce isolation");

const nudge3015 = buildNudgePrompt(3015);
assert.ok(nudge3015.includes("Port 3015"), "Nudge must mention Port 3015");
assert.ok(nudge3015.includes("NEVER connect to other ports (3013, 3014, 3016, 3017)"), "Port 3015 must exclude itself");
assert.ok(!nudge3015.includes("NEVER connect to port 3015"), "Port 3015 must not ban itself");

// 5. Test pruneExcessTabs against live container
const pruneResult = await pruneExcessTabs(3013, 3);
assert.ok(typeof pruneResult.closed === "number", "pruneExcessTabs must return number of closed tabs");
assert.ok(typeof pruneResult.remaining === "number", "pruneExcessTabs must return number of remaining tabs");
assert.ok(pruneResult.remaining <= 3, "pruneExcessTabs must keep <= 3 tabs");

// 6. Test cleanupScreenshots
const testTmpShot = path.join(os.tmpdir(), `shot_test_${Date.now()}.png`);
fs.writeFileSync(testTmpShot, "dummy-png");
const cleanRes = cleanupScreenshots({ olderThanMs: 0 });
assert.ok(!fs.existsSync(testTmpShot), "cleanupScreenshots must purge temporary shot files");
assert.ok(cleanRes.filesRemoved >= 1, "cleanupScreenshots must report at least 1 removed file");

// 7. Test loadEnvFiles
import { loadEnvFiles } from "../scripts/survey_driver.mjs";
const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
const tmpEnvPath = path.join(tmpEnvDir, ".env");
fs.writeFileSync(tmpEnvPath, `
# Test Comment
TEST_OR_KEY="sk-or-test-key-12345"
TEST_OR_EMPTY=
TEST_OR_PLAIN=unquoted_value
`);
const origCwd = process.cwd();
try {
  process.chdir(tmpEnvDir);
  loadEnvFiles();
  assert.equal(process.env.TEST_OR_KEY, "sk-or-test-key-12345", "Must load quoted env var");
  assert.equal(process.env.TEST_OR_PLAIN, "unquoted_value", "Must load unquoted env var");
  assert.equal(process.env.TEST_OR_EMPTY, undefined, "Must skip empty env var");
} finally {
  process.chdir(origCwd);
  fs.rmSync(tmpEnvDir, { recursive: true, force: true });
}

console.log("PASS survey_driver port isolation, tab pruning, cleanup, and env loading tests passed successfully!");


