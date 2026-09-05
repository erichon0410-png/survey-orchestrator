import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
