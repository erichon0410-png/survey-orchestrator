#!/usr/bin/env node
// scripts/ensure_fleet_navigation.mjs — Ensure all fleet containers are navigated to their assigned platform dashboard.
//
// 3/2 Fleet Split:
//   3013 -> SurveyJunkie (https://app.surveyjunkie.com/)
//   3014 -> Swagbucks    (https://www.swagbucks.com/surveys)
//   3015 -> SurveyJunkie (https://app.surveyjunkie.com/)
//   3016 -> SurveyJunkie (https://app.surveyjunkie.com/)
//   3017 -> Swagbucks    (https://www.swagbucks.com/surveys)

import { PORT_TO_PLATFORM, pruneExcessTabs } from "./survey_driver.mjs";

export const PLATFORM_DASHBOARD_URLS = {
  surveyjunkie: "https://app.surveyjunkie.com/",
  swagbucks: "https://www.swagbucks.com/surveys",
};

export function isCorrectUrl(currentUrl, platform) {
  if (!currentUrl) return false;
  if (platform === "surveyjunkie") {
    return currentUrl.startsWith("https://app.surveyjunkie.com") &&
      !currentUrl.includes("/404") &&
      !currentUrl.includes("/rewards");
  }
  if (platform === "swagbucks") {
    return currentUrl.includes("swagbucks.com/surveys");
  }
  return false;
}

export async function navigatePortToPlatform(port, options = {}) {
  const platform = options.platform || PORT_TO_PLATFORM[port] || "surveyjunkie";
  const targetUrl = PLATFORM_DASHBOARD_URLS[platform] || "https://app.surveyjunkie.com/";
  const host = options.host || "127.0.0.1";
  const timeoutMs = options.timeoutMs || 5000;

  try {
    const listRes = await fetch(`http://${host}:${port}/cdp/json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!listRes.ok) return { port, ok: false, error: `CDP HTTP ${listRes.status}` };
    const targets = await listRes.json();
    const page = targets.find((t) => t && t.type === "page");
    if (!page) return { port, ok: false, error: "no page target" };

    if (isCorrectUrl(page.url, platform) && !options.force) {
      await pruneExcessTabs(port, 3).catch(() => {});
      return { port, ok: true, platform, url: page.url, navigated: false };
    }

    const wsUrl = String(page.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://${host}:${port}/cdp`);
    const WebSocketImpl = globalThis.WebSocket || (await import("ws")).default;
    const ws = new WebSocketImpl(wsUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("nav ws timeout")); }, timeoutMs);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1001,
          method: "Page.navigate",
          params: { url: targetUrl }
        }));
      };
      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data.toString());
          if (data.id === 1001) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(data.result);
          }
        } catch {}
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });

    await pruneExcessTabs(port, 3).catch(() => {});
    return { port, ok: true, platform, url: targetUrl, navigated: true };
  } catch (e) {
    return { port, ok: false, platform, error: String(e?.message || e) };
  }
}

export async function ensureAllFleetNavigation(options = {}) {
  const ports = options.ports || [3013, 3014, 3015, 3016, 3017];
  const results = [];
  for (const port of ports) {
    const res = await navigatePortToPlatform(port, options);
    results.push(res);
  }
  return results;
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCLI) {
  console.log("🧭 Ensuring all fleet containers are navigated to their assigned platform dashboards...");
  ensureAllFleetNavigation().then((results) => {
    for (const r of results) {
      const status = r.ok ? (r.navigated ? "NAVIGATED" : "ALREADY_ON_SITE") : "FAILED";
      console.log(`  Port ${r.port} [${r.platform}]: [${status}] ${r.url || r.error}`);
    }
    const allOk = results.every((r) => r.ok);
    process.exit(allOk ? 0 : 1);
  }).catch((e) => {
    console.error("Fatal navigation error:", e);
    process.exit(1);
  });
}
