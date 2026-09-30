// scripts/autonomous_survey_loop.mjs — End-to-End Autonomous Survey Loop
// Continuously answers questionnaire questions using System 1 heuristics,
// post-action verification, neural Laya fallback, biological human pacing, and
// anti-loop state escalation. Monitors balance updates and launches subsequent surveys until daily target is met.

import fs from "node:fs";
import path from "node:path";
import { tryExecuteFastPath, selectSurveyTarget, withCDPSession } from "./system1_runner.mjs";
import { autoLaunchDashboardSurvey, isDashboardPage } from "./dashboard_launcher.mjs";
import { detectAndDismissStallModals } from "./auto_fixer.mjs";
import { harvestControls } from "./harvest_controls.mjs";
import { stealthClick } from "./stealth_mouse.mjs";
import { readSwagbucksBalance } from "./read_balance.mjs";

const WS = "/home/erich/workspace/survey-orchestrator";
const TARGET_SB = parseInt(process.env.TARGET_SB || "4330", 10);
const BASELINE_SB = 4230;

function log(msg, detail = null) {
  const ts = new Date().toISOString();
  if (detail) {
    console.log(`[${ts}] [auto-loop] ${msg}`, JSON.stringify(detail));
  } else {
    console.log(`[${ts}] [auto-loop] ${msg}`);
  }
}

async function isSurveyOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const list = await res.json();
    const surveyTarget = selectSurveyTarget(list);
    if (!surveyTarget || !surveyTarget.url) return false;
    const u = surveyTarget.url.toLowerCase();
    if (u.includes("swagbucks.com/surveys") || u.includes("swagbucks.com/dashboard") ||
        u.includes("surveyjunkie.com/surveys") || u.includes("surveyjunkie.com/dashboard")) {
      return false;
    }
    const isSurvey = u.includes("survey") || u.includes("screener") || u.includes("decipher") ||
                     u.includes("qualtrics") || u.includes("samplicio") || u.includes("compassrose") ||
                     (!u.includes("swagbucks.com") && !u.includes("surveyjunkie.com") && /^https?:\/\//i.test(u));
    return isSurvey ? surveyTarget : false;
  } catch {
    return false;
  }
}

async function getPageSignature(port, target) {
  return await withCDPSession(port, { target }, async (send) => {
    try {
      const res = await send("Runtime.evaluate", {
        expression: `(() => {
          const h = document.querySelector('h1, h2, h3, legend, .cf-question__text, .question-text, [class*="question-title"]');
          const txt = h ? h.innerText.trim().slice(0, 100) : document.body.innerText.trim().slice(0, 100);
          return txt.replace(/\\s+/g, ' ');
        })()`,
        returnByValue: true,
      });
      return res?.result?.value || "";
    } catch {
      return "";
    }
  });
}

async function handleInterstitialIfAny(port, target) {
  return await withCDPSession(port, { target }, async (send) => {
    let h;
    try {
      h = await harvestControls(send);
    } catch {
      return false;
    }
    if (!h || !h.nextButton) return false;
    const actionable = (h.controls || []).filter((c) =>
      !c.isSubmitOrNext &&
      !/\b(back|prev|previous)\b/i.test(c.label || "") &&
      (c.role === "radio" || c.type === "radio" || c.role === "checkbox" || c.type === "checkbox" ||
       c.role === "textbox" || c.tag === "textarea" || c.role === "combobox" || c.role === "option" ||
       (c.tag === "input" && c.type !== "hidden") ||
       ((c.role === "button" || c.tag === "button") && !c.isSubmitOrNext))
    );
    if (actionable.length === 0) {
      log(`Clicking interstitial notice page button: "${h.nextButton.label || 'Next'}"`);
      await new Promise((r) => setTimeout(r, 2000));
      await stealthClick(send, h.nextButton);
      return true;
    }
    return false;
  });
}

export async function runAutonomousLoop(port = 3014, options = {}) {
  log(`Starting autonomous survey execution loop on port ${port}... Target: >= ${TARGET_SB} SB`);

  let questionsAnswered = 0;
  let lastPageSignature = "";
  let repeatSignatureCount = 0;
  let lastStateChange = Date.now();

  while (true) {
    // 1. Check if an active survey is open
    const surveyTarget = await isSurveyOpen(port);

    if (surveyTarget) {
      const currentSignature = await getPageSignature(port, surveyTarget);

      if (currentSignature && currentSignature === lastPageSignature) {
        repeatSignatureCount++;
        log(`Current page unchanged: "${currentSignature.slice(0, 60)}..." (attempt ${repeatSignatureCount})`);

        if (repeatSignatureCount === 4) {
          log(`Stall detected on question "${currentSignature.slice(0, 60)}...". Invoking modal unstuck & recovery.`);
          await detectAndDismissStallModals(port);
          await new Promise((r) => setTimeout(r, 2000));
        } else if (repeatSignatureCount >= 7) {
          log(`Dead page / persistent stall detected (attempt ${repeatSignatureCount}). Recovering tab...`);
          try {
            const listRes = await fetch(`http://127.0.0.1:${port}/cdp/json`);
            const allTargets = (await listRes.json()).filter(t => t.type === "page" || !t.type);
            if (allTargets.length > 1 && surveyTarget.id) {
              log(`Closing stalled survey tab: ${surveyTarget.url}`);
              await fetch(`http://127.0.0.1:${port}/cdp/json/close/${surveyTarget.id}`);
            } else {
              log(`Navigating stalled single tab back to Swagbucks surveys dashboard...`);
              await withCDPSession(port, { target: surveyTarget }, async (send) => {
                await send("Page.navigate", { url: "https://www.swagbucks.com/surveys" });
              });
            }
          } catch (recErr) {
            log(`Tab recovery failed: ${recErr.message}`);
          }
          lastPageSignature = "";
          repeatSignatureCount = 0;
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
      } else {
        lastPageSignature = currentSignature;
        repeatSignatureCount = 0;
        lastStateChange = Date.now();
      }

      // 2. Execute fast-path on active questionnaire with post-action verification
      try {
        const fastRes = await tryExecuteFastPath(port, {
          target: surveyTarget,
          useNeuralLaya: true,
          timeoutMs: 35000,
          repeatAttempt: repeatSignatureCount,
        });

        if (fastRes && fastRes.handled) {
          questionsAnswered++;
          log(`Handled question ${questionsAnswered}: "${fastRes.optionClicked || fastRes.decision?.type}" (paced ${fastRes.pacedMs}ms)`);
          await new Promise((r) => setTimeout(r, 2000)); // Allow DOM transition
          continue;
        }

        // Check if pure interstitial page (e.g. intro notice or instructions)
        const interstitialClicked = await handleInterstitialIfAny(port, surveyTarget);
        if (interstitialClicked) {
          questionsAnswered++;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        log(`Question unhandled (${fastRes?.reason || "unknown"}). Attempting modal dismissal...`);
        await detectAndDismissStallModals(port);
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        log(`Execution error on active survey: ${err.message || String(err)}`);
        await new Promise((r) => setTimeout(r, 4000));
      }
      continue;
    }

    // 3. No active survey open — check dashboard balance!
    log("No active survey detected. Checking platform balance...");
    let balanceInfo = null;
    try {
      balanceInfo = await readSwagbucksBalance(port);
    } catch (e) {
      log(`Failed to read balance: ${e.message}`);
    }

    if (balanceInfo && balanceInfo.raw) {
      const currentSb = balanceInfo.raw;
      const netEarnedToday = currentSb - BASELINE_SB;
      log(`Current balance: ${currentSb} SB (Net today: ${netEarnedToday >= 0 ? '+' : ''}${netEarnedToday} SB)`);

      if (currentSb >= TARGET_SB) {
        log(`SUCCESS! Target reached! Balance: ${currentSb} SB >= ${TARGET_SB} SB!`);
        const markerPath = path.join(WS, "status", `target_reached_${port}.json`);
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, JSON.stringify({
          port,
          total_usd: currentSb * 0.01,
          total_raw: currentSb,
          ts: new Date().toISOString(),
          achieved: true,
        }, null, 2));
        break;
      }
    }

    // 4. Balance still under target — auto-launch next survey card!
    log("Auto-launching next survey from dashboard...");
    try {
      const launchRes = await autoLaunchDashboardSurvey(port);
      if (launchRes && launchRes.launched) {
        log(`Launched survey via ${launchRes.action} ("${launchRes.targetLabel}")`);
        for (let w = 0; w < 6; w++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (await isSurveyOpen(port)) {
            log("Survey successfully loaded into active tab!");
            break;
          }
        }
      } else {
        log(`Dashboard launch result: ${launchRes?.reason || "none"}. Waiting 15s before re-checking...`);
        await new Promise((r) => setTimeout(r, 15000));
      }
    } catch (err) {
      log(`Error launching survey: ${err.message}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  log(`Autonomous execution complete on port ${port}.`);
  return { completed: true, questionsAnswered };
}

if (process.argv[1] && process.argv[1].includes("autonomous_survey_loop.mjs")) {
  const port = parseInt(process.argv[2] || "3014", 10);
  runAutonomousLoop(port).then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Autonomous loop fatal error:", err);
    process.exit(1);
  });
}
