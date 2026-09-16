// cdp_control.mjs — minimal CDP control surface for NON-CODEX survey workers.
//
// The fleet's codex agents drive containers via a Node REPL; this script gives a
// plain subagent (no codex, no rate-limit burn) the same capability through bounded
// bash calls:
//
//   node scripts/cdp_control.mjs targets <port> [--host 127.0.0.1]
//     -> JSON list of real page targets [{url,title}]
//   node scripts/cdp_control.mjs eval <port> --js "<expression>" [--match <url-substring>]
//     -> Runtime.evaluate (returnByValue) on the selected page target; prints the
//        result as JSON. Use it to read state AND to act (click/type via JS).
//   node scripts/cdp_control.mjs click <port> <--selector S|--coords X,Y> [--match <url-substring>]
//     -> Dispatches trusted physical mouse click (Input.dispatchMouseEvent) at element
//        or coordinates with trajectory and jitter.
//   node scripts/cdp_control.mjs nav <port> <url>
//     -> Target.createTarget(url); waits until the new target is listed; prints it.
//   node scripts/cdp_control.mjs screenshot <port> [-o /path/shot.png] [--match <url-substring>]
//     -> Page.captureScreenshot PNG written to -o path (or base64 on stdout if omitted)
//
// Target selection reuses cdp_readonly.selectPageTarget (balance/account page first);
// --match pins a target whose URL contains the given substring. Every call is bounded
// by a timeout; nothing here loops.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectPageTarget } from "./cdp_readonly.mjs";
import { dispatchMouseClick } from "./mouse_helper.mjs";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

const [cmd, portArg, ...rest] = process.argv.slice(2);
const port = Number(portArg);
if (!cmd || !Number.isFinite(port) || port <= 0) {
  console.error("usage: cdp_control.mjs <targets|eval|screenshot|click> <port> [--host H] [--match S] [--js JS] [--selector SEL] [--coords X,Y] [-o FILE]");
  process.exit(2);
}
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const host = opt("--host") || "127.0.0.1";
const match = opt("--match");
const js = opt("--js");
const selector = opt("--selector");
const coords = opt("--coords");
const outPath = opt("-o");
const timeoutMs = 15_000;
// positional args (flags and their values excluded)
const FLAG_VALS = new Set(["--host", "--match", "--js", "--selector", "--coords", "-o"]);
const posArgs = [];
for (let i = 0; i < rest.length; i++) { if (FLAG_VALS.has(rest[i])) i++; else posArgs.push(rest[i]); }

if (cmd === "click" && !selector && !coords) {
  console.error(JSON.stringify({ ok: false, error: "missing --selector or --coords" }));
  process.exit(2);
}

// 1) list targets
let list;
try {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: ac.signal });
  clearTimeout(to);
  if (!res.ok) { console.error(JSON.stringify({ ok: false, error: `CDP /json HTTP ${res.status}` })); process.exit(1); }
  list = await res.json();
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: `CDP unreachable: ${e.message || e}` }));
  process.exit(1);
}

if (cmd === "targets") {
  const pages = list.filter((t) => t && t.type === "page" && /^https?:\/\//i.test(String(t.url)));
  console.log(JSON.stringify(pages.map((t) => ({ url: t.url, title: t.title })), null, 1));
  process.exit(0);
}

if (cmd !== "eval" && cmd !== "screenshot" && cmd !== "nav" && cmd !== "click") {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

// Bounded CDP session on one target: connect, hand `fn` a send(), always close.
async function cdpSession(t, fn) {
  const wsUrl = String(t.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://${host}:${port}/cdp`);
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
      const to = setTimeout(() => { ws.off("message", h); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      const h = (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id !== id) return;
        clearTimeout(to); ws.off("message", h);
        resolve(msg.result ?? {});
      };
      ws.on("message", h);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(send, ws);
  } finally {
    try { ws.close(); } catch {}
  }
}

if (cmd === "nav") {
  const url = posArgs[0];
  if (!url) { console.error(JSON.stringify({ ok: false, error: "missing <url>" })); process.exit(2); }
  const any = list.find((t) => t && t.webSocketDebuggerUrl);
  if (!any) { console.error(JSON.stringify({ ok: false, error: "no CDP target to attach for navigation" })); process.exit(1); }
  let created;
  try {
    await cdpSession(any, async (send) => { created = await send("Target.createTarget", { url }); });
  } catch (e) { console.error(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); }
  const tid = created && created.targetId;
  if (!tid) { console.error(JSON.stringify({ ok: false, error: "Target.createTarget returned no targetId" })); process.exit(1); }
  // Bounded poll until the new target is listed.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let l2;
    try {
      const r2 = await fetch(`http://${host}:${port}/cdp/json`);
      l2 = await r2.json();
    } catch {}
    const hit = Array.isArray(l2) ? l2.find((t) => t && t.id === tid) : null;
    if (hit) { console.log(JSON.stringify({ ok: true, url: hit.url, title: hit.title })); process.exit(0); }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  console.error(JSON.stringify({ ok: false, error: "target created but not listed yet" }));
  process.exit(1);
}

// 2) pick the page target (eval/screenshot/click)
let target = match
  ? list.find((t) => t && t.type === "page" && String(t.url).includes(match))
  : selectPageTarget(list, {});
if (!target) { console.error(JSON.stringify({ ok: false, error: `no page target${match ? ` matching "${match}"` : ""}` })); process.exit(1); }

// 3) one bounded CDP call
let result;
try {
  await cdpSession(target, async (send) => {
    if (cmd === "eval") {
      if (!js) { console.error(JSON.stringify({ ok: false, error: "missing --js" })); process.exit(2); }
      const r = await send("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true });
      result = { ok: !r.exceptionDetails, url: target.url, value: r.result ? r.result.value : undefined, exception: r.exceptionDetails ? String(r.exceptionDetails.text) : null };
    } else if (cmd === "click") {
      let targetSpec;
      if (coords) {
        const [cx, cy] = coords.split(",").map(Number);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
          console.error(JSON.stringify({ ok: false, error: `invalid --coords: ${coords}` }));
          process.exit(2);
        }
        targetSpec = { x: cx, y: cy };
      } else {
        targetSpec = selector;
      }
      const clickRes = await dispatchMouseClick(send, targetSpec);
      result = { ok: true, url: target.url, ...clickRes };
    } else {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (outPath) { fs.writeFileSync(outPath, Buffer.from(String(r.data || ""), "base64")); result = { ok: true, url: target.url, path: outPath }; }
      else result = { ok: true, url: target.url, screenshot_b64: r.data };
    }
  });
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e), url: target.url }));
  process.exit(1);
}
console.log(JSON.stringify(result));
