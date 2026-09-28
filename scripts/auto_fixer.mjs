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
//   target_reached -> steady state: a valid target-reached marker exists and no
//                     driver process is expected (the driver exits cleanly by
//                     design); treated as healthy, never redeployed
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

// Find a marker file matching a regex in the inbox or its archived processed tree.
function findMarker(baseDir, re) {
  try {
    for (const name of fs.readdirSync(baseDir)) {
      const markerPath = path.join(baseDir, name);
      let stat;
      try {
        stat = fs.statSync(markerPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const nested = findMarker(markerPath, re);
        if (nested) return nested;
      } else if (re.test(name)) {
        return markerPath;
      }
    }
  } catch {}
  return null;
}

// Check if an idle-today marker exists for the given port.
function hasIdleTodayMarker(port, inboxDir) {
  const re = new RegExp(`^${port}_idle_today_.*\\.json$`);
  return findMarker(inboxDir, re) !== null || findMarker(path.join(inboxDir, "..", "processed"), re) !== null;
}

// Returns in-page evaluation snippet that detects and dismisses validation errors,
// cookie banners, and stuck prescreener continue buttons.
export function getStallModalScript() {
  return `(() => {
    function isVisible(el) {
      if (!el) return false;
      if (typeof el.checkVisibility === "function") {
        try { if (!el.checkVisibility()) return false; } catch {}
      }
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
        return false;
      }
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      return (rect.width > 0 && rect.height > 0) || (el.offsetWidth > 0 || el.offsetHeight > 0);
    }

    function getText(el) {
      return (el.innerText || el.textContent || "").trim();
    }

    // 1. Validation Error Modals / Banners
    const validationSelectors = [
      ".validation-error",
      "[class*='validation-error']",
      "[id*='validation-error']",
      "[role='alertdialog']",
      "[role='alert']",
      ".error-message",
      ".error-modal"
    ];

    let validationEl = null;
    for (const sel of validationSelectors) {
      try {
        const found = Array.from(document.querySelectorAll(sel)).find(isVisible);
        if (found) {
          validationEl = found;
          break;
        }
      } catch {}
    }

    if (!validationEl) {
      const candidates = Array.from(document.querySelectorAll("div, p, span, h1, h2, h3, h4, h5, h6, strong, em, b"));
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = getText(el);
        if (/missing answer/i.test(text) || /please answer this question/i.test(text) || /please answer/i.test(text)) {
          if (!el.children || el.children.length <= 2) {
            validationEl = el;
            break;
          }
        }
      }
    }

    if (validationEl) {
      const container = (typeof validationEl.closest === "function" ?
        validationEl.closest("[role='dialog'], [role='alertdialog'], .modal, .modal-dialog, .modal-box, .alert-dialog, body") : null) || document;
      const btnCandidates = Array.from(container.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a.btn, .close, [aria-label*='Close' i]"));

      let dismissBtn = null;
      for (const b of btnCandidates) {
        if (!isVisible(b)) continue;
        const bText = getText(b);
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        if (/^(ok|dismiss|close|got it|continue|understand|i understand)$/i.test(bText) ||
            aria.includes("close") || aria.includes("dismiss")) {
          dismissBtn = b;
          break;
        }
      }
      if (!dismissBtn && btnCandidates.length > 0) {
        dismissBtn = btnCandidates.find(isVisible) || null;
      }

      if (dismissBtn) {
        dismissBtn.click();
        return { detected: true, type: "validation_error", actionTaken: "dismiss_modal" };
      }

      if (typeof validationEl.click === "function") {
        validationEl.click();
        return { detected: true, type: "validation_error", actionTaken: "dismiss_modal" };
      }
      return { detected: true, type: "validation_error", actionTaken: "detected" };
    }

    // 2. Cookie Banners & Dialog Overlays
    const oneTrustBtn = document.querySelector("#onetrust-accept-btn-handler");
    if (oneTrustBtn && isVisible(oneTrustBtn)) {
      oneTrustBtn.click();
      return { detected: true, type: "cookie_banner", actionTaken: "clicked_onetrust_accept" };
    }

    const closeButtons = Array.from(document.querySelectorAll("button[aria-label='Close' i], [aria-label='Close' i], button.close, [data-dismiss='modal']"));
    for (const cb of closeButtons) {
      if (isVisible(cb)) {
        cb.click();
        return { detected: true, type: "dialog_overlay", actionTaken: "clicked_close" };
      }
    }

    const allButtons = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a"));
    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const text = getText(btn);
      if (/accept all/i.test(text) || /accept cookies/i.test(text) || /allow all/i.test(text) || /i agree/i.test(text)) {
        btn.click();
        return { detected: true, type: "cookie_banner", actionTaken: "clicked_accept_all" };
      }
    }

    // 3. Stuck Prescreener Continue Buttons
    const continueSelectors = [
      ".continue-btn",
      "button.continue-btn",
      "a.continue-btn",
      "input[value='Continue' i]",
      "button.next-btn",
      ".next-btn"
    ];

    for (const sel of continueSelectors) {
      try {
        const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
        if (btn) {
          btn.click();
          const actionTaken = (sel.includes("next") || (btn.className && String(btn.className).includes("next"))) ? "clicked_next" : "clicked_continue";
          return { detected: true, type: "prescreener_continue", actionTaken };
        }
      } catch {}
    }

    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const text = getText(btn);
      if (/^continue$/i.test(text)) {
        btn.click();
        return { detected: true, type: "prescreener_continue", actionTaken: "clicked_continue" };
      }
    }

    return { detected: false };
  })()`;
}

// Bounded CDP WebSocket evaluation fallback when cdpEvaluate is not injected.
async function cdpEvaluateOverWebSocket(port, host = "127.0.0.1", script, timeoutMs = 5000) {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) return { detected: false };
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return { detected: false };

    const target = list.find((t) => t && t.type === "page" && /^https?:\/\//i.test(String(t.url))) ||
                   list.find((t) => t && t.type === "page") ||
                   list[0];
    if (!target || !target.webSocketDebuggerUrl) return { detected: false };

    const WS = globalThis.WebSocket;
    if (!WS) return { detected: false };

    const wsUrl = String(target.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://${host}:${port}/cdp`);
    const ws = new WS(wsUrl);

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve({ detected: false });
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
      };

      const onMessage = (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : event.toString();
          const msg = JSON.parse(raw);
          if (msg.id === 1001) {
            cleanup();
            const val = msg.result?.result?.value;
            resolve(val && typeof val === "object" ? val : { detected: false });
          }
        } catch {
          cleanup();
          resolve({ detected: false });
        }
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", () => { cleanup(); resolve({ detected: false }); });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({
            id: 1001,
            method: "Runtime.evaluate",
            params: { expression: script, returnByValue: true, awaitPromise: true }
          }));
        });
      } else if (typeof ws.on === "function") {
        ws.on("message", (data) => onMessage({ data }));
        ws.on("error", () => { cleanup(); resolve({ detected: false }); });
        ws.on("open", () => {
          ws.send(JSON.stringify({
            id: 1001,
            method: "Runtime.evaluate",
            params: { expression: script, returnByValue: true, awaitPromise: true }
          }));
        });
      } else {
        cleanup();
        resolve({ detected: false });
      }
    });
  } catch {
    return { detected: false };
  }
}

/**
 * Detects and dismisses stall modals, validation errors, cookie banners,
 * and stuck prescreener continue buttons on the page.
 *
 * @param {number|Object} portOrOpts
 * @param {Object} [maybeOpts]
 * @returns {Promise<{ detected: boolean, type?: string, actionTaken?: string }>}
 */
export async function detectAndDismissStallModals(portOrOpts, maybeOpts = {}) {
  let port;
  let opts;
  if (typeof portOrOpts === "object" && portOrOpts !== null) {
    port = portOrOpts.port;
    opts = portOrOpts;
  } else {
    port = portOrOpts;
    opts = maybeOpts || {};
  }
  const { cdpEvaluate, host = "127.0.0.1" } = opts;
  const script = getStallModalScript();

  let rawResult;
  try {
    if (typeof cdpEvaluate === "function") {
      rawResult = await cdpEvaluate(script);
    } else {
      rawResult = await cdpEvaluateOverWebSocket(port, host, script);
    }
  } catch {
    return { detected: false };
  }

  let result = rawResult;
  if (result && typeof result === "object") {
    if (result.result && typeof result.result.value === "object") {
      result = result.result.value;
    } else if (result.value && typeof result.value === "object") {
      result = result.value;
    }
  }

  if (result && result.detected) {
    return {
      detected: true,
      type: String(result.type || "modal"),
      actionTaken: String(result.actionTaken || "dismissed"),
    };
  }

  return { detected: false };
}

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
    // Default: no target-reached knowledge (legacy behavior). The supervisor wires
    // its hasTargetMarker() so target ports are treated as steady state.
    hasTargetMarker: () => false,
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

  // Target-reached ports have no persistent driver by design (survey_driver.mjs
  // exits cleanly when its marker is present), so "no driver process" there is
  // steady state, not a fault. Mirrors the supervisor deploy loop's convention.
  function targetReached(item) {
    try {
      return !!probes.hasTargetMarker(item.port);
    } catch {
      return false;
    }
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
    if (!alive) return targetReached(item) ? "target_reached" : "driver_dead";
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
    if (state === "target_reached") return { port: item.port, state: "healthy", ok: true, steps: [] };

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
    // After infra repair, redeploy the driver — unless this is a target-reached
    // port, where no persistent driver is expected (it would exit immediately).
    if (!alive && !targetReached(item)) {
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

      // Skip ports with idle-today markers (no surveys available for this platform today).
      if (hasIdleTodayMarker(item.port, inboxDir)) {
        logLine({ port: item.port, event: "autofix_skipped_idle_today", note: "idle-today marker present; no surveys available" });
        out.healthy.push(item.port);
        continue;
      }

      const res = await fixPort(item);
      if (res.ok) {
        if (res.state === "healthy") out.healthy.push(item.port);
        else out.repaired.push(item.port);

        // For active ports that are alive, detect and dismiss stall modals / prescreener continue buttons
        let alive = false;
        try {
          alive = probes.isPortAlive(item.port, psLinesCache);
        } catch {}
        if (alive && !targetReached(item)) {
          try {
            const unstuckFn = opts.detectAndDismissStallModals || probes.detectAndDismissStallModals || detectAndDismissStallModals;
            const evalFn = opts.cdpEvaluate || probes.cdpEvaluate;
            const modalRes = await unstuckFn(item.port, { cdpEvaluate: evalFn });
            if (modalRes && modalRes.detected) {
              logLine({
                port: item.port,
                container: item.container,
                event: "autofix_modal_unstuck",
                type: modalRes.type,
                actionTaken: modalRes.actionTaken,
              });
              if (!out.unstuck) out.unstuck = [];
              out.unstuck.push({ port: item.port, ...modalRes });
            }
          } catch (e) {
            logLine({
              port: item.port,
              container: item.container,
              event: "autofix_modal_unstuck_error",
              error: String(e && e.message || e),
            });
          }
        }
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
