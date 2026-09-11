import assert from "node:assert";
import {
  createEventEnvelope,
  normalizeCodexLine,
  formatTerminalLine,
  parseEarningsFromText,
} from "../scripts/fleet_events.mjs";

console.log("Testing fleet_events...");

// 1. Envelope creation
const ev = createEventEnvelope({
  source: "supervisor",
  port: null,
  event: "tick_started",
  message: "tick started, 5 ports checked",
});
assert.strictEqual(ev.source, "supervisor");
assert.strictEqual(ev.port, null);
assert.strictEqual(typeof ev.ts, "string");
assert.strictEqual(ev.message, "tick started, 5 ports checked");

// 2. Earnings parsing
const earn1 = parseEarningsFromText("Survey completed! You earned $0.15 on Eureka");
assert.ok(earn1, "Should parse $0.15");
assert.strictEqual(earn1.earnedUsd, 0.15);

const earn2 = parseEarningsFromText("Balance updated: $4.55 / $5.00");
assert.ok(earn2, "Should parse $4.55");
assert.strictEqual(earn2.earnedUsd, 4.55);

const earn3 = parseEarningsFromText("earned 25 SB on Swagbucks");
assert.ok(earn3, "Should parse 25 SB");
assert.strictEqual(earn3.earnedUsd, 0.25);

// 3. Codex JSONL normalization: thread.started
const threadLine = JSON.stringify({ type: "thread.started", thread_id: "thread_abc123" });
const threadEv = normalizeCodexLine(threadLine, 3015);
assert.ok(threadEv);
assert.strictEqual(threadEv.port, 3015);
assert.strictEqual(threadEv.event, "thread_started");
assert.ok(threadEv.message.includes("thread_abc123"));

// 4. Codex JSONL normalization: item.started (MCP tool call with title)
const toolLine = JSON.stringify({
  type: "item.started",
  item: {
    id: "item_1",
    type: "mcp_tool_call",
    server: "node_repl",
    tool: "js",
    arguments: { title: "Confirm survey navigation", code: "location.href" },
  },
});
const toolEv = normalizeCodexLine(toolLine, 3015);
assert.ok(toolEv);
assert.strictEqual(toolEv.port, 3015);
assert.strictEqual(toolEv.event, "acting");
assert.ok(toolEv.message.includes("Confirm survey navigation"));

// 5. Codex JSONL normalization: item.completed with questionnaire text
const compLine = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_2",
    type: "mcp_tool_call",
    arguments: { title: "Inspect the questionnaire" },
    result: {
      content: [{ type: "text", text: "You have a survey in progress. Complete to earn $2.00!" }],
    },
  },
});
const compEv = normalizeCodexLine(compLine, 3015);
assert.ok(compEv);
assert.strictEqual(compEv.port, 3015);
assert.ok(compEv.message.includes("survey in progress") || compEv.message.includes("Complete to earn $2.00"));

// 6. Terminal formatting
const formatted = formatTerminalLine(compEv, { noColor: true });
assert.ok(formatted.includes("[3015]"));
assert.ok(formatted.includes(compEv.message));

// 7. Error normalization
const errLine = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_3",
    type: "mcp_tool_call",
    arguments: { title: "Click next button" },
    error: "element not interactable",
  },
});
const errEv = normalizeCodexLine(errLine, 3015);
assert.ok(errEv);
assert.strictEqual(errEv.event, "error");
assert.ok(errEv.message.includes("element not interactable"));

console.log("PASS test_fleet_events");
