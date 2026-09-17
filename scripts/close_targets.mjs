// close_targets.mjs — Close non-page targets (workers, browser_ui) via CDP
// Target.close is sent directly over WebSocket to each target.
// Usage: node scripts/close_targets.mjs <port> [--host 127.0.0.1]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

const [portArg, ...rest] = process.argv.slice(2);
const port = Number(portArg);
const host = rest.find((a) => a === "--host") ? rest[rest.indexOf("--host") + 1] : "127.0.0.1";

if (!Number.isFinite(port) || port <= 0) {
  console.error("usage: close_targets.mjs <port> [--host H]");
  process.exit(2);
}

// Fetch the target list
const ac = new AbortController();
const to = setTimeout(() => ac.abort(), 15_000);
let targets = [];
try {
  const res = await fetch(`http://${host}:${port}/cdp/json`, { signal: ac.signal });
  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, error: `HTTP ${res.status}` }));
    process.exit(1);
  }
  targets = await res.json();
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: `CDP unreachable: ${e.message}` }));
  process.exit(1);
}
clearTimeout(to);

// Close all non-page targets via Target.close
const closeResults = [];
const nonPages = targets.filter(
  (t) => t && t.type !== "page"
);

for (const target of nonPages) {
  try {
    const ws = new WebSocket(
      target.webSocketDebuggerUrl.replace("ws://", "wss://").replace("wss://", "ws://")
    );
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const msgId = Math.floor(Math.random() * 1_000_000_000);
    ws.send(JSON.stringify({
      id: msgId,
      method: "Target.close",
      params: { targetId: target.id }
    }));
    await new Promise((resolve, reject) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString() || "{}");
        if (parsed.id === msgId) {
          resolve(parsed);
        }
      });
      ws.on("error", reject);
    });
    ws.close();
    closeResults.push({ id: target.id, type: target.type, status: "closed", error: null });
    console.log(`CLOSED ${target.id} (${target.type})`);
  } catch (e) {
    closeResults.push({ id: target.id, type: target.type, status: "failed", error: String(e.message || e) });
    console.error(`FAILED to close ${target.id}: ${e.message}`);
  }
}

console.log(JSON.stringify(closeResults, null, 1));
process.exit(0);
