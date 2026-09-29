// tests/test_system1_runner.mjs — Paced Fast-Path Execution Engine Unit Tests
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { tryExecuteFastPath, withCDPSession } from "../scripts/system1_runner.mjs";
import { MEI_LIN_CHEN_PERSONA } from "../scripts/system1_decision.mjs";

let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import(path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "ws", "index.js"))).default;
}

console.log("[test] 1. tryExecuteFastPath handles demographic choice, paces reading/dwell, clicks option and next button");
{
  const mouseEvents = [];
  const sleepCalls = [];

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      // Simulate harvestControls in-page script evaluation
      return {
        result: {
          value: [
            {
              role: "radio",
              label: "Male",
              tag: "input",
              type: "radio",
              x: 150,
              y: 200,
              w: 20,
              h: 20,
              checked: false,
              isSubmitOrNext: false,
            },
            {
              role: "radio",
              label: "Female",
              tag: "input",
              type: "radio",
              x: 150,
              y: 240,
              w: 20,
              h: 20,
              checked: false,
              isSubmitOrNext: false,
            },
            {
              role: "radio",
              label: "Prefer not to say",
              tag: "input",
              type: "radio",
              x: 150,
              y: 280,
              w: 20,
              h: 20,
              checked: false,
              isSubmitOrNext: false,
            },
            {
              role: "button",
              label: "Next",
              tag: "button",
              type: "submit",
              x: 300,
              y: 400,
              w: 100,
              h: 40,
              checked: false,
              isSubmitOrNext: true,
            },
          ],
        },
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      mouseEvents.push(params);
      return {};
    }
    return {};
  };

  const mockSleep = async (ms) => {
    sleepCalls.push(ms);
  };

  const result = await tryExecuteFastPath(3013, {
    send: mockSend,
    persona: MEI_LIN_CHEN_PERSONA,
    sleepFn: mockSleep,
  });

  assert.equal(result.handled, true, "fast-path should handle standard choice");
  assert.equal(result.action, "fastpath_completed");
  assert.equal(result.optionClicked, "Female");
  assert.equal(result.nextClicked, true);
  assert.ok(result.pacedMs > 0, "must record total paced duration");
  assert.ok(result.decision && result.decision.canHandle === true);
  assert.equal(result.decision.targetControl.label, "Female");

  // Verify pacing dwell milestones were recorded
  // readingMs, preClickDwellMs, postClickDwellMs, preSubmitDwellMs
  assert.ok(sleepCalls.length >= 3, `expected at least 3 dwell intervals, got ${sleepCalls.length}`);
  const totalSlept = sleepCalls.reduce((sum, d) => sum + d, 0);
  assert.equal(result.pacedMs, totalSlept, "total paced ms must match slept intervals");

  // Verify mouse events: option click + next button click
  const pressedEvents = mouseEvents.filter((e) => e.type === "mousePressed");
  const releasedEvents = mouseEvents.filter((e) => e.type === "mouseReleased");
  assert.equal(pressedEvents.length, 2, "must dispatch 2 mousePressed events (option + next)");
  assert.equal(releasedEvents.length, 2, "must dispatch 2 mouseReleased events (option + next)");

  // Female is at (150, 240) size 20x20 -> press coords should be near center
  assert.ok(pressedEvents[0].x >= 140 && pressedEvents[0].x <= 180, `female click x=${pressedEvents[0].x}`);
  assert.ok(pressedEvents[0].y >= 230 && pressedEvents[0].y <= 270, `female click y=${pressedEvents[0].y}`);

  // Next button is at (300, 400) size 100x40 -> press coords should be near center
  assert.ok(pressedEvents[1].x >= 280 && pressedEvents[1].x <= 420, `next click x=${pressedEvents[1].x}`);
  assert.ok(pressedEvents[1].y >= 380 && pressedEvents[1].y <= 440, `next click y=${pressedEvents[1].y}`);
}

console.log("[test] 2. tryExecuteFastPath handles question without next button");
{
  const mouseEvents = [];
  const sleepCalls = [];

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: [
            { role: "radio", label: "Female", x: 100, y: 200, w: 20, h: 20, isSubmitOrNext: false },
            { role: "radio", label: "Male", x: 100, y: 240, w: 20, h: 20, isSubmitOrNext: false },
          ],
        },
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      mouseEvents.push(params);
      return {};
    }
    return {};
  };

  const result = await tryExecuteFastPath(3013, {
    send: mockSend,
    sleepFn: async (ms) => sleepCalls.push(ms),
  });

  assert.equal(result.handled, true);
  assert.equal(result.optionClicked, "Female");
  assert.equal(result.nextClicked, false);
  const pressedEvents = mouseEvents.filter((e) => e.type === "mousePressed");
  assert.equal(pressedEvents.length, 1, "only 1 click when no next button is present");
}

console.log("[test] 3. tryExecuteFastPath falls back cleanly to System 2 on textarea / complex controls");
{
  let clickDispatched = false;

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: [
            { role: "radio", label: "Yes", x: 100, y: 200, isSubmitOrNext: false },
            { role: "radio", label: "No", x: 100, y: 240, isSubmitOrNext: false },
            { role: "textbox", tag: "textarea", label: "Please explain your feedback in detail", isSubmitOrNext: false },
            { role: "button", label: "Next", x: 200, y: 350, isSubmitOrNext: true },
          ],
        },
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      clickDispatched = true;
      return {};
    }
    return {};
  };

  const result = await tryExecuteFastPath(3013, { send: mockSend });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "needs_system2");
  assert.equal(clickDispatched, false, "must not click anything on fallback");
}

console.log("[test] 4. tryExecuteFastPath falls back cleanly on ambiguous or low-confidence questions");
{
  let clickDispatched = false;

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: [
            { role: "radio", label: "Quantum Flux", x: 100, y: 200, isSubmitOrNext: false },
            { role: "radio", label: "Dark Matter", x: 100, y: 240, isSubmitOrNext: false },
          ],
        },
      };
    }
    if (method === "Input.dispatchMouseEvent") {
      clickDispatched = true;
      return {};
    }
    return {};
  };

  const result = await tryExecuteFastPath(3013, { send: mockSend });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "needs_system2");
  assert.equal(clickDispatched, false);
}

console.log("[test] 5. tryExecuteFastPath handles empty controls and harvest errors gracefully");
{
  // A. Empty controls
  const emptySend = async (method) => ({
    result: { value: [] },
  });
  const emptyResult = await tryExecuteFastPath(3013, { send: emptySend });
  assert.equal(emptyResult.handled, false);
  assert.equal(emptyResult.reason, "no_controls");

  // B. Harvest evaluation failure
  const failingSend = async () => ({
    exceptionDetails: { text: "Protocol error: page crashed" },
  });
  const failResult = await tryExecuteFastPath(3013, { send: failingSend });
  assert.equal(failResult.handled, false);
  assert.ok(failResult.reason.includes("harvest_error") || failResult.reason.includes("Protocol error"));
}

console.log("[test] 6. tryExecuteFastPath standalone port invocation over CDP session");
{
  // A. Unreachable CDP port returns graceful failure without throwing
  const deadPortResult = await tryExecuteFastPath(59999, { timeoutMs: 300 });
  assert.equal(deadPortResult.handled, false);
  assert.ok(deadPortResult.reason.includes("cdp_connection_failed") || deadPortResult.reason.includes("ECONNREFUSED") || deadPortResult.reason.includes("fetch failed"));

  // B. Mock CDP HTTP + WebSocket server
  if (WebSocket && WebSocket.Server) {
    let wsServerConnected = false;
    let evalReceived = false;

    const httpServer = http.createServer((req, res) => {
      if (req.url === "/cdp/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "target-page-1",
              type: "page",
              title: "Survey Question",
              url: "https://survey.example.com/start",
              webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/cdp/target-page-1`,
            },
          ])
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const wss = new WebSocket.Server({ noServer: true });
    httpServer.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws) => {
      wsServerConnected = true;
      ws.on("message", (msg) => {
        const req = JSON.parse(msg.toString());
        if (req.method === "Runtime.evaluate") {
          evalReceived = true;
          if (req.params?.expression && (req.params.expression.includes("checkVisibility") || req.params.expression.includes("visibleControls"))) {
            // Return Female option + Next button for harvestControls
            ws.send(
              JSON.stringify({
                id: req.id,
                result: {
                  result: {
                    value: [
                      { role: "radio", label: "Female", x: 100, y: 200, w: 20, h: 20, isSubmitOrNext: false },
                      { role: "radio", label: "Male", x: 100, y: 240, w: 20, h: 20, isSubmitOrNext: false },
                      { role: "button", label: "Next", x: 200, y: 350, w: 80, h: 30, isSubmitOrNext: true },
                    ],
                  },
                },
              })
            );
            return;
          }
          ws.send(JSON.stringify({ id: req.id, result: {} }));
        } else if (req.method === "Page.addScriptToEvaluateOnNewDocument") {
          ws.send(JSON.stringify({ id: req.id, result: { identifier: "1" } }));
        } else if (req.method === "Input.dispatchMouseEvent") {
          ws.send(JSON.stringify({ id: req.id, result: {} }));
        } else {
          ws.send(JSON.stringify({ id: req.id, result: {} }));
        }
      });
    });

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const serverPort = httpServer.address().port;

    try {
      const fastResult = await tryExecuteFastPath(serverPort, {
        sleepFn: async () => {}, // instant sleep for test speed
      });

      assert.equal(wsServerConnected, true, "WS server received connection");
      assert.equal(evalReceived, true, "CDP received evaluate command");
      assert.equal(fastResult.handled, true, "standalone invocation handled page");
      assert.equal(fastResult.optionClicked, "Female");
      assert.equal(fastResult.nextClicked, true);
    } finally {
      wss.close();
      httpServer.close();
    }
  }
}


console.log("[test] 7. tryExecuteFastPath neural Laya decision integration");
{
  const mockElements = [
    { role: "radio", label: "I rent an apartment", x: 100, y: 200, w: 20, h: 20, isSubmitOrNext: false },
    { role: "radio", label: "I own a single-family home", x: 100, y: 240, w: 20, h: 20, isSubmitOrNext: false },
    { role: "radio", label: "I live with parents", x: 100, y: 280, w: 20, h: 20, isSubmitOrNext: false },
    { role: "button", label: "Next", x: 200, y: 350, w: 80, h: 30, isSubmitOrNext: true }
  ];

  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: mockElements } };
    }
    return {};
  };

  // Mock neural fetchFn for deterministic offline testing
  const mockFetchFn = async () => ({
    model: "laya-english",
    answers: {
      survey_question: {
        type: "choice",
        choice: "I own a single-family home",
        confidence: 0.92,
        probabilities: {
          "I rent an apartment": 0.05,
          "I own a single-family home": 0.92,
          "I live with parents": 0.03
        }
      }
    }
  });

  const res = await tryExecuteFastPath(3013, {
    send: mockSend,
    sleepFn: async () => {},
    useNeuralLaya: true,
    fetchFn: mockFetchFn,
  });

  assert.equal(res.handled, true, "neural Laya handled the question");
  assert.equal(res.optionClicked, "I own a single-family home");
  assert.equal(res.nextClicked, true);
  assert.ok(res.decision.reason.includes("unsloth_laya_neural"));
}

console.log("PASS: test_system1_runner");

