// scripts/fleet_events.mjs — standard event envelope and codex normalizer for fleet observability.
// Node 18+ ESM, stdlib only.

export function iso() {
  return new Date().toISOString();
}

/**
 * Standardized Fleet Event Envelope
 */
export function createEventEnvelope({
  source = "codex",
  port = null,
  event = "activity",
  message = "",
  detail = null,
  ts = null,
}) {
  return {
    ts: ts || iso(),
    source,
    port: port !== null && port !== undefined ? Number(port) : null,
    event,
    message: String(message),
    detail: detail || undefined,
  };
}

/**
 * Extract earnings from text if present (e.g. "$0.15", "$4.55", "25 SB", "50 points")
 */
export function parseEarningsFromText(text) {
  if (typeof text !== "string") return null;

  // Match "$0.15" or "$4.55" or "earned $2.00"
  const dollarMatch = text.match(/(?:earned\s*|earn\s*|balance(?:\s*updated)?:\s*|\+\s*|\$\s*)(\d+\.\d{2})/i);
  if (dollarMatch) {
    const val = parseFloat(dollarMatch[1]);
    if (!isNaN(val)) {
      return { earnedUsd: val, rawMatch: dollarMatch[0] };
    }
  }

  // Match SB (Swagbucks: 100 SB = $1.00)
  const sbMatch = text.match(/(\d+)\s*SB/i);
  if (sbMatch) {
    const sb = parseInt(sbMatch[1], 10);
    if (!isNaN(sb) && sb > 0) {
      return { earnedUsd: Math.round(sb * 0.01 * 100) / 100, rawMatch: sbMatch[0] };
    }
  }

  // Match points (Survey Junkie: 100 pts = $1.00)
  const ptsMatch = text.match(/(\d+)\s*points/i);
  if (ptsMatch) {
    const pts = parseInt(ptsMatch[1], 10);
    if (!isNaN(pts) && pts > 0) {
      return { earnedUsd: Math.round(pts * 0.01 * 100) / 100, rawMatch: ptsMatch[0] };
    }
  }

  return null;
}

/**
 * Normalizes a raw codex JSON line into a human-friendly FleetEvent.
 * If the line cannot be parsed as JSON or has no interesting information, returns null.
 */
export function normalizeCodexLine(line, port) {
  if (typeof line !== "string" || !line.trim()) return null;

  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }

  const type = data.type || "";

  // 1. Thread initialization
  if (type === "thread.started" || (data.thread_id && !type)) {
    const threadId = data.thread_id || data.id || "unknown";
    return createEventEnvelope({
      source: "codex",
      port,
      event: "thread_started",
      message: `codex thread started (${threadId})`,
      detail: { threadId },
    });
  }

  // 2. Tool call started (acting)
  if (type === "item.started") {
    const item = data.item || {};
    const args = item.arguments || {};
    const title = args.title || item.title || "";
    
    if (title) {
      return createEventEnvelope({
        source: "codex",
        port,
        event: "acting",
        message: `acting: ${title}`,
        detail: { item },
      });
    }

    if (item.type === "mcp_tool_call") {
      const toolName = item.tool || "tool";
      return createEventEnvelope({
        source: "codex",
        port,
        event: "acting",
        message: `calling tool ${toolName}`,
        detail: { item },
      });
    }
  }

  // 3. Tool call completed
  if (type === "item.completed") {
    const item = data.item || {};
    const args = item.arguments || {};
    const title = args.title || "";

    // Error in item
    if (item.error || data.error) {
      const err = item.error || data.error;
      const errStr = typeof err === "string" ? err : JSON.stringify(err);
      return createEventEnvelope({
        source: "codex",
        port,
        event: "error",
        message: `error: ${errStr.slice(0, 200)}`,
        detail: { item, error: err },
      });
    }

    // Check result content
    const res = item.result || {};
    let text = "";
    if (Array.isArray(res.content)) {
      for (const c of res.content) {
        if (c.type === "text" && c.text) text += c.text + " ";
      }
    } else if (typeof res === "string") {
      text = res;
    }

    // Check for earnings in result text
    const earnings = parseEarningsFromText(text);
    if (earnings && (text.includes("earned") || text.includes("completed") || text.includes("Balance updated") || text.includes("Survey completed"))) {
      return createEventEnvelope({
        source: "codex",
        port,
        event: "survey_earned",
        message: `port ${port} earned $${earnings.earnedUsd.toFixed(2)}!`,
        detail: { earnings, snippet: text.slice(0, 150) },
      });
    }

    // Check for interesting survey activity snippets
    if (text.includes("survey in progress") || text.includes("Complete to earn") || text.includes("questionnaire") || text.includes("Which everyday object")) {
      const snippet = text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      return createEventEnvelope({
        source: "codex",
        port,
        event: "survey_activity",
        message: title ? `${title}: ${snippet}` : snippet,
        detail: { snippet },
      });
    }

    if (title) {
      return createEventEnvelope({
        source: "codex",
        port,
        event: "item_completed",
        message: `completed: ${title}`,
        detail: { title },
      });
    }
  }

  // 4. Turn end / completed
  if (type === "turn.completed" || type === "turn/end") {
    return createEventEnvelope({
      source: "codex",
      port,
      event: "turn_completed",
      message: `codex turn completed`,
      detail: data,
    });
  }

  // 5. Explicit error event
  if (type === "error" || data.error) {
    const errMsg = data.message || (typeof data.error === "string" ? data.error : JSON.stringify(data.error));
    return createEventEnvelope({
      source: "codex",
      port,
      event: "error",
      message: `error: ${errMsg.slice(0, 200)}`,
      detail: data,
    });
  }

  return null;
}

/**
 * Format timestamp to [HH:MM:SS]
 */
function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return "00:00:00";
  }
}

/**
 * Formats a FleetEvent as a line for terminal output.
 */
export function formatTerminalLine(event, options = {}) {
  const { noColor = false } = options;
  const time = `[${formatTime(event.ts)}]`;
  const portLabel = event.port ? `[${event.port}]` : `[${event.source || "fleet"}]`;

  if (noColor) {
    return `${time} ${portLabel} ${event.message}`;
  }

  // ANSI color helpers
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const magenta = "\x1b[35m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";

  let coloredSource = `${cyan}${bold}${portLabel}${reset}`;
  if (!event.port) {
    coloredSource = `${magenta}${bold}${portLabel}${reset}`;
  }

  let coloredMsg = event.message;
  if (event.event === "error" || event.event === "tech_issue") {
    coloredMsg = `${red}${bold}${event.message}${reset}`;
  } else if (event.event === "survey_earned" || event.event === "target_reached") {
    coloredMsg = `${green}${bold}${event.message}${reset}`;
  } else if (event.event === "acting") {
    coloredMsg = `${yellow}${event.message}${reset}`;
  }

  return `${dim}${time}${reset} ${coloredSource} ${coloredMsg}`;
}
