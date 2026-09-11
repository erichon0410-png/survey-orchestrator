// test_driver_kill.mjs — the supervisor's driver-kill pattern must actually match
// a live driver process, or idle/auth timeouts detect-but-never-kill (stalled agents).
//
// Regression background: both kill sites used pkill -f "survey_driver.*port=${port}",
// but a real driver argv is `.../scripts/survey_driver.mjs --port 3015 --marker codex
// exec bound port 3015 ...` — the needle was `port=3015`, which never occurs, so every
// idle_kill/auth_kill silently no-opped (live log: action "idle_kill_failed").

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driverKillPattern } from "../scripts/driver_kill.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Real driver cmdline captured live (pid 1011806, port 3015):
const LIVE_LINE_3015 =
  "/usr/bin/node /home/erich/workspace/survey-orchestrator/scripts/survey_driver.mjs --port 3015 --marker codex exec bound port 3015 --prompt-file /home/erich/workspace/survey-orchestrator/logs/.prompt_3015.txt --max-nudges 3";

function liveLine(port) {
  return LIVE_LINE_3015.replace(/3015/g, String(port));
}

// T9a: the pattern matches a real driver process line for its own port.
{
  const re = new RegExp(driverKillPattern(3015));
  assert.match(LIVE_LINE_3015, re, "T9a: pattern must match the live driver cmdline");
  console.log("PASS T9a pattern matches real driver cmdline");
}

// T9b: the pattern does NOT match a different port's driver (no cross-port kills).
{
  const re = new RegExp(driverKillPattern(3015));
  assert.doesNotMatch(liveLine(3014), re, "T9b: pattern must not match port 3014");
  assert.doesNotMatch(liveLine(3016), re, "T9b: pattern must not match port 3016");
  console.log("PASS T9b pattern does not match other ports");
}

// T9c: matches when --port N is the final argument (no trailing space) — end-of-line safe.
{
  const line = "node /x/scripts/survey_driver.mjs --port 3013";
  assert.match(line, new RegExp(driverKillPattern(3013)), "T9c: end-of-line argv must match");
  console.log("PASS T9c end-of-line argv matches");
}

// T9d: the codex child (no survey_driver in argv) is NOT matched — only the driver is
// killed; the driver's SIGTERM handler cascades to its codex child.
{
  const codexChild = "codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt bound port 3015";
  assert.doesNotMatch(codexChild, new RegExp(driverKillPattern(3015)), "T9d: codex child must not match");
  console.log("PASS T9d codex child process not matched");
}

// T9e: contract — both supervisor kill sites use the helper; the broken `port=${port}`
// needle is gone from fleet_supervisor.mjs.
{
  const sup = fs.readFileSync(path.join(ROOT, "scripts", "fleet_supervisor.mjs"), "utf8");
  assert.ok(!sup.includes("port=${port}"), "T9e: broken port=${port} pattern must be removed");
  const uses = (sup.match(/driverKillPattern/g) || []).length;
  assert.ok(uses >= 3, `T9e: both kill sites + import must use driverKillPattern (found ${uses})`);
  console.log("PASS T9e supervisor kill sites wired to driverKillPattern");
}

console.log("\n=== ALL DRIVER-KILL TESTS PASSED ===");
