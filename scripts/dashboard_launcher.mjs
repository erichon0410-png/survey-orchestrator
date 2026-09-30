// scripts/dashboard_launcher.mjs — Autonomous Dashboard Survey Launcher
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

  // 1. Active Modal Start Buttons
  const startModalBtn = controls.find((c) => {
    const lbl = String(c.label || c.text || "").trim();
    return /^(start survey|take survey|try this survey|start|take this survey)$/i.test(lbl) ||
           /start-survey-cta/i.test(c.className || "");
  });
  if (startModalBtn) {
    return {
      type: "modal_start",
      target: startModalBtn,
      label: startModalBtn.label || startModalBtn.text || "Start Survey",
    };
  }

  // 2. Refresh CTA ("Check for New Surveys")
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

  // 3. Survey Cards
  const surveyCard = controls.find((c) => {
    const cls = String(c.className || "");
    const lbl = String(c.label || c.text || "");
    const isCard = /card_card|survey-card|surveyCard|survey-item/i.test(cls);
    const hasSbOrMin = /\b(\d+\s*sb|\d+\s*pts|\d+\s*min)\b/i.test(lbl);
    return isCard || hasSbOrMin;
  });
  if (surveyCard) {
    return {
      type: "survey_card",
      target: surveyCard,
      label: surveyCard.label || surveyCard.text || "Survey Card",
    };
  }

  return null;
}

export async function autoLaunchDashboardSurvey(port, options = {}) {
  const host = options.host || "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { launched: false, reason: "cdp_fetch_failed" };
    const targets = await res.json();
    const dashboardTarget = targets.find((t) => t && (t.type === "page" || !t.type) && isDashboardPage(t));
    if (!dashboardTarget) return { launched: false, reason: "not_on_dashboard" };

    const wsUrl = dashboardTarget.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${host}:${port}/cdp`);
    let WebSocketClass = options.WebSocket;
    if (!WebSocketClass) {
      try {
        WebSocketClass = (await import("ws")).default;
      } catch {
        WebSocketClass = globalThis.WebSocket;
      }
    }

    const ws = new WebSocketClass(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    let id = 0;
    const send = options.send || ((m, p = {}) => new Promise((resolve) => {
      const cur = ++id;
      const h = (d) => { const msg = JSON.parse(d); if (msg.id === cur) { ws.off("message", h); resolve(msg.result); } };
      ws.on("message", h);
      ws.send(JSON.stringify({ id: cur, method: m, params: p }));
    }));

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
      ws.close();
      return { launched: false, reason: "no_dashboard_action_found" };
    }

    const clickFn = options.stealthClick || stealthClick;
    await clickFn(send, action.target, { isIframe: false });
    ws.close();

    return {
      launched: true,
      action: action.type,
      targetLabel: action.label,
    };
  } catch (err) {
    return { launched: false, reason: err.message || String(err) };
  }
}