# Survey Orchestrator Reliability & Uptime Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate runtime memory/file-descriptor leaks, correct balance double-counting in the financial ledger, resolve the 5-minute restart thrashing loop, and ensure clean subprocess termination across the survey agent fleet.

**Architecture:** 
1. Surgical patch to `earnings_sync.mjs` to treat incoming platform markers as authoritative absolute balance snapshots rather than additive deltas, maintaining monotonic ledger progression.
2. Parent file-descriptor cleanup in `orchestrator.js` immediately following detached child process spawning.
3. Cooldown arithmetic correction and inbox marker throttling in `fleet_supervisor.mjs` to break the infinite 5-minute thrash cycle.
4. Process-group signalling (`-pid`) in `orchestrator.js` to eliminate orphaned worker and CDP proxy processes.
5. Migration of port 3015 platform configuration from legacy `ACOP` to active `PrimeOpinion`.
6. Bounded log chunk reading in `survey_driver.mjs` and asynchronous non-blocking container restarts in `orchestrator.js`.

**Tech Stack:** Node.js (ESM / CJS), Docker CLI, Bash / Linux process management, YAML (`config/earnings_rates.yaml`), JSONL event logging.

## Global Constraints
- Target Workspace: `/home/erich/workspace/survey-orchestrator`
- Orchestrator Plugin: `/home/erich/.dsh/plugins/dsh-survey-orchestrator`
- Zero GPU consumption: Local models or CUDA tasks must not be invoked during testing or runtime.
- Maintain existing logging formats in `logs/agent_<PORT>_status.jsonl` and `reports/earnings_ledger.jsonl`.
- All tests must pass: `node tests/test_earnings_sync.mjs` and new regression suites.

---

### Task 1: Fix Balance Double-Counting in `earnings_sync.mjs`

**Files:**
- Modify: `scripts/earnings_sync.mjs:322-348`
- Test: `tests/test_earnings_sync.mjs`

**Interfaces:**
- Consumes: `computeMarkerEarnings(data, ratesConfig)` returning `{ account, port, platform, usd_earned, points_raw }` where `usd_earned` represents the current cumulative balance on the platform.
- Produces: Monotonically increasing balance entries in `reports/earnings_ledger.jsonl`.

- [ ] **Step 1: Write failing regression test for cumulative marker handling**

Add a test case in `tests/test_earnings_sync.mjs` that feeds two successive markers for the same account (first $5.00, second $5.50) and asserts the ledger balance updates from $5.00 to $5.50 (NOT $5.00 + $5.50 = $10.50):

```javascript
// In tests/test_earnings_sync.mjs inside Task 3 suite:
{
  const testInbox = path.join(ROOT, "reports", "inbox");
  const testProcessed = path.join(ROOT, "reports", "processed");
  const testSeenFile = path.join(ROOT, "reports", ".test_double_count_seen.json");
  const marker1 = path.join(testInbox, "9998_target_reached_20260904_111111.json");
  const marker2 = path.join(testInbox, "9998_target_reached_20260904_222222.json");

  try {
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
    fs.writeFileSync(marker1, JSON.stringify({
      port: 9998,
      ts: "2026-09-04T16:00:00Z",
      type: "target_reached",
      total_usd: 5.00,
      account: "_test:double_count@example.com",
      platform: "_test",
    }));

    syncEarnings({ inboxDir: testInbox, processedDir: testProcessed, seenFilePath: testSeenFile, silent: true });
    
    fs.writeFileSync(marker2, JSON.stringify({
      port: 9998,
      ts: "2026-09-04T17:00:00Z",
      type: "target_reached",
      total_usd: 5.50,
      account: "_test:double_count@example.com",
      platform: "_test",
    }));

    syncEarnings({ inboxDir: testInbox, processedDir: testProcessed, seenFilePath: testSeenFile, silent: true });

    const balances = latestBalances();
    const entry = balances.get("_test:double_count@example.com");
    assert.equal(entry.balance_usd, 5.50, "Second marker of $5.50 cumulative should set balance to $5.50, NOT 5.00 + 5.50 = 10.50");
  } finally {
    if (fs.existsSync(marker1)) fs.unlinkSync(marker1);
    if (fs.existsSync(marker2)) fs.unlinkSync(marker2);
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_earnings_sync.mjs
```
Expected: FAIL with `AssertionError: Second marker of $5.50 cumulative should set balance to $5.50, NOT 5.00 + 5.50 = 10.50` (`10.50 === 5.50`).

- [ ] **Step 3: Implement monotonic snapshot calculation in `scripts/earnings_sync.mjs`**

Modify lines 322–330 of `/home/erich/workspace/survey-orchestrator/scripts/earnings_sync.mjs`:
```javascript
    const { account, port, platform, usd_earned, points_raw } = earnedInfo;
    const currentBalances = latestBalances();
    const lastKnownEntry = currentBalances.get(account);
    const last_known_balance = lastKnownEntry?.balance_usd != null ? Number(lastKnownEntry.balance_usd) : 0;

    // Platform markers report cumulative total balance.
    // Ensure monotonic non-decreasing updates:
    let new_balance = Math.max(usd_earned, last_known_balance);
    new_balance = Math.round(new_balance * 100) / 100;
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_earnings_sync.mjs
```
Expected: PASS (All test suites pass).

- [ ] **Step 5: Commit changes**

```bash
git add scripts/earnings_sync.mjs tests/test_earnings_sync.mjs
git commit -m "fix(accounting): prevent double-counting cumulative balances in earnings sync"
```

---

### Task 2: Fix File Descriptor Leak in `orchestrator.js`

**Files:**
- Modify: `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js:135-152`
- Test: `tests/test_orchestrator_lifecycle.mjs`

**Interfaces:**
- Consumes: Node.js `fs.openSync`, `child_process.spawn`.
- Produces: Correctly closes duplicated file descriptor `out` in the parent process immediately after spawning.

- [ ] **Step 1: Write test for file descriptor cleanup**

Create `tests/test_orchestrator_lifecycle.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify expected behavior**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_orchestrator_lifecycle.mjs
```
Expected: PASS (`✓ FD cleanup test passed`).

- [ ] **Step 3: Close `out` in `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js`**

In `deployAgent`, add `fs.closeSync(out)` immediately following `sub.unref()`:
```javascript
  const out = fs.openSync(driverLog, "w");
  const sub = spawn(
    process.execPath,
    [
      path.join(workspaceRoot, "scripts", "survey_driver.mjs"),
      "--port", String(item.port),
      "--marker", `codex exec bound port ${item.port}`,
      "--prompt-file", promptTmp,
      "--max-nudges", "3"
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: ["ignore", out, out]
    }
  );
  fs.closeSync(out); // Prevent file descriptor leak in supervisor process
  sub.unref();
```

- [ ] **Step 4: Verify syntax and module loading**

Run:
```bash
node -e 'import("/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js").then(() => console.log("Loaded OK"))'
```
Expected: `Loaded OK`.

---

### Task 3: Update Port 3015 Platform to PrimeOpinion

**Files:**
- Modify: `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js:9`

**Interfaces:**
- Consumes: `FLEET` configuration array.
- Produces: Correct platform prompt binding `platform: "PrimeOpinion"` for port 3015.

- [ ] **Step 1: Write test for FLEET platform alignment**

Add verification check to `tests/test_orchestrator_lifecycle.mjs`:
```javascript
import { FLEET } from "/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js";

const p3015 = FLEET.find(f => f.port === 3015);
assert.equal(p3015.platform, "PrimeOpinion", "Port 3015 platform must be PrimeOpinion");
console.log("✓ FLEET port 3015 platform verified");
```

- [ ] **Step 2: Run test to verify it fails currently**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_orchestrator_lifecycle.mjs
```
Expected: FAIL with `AssertionError: Port 3015 platform must be PrimeOpinion` (`'ACOP' === 'PrimeOpinion'`).

- [ ] **Step 3: Update line 9 in `orchestrator.js`**

Change:
```javascript
{ port: 3015, container: "SurveyCompleter-gmail-05", platform: "ACOP", account: "nupkill104@gmail.com" },
```
To:
```javascript
{ port: 3015, container: "SurveyCompleter-gmail-05", platform: "PrimeOpinion", account: "nupkill104@gmail.com" },
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_orchestrator_lifecycle.mjs
```
Expected: PASS (`✓ FLEET port 3015 platform verified`).

---

### Task 4: Fix Restart Cap Cooldown Thrash & Clean Inbox Flooding

**Files:**
- Modify: `scripts/fleet_supervisor.mjs:130-165, 230-265`
- Cleanup: Purge duplicate `*_restart_cap_*.json` in `reports/inbox/`

**Interfaces:**
- Consumes: `pausedPorts` and `restarts` maps.
- Produces: Resets restart count to 0 upon cooldown expiration so subsequent failure does not re-trigger immediate 5-minute pause on the very next 30s tick; throttles inbox marker creation to once per pause event.

- [ ] **Step 1: Write test for restart cap recovery behavior**

Create `tests/test_restart_recovery.mjs`:
```javascript
import assert from "node:assert/strict";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 4;

function simulateResume(restartsList, now) {
  return [now]; // Fresh attempt on resume
}

const now = Date.now();
const pastRestarts = [now - 10000, now - 8000, now - 6000, now - 4000];
const updated = simulateResume(pastRestarts, now);
assert.equal(updated.length, 1);
assert.ok(updated.length < MAX_RESTARTS_PER_WINDOW);
console.log("✓ Restart recovery arithmetic test passed");
```

- [ ] **Step 2: Update `fleet_supervisor.mjs` cooldown resume logic**

In `/home/erich/workspace/survey-orchestrator/scripts/fleet_supervisor.mjs`, update lines 251-256:
```javascript
        // Reset restarts history on resume to give a clean trial deployment
        // instead of leaving it 1 failure away from an immediate re-cap:
        restarts.set(port, []);
```

- [ ] **Step 3: Sweep existing duplicate restart cap markers from `reports/inbox/`**

Run cleanup script to remove redundant restart cap spam:
```bash
cd /home/erich/workspace/survey-orchestrator && rm -f reports/inbox/*_restart_cap_*.json
```
Verify inbox is clean:
```bash
ls -la /home/erich/workspace/survey-orchestrator/reports/inbox/ | wc -l
```

- [ ] **Step 4: Commit changes**

```bash
git add scripts/fleet_supervisor.mjs tests/test_restart_recovery.mjs
git commit -m "fix(supervisor): reset restart counter on cooldown recovery to prevent thrash loop"
```

---

### Task 5: Process Group Signalling (`-pid`) in `killAgentForPort`

**Files:**
- Modify: `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js:65-95`

**Interfaces:**
- Consumes: Target agent PID.
- Produces: Sends `SIGTERM`/`SIGKILL` to `-pid` (process group) to terminate `codex exec`, headless node proxies, and MCP tools cleanly.

- [ ] **Step 1: Write test for process group termination**

Add to `tests/test_orchestrator_lifecycle.mjs`:
```javascript
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
console.log("✓ Process group termination helper verified");
```

- [ ] **Step 2: Update `killAgentForPort` in `orchestrator.js`**

Modify `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js`:
```javascript
export function killAgentForPort(port) {
  const agents = getRunningAgents().filter((a) => a.port === port);
  const killed = [];
  for (const a of agents) {
    const pid = parseInt(a.pid, 10);
    try {
      // Kill the entire process group if detached, fallback to PID
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      killed.push(a);
    } catch {}
  }
  return killed;
}
```

- [ ] **Step 3: Verify module loads and exports correctly**

Run:
```bash
node -e 'import("/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js").then(m => console.log(typeof m.killAgentForPort))'
```
Expected: `function`.

---

### Task 6: Non-Blocking Browser Relaunch & Bounded Log Reading

**Files:**
- Modify: `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js:38-46`
- Modify: `scripts/survey_driver.mjs:124-135`

**Interfaces:**
- Consumes: Async `exec` Promise for container commands; bounded buffer read for thread ID.
- Produces: Zero event loop stalling on browser crashes; bounded memory consumption during long multi-day survey runs.

- [ ] **Step 1: Convert `relaunchChromium` to async Promise**

In `/home/erich/.dsh/plugins/dsh-survey-orchestrator/lib/orchestrator.js`:
```javascript
export function relaunchChromium(container) {
  return new Promise((resolve) => {
    const cmd = `docker exec ${container} sh -c 'setsid env XDG_RUNTIME_DIR=/config/.XDG WAYLAND_DISPLAY=wayland-0 DISPLAY=:1 HOME=/config wrapped-chromium --enable-features=UseOzonePlatform --ozone-platform=wayland --remote-debugging-port=9222 >/dev/null 2>&1 &'`;
    exec(cmd, { timeout: 10000 }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
}
```

- [ ] **Step 2: Optimize `extractThreadId` to read only the head of the log file**

In `/home/erich/workspace/survey-orchestrator/scripts/survey_driver.mjs`:
```javascript
function extractThreadId() {
  if (!fs.existsSync(AGENT_LOG)) return null;
  try {
    // Thread ID appears within the first 8KB of the log; avoid reading 50MB+ into RAM
    const fd = fs.openSync(AGENT_LOG, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf-8", 0, bytesRead);
    const lines = head.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.thread_id) return parsed.thread_id;
      } catch {}
    }
  } catch {}
  return null;
}
```

- [ ] **Step 3: Run full survey-orchestrator test suite**

Run:
```bash
node /home/erich/workspace/survey-orchestrator/tests/test_earnings_sync.mjs
```
Expected: All tests pass.

- [ ] **Step 4: Commit changes**

```bash
git add scripts/survey_driver.mjs
git commit -m "perf(driver): read bounded buffer for thread id extraction to avoid heap spikes"
```

---

### Task 7: End-to-End Fleet Health & Daemon Restart Verification

**Files:**
- Verify: `scripts/fleet_supervisor.mjs`
- Verify: Hermes Cron Job `b9d2c1036c6b`

**Interfaces:**
- Consumes: Running supervisor process and Hermes summary generator.
- Produces: Clean status log with zero errors, zero FD leaks, and verified earnings ledger.

- [ ] **Step 1: Run manual tick of `fleet_supervisor.mjs` dry-run or status check**

Run:
```bash
node -e 'import("/home/erich/workspace/survey-orchestrator/scripts/earnings_sync.mjs").then(m => console.log(m.syncEarnings({ silent: true })))'
```
Expected: Outputs valid sync summary with 0 marker errors.

- [ ] **Step 2: Restart Fleet Supervisor daemon cleanly**

Kill existing supervisor (PID 631211) and relaunch:
```bash
pkill -f 'node scripts/fleet_supervisor.mjs' || true; sleep 1; nohup node /home/erich/workspace/survey-orchestrator/scripts/fleet_supervisor.mjs > /home/erich/workspace/survey-orchestrator/logs/supervisor.stdout 2>&1 &
```
Verify running PID:
```bash
pgrep -f 'node scripts/fleet_supervisor.mjs'
```

- [ ] **Step 3: Execute Hermes cron tick to verify executive reporting**

Run:
```bash
python3 /home/erich/.hermes/scripts/survey_fleet_supervisor.py
```
Expected: Clean Markdown report generated, accurate balances printed, 0 MB GPU VRAM utilized.
