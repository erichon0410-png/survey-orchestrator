// scripts/system1_runner.mjs — System 1 Fast-Path Execution Engine & CDP Integration
//
// Combines lightweight in-page control harvesting (<15ms), heuristic demographic decision,
// anti-speeding human pacing regulation, and trusted Bézier mouse kinematics into a single
// non-autoregressive execution pass.

import os from "node:os";
import path from "node:path";
import { harvestControls } from "./harvest_controls.mjs";
import { evaluateControls, evaluateControlsNeural, MEI_LIN_CHEN_PERSONA } from "./system1_decision.mjs";
import { getPacingSchedule, sleep, enforcePageDwell } from "./human_pacer.mjs";
import { stealthClick, injectVirtualCursor } from "./stealth_mouse.mjs";
import { selectPageTarget } from "./cdp_readonly.mjs";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

/**
 * Selects an active survey questionnaire or prescreener target from the target list,
 * preferring questionnaire pages over account dashboards.
 */
export function selectSurveyTarget(targets, options = {}) {
  if (options.target) return options.target;
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const pages = targets.filter((t) => t && (t.type === "page" || t.type === "iframe" || !t.type) && /^https?:\/\//i.test(t.url));
  if (pages.length === 0) return null;

  if (options.match) {
    const matched = pages.filter((t) => (t.url || "").toLowerCase().includes(options.match.toLowerCase()));
    if (matched.length > 0) return matched[matched.length - 1];
  }

  if (pages.length > 1) {
    const surveyPages = pages.filter((t) => {
      try {
        const u = new URL(t.url);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.replace(/\/+$/, "").toLowerCase();
        if (host.includes("swagbucks.com") && (path === "" || path.startsWith("/surveys") || path.startsWith("/dashboard"))) {
          return false;
        }
        if (host.includes("surveyjunkie.com") && (path === "" || path.startsWith("/surveys") || path.startsWith("/dashboard"))) {
          return false;
        }
        const low = (t.url || "").toLowerCase();
        if (low.includes("recaptcha") || low.includes("doubleclick") || low.includes("googlesyndication") || low.includes("service-worker")) {
          return false;
        }
        return low.includes("prescreener") || low.includes("survey") || low.includes("screener") || low.includes("decipher") || low.includes("qualtrics") || low.includes("samplicio") || low.includes("cloudfront") || !host.includes("swagbucks.com");
      } catch {
        return false;
      }
    });
    if (surveyPages.length > 0) {
      const iframeTarget = surveyPages.find((t) => t.type === "iframe");
      if (iframeTarget) return iframeTarget;
      return surveyPages[surveyPages.length - 1];
    }
  }
  return selectPageTarget(targets, options);
}

/**
 * Manages a bounded CDP session over WebSocket on a selected target page.
 *
 * @param {number} port - CDP remote debugging port
 * @param {Object} [options={}] - Connection options (host, timeoutMs)
 * @param {Function} fn - Async callback receiving (send, ws)
 * @returns {Promise<any>}
 */
export async function withCDPSession(port, options = {}, fn) {
  const host = options.host || "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 15_000;

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  let list;
  try {
    const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: ac.signal });
    if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
    list = await res.json();
  } finally {
    clearTimeout(to);
  }

  const target = selectSurveyTarget(list, options);
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(`No active page target found on port ${port}`);
  }

  const wsUrl = String(target.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://${host}:${port}/cdp`);
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (e) => reject(new Error(`ws connect: ${e && e.message ? e.message : "connect error"}`)));
    setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
  });

  const seq = { n: 0 };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq.n;
      const sendTimeout = setTimeout(() => {
        ws.off("message", h);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      const h = (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(sendTimeout);
        ws.off("message", h);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result ?? {});
        }
      };
      ws.on("message", h);
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    const isIframe = target?.type === "iframe";
    return await fn(send, ws, { target, isIframe });
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/**
 * Runs fast-path decision and human-paced execution on an active CDP session send function.
 *
 * @param {Function} send - CDP send function (method, params)
 * @param {Object} [options={}]
 * @returns {Promise<Object>} Execution result object
 */
async function runFastPath(send, options = {}) {
  const persona = options.persona || MEI_LIN_CHEN_PERSONA;
  const sleepFn = options.sleepFn || sleep;

  // 1. Harvest in-page controls
  let harvested;
  try {
    harvested = await harvestControls(send);
  } catch (err) {
    return {
      handled: false,
      reason: `harvest_error: ${err.message || String(err)}`,
    };
  }

  if (!harvested || !Array.isArray(harvested.controls) || harvested.controls.length === 0) {
    return {
      handled: false,
      reason: "no_controls",
    };
  }

  // 2. Fast-path decision evaluation (Tier 1: local heuristic <0.01ms)
  let decision = evaluateControls(harvested, persona);

  // If local heuristic cannot handle it and neural Laya is enabled (Tier 2: Unsloth Studio Laya ~100ms)
  const enableNeuralLaya = options.useNeuralLaya ?? (
    options.fetchFn != null ||
    process.env.SURVEY_NEURAL_LAYA === "1" ||
    process.env.ENABLE_NEURAL_LAYA === "true" ||
    (!options.send && process.env.SURVEY_NEURAL_LAYA !== "0")
  );
  if ((!decision || !decision.canHandle) && enableNeuralLaya) {
    const neuralRes = await evaluateControlsNeural(harvested, persona, options);
    if (neuralRes && neuralRes.canHandle) {
      decision = neuralRes;
    }
  }

  if (!decision || !decision.canHandle) {
    // Handle interstitial/transition pages that have ONLY a next/submit button
    const nextBtn = harvested.nextButton;
    const actionableCount = harvested.controls?.filter((c) => !c.isSubmitOrNext).length || 0;
    if (nextBtn && actionableCount === 0) {
      // Pure interstitial page — just click Continue/Next after reading dwell
      const interstitialDwell = 2000 + Math.floor(Math.random() * 2000);
      await sleepFn(interstitialDwell);
      await stealthClick(send, nextBtn, { ...options, isIframe: options.isIframe });
      return {
        handled: true,
        action: "interstitial_advance",
        decision: { type: "interstitial", reason: "Only submit/next button present" },
        pacedMs: interstitialDwell,
        optionClicked: nextBtn.label,
        nextClicked: true,
      };
    }
    return {
      handled: false,
      reason: decision?.reason || "needs_system2",
    };
  }

  const targetControl = decision.targetControl;
  if (!targetControl) {
    return {
      handled: false,
      reason: "missing_target_control",
    };
  }

  // 3. Compute pacing schedule
  const questionText = harvested.question || harvested.questionText || targetControl.label || "";
  const candidateOptions = harvested.radios?.length
    ? harvested.radios
    : harvested.controls.filter((c) => !c.isSubmitOrNext && (c.role === "radio" || c.role === "checkbox" || c.role === "option"));

  const schedule = getPacingSchedule(questionText, candidateOptions, options.pacingConfig || {});

  // 4. Reading delay
  if (schedule.readingMs > 0) {
    await sleepFn(schedule.readingMs);
  }

  // 5. Pre-click hover / deliberation dwell
  if (schedule.preClickDwellMs > 0) {
    await sleepFn(schedule.preClickDwellMs);
  }

  // 6. Dispatch action: text entry or stealth click
  if (decision.type === "text") {
    const textVal = decision.textValue;
    const sel = targetControl.selector;
    await send("Runtime.evaluate", {
      expression: `(() => {
        let inp = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : `null`};
        if (!inp && ${JSON.stringify(targetControl.x)} > 0) inp = document.elementFromPoint(${targetControl.x}, ${targetControl.y});
        if (!inp) inp = document.querySelector('input[type=text], input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea');
        if (!inp) return false;
        inp.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (nativeSetter) nativeSetter.call(inp, ${JSON.stringify(textVal)});
        else inp.value = ${JSON.stringify(textVal)};
        const k = Object.keys(inp).find(x => x.startsWith('__reactProps') || x.startsWith('__reactEventHandlers'));
        if (k && inp[k] && typeof inp[k].onChange === 'function') {
          try { inp[k].onChange({ target: inp, currentTarget: inp, persist: () => {}, preventDefault: () => {}, stopPropagation: () => {} }); } catch {}
        }
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
  } else {
    await stealthClick(send, targetControl, { ...options, isIframe: options.isIframe });
  }

  // 7. Post-click dwell
  if (schedule.postClickDwellMs > 0) {
    await sleepFn(schedule.postClickDwellMs);
  }

  // 8. If next button present and submission allowed, advance page
  let nextClicked = false;
  let totalPacedMs = schedule.readingMs + schedule.preClickDwellMs + schedule.postClickDwellMs;

  let nextButton = harvested.nextButton;
  if (!nextButton && options.allowSubmit !== false) {
    try {
      const refreshed = await harvestControls(send);
      if (refreshed?.nextButton) {
        nextButton = refreshed.nextButton;
      }
    } catch {}
  }

  if (nextButton && options.allowSubmit !== false) {
    if (schedule.preSubmitDwellMs > 0) {
      await sleepFn(schedule.preSubmitDwellMs);
      totalPacedMs += schedule.preSubmitDwellMs;
    }
    await stealthClick(send, nextButton, { ...options, isIframe: options.isIframe });
    nextClicked = true;
  }

  // Optional page dwell enforcement if pageStartTime is provided
  if (options.pageStartTime && options.minPageDwellMs) {
    const dwellRes = await enforcePageDwell(options.pageStartTime, options.minPageDwellMs, sleepFn);
    if (dwellRes.waited) {
      totalPacedMs += dwellRes.remainingMs;
    }
  }

  return {
    handled: true,
    action: "fastpath_completed",
    decision,
    pacedMs: totalPacedMs,
    optionClicked: targetControl.label,
    nextClicked,
    dwellMilestones: {
      readingMs: schedule.readingMs,
      preClickDwellMs: schedule.preClickDwellMs,
      postClickDwellMs: schedule.postClickDwellMs,
      preSubmitDwellMs: schedule.preSubmitDwellMs,
      totalDwellMs: schedule.totalDwellMs,
    },
  };
}

/**
 * Attempts fast-path execution against a remote browser port or pre-connected session.
 *
 * @param {number} port - CDP remote port (ignored if options.send is passed)
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function tryExecuteFastPath(port, options = {}) {
  try {
    if (typeof options.send === "function") {
      return await runFastPath(options.send, options);
    }

    return await withCDPSession(port, options, async (send, ws, meta) => {
      if (!meta?.isIframe) {
        try {
          await injectVirtualCursor(send);
        } catch {}
      }
      return await runFastPath(send, { ...options, isIframe: meta?.isIframe });
    });
  } catch (err) {
    return {
      handled: false,
      reason: `cdp_connection_failed: ${err.message || String(err)}`,
    };
  }
}
