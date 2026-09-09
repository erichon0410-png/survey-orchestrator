// cdp_readonly.mjs — READ-ONLY CDP "manual look" at one live survey container.
//
// The survey-fleet-supervisor calls this per port to LOOK at what is actually on the
// container's screen right now, instead of trusting stored state. It is strictly read-only:
//   - Page.captureScreenshot  (PNG of the selected page)
//   - Runtime.evaluate         (reads document.title / location.href / body.innerText)
// No Input.* events, no navigation, no bringToFront — nothing that mutates the container.
//
// Output (stdout): a single JSON object
//   { ok:true,  port, url, title, screenshot_b64, text, error:null }
// or
//   { ok:false, port, url:null, title:"", screenshot_b64:"", text:"", error:"<reason>" }
//
// CLI: node scripts/cdp_readonly.mjs <port> [--host 127.0.0.1] [--preferred-hosts a.com,b.com] [--max-text 6000]

import { writeSync } from "node:fs";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import("/home/erich/.dsh/profiles/web/node_modules/ws/index.js")).default;
}

// A target counts as a "real page" only if it is type==="page" with an http(s) url.
// This excludes about:blank, devtools://, chrome://, workers, and browser_ui chrome pages.
function isRealHttpUrl(u) {
  const s = String(u || "");
  return /^https?:\/\//i.test(s);
}

// Score a page URL so the balance/account page ranks above transient survey machinery.
// Lower is better. This is what lets us read "current earnings" instead of a mid-survey
// or /callback "no longer available" screen.
function urlScore(u) {
  let s = 0;
  let path = "/";
  try {
    const W = new URL(String(u));
    path = W.pathname || "/";
  } catch {
    return 100;
  }
  if (/\/(callback|surveys|screener|livescreener|control)\b/i.test(u)) s += 2;
  if (/[?&](survey_id|access_key|tid=)/i.test(u)) s += 1;
  if (/dashboard|account|profile|earnings|balance/i.test(u)) s -= 2;
  if (path === "/") s -= 3; // logged-in home — usually where the balance is shown
  return s;
}

// Choose which page target to look at. Prefer the platform's own domain (where the account
// balance/earnings live) over third-party screener/traffic pages; within a candidate set,
// prefer the balance/account page (lowest urlScore). Fall back to the best real http(s) page
// when no preferred host is present.
export function selectPageTarget(targets, opts = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const preferredHosts = Array.isArray(opts.preferredHosts) ? opts.preferredHosts : [];
  const pages = targets.filter((t) => t && t.type === "page" && isRealHttpUrl(t.url));
  if (pages.length === 0) return null;
  const best = (arr) => [...arr].sort((a, b) => urlScore(a.url) - urlScore(b.url))[0];
  for (const ph of preferredHosts) {
    const needle = String(ph).toLowerCase().trim();
    if (!needle) continue;
    const hits = pages.filter((t) => {
      try {
        return new URL(String(t.url)).hostname.toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
    if (hits.length) return best(hits);
  }
  return best(pages);
}

// Read-only CDP round trip against one container. Never throws — always returns an object.
export async function readContainer({
  port,
  host = "127.0.0.1",
  preferredHosts = [],
  maxText = 6000,
  timeoutMs = 30000,
} = {}) {
  const fail = (error) => ({
    ok: false,
    port,
    url: null,
    title: "",
    screenshot_b64: "",
    text: "",
    error: String(error),
  });

  let list;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) return fail(`CDP /json HTTP ${res.status}`);
    list = await res.json();
  } catch (e) {
    return fail(`CDP /json unreachable: ${e.message || e}`);
  }

  const target = selectPageTarget(list, { preferredHosts });
  if (!target) return fail("no real http(s) page target found");

  let ws;
  try {
    // Same host-remap the proven probe scripts use: reach the in-container CDP through the
    // docker-mapped host port under the /cdp path prefix.
    const wsUrl = String(target.webSocketDebuggerUrl).replace(
      /ws:\/\/[^/]+/,
      `ws://${host}:${port}/cdp`
    );
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", (e) => reject(new Error(`ws connect: ${e && e.message ? e.message : "connect error"}`)));
    });

    let seq = 0;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const to = setTimeout(() => {
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
          if (msg.id === id) {
            clearTimeout(to);
            ws.off("message", h);
            resolve(msg.result ?? {});
          }
        };
        ws.on("message", h);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const shot = await send("Page.captureScreenshot", { format: "png" });
    const screenshot_b64 = (shot && shot.data) || "";

    const maxN = Math.max(200, Number(maxText) || 6000);
    const expr = `(function(){try{var t=(document.body&&document.body.innerText)||"";return JSON.stringify({title:document.title||"",url:location.href||"",text:t.slice(0,${maxN})});}catch(e){return JSON.stringify({title:(document.title||""),url:(location.href||""),text:"",error:String(e)});}})()`;
    let text = "";
    try {
      const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      const val = ev && ev.result ? ev.result.value : undefined;
      if (typeof val === "string") {
        const parsed = JSON.parse(val);
        text = String(parsed.text || "");
      }
    } catch {
      // non-fatal: screenshot still captured; leave text empty
    }

    ws.close();
    return {
      ok: true,
      port,
      url: target.url,
      title: "",
      screenshot_b64,
      text,
      error: null,
    };
  } catch (e) {
    try {
      if (ws) ws.close();
    } catch {}
    return fail(`CDP read failed: ${e.message || e}`);
  }
}

// --- CLI entry point ---------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const port = Number(args[0]) || Number(process.argv[2]) || 3014;
  const host = arg("--host", "127.0.0.1");
  const preferredHosts = (arg("--preferred-hosts", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxText = Number(arg("--max-text", "6000")) || 6000;

  const out = await readContainer({ port, host, preferredHosts, maxText });
  // Synchronous write so a large base64 payload is fully flushed before exit.
  // (process.stdout to a pipe is async; an immediate process.exit truncated the tail.)
  const s = JSON.stringify(out) + "\n";
  try {
    writeSync(1, s);
  } catch {
    process.stdout.write(s);
  }
  process.exitCode = out.ok ? 0 : 3;
}
