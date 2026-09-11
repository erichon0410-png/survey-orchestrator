import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { formatWatcherLine, parseWatcherArgs } from "../scripts/fleet_watch.mjs";
import { createEventHub } from "../scripts/observability_hub.mjs";

console.log("Testing fleet_watch...");

// 1. Argument parsing
const args1 = parseWatcherArgs(["--port", "3015", "--errors-only"]);
assert.strictEqual(args1.port, 3015);
assert.strictEqual(args1.errorsOnly, true);
assert.strictEqual(args1.noColor, false);

const args2 = parseWatcherArgs(["--replay", "50", "--no-color"]);
assert.strictEqual(args2.replay, 50);
assert.strictEqual(args2.noColor, true);

// 2. Line formatting and filtering
const evNormal = {
  ts: "2026-09-11T04:30:00.000Z",
  source: "codex",
  port: 3015,
  event: "survey_earned",
  message: "port 3015 earned $0.15!",
};
const lineNormal = formatWatcherLine(evNormal, { noColor: true });
assert.ok(lineNormal.includes("[3015]"));
assert.ok(lineNormal.includes("port 3015 earned $0.15!"));

// Error event
const evError = {
  ts: "2026-09-11T04:30:01.000Z",
  source: "codex",
  port: 3013,
  event: "error",
  message: "element not interactable",
};
const lineError = formatWatcherLine(evError, { noColor: true });
assert.ok(lineError.includes("[3013]"));
assert.ok(lineError.includes("element not interactable"));

// 3. Filtering test
function shouldDisplay(event, options) {
  if (options.port && event.port !== options.port) return false;
  if (options.errorsOnly && event.event !== "error" && event.event !== "tech_issue") return false;
  return true;
}

assert.strictEqual(shouldDisplay(evNormal, { port: 3015 }), true);
assert.strictEqual(shouldDisplay(evNormal, { port: 3013 }), false);
assert.strictEqual(shouldDisplay(evNormal, { errorsOnly: true }), false);
assert.strictEqual(shouldDisplay(evError, { errorsOnly: true }), true);

console.log("PASS test_fleet_watch");
