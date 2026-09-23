import assert from "node:assert/strict";
import fs from "node:fs";

const promptContent = fs.readFileSync("prompts/survey_agent_prompt.txt", "utf8");

// Must define globalThis.mouseClick in startup snippet
assert.ok(promptContent.includes("globalThis.mouseClick"), "Prompt startup snippet must define globalThis.mouseClick");

// Must mandate mouseClick in Rule 3
assert.ok(promptContent.includes("ALWAYS use `await mouseClick"), "Prompt Rule 3 must mandate ALWAYS use `await mouseClick");

// Must ban element.click
assert.ok(!promptContent.includes("first try via Runtime.evaluate — find the element by selector/text and call `.click()`"), "Prompt must not suggest calling .click() first");

// Must use observe action instead of snapshot as primary inspection
assert.ok(promptContent.includes('browser_inspect({ action: "observe"'), "Prompt must mandate observe action");
assert.ok(!promptContent.includes('browser_inspect({ action: "snapshot"'), "Prompt must not mandate snapshot action as primary inspection");

// Must not require mandatory double-snapshot before clicking Next
assert.ok(!promptContent.includes("CRITICAL MANDATORY SNAPSHOT"), "Prompt must not contain CRITICAL MANDATORY SNAPSHOT rule");
assert.ok(!promptContent.includes("ALWAYS call `browser_inspect({ action: \"snapshot\""), "Prompt must not mandate double snapshot before clicking Next");

// Must permit direct selectors and same-turn Next/Submit clicking
assert.ok(promptContent.includes('button[type="submit"]') && promptContent.includes(".next-btn"), "Prompt must permit direct CSS selectors for Next/Submit");
assert.ok(promptContent.includes("same interaction turn"), "Prompt must permit clicking Next/Submit in same interaction turn");

// Check survey_agent.patch.yml invariants
const patchContent = fs.readFileSync("scripts/survey_agent.patch.yml", "utf8");
assert.ok(patchContent.includes('browser_inspect({ action: "observe" })'), "Patch must use observe action");
assert.ok(!patchContent.includes("CRITICAL MANDATORY SNAPSHOT"), "Patch must not contain CRITICAL MANDATORY SNAPSHOT rule");
assert.ok(patchContent.includes('button[type="submit"]'), "Patch must permit direct Next button selectors");
assert.ok(patchContent.includes("reasoningEfforts: off"), "Patch must configure reasoningEfforts to off");

console.log("PASS survey_agent_prompt.txt and survey_agent.patch.yml comply with streamlined observe and fast next rules");
