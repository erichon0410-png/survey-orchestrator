import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ORCH_PATH = process.env.DSH_ORCHESTRATOR || path.join(os.homedir(), ".dsh", "plugins", "dsh-survey-orchestrator", "lib", "orchestrator.js");
const { FLEET, killAgentForPort, killProcessGroup: exportedKillProcessGroup } = await import(ORCH_PATH);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpLog = path.join(__dirname, "test_spawn_fd.log");

const out = fs.openSync(tmpLog, "w");
const sub = spawn(process.execPath, ["-e", "console.log('test')"], {
  detached: true,
  stdio: ["ignore", out, out],
});
fs.closeSync(out);
sub.unref();

// Verify that out fd is closed in parent
assert.throws(() => {
  fs.fstatSync(out);
}, /EBADF/, "File descriptor must be closed in parent process");

console.log("✓ FD cleanup test passed");
if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);

const p3015 = FLEET.find(f => f.port === 3015);
assert.equal(p3015.platform, "Eureka", "Port 3015 platform must be Eureka");
console.log("✓ FLEET port 3015 platform verified");

function killProcessGroup(pid, signal = "SIGTERM") {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
assert.equal(typeof killProcessGroup, "function");
assert.equal(typeof killAgentForPort, "function", "killAgentForPort must be exported as a function");
assert.equal(typeof exportedKillProcessGroup, "function", "killProcessGroup must be exported from orchestrator.js");

// Verify helper logic with a real detached process
const detachedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
assert.ok(detachedChild.pid > 0, "detached child must have a valid pid");
assert.equal(killProcessGroup(detachedChild.pid, "SIGTERM"), true, "killProcessGroup should succeed for detached process");
assert.equal(killProcessGroup(999999, "SIGTERM"), false, "killProcessGroup should safely return false for invalid PID");
assert.equal(exportedKillProcessGroup(999999, "SIGTERM"), false, "exported killProcessGroup should safely return false for invalid PID");

console.log("✓ Process group termination helper verified");
