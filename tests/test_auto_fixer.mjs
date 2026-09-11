// tests/test_auto_fixer.mjs — supervisor auto-fixer contract tests.
// Run: node --test tests/test_auto_fixer.mjs   (exit 0 = pass)
//
// Covers the approved Part B design:
//   - detection states: container_down / cdp_offline / driver_dead / healthy
//   - bounded, idempotent remediation ladder (start container -> wait CDP ->
//     relaunch chromium -> redeploy agent)
//   - attempt cap + backoff cooldown with fail-closed marker
//     reports/inbox/<port>_autofix_failed.json
//   - GUARDRAIL: the auto-fixer never writes core source files
//     (scripts/, config/, *.mjs, *.sh, *.yaml) — only reports/ and logs/.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAutoFixer } from "../scripts/auto_fixer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-test-"));
  fs.mkdirSync(path.join(dir, "reports", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

// --- probes helper -----------------------------------------------------------
function makeProbes({ containerRunning = true, cdpOk = true, driverAlive = true } = {}) {
  const calls = { startContainer: 0, relaunchChromium: 0, deployAgent: 0 };
  return {
    calls,
    probes: {
      isContainerRunning: async () => containerRunning,
      checkCdp: async () => ({ ok: cdpOk }),
      startContainer: async () => { calls.startContainer++; return { ok: true }; },
      relaunchChromium: async () => { calls.relaunchChromium++; return { ok: true }; },
      deployAgent: async () => { calls.deployAgent++; return { ok: true, pid: 4242 }; },
      isPortAlive: () => driverAlive,
    },
  };
}

function makeFixer(root, probes, opts = {}) {
  return createAutoFixer({
    fleet: [{ port: 3099, container: "TestContainer-99" }],
    root,
    inboxDir: path.join(root, "reports", "inbox"),
    logFile: path.join(root, "logs", "autofix.log"),
    probes,
    now: opts.now ?? (() => Date.now()),
    sleep: async () => {}, // no real waiting in tests
    maxAttempts: opts.maxAttempts ?? 3,
    cooldownMs: opts.cooldownMs ?? 60_000,
    cdpWaitMs: opts.cdpWaitMs ?? 1000,
    cdpPollMs: opts.cdpPollMs ?? 500,
  });
}

// === T1: detection matrix =====================================================
{
  const root = tmpRoot();
  let p = makeProbes({ containerRunning: true, cdpOk: true, driverAlive: true });
  assert.equal(await makeFixer(root, p.probes).assessPort({ port: 3099, container: "TestContainer-99" }), "healthy", "all green -> healthy");

  p = makeProbes({ containerRunning: false, cdpOk: false, driverAlive: false });
  assert.equal(await makeFixer(root, p.probes).assessPort({ port: 3099, container: "TestContainer-99" }), "container_down", "stopped container -> container_down");

  p = makeProbes({ containerRunning: true, cdpOk: false, driverAlive: false });
  assert.equal(await makeFixer(root, p.probes).assessPort({ port: 3099, container: "TestContainer-99" }), "cdp_offline", "CDP down -> cdp_offline");

  p = makeProbes({ containerRunning: true, cdpOk: true, driverAlive: false });
  assert.equal(await makeFixer(root, p.probes).assessPort({ port: 3099, container: "TestContainer-99" }), "driver_dead", "no live driver -> driver_dead");
  console.log("PASS T1 detection matrix");
}

// === T2: container_down ladder — start once, wait CDP, no deploy when driver alive ===
{
  const root = tmpRoot();
  let cdpCalls = 0;
  const probes = {
    isContainerRunning: async () => false,
    checkCdp: async () => ({ ok: cdpCalls++ >= 2 }), // comes up on 3rd poll
    startContainer: async () => ({ ok: true }),
    relaunchChromium: async () => ({ ok: true }),
    deployAgent: async () => ({ ok: true, pid: 1 }),
    isPortAlive: () => true, // driver alive -> no redeploy needed
  };
  const fixer = makeFixer(root, probes);
  const res = await fixer.fixPort({ port: 3099, container: "TestContainer-99" });
  assert.equal(res.ok, true, "container_down repair must succeed once CDP comes up");
  assert.equal(res.state, "repaired");
  assert.ok(!res.steps.includes("deploy_agent"), "driver alive -> deploy_agent step not expected");
  console.log("PASS T2 container_down ladder");
}

// === T3: cdp_offline ladder — relaunch chromium, then redeploy dead driver ===
{
  const root = tmpRoot();
  let cdpCalls = 0;
  const probes = {
    isContainerRunning: async () => true,
    checkCdp: async () => ({ ok: cdpCalls++ >= 1 }), // offline at assess, up after relaunch
    startContainer: async () => ({ ok: true }),
    relaunchChromium: async () => ({ ok: true }),
    deployAgent: async () => ({ ok: true, pid: 2 }),
    isPortAlive: () => false, // driver dead -> must redeploy
  };
  const fixer = makeFixer(root, probes);
  const res = await fixer.fixPort({ port: 3099, container: "TestContainer-99" });
  assert.equal(res.ok, true, "cdp_offline repair must succeed");
  assert.ok(res.steps.includes("relaunch_chromium"), "must relaunch chromium for cdp_offline");
  assert.ok(res.steps.includes("deploy_agent"), "dead driver must be redeployed after CDP is up");
  console.log("PASS T3 cdp_offline ladder + redeploy");
}

// === T4: attempt cap, backoff cooldown, fail-closed marker =====================
{
  const root = tmpRoot();
  const inbox = path.join(root, "reports", "inbox");
  const markerPath = path.join(inbox, "3099_autofix_failed.json");

  let t = 1_000_000;
  let startCalls = 0;
  const probes = {
    isContainerRunning: async () => false, // never recovers
    checkCdp: async () => ({ ok: false }),
    startContainer: async () => { startCalls++; return { ok: true }; },
    relaunchChromium: async () => ({ ok: true }),
    deployAgent: async () => ({ ok: true, pid: 3 }),
    isPortAlive: () => false,
  };
  const fixer = makeFixer(root, probes, { now: () => t, maxAttempts: 3, cooldownMs: 60_000 });
  const item = { port: 3099, container: "TestContainer-99" };

  for (let i = 1; i <= 3; i++) {
    t += 1000; // stay inside the cooldown window between attempts
    await fixer.tick([""]);
  }
  assert.equal(startCalls, 3, "exactly maxAttempts remediation attempts in-window");
  assert.ok(fs.existsSync(markerPath), "fail-closed marker <port>_autofix_failed.json must exist after cap");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.equal(marker.port, 3099);
  assert.equal(marker.attempts, 3);
  assert.ok(marker.resume_at, "marker must carry resume_at");

  // Inside the cooldown: no further remediation attempts.
  const tick4 = await fixer.tick([""]);
  t += 1000;
  assert.equal(startCalls, 3, "no new attempts while in fail-closed cooldown");
  assert.ok(tick4.cooldown.includes(3099), "tick must report the port as in cooldown");

  // Cooldown elapsed: a fresh trial begins and the stale marker is reconciled away.
  t += 61_000;
  await fixer.tick([""]);
  assert.equal(startCalls, 4, "cooldown expiry re-arms remediation (fresh trial)");
  console.log("PASS T4 attempt cap + backoff + fail-closed marker");
}

// === T5: GUARDRAIL — no core source file is ever written =======================
{
  const root = tmpRoot();
  // Build a mini repo tree with real-looking core sources.
  const scriptsDir = path.join(root, "scripts");
  const configDir = path.join(root, "config");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts", "auto_fixer.mjs"), path.join(scriptsDir, "auto_fixer.mjs"));
  fs.copyFileSync(path.join(ROOT, "scripts", "fleet_supervisor.mjs"), path.join(scriptsDir, "fleet_supervisor.mjs"));
  fs.copyFileSync(path.join(ROOT, "config", "earnings_rates.yaml"), path.join(configDir, "earnings_rates.yaml"));

  const hashCore = () => {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out[p] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    };
    walk(scriptsDir);
    walk(configDir);
    for (const f of fs.readdirSync(root)) {
      if (/\.(mjs|sh|yaml)$/.test(f)) out[path.join(root, f)] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
    }
    return out;
  };
  const listFiles = () => {
    const out = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name));
        else out.push(path.join(rel, e.name));
      }
    };
    walk(root, ".");
    return out;
  };

  const before = hashCore();
  const filesBefore = new Set(listFiles());

  // Run a full failing remediation pass so the fixer actually writes (marker + log).
  let t = 2_000_000;
  const probes = {
    isContainerRunning: async () => false,
    checkCdp: async () => ({ ok: false }),
    startContainer: async () => ({ ok: true }),
    relaunchChromium: async () => ({ ok: true }),
    deployAgent: async () => ({ ok: true, pid: 4 }),
    isPortAlive: () => false,
  };
  const fixer = createAutoFixer({
    fleet: [{ port: 3099, container: "TestContainer-99" }],
    root,
    inboxDir: path.join(root, "reports", "inbox"),
    logFile: path.join(root, "logs", "autofix.log"),
    probes,
    now: () => t,
    sleep: async () => {},
    maxAttempts: 3,
    cooldownMs: 60_000,
    cdpWaitMs: 1000,
    cdpPollMs: 500,
  });
  for (let i = 0; i < 3; i++) { t += 1000; await fixer.tick([""]); }

  const after = hashCore();
  assert.deepEqual(after, before, "GUARDRAIL: core source files (scripts/, config/, *.mjs/*.sh/*.yaml) must be byte-identical");

  for (const f of listFiles()) {
    if (!filesBefore.has(f)) {
      const underReports = f.startsWith("reports/") || f === "reports";
      const underLogs = f.startsWith("logs/") || f === "logs";
      assert.ok(underReports || underLogs, `GUARDRAIL: new file ${f} must be under reports/ or logs/`);
    }
  }
  console.log("PASS T5 guardrail: only reports/ and logs/ are written");
}

// === T6: healthy port is a no-op ==============================================
{
  const root = tmpRoot();
  const p = makeProbes({ containerRunning: true, cdpOk: true, driverAlive: true });
  const fixer = makeFixer(root, p.probes);
  const res = await fixer.tick([""]);
  assert.ok(res.healthy.includes(3099), "healthy port reported in healthy[]");
  assert.equal(p.calls.startContainer, 0);
  assert.equal(p.calls.relaunchChromium, 0);
  assert.equal(p.calls.deployAgent, 0, "healthy port must trigger zero remediation actions");
  assert.ok(!fs.existsSync(path.join(root, "reports", "inbox", "3099_autofix_failed.json")));
  console.log("PASS T6 healthy no-op");
}

// === T7: supervisor integration contract =======================================
{
  const supPath = path.join(ROOT, "scripts", "fleet_supervisor.mjs");
  const supCode = fs.readFileSync(supPath, "utf-8");
  assert.ok(supCode.includes("createAutoFixer"), "fleet_supervisor.mjs must wire in createAutoFixer");
  assert.ok(supCode.includes("autofix"), "fleet_supervisor.mjs must log/report autofix outcomes");
  console.log("PASS T7 supervisor integration contract");
}

console.log("\n=== ALL AUTO-FIXER TESTS PASSED ===");
