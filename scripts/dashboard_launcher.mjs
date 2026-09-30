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

  // 1. Active Modal Start Buttons
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

  // 2. Survey Cards (Priority: launch available survey)
  const surveyCards = controls.filter((c) => {
    const cls = String(c.className || "");
    const lbl = String(c.label || c.text || "");
    const isCard = /card_card|survey-card|surveyCard|survey-item/i.test(cls);
    const hasSbOrMin = /\b(\d+\s*sb|\d+\s*pts|\d+\s*min)\b/i.test(lbl);
    return isCard || hasSbOrMin;
  });
  if (surveyCards.length > 0) {
    const viableCards = surveyCards.filter((c) => {
      const lbl = String(c.label || c.text || "");
      return !/bonus|toggler/i.test(c.className || "") && !/survey bonus/i.test(lbl);
    });
    const pool = viableCards.length > 0 ? viableCards : surveyCards;
    pool.sort((a, b) => {
      const getSb = (c) => {
        const m = String(c.label || c.text || "").match(/(\d+)\s*(?:sb|pts)/i);
        return m ? parseInt(m[1], 10) : 0;
      };
      return getSb(b) - getSb(a);
    });
    const chosen = pool[0];
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
      if (ws.once) {
        ws.once("open", resolve);
        ws.once("error", reject);
      } else {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      }
    });

    let id = 0;
    const send = options.send || ((m, p = {}) => new Promise((resolve, reject) => {
      const cur = ++id;
      const sendTimeout = setTimeout(() => {
        if (ws.off) ws.off("message", h);
        else ws.removeEventListener("message", h);
        reject(new Error("CDP timeout: " + m));
      }, 10000);
      const h = (d) => {
        let msg;
        try {
          const raw = typeof d === "string" ? d : (d?.data ? String(d.data) : (d?.toString ? d.toString("utf8") : "{}"));
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg && msg.id === cur) {
          clearTimeout(sendTimeout);
          if (ws.off) ws.off("message", h);
          else ws.removeEventListener("message", h);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result ?? {});
        }
      };
      if (ws.on) ws.on("message", h);
      else ws.addEventListener("message", h);
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