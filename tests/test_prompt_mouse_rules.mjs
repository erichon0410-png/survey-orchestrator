import assert from "node:assert/strict";
import fs from "node:fs";

const promptContent = fs.readFileSync("prompts/survey_agent_prompt.txt", "utf8");

// Must define globalThis.mouseClick in startup snippet
assert.ok(promptContent.includes("globalThis.mouseClick"), "Prompt startup snippet must define globalThis.mouseClick");

// Must mandate mouseClick in Rule 3
assert.ok(promptContent.includes("ALWAYS use `await mouseClick"), "Prompt Rule 3 must mandate ALWAYS use `await mouseClick");

// Must ban element.click
assert.ok(!promptContent.includes("first try via Runtime.evaluate — find the element by selector/text and call `.click()`"), "Prompt must not suggest calling .click() first");

console.log("PASS survey_agent_prompt.txt complies with trusted mouse requirements");
