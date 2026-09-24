// scripts/monitor_3h.mjs — 3-Hour Autonomous Survey Monitor & Verified Earnings Engine
//
// Continuously supervises and drives ports 3013 (SurveyJunkie) and 3014 (Swagbucks)
// for 3 hours. Guarantees forward momentum by:
// 1. Reading live balance and tracking exact earnings deltas in real-time.
// 2. Dismissing blocking promo overlays (e.g. SurveyJunkie 3-Day Leaderboard).
// 3. Auto-clicking "Check for New Surveys" and "Start Survey" on dashboard modals.
// 4. Answering prescreener and partner survey questions (Alchemer, Qualtrics, Decipher, Dynata)
//    with the standard Mei Lin Chen demographic persona.
// 5. Recovering from stuck states (raw JSON endpoints, empty tabs, stale screenouts).
// 6. Taking periodic visual screenshots for inspection.
// 7. Appending verified earnings increments to reports/earnings_ledger.jsonl.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

const PORTS = [3013, 3014];
const DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
const TICK_INTERVAL_MS = 12000; // 12 seconds
const LEDGER_FILE = path.join(ROOT, "reports", "earnings_ledger.jsonl");
const LOG_FILE = path.join(ROOT, "logs", "monitor_3h.log");
const ARTIFACTS_DIR = "/mnt/c/Users/erich/.gemini/antigravity-cli/brain/dc13a794-a1c3-4dbc-8ba0-b23ccd5854f3";

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// Bounded CDP session helper
async function withCdp(port, fn, targetFilter = null) {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`);
    list = await res.json();
  } catch (e) {
    return { ok: false, error: `CDP unreachable: ${e.message}` };
  }

  const pages = list.filter(t => t.type === "page" && /^https?:\/\//i.test(t.url));
  if (pages.length === 0) return { ok: false, error: "No active http(s) page" };

  let target = pages[0];
  if (targetFilter) {
    target = pages.find(targetFilter) || pages[0];
  }

  const wsUrl = String(target.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}/cdp`);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
    setTimeout(() => rej(new Error("ws connect timeout")), 8000);
  });

  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const to = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id === i) {
        clearTimeout(to);
        ws.off("message", h);
        if (m.error) reject(m.error); else resolve(m.result ?? {});
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  try {
    return await fn({ send, ws, target, allPages: pages });
  } finally {
    try { ws.close(); } catch {}
  }
}

// Universal In-Page Survey Solver Script
const INPAGE_SOLVER_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : '';
  const url = location.href;

  // 1. Check for terminal screenout or completion pages
  const isCompleteOrScreenout = /thank you for completing|survey completed|not a good match|sorry.*did not qualify|quota.*full|survey.*expired|already participated/i.test(text);
  if (isCompleteOrScreenout) {
    // If "Start another survey" button exists, click it
    const nextSurveyBtn = Array.from(document.querySelectorAll('button, a')).find(b => /start another survey|back to dashboard|return/i.test(b.innerText));
    if (nextSurveyBtn) {
      nextSurveyBtn.click();
      return { action: 'clicked_screenout_btn', url };
    }
    // Return flag so driver can redirect to dashboard
    return { action: 'terminal_state', url };
  }

  // 2. Radio Groups (matrix and standalone)
  const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
  let answeredRadios = 0;
  if (radios.length > 0) {
    const groups = new Map();
    radios.forEach(r => {
      const gName = r.name || 'unnamed';
      if (!groups.has(gName)) groups.set(gName, []);
      groups.get(gName).push(r);
    });

    groups.forEach((group, name) => {
      // Find parent question context
      const container = group[0].closest('tr, fieldset, div[class*="question"], div[role="radiogroup"]') || document.body;
      const qText = container.innerText || '';

      let targetRadio = null;
      // Demographic matching
      if (/gender/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /female/i.test(l?.innerText || r.value);
        });
      } else if (/hispanic|latino/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /no/i.test(l?.innerText || r.value);
        });
      } else if (/race|ethnicity/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /asian|chinese/i.test(l?.innerText || r.value);
        });
      } else if (/education/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /doctorate|phd|graduate|post-graduate/i.test(l?.innerText || r.value);
        });
      } else if (/employment|work status/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /employed full-time|full time/i.test(l?.innerText || r.value);
        });
      } else if (/marital/i.test(qText)) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /married/i.test(l?.innerText || r.value);
        });
      } else if (/yes.*no/i.test(qText) || group.length === 2) {
        // Default positive on binary
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /yes/i.test(l?.innerText || r.value);
        }) || group[0];
      }

      // Default to first option or random positive option if no match
      if (!targetRadio) {
        targetRadio = group.find(r => {
          const l = r.closest('label') || r.parentElement;
          return /agree|satisfied|familiar|somewhat|very|often|frequently|always/i.test(l?.innerText || r.value);
        }) || group[0];
      }

      if (targetRadio) {
        targetRadio.checked = true;
        const parent = targetRadio.closest('label') || targetRadio.parentElement;
        if (parent) parent.click();
        targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
        answeredRadios++;
      }
    });
  }

  // 3. Checkboxes (multi-select)
  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
  let answeredCheckboxes = 0;
  if (checkboxes.length > 0) {
    // Select 2-3 reasonable checkboxes
    const valid = checkboxes.filter(cb => {
      const l = cb.closest('label') || cb.parentElement;
      return !/none of the above|prefer not|don't know/i.test(l?.innerText || cb.value);
    });
    const toCheck = valid.slice(0, Math.min(3, valid.length));
    toCheck.forEach(cb => {
      cb.checked = true;
      const parent = cb.closest('label') || cb.parentElement;
      if (parent) parent.click();
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      answeredCheckboxes++;
    });
  }

  // 4. Dropdowns (<select>)
  const selects = Array.from(document.querySelectorAll('select'));
  let answeredSelects = 0;
  selects.forEach(sel => {
    if (sel.options && sel.options.length > 1) {
      // Find matching option or pick index 1
      let pickIdx = 1;
      for (let i = 1; i < sel.options.length; i++) {
        const optText = sel.options[i].text.toLowerCase();
        if (/ohio|43065|female|married|doctorate|healthcare|asian/i.test(optText)) {
          pickIdx = i;
          break;
        }
      }
      sel.selectedIndex = pickIdx;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      answeredSelects++;
    }
  });

  // 5. Text inputs & Textareas
  const textInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], textarea'));
  let answeredTexts = 0;
  const brandList = ['Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'Capital One'];
  textInputs.forEach((ti, i) => {
    if (!ti.value) {
      const qContext = ti.closest('div, tr, fieldset')?.innerText || '';
      if (/zip/i.test(qContext) || ti.placeholder?.includes('ZIP') || ti.name?.includes('zip')) {
        ti.value = '43065';
      } else if (/age/i.test(qContext) || ti.placeholder?.includes('Age')) {
        ti.value = '32';
      } else if (/year/i.test(qContext)) {
        ti.value = '1994';
      } else if (/brand/i.test(qContext)) {
        ti.value = brandList[i % brandList.length];
      } else {
        ti.value = 'Great quality and reliable service.';
      }
      ti.dispatchEvent(new Event('input', { bubbles: true }));
      ti.dispatchEvent(new Event('change', { bubbles: true }));
      answeredTexts++;
    }
  });

  // 6. Click Next / Continue / Submit
  const nextBtn = Array.from(document.querySelectorAll('input[type="submit"], button, a')).find(b => {
    const val = (b.value || b.innerText || '').trim();
    return /^(next|continue|submit|proceed|forward|done)$/i.test(val) || /^Next/i.test(val);
  });

  let nextClicked = false;
  if (nextBtn) {
    nextBtn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    nextBtn.click();
    nextClicked = true;
  }

  return {
    action: 'answered',
    url,
    answeredRadios,
    answeredCheckboxes,
    answeredSelects,
    answeredTexts,
    nextClicked,
  };
})()`;

// Balance and earnings tracker
const state = {
  3013: { initialBalance: null, currentBalance: null, unit: "pts", platform: "SurveyJunkie", surveysStarted: 0, questionsAnswered: 0 },
  3014: { initialBalance: null, currentBalance: null, unit: "SB", platform: "Swagbucks", surveysStarted: 0, questionsAnswered: 0 },
  startTime: Date.now(),
};

function recordEarnings(port, delta, currentBal) {
  const ts = new Date().toISOString();
  const usdDelta = delta * 0.01;
  const entry = {
    ts,
    port,
    platform: state[port].platform,
    deltaRaw: delta,
    unit: state[port].unit,
    deltaUsd: usdDelta,
    currentBalance: currentBal,
    note: "Monitored verified earnings increase",
  };
  log(`💰 [Port ${port}] EARNINGS DETECTED: +${delta} ${state[port].unit} (+$${usdDelta.toFixed(2)})! Current: ${currentBal}`);
  try {
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    log(`Failed to write earnings ledger: ${e.message}`);
  }
}

// -------------------------------------------------------------
// PORT 3013: SurveyJunkie Handler
// -------------------------------------------------------------
async function handlePort3013() {
  return await withCdp(3013, async ({ send, target }) => {
    const isDashboard = target.url.includes("app.surveyjunkie.com");

    if (isDashboard) {
      // On dashboard: read balance, dismiss promo, launch survey
      const res = await send("Runtime.evaluate", {
        expression: `(() => {
          const balEl = document.querySelector('div[class*="cspFOX"]') ||
                        Array.from(document.querySelectorAll('div')).find(d => /^\\d{3,5}$/.test(d.innerText.trim()) && d.children.length === 0);
          let pts = null;
          if (balEl) pts = parseInt(balEl.innerText.trim(), 10);

          // Close 3-Day Leaderboard or other promo toasts
          const toastX = document.querySelector('[class*="leaderboard"] button, [class*="toast"] button, [aria-label="Close"]');
          let dismissedPromo = false;
          if (toastX) { toastX.click(); dismissedPromo = true; }

          // Close modal or prescreener if finish is available
          const finishBtn = Array.from(document.querySelectorAll('button')).find(b => /finish|start another survey/i.test(b.innerText));
          if (finishBtn) { finishBtn.click(); }

          // Launch top survey card via direct redirect href
          const links = Array.from(document.querySelectorAll('a[href*="mrs.us.sjapis.com"]'));
          let launchedHref = null;
          if (links.length > 0) {
            launchedHref = links[0].href;
            location.href = links[0].href;
          }

          return { pts, dismissedPromo, launchedHref, title: document.title };
        })()`,
        returnByValue: true
      });

      const val = res.result?.value || {};
      if (val.pts && Number.isFinite(val.pts)) {
        if (state[3013].initialBalance === null) {
          state[3013].initialBalance = val.pts;
          state[3013].currentBalance = val.pts;
          log(`[Port 3013] SurveyJunkie Baseline: ${val.pts} pts ($${(val.pts * 0.01).toFixed(2)})`);
        } else if (val.pts > state[3013].currentBalance) {
          const delta = val.pts - state[3013].currentBalance;
          state[3013].currentBalance = val.pts;
          recordEarnings(3013, delta, val.pts);
        }
      }

      if (val.dismissedPromo) log(`[Port 3013] Dismissed promo overlay`);
      if (val.launchedHref) {
        state[3013].surveysStarted++;
        log(`[Port 3013] Launched survey #${state[3013].surveysStarted} from dashboard`);
      }
    } else {
      // On partner survey page (Alchemer, Qualtrics, Dynata, etc.)
      const solverRes = await send("Runtime.evaluate", {
        expression: INPAGE_SOLVER_SCRIPT,
        returnByValue: true
      });

      const result = solverRes.result?.value || {};
      if (result.action === 'terminal_state') {
        log(`[Port 3013] Survey reached terminal screen -> navigating back to dashboard`);
        await send("Page.navigate", { url: "https://app.surveyjunkie.com/" });
      } else if (result.nextClicked) {
        state[3013].questionsAnswered++;
        log(`[Port 3013] Answered question on ${target.url.slice(0, 45)}... (answered Q#${state[3013].questionsAnswered})`);
      }
    }

    return { ok: true };
  });
}

// -------------------------------------------------------------
// PORT 3014: Swagbucks Handler
// -------------------------------------------------------------
async function handlePort3014() {
  return await withCdp(3014, async ({ send, target, allPages }) => {
    // Check if an active prescreener or survey tab exists
    const surveyTab = allPages.find(p => p.url.includes("prescreener") || (p.url.includes("survey") && !p.url.endsWith("/surveys")));
    const activeTarget = surveyTab || target;
    const isDashboard = activeTarget.url.endsWith("/surveys") || activeTarget.url.endsWith("/surveys/");

    if (isDashboard) {
      const res = await send("Runtime.evaluate", {
        expression: `(() => {
          const balEl = document.querySelector('var[class*="balanceNumber"]');
          let sb = null;
          if (balEl) sb = parseInt(balEl.innerText.replace(/[^\\d]/g, ''), 10);

          // Check if raw JSON appeared
          const isRawJson = location.href.includes('/survey-click/v2') || (document.body && document.body.innerText.startsWith('{"flowId"'));
          if (isRawJson) { location.href = 'https://www.swagbucks.com/surveys'; return { redirected: true }; }

          // Recommended modal
          const modalBtn = Array.from(document.querySelectorAll('button')).find(b => /start survey|try this survey/i.test(b.innerText));
          let clickedModal = false;
          if (modalBtn) { modalBtn.click(); clickedModal = true; }

          // Refresh button
          const refreshBtn = document.querySelector('button.refresh-surveys-cta_cta__d1xoH');
          let clickedRefresh = false;
          if (refreshBtn && !clickedModal) { refreshBtn.click(); clickedRefresh = true; }

          // Launch available card (prefer 40+ SB cards or first card)
          let clickedCard = false;
          if (!clickedModal && !refreshBtn) {
            const cards = Array.from(document.querySelectorAll('div[class*="card_card__"]'));
            if (cards.length > 0) {
              const bestCard = cards.find(c => /50|75|100|200/i.test(c.innerText)) || cards[0];
              bestCard.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              bestCard.click();
              clickedCard = true;
            }
          }

          return { sb, clickedModal, clickedRefresh, clickedCard };
        })()`,
        returnByValue: true
      });

      const val = res.result?.value || {};
      if (val.sb && Number.isFinite(val.sb)) {
        if (state[3014].initialBalance === null) {
          state[3014].initialBalance = val.sb;
          state[3014].currentBalance = val.sb;
          log(`[Port 3014] Swagbucks Baseline: ${val.sb} SB ($${(val.sb * 0.01).toFixed(2)})`);
        } else if (val.sb > state[3014].currentBalance) {
          const delta = val.sb - state[3014].currentBalance;
          state[3014].currentBalance = val.sb;
          recordEarnings(3014, delta, val.sb);
        }
      }

      if (val.clickedModal) {
        state[3014].surveysStarted++;
        log(`[Port 3014] Clicked "Start Survey" on recommended modal`);
      }
      if (val.clickedCard) {
        state[3014].surveysStarted++;
        log(`[Port 3014] Clicked available survey card on dashboard (#${state[3014].surveysStarted})`);
      }
      if (val.clickedRefresh) log(`[Port 3014] Clicked "Check for New Surveys" to refresh cards`);
    } else {
      // On prescreener or partner survey
      const solverRes = await send("Runtime.evaluate", {
        expression: INPAGE_SOLVER_SCRIPT,
        returnByValue: true
      });

      const result = solverRes.result?.value || {};
      if (result.action === 'terminal_state') {
        log(`[Port 3014] Survey reached terminal screen -> navigating back to dashboard`);
        await send("Page.navigate", { url: "https://www.swagbucks.com/surveys" });
      } else if (result.nextClicked) {
        state[3014].questionsAnswered++;
        log(`[Port 3014] Answered question on ${activeTarget.url.slice(0, 45)}... (answered Q#${state[3014].questionsAnswered})`);
      }
    }

    return { ok: true };
  });
}

// -------------------------------------------------------------
// Capture Visual Proof Screenshot
// -------------------------------------------------------------
async function captureProof(port) {
  try {
    await withCdp(port, async ({ send }) => {
      try { await send("Page.enable"); } catch {}
      try { await send("Page.bringToFront"); } catch {}
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      if (shot?.data) {
        const buf = Buffer.from(shot.data, "base64");
        const outName = `live_${port}.png`;
        const localPath = path.join(ROOT, "reports", outName);
        fs.writeFileSync(localPath, buf);

        const artifactPath = path.join(ARTIFACTS_DIR, outName);
        try {
          fs.writeFileSync(artifactPath, buf);
        } catch {}
      }
    });
  } catch (e) {
    // Non-fatal
  }
}

// -------------------------------------------------------------
// Main Monitoring Loop
// -------------------------------------------------------------
async function main() {
  log("=================================================================");
  log(`🚀 Starting 3-Hour Autonomous Survey Monitor & Earnings Engine`);
  log(`⏱️ Duration: 3 hours (${DURATION_MS / 1000}s) | Tick Interval: ${TICK_INTERVAL_MS / 1000}s`);
  log(`🎯 Active Targets: Port 3013 (SurveyJunkie) & Port 3014 (Swagbucks)`);
  log("=================================================================");

  const endTime = Date.now() + DURATION_MS;
  let tick = 0;

  while (Date.now() < endTime) {
    tick++;
    const remainingMin = Math.round((endTime - Date.now()) / 60000);

    try {
      await handlePort3013();
    } catch (e) {
      log(`[Port 3013] Tick error: ${e.message}`);
    }

    try {
      await handlePort3014();
    } catch (e) {
      log(`[Port 3014] Tick error: ${e.message}`);
    }

    // Capture visual screenshots every ~60 seconds (every 5 ticks)
    if (tick % 5 === 0) {
      await captureProof(3013);
      await captureProof(3014);
    }

    // Print summary report every 10 ticks (~2 minutes)
    if (tick % 10 === 0) {
      const sjBal = state[3013].currentBalance !== null ? `${state[3013].currentBalance} pts ($${(state[3013].currentBalance * 0.01).toFixed(2)})` : "pending";
      const sjDelta = state[3013].initialBalance !== null ? state[3013].currentBalance - state[3013].initialBalance : 0;
      const sbBal = state[3014].currentBalance !== null ? `${state[3014].currentBalance} SB ($${(state[3014].currentBalance * 0.01).toFixed(2)})` : "pending";
      const sbDelta = state[3014].initialBalance !== null ? state[3014].currentBalance - state[3014].initialBalance : 0;
      const totalEarnedUsd = (sjDelta + sbDelta) * 0.01;

      log(`--- [TICK ${tick} | ${remainingMin}m remaining] ---`);
      log(`  SurveyJunkie (3013): ${sjBal} | New: +${sjDelta} pts (+$${(sjDelta * 0.01).toFixed(2)}) | Qs: ${state[3013].questionsAnswered}`);
      log(`  Swagbucks (3014):    ${sbBal} | New: +${sbDelta} SB (+$${(sbDelta * 0.01).toFixed(2)}) | Qs: ${state[3014].questionsAnswered}`);
      log(`  Total Monitored Profit: +$${totalEarnedUsd.toFixed(2)} USD`);
      log(`--------------------------------------------------`);
    }

    await new Promise(r => setTimeout(r, TICK_INTERVAL_MS));
  }

  log("=================================================================");
  log(`🏁 3-Hour Monitored Session Complete!`);
  const finalSjDelta = (state[3013].currentBalance || 0) - (state[3013].initialBalance || 0);
  const finalSbDelta = (state[3014].currentBalance || 0) - (state[3014].initialBalance || 0);
  const finalTotalUsd = (finalSjDelta + finalSbDelta) * 0.01;
  log(`SurveyJunkie Net: +${finalSjDelta} pts (+$${(finalSjDelta * 0.01).toFixed(2)})`);
  log(`Swagbucks Net:    +${finalSbDelta} SB (+$${(finalSbDelta * 0.01).toFixed(2)})`);
  log(`Total Verified Earnings: +$${finalTotalUsd.toFixed(2)} USD`);
  log("=================================================================");
}

main().catch(err => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
