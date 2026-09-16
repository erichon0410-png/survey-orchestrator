import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpJournal = path.join(os.tmpdir(), `test_fleet_events_${Date.now()}.jsonl`);

try {
  // Create sample event within the last 1 minute
  fs.writeFileSync(
    tmpJournal,
    JSON.stringify({
      ts: new Date().toISOString(),
      source: "codex",
      port: 3013,
      event: "acting",
      message: "acting: Answer question 4 about insurance",
      detail: { title: "Answer question 4 about insurance" },
    }) + "\n"
  );

  // 1. Dry run output verification (--once --dry-run)
  const run = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run"], {
    env: { ...process.env, FLEET_EVENTS_PATH: tmpJournal },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `Dry run failed: ${run.stderr}`);
  assert.ok(run.stdout.includes("DRY-RUN: discord:#survey-reports"), "Dry run should output rollup channel");
  assert.ok(run.stdout.includes("DRY-RUN: discord:#agent-3013"), "Dry run should output agent-3013 channel");

  // 2. Port filter flag (--port 3014)
  const runPort = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run", "--port", "3014"], {
    env: { ...process.env, FLEET_EVENTS_PATH: tmpJournal },
    encoding: "utf8",
  });
  assert.equal(runPort.status, 0, `Port filter run failed: ${runPort.stderr}`);
  assert.ok(runPort.stdout.includes("DRY-RUN: discord:#agent-3014"), "Should output filtered agent channel");
  assert.ok(!runPort.stdout.includes("DRY-RUN: discord:#survey-reports"), "Port filter should suppress fleet rollup");
  assert.ok(!runPort.stdout.includes("DRY-RUN: discord:#agent-3013"), "Port filter should suppress other ports");

  // 3. Custom interval flag (--interval 60)
  const runInterval = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run", "--interval", "60"], {
    env: { ...process.env, FLEET_EVENTS_PATH: tmpJournal },
    encoding: "utf8",
  });
  assert.equal(runInterval.status, 0, `Interval run failed: ${runInterval.stderr}`);
  assert.ok(runInterval.stdout.includes("DRY-RUN: discord:#survey-reports"), "Interval run should produce report");

  // 4. Missing log file handling (graceful empty report)
  const runNoFile = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run"], {
    env: { ...process.env, FLEET_EVENTS_PATH: path.join(os.tmpdir(), "nonexistent_events.jsonl") },
    encoding: "utf8",
  });
  assert.equal(runNoFile.status, 0, `Missing file run failed: ${runNoFile.stderr}`);
  assert.ok(runNoFile.stdout.includes("DRY-RUN: discord:#survey-reports"), "Missing file should still output empty rollup");

  console.log("PASS hermes_fleet_reporter.mjs dry-run and argument parsing");
} finally {
  try {
    fs.unlinkSync(tmpJournal);
  } catch {}
}
