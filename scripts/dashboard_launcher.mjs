// scripts/dashboard_launcher.mjs — Autonomous Dashboard Survey Launcher
import path from "node:path";
import { stealthClick } from "./stealth_mouse.mjs";

export function isDashboardPage(target) {
  if (!target || !target.url) return false;
  try {
    const parsed = new URL(target.url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");

    if (host.includes("swagbucks.com")) {
      return pathname === "" || pathname === "/surveys" || pathname === "/dashboard";
    }
    if (host.includes("surveyjunkie.com")) {
      return pathname === "" || pathname === "/surveys" || pathname === "/dashboard";
    }
    return false;
  } catch {
    return false;
  }
}

export function findDashboardAction(controls = []) {
  if (!Array.isArray(controls) || controls.length === 0) return null;

  // 1. Active Modal Start Buttons (Highest Priority when survey launch modal is open)
  const startModalBtn = controls.find((c) => {
    const lbl = String(c.label || c.text || "").trim();
    return /^(start survey|take survey|try this survey|start|take this survey|start next survey)$/i.test(lbl) ||
           /start-survey-cta/i.test(c.className || "");
  });
  if (startModalBtn) {
    return {
      type: "modal_start",
      target: startModalBtn,
      label: startModalBtn.label || startModalBtn.text || "Start Survey",
    };
  }

  // 2. Active Modal Dismiss / Close Buttons (Only when NO start button exists, e.g. feedback dialogs)
  const modalCloseBtn = controls.find((c) => {
    const lbl = String(c.label || c.text || "").trim();
    const cls = String(c.className || "");
    return (
      (/^close$/i.test(lbl) && /modal|dialog|cta|feedback/i.test(cls)) ||
      /feedback-modal_cta/i.test(cls) ||
      (lbl === "Close" && c.w > 0 && c.h > 0)
    );
  });
  if (modalCloseBtn) {
    return {
      type: "dismiss_modal",
      target: modalCloseBtn,
      label: modalCloseBtn.label || "Close Modal",
    };
  }

  // 2. Survey Cards (Priority: launch available survey)
  const surveyCards = controls.filter((c) => {
    const cls = String(c.className || "");
    const lbl = String(c.label || c.text || "").trim();
    if (c.y !== undefined && c.y < 120) return false;
    if (/header|nav|toggler|tertiary|bonus/i.test(cls)) return false;
    if (/& get|\bearn\b.*&|daily goal|survey bonus/i.test(lbl)) return false;

    const isCard = /card_card|survey-card|surveyCard|survey-item/i.test(cls);
    const hasBothMinAndSb = /\b\d+\s*min\b/i.test(lbl) && /\b\d+\s*(?:sb|pts)\b/i.test(lbl);
    return isCard || hasBothMinAndSb;
  });
  if (surveyCards.length > 0) {
    surveyCards.sort((a, b) => {
      const getSb = (c) => {
        const m = String(c.label || c.text || "").match(/(\d+)\s*(?:sb|pts)/i);
        return m ? parseInt(m[1], 10) : 0;
      };
      return getSb(b) - getSb(a);
    });
    const chosen = surveyCards[0];
    return {
      type: "survey_card",
      target: chosen,
      label: chosen.label || chosen.text || "Survey Card",
    };
  }

  // 3. Refresh CTA ("Check for New Surveys")
  const refreshCta = controls.find((c) => {
    const lbl = String(c.label || c.text || "").trim();
    return /check for new surveys|refresh surveys/i.test(lbl) ||
           /refresh-surveys-cta/i.test(c.className || "");
  });
  if (refreshCta) {
    return {
      type: "refresh_cta",
      target: refreshCta,
      label: refreshCta.label || refreshCta.text || "Check for New Surveys",
    };
  }

  return null;
}

import { withCDPSession } from "./system1_runner.mjs";

export async function autoLaunchDashboardSurvey(port, options = {}) {
  const host = options.host || "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { launched: false, reason: "cdp_fetch_failed" };
    const targets = await res.json();
    const dashboardTargets = targets.filter((t) => t && (t.type === "page" || !t.type) && isDashboardPage(t));
    if (dashboardTargets.length === 0) return { launched: false, reason: "not_on_dashboard" };

    // Prefer dashboard target that has active survey modal query params or the newest tab
    const modalTab = dashboardTargets.find((t) => t.url && (t.url.includes("m=") || t.url.includes("s=")));
    const dashboardTarget = modalTab || dashboardTargets[dashboardTargets.length - 1];

    // Prune stale duplicate dashboard tabs
    for (const dt of dashboardTargets) {
      if (dt.id !== dashboardTarget.id) {
        fetch(`http://${host}:${port}/cdp/json/close/${dt.id}`).catch(() => {});
      }
    }

    return await withCDPSession(port, { target: dashboardTarget, host }, async (send) => {
      const evalRes = await send("Runtime.evaluate", {
        expression: `(() => {
          function isVis(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return Array.from(document.querySelectorAll("button, a, div[role=button], div[class*='card']")).filter(isVis).map(el => {
            const r = el.getBoundingClientRect();
            return {
              role: el.getAttribute("role") || el.tagName.toLowerCase(),
              label: (el.innerText || el.textContent || "").trim().substring(0, 100),
              className: typeof el.className === "string" ? el.className : "",
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              w: Math.round(r.width),
              h: Math.round(r.height),
              id: el.id
            };
          });
        })()`,
        returnByValue: true,
      });

      const controls = evalRes?.result?.value || [];
      const action = findDashboardAction(controls);
      if (!action) {
        return { launched: false, reason: "no_dashboard_action_found" };
      }

      const clickFn = options.stealthClick || stealthClick;
      await clickFn(send, action.target, { isIframe: false });

      return {
        launched: true,
        action: action.type,
        targetLabel: action.label,
      };
    });
  } catch (err) {
    return { launched: false, reason: err.message || String(err) };
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "dashboard_launcher.mjs") {
  const port = parseInt(process.argv[2] || "3014", 10);
  autoLaunchDashboardSurvey(port).then((res) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.launched ? 0 : 1);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}