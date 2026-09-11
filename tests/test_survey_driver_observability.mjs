import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setupCodexStreams } from "../scripts/survey_driver.mjs";

console.log("Testing survey_driver observability...");

const tmpDir = path.join(process.cwd(), "logs", "_test_driver_" + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const stdoutLog = path.join(tmpDir, "agent_3015.log");
const stderrLog = path.join(tmpDir, "agent_3015.stderr.log");

try {
  // 1. Mock child process with stdout & stderr streams
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const published = [];
  const mockPublisher = {
    publish(ev) {
      published.push(ev);
    },
  };

  const streams = setupCodexStreams({
    child,
    stdoutPath: stdoutLog,
    stderrPath: stderrLog,
    port: 3015,
    publisher: mockPublisher,
    onThreadId: (id) => {
      streams.capturedThreadId = id;
    },
  });

  // Emit stdout chunks
  child.stdout.emit("data", Buffer.from('{"type":"thread.started","thread_id":"th_xyz"}\n'));
  child.stdout.emit("data", Buffer.from('{"type":"item.started","item":{"title":"Open survey page"}}\n'));
  // Emit stderr chunk
  child.stderr.emit("data", Buffer.from('Warning: experimental feature enabled\n'));

  // Close streams
  streams.close();

  // Assert stdout wrote clean JSONL
  assert.ok(fs.existsSync(stdoutLog), "stdout log should exist");
  const stdoutContent = fs.readFileSync(stdoutLog, "utf-8");
  assert.ok(stdoutContent.includes("thread.started"));
  assert.ok(stdoutContent.includes("Open survey page"));
  assert.ok(!stdoutContent.includes("Warning: experimental"), "stdout must NOT contain stderr data");

  // Assert stderr wrote to stderr log
  assert.ok(fs.existsSync(stderrLog), "stderr log should exist");
  const stderrContent = fs.readFileSync(stderrLog, "utf-8");
  assert.ok(stderrContent.includes("Warning: experimental"), "stderr log must contain stderr data");

  // Assert publisher received normalized events
  assert.strictEqual(published.length, 2);
  assert.strictEqual(published[0].event, "thread_started");
  assert.strictEqual(published[1].event, "acting");
  assert.strictEqual(streams.capturedThreadId, "th_xyz");

  // Code contract test: survey_driver.mjs must no longer use stdio: ["ignore", state.logFd, state.logFd]
  const driverSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "survey_driver.mjs"), "utf-8");
  assert.ok(!driverSrc.includes('["ignore", state.logFd, state.logFd]'), "Legacy merged stdio must be removed");

  console.log("PASS test_survey_driver_observability");
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
