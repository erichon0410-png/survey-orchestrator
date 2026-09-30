// tests/test_live_stealth_cursor.mjs — Live verification of visual stealth cursor on container 3013
//
// Verifies:
// 1. Injects virtual cursor overlay (#codex-virtual-cursor) into live page
// 2. Dispatches human Bézier trajectory stealth click to target coordinates (450, 350)
// 3. Confirms #codex-virtual-cursor position in DOM updates along trajectory

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { stealthClick, injectVirtualCursor } from "../scripts/stealth_mouse.mjs";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

const PORT = Number(process.env.PORT) || 3013;
console.log(`[test] Connecting to container on port ${PORT}...`);

let list;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/cdp/json`);
  if (res.ok) list = await res.json();
} catch (e) {
  console.log(`Port ${PORT} not reachable (${e.message}), skipping live container test.`);
  process.exit(0);
}

const page = list?.find((t) => t && t.type === "page" && /^https?:\/\//i.test(String(t.url)));
if (!page) {
  console.log(`No active http(s) page target on port ${PORT}, skipping live container test.`);
  process.exit(0);
}

console.log(`[test] Connected to target page: ${page.url}`);

const wsUrl = String(page.webSocketDebuggerUrl).replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${PORT}/cdp`);
const ws = new WebSocket(wsUrl);

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
  setTimeout(() => reject(new Error("ws connect timeout")), 10000);
});

let id = 1;
function send(method, params = {}) {
  const reqId = id++;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.off("message", h);
      reject(new Error(`Timeout ${reqId} ${method}`));
    }, 10000);
    const h = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === reqId) {
        clearTimeout(to);
        ws.off("message", h);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result ?? {});
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

try {
  console.log("[test] 1. Injecting virtual cursor overlay...");
  await injectVirtualCursor(send);

  const checkRes = await send("Runtime.evaluate", {
    expression: "!!document.getElementById('codex-virtual-cursor')",
    returnByValue: true,
  });
  assert.equal(checkRes.result?.value, true, "#codex-virtual-cursor must exist in document");
  console.log("  ✓ Virtual cursor element #codex-virtual-cursor verified in DOM");

  console.log("[test] 2. Dispatching stealth Bézier movement & click at coordinates (450, 350)...");
  const clickRes = await stealthClick(send, { x: 450, y: 350 }, { minSteps: 5, maxSteps: 8, stepDelayMs: 10, dwellMs: 60, holdMs: 30, settleMs: 30 });
  assert.equal(clickRes.ok, true);
  console.log(`  ✓ stealthClick dispatched at (${clickRes.x}, ${clickRes.y})`);

  console.log("[test] 3. Verifying cursor position in DOM...");
  const posRes = await send("Runtime.evaluate", {
    expression: "document.getElementById('codex-virtual-cursor').style.transform",
    returnByValue: true,
  });
  assert.ok(posRes.result?.value.includes("350"), "cursor transform must reflect new Y position");
  assert.ok(posRes.result?.value.includes("450"), "cursor transform must reflect new X position");
  console.log(`  ✓ Cursor style transform updated: ${posRes.result?.value}`);

  console.log("PASS: test_live_stealth_cursor");
} finally {
  ws.close();
}
process.exit(0);
