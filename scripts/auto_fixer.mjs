#!/usr/bin/env node
// scripts/auto_fixer.mjs — bounded runtime self-heal for fleet ports (Node ESM, stdlib only).
//
// The supervisor calls tick(psLines) once per poll. For each FLEET port the fixer
// detects one of four states and applies a bounded, idempotent remediation ladder:
//
//   healthy        -> do nothing
//   container_down -> docker start <container>  -> wait for CDP
//   cdp_offline    -> relaunch chromium in-container -> wait for CDP
//   driver_dead    -> redeploy the agent (container + CDP already verified up)
//
// After CDP is confirmed up, a dead driver is redeployed as part of the same repair.
//
// Boundaries (fail-closed):
//   - at most maxAttempts failed repairs per port within cooldownMs; on exhaustion a
//     fail-closed marker reports/inbox/<port>_autofix_failed.json is written and no
//     further attempts are made until resume_at elapses (backoff). The stale marker
//     is reconciled (deleted) when the port is healthy or the cooldown expires.
//   - CDP waits are bounded: one initial probe plus cdpWaitMs/cdpPollMs polls.
//   - writes go ONLY to reports/ (marker) and logs/ (JSON-line log). Core source
//     files (scripts/, config/, *.mjs, *.sh, *.yaml) are NEVER written by this module.
//
// All probes are injectable; defaults wire the orchestrator plugin + docker CLI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_CDP_WAIT_MS = 15_000;
const DEFAULT_CDP_POLL_MS = 2_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

export function createAutoFixer(opts) {
  const fleet = Array.isArray(opts.fleet) ? opts.fleet : [];
  const root = opts.root;
  const inboxDir = opts.inboxDir || path.join(root, "reports", "inbox");
  const logFile = opts.logFile || path.join(root, "logs", "autofix.log");
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
  const cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const cdpWaitMs = Number(opts.cdpWaitMs) > 0 ? Number(opts.cdpWaitMs) : DEFAULT_CDP_WAIT_MS;
  const cdpPollMs = Number(opts.cdpPollMs) > 0 ? Number(opts.cdpPollMs) : DEFAULT_CDP_POLL_MS;

  const probes = {
    startContainer: async (container) => {
      try {
        execSync(`docker start ${container}`, { timeout: 30_000 });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
    ...opts.probes,
  };

  const attemptsByPort = new Map(); // port -> [timestamps of failed attempts]
  let psLinesCache = [];

  function logLine(obj) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({ ts: iso(now()), ...obj }) + "\n");
    } catch {}
  }

  function markerPath(port) {
    return path.join(inboxDir, `${port}_autofix_failed.json`);
  }

  function readMarker(port) {
    try {
      return JSON.parse(fs.readFileSync(markerPath(port), "utf-8"));
    } catch {
      return null;
    }
  }

  function writeMarker(port, container, attempts, lastError, resumeAtMs) {
    try {
      fs.mkdirSync(inboxDir, { recursive: true });
      const body = {
        port,
        container,
        ts: iso(now()),
        attempts,
        last_error: lastError || null,
        resume_at: new Date(resumeAtMs).toISOString(),
        note: "auto-fixer fail-closed: remediation attempt cap exhausted; backoff active until resume_at",
      };
      fs.writeFileSync(markerPath(port), JSON.stringify(body, null, 2) + "\n");
    } catch (e) {
      logLine({ port, event: "autofix_marker_write_error", error: String(e && e.message || e) });
    }
  }

  function clearMarker(port) {
    try {
      fs.unlinkSync(markerPath(port));
    } catch {}
  }

  // Bounded CDP wait: one initial probe, then polls until cdpWaitMs elapses.
  async function waitCdp(port) {
    const maxPolls = Math.max(1, Math.ceil(cdpWaitMs / cdpPollMs));
    for (let i = 0; i <= maxPolls; i++) {
      let cdp = null;
      try {
        cdp = await probes.checkCdp(port);
      } catch {}
      if (cdp && cdp.ok) return true;
      if (i < maxPolls) await sleep(cdpPollMs);
    }
    return false;
  }

  // Detection: first failing layer wins.
  async function assessPort(item) {
    let running = false;
    try {
      running = await probes.isContainerRunning(item.container);
    } catch {}
    if (!running) return "container_down";
    let cdp = null;
    try {
      cdp = await probes.checkCdp(item.port);
    } catch {}
    if (!cdp || !cdp.ok) return "cdp_offline";
    let alive = false;
    try {
      alive = probes.isPortAlive(item.port, psLinesCache);
    } catch {}
    if (!alive) return "driver_dead";
    return "healthy";
  }

  function recordFailure(item, error) {
    const t = now();
    const hist = (attemptsByPort.get(item.port) || []).filter((x) => t - x < cooldownMs);
    hist.push(t);
    attemptsByPort.set(item.port, hist);
    let markerWritten = false;
    if (hist.length >= maxAttempts) {
      writeMarker(item.port, item.container, hist.length, error, t + cooldownMs);
      markerWritten = true;
    }
    logLine({ port: item.port, container: item.container, event: "autofix_attempt_failed", error, attempts: hist.length, marker_written: markerWritten });
    return { ok: false, error };
  }

  async function fixPort(item) {
    const state = await assessPort(item);
    if (state === "healthy") return { port: item.port, state: "healthy", ok: true, steps: [] };

    const steps = [];
    let cdpUp;
    try {
      if (state === "container_down") {
        const s = await probes.startContainer(item.container);
        steps.push("start_container");
        if (!s || !s.ok) return recordFailure(item, "start_container_failed");
        cdpUp = await waitCdp(item.port);
        steps.push("wait_cdp");
      } else if (state === "cdp_offline") {
        const r = await probes.relaunchChromium(item.container);
        steps.push("relaunch_chromium");
        if (!r || !r.ok) return recordFailure(item, "relaunch_chromium_failed");
        cdpUp = await waitCdp(item.port);
        steps.push("wait_cdp");
      } else {
        // driver_dead: container + CDP already verified healthy by assessPort.
        cdpUp = true;
      }
    } catch (e) {
      return recordFailure(item, String(e && e.message || e));
    }

    if (!cdpUp) return recordFailure(item, "cdp_not_up_after_wait");

    let alive = false;
    try {
      alive = probes.isPortAlive(item.port, psLinesCache);
    } catch {}
    if (!alive) {
      let d = null;
      try {
        d = await probes.deployAgent(item);
      } catch (e) {
        return recordFailure(item, String(e && e.message || e));
      }
      steps.push("deploy_agent");
      if (!d || !d.ok) return recordFailure(item, "deploy_failed");
    }

    attemptsByPort.set(item.port, []);
    logLine({ port: item.port, container: item.container, event: "autofix_repaired", from_state: state, steps });
    return { port: item.port, state: "repaired", ok: true, steps };
  }

  async function tick(psLines) {
    psLinesCache = Array.isArray(psLines) ? psLines : [];
    const out = { healthy: [], repaired: [], failed: [], cooldown: [] };
    for (const item of [...fleet].sort((a, b) => a.port - b.port)) {
      // Reconcile fail-closed state before touching the port.
      const marker = readMarker(item.port);
      if (marker) {
        const resumeAt = Date.parse(marker.resume_at);
        if (Number.isFinite(resumeAt) && now() < resumeAt) {
          out.cooldown.push(item.port);
          continue;
        }
        clearMarker(item.port); // stale: cooldown elapsed or externally cleared
        attemptsByPort.set(item.port, []);
      }

      const res = await fixPort(item);
      if (res.ok) {
        if (res.state === "healthy") out.healthy.push(item.port);
        else out.repaired.push(item.port);
      } else {
        out.failed.push(item.port);
      }
    }
    return out;
  }

  return { assessPort, fixPort, tick };
}

// --- standalone CLI: one repair pass over the whole fleet --------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.SURVEY_ROOT || path.resolve(__dirname, "..");
  const ORCH_PATH = process.env.DSH_ORCHESTRATOR || path.join(
    (await import("node:os")).homedir(), ".dsh", "plugins", "dsh-survey-orchestrator", "lib", "orchestrator.js"
  );
  const { FLEET, isContainerRunning, checkCdp, relaunchChromium, deployAgent } = await import(ORCH_PATH);
  let psLines = [];
  try {
    psLines = String(execSync("ps -eo args", { timeout: 5000 })).split("\n");
  } catch {}

  const fixer = createAutoFixer({
    fleet: FLEET,
    root: ROOT,
    inboxDir: path.join(ROOT, "reports", "inbox"),
    logFile: path.join(ROOT, "logs", "autofix.log"),
    probes: { isContainerRunning, checkCdp, relaunchChromium, deployAgent, isPortAlive: (port) => psLines.some((l) => l.includes("survey_driver.mjs") && l.includes(`bound port ${port}`)) },
  });
  const result = await fixer.tick(psLines);
  console.log(JSON.stringify(result, null, 2));
}
