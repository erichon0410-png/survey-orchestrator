import assert from "node:assert/strict";
import fs from "node:fs";
import { preparePrompt, buildNudgePrompt, PORT_TO_PLATFORM } from "../scripts/survey_driver.mjs";

console.log("Testing survey_driver port isolation & prompt preparation...");

// 1. Check PORT_TO_PLATFORM
assert.ok(PORT_TO_PLATFORM[3013], "Must have platform mapping for 3013");
assert.ok(PORT_TO_PLATFORM[3016], "Must have platform mapping for 3016");
assert.ok(PORT_TO_PLATFORM[3017], "Must have platform mapping for 3017");

// 2. Test preparePrompt for port 3013
const rawPrompt = fs.readFileSync("prompts/survey_agent_prompt.txt", "utf8");
const prepared3013 = preparePrompt({ rawPrompt, port: 3013 });

assert.ok(!prepared3013.includes("<PORT>"), "Must replace all <PORT> with 3013");
assert.ok(prepared3013.includes("http://127.0.0.1:3013/cdp/json"), "Must contain port 3013 CDP URL");
assert.ok(prepared3013.includes("=== STRICT PORT BINDING & ISOLATION (MANDATORY) ==="), "Must include strict isolation block");
assert.ok(prepared3013.includes("NEVER fetch, scan, query, or connect to port 3015"), "Must forbid connecting to 3015");
assert.ok(prepared3013.includes("Start survey"), "Must include SurveyJunkie Start survey selector");

// 3. Test preparePrompt for port 3017
const prepared3017 = preparePrompt({ rawPrompt, port: 3017 });
assert.ok(prepared3017.includes("http://127.0.0.1:3017/cdp/json"), "Must contain port 3017 CDP URL");
assert.ok(prepared3017.includes("Start Survey"), "Must include Swagbucks Start Survey selector");

// 4. Test buildNudgePrompt
const nudge3013 = buildNudgePrompt(3013);
assert.ok(nudge3013.includes("Port 3013"), "Nudge must mention Port 3013");
assert.ok(nudge3013.includes("http://127.0.0.1:3013/cdp/json"), "Nudge must remind of bound CDP endpoint");
assert.ok(nudge3013.includes("NEVER connect to other ports (3014, 3015, 3016, 3017)"), "Nudge must reinforce isolation");

const nudge3015 = buildNudgePrompt(3015);
assert.ok(nudge3015.includes("Port 3015"), "Nudge must mention Port 3015");
assert.ok(nudge3015.includes("NEVER connect to other ports (3013, 3014, 3016, 3017)"), "Port 3015 must exclude itself");
assert.ok(!nudge3015.includes("NEVER connect to port 3015"), "Port 3015 must not ban itself");

console.log("PASS survey_driver port isolation tests passed successfully!");

