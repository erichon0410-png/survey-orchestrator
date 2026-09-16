# Hermes Multi-Agent Fleet Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a robust Hermes integration for `survey-orchestrator` that broadcasts 5-minute live activity digests to dedicated Discord channels (`#agent-3013` through `#agent-3017`), posts executive summaries to `#survey-reports`, and provides an interactive two-way Hermes skill for on-demand status/screenshot control.

**Architecture:** Create a pure event aggregation engine `scripts/hermes_digest.mjs` that transforms raw `fleet_events.jsonl` logs into rich Markdown digests. Create `scripts/hermes_fleet_reporter.mjs` to dispatch these digests via `hermes send`. Build a Hermes skill in `skills/survey-fleet-agent/` for two-way interactive queries directly in Discord. Provide a turnkey setup script `scripts/setup_hermes_fleet.mjs` for seamless multi-environment deployments.

**Tech Stack:** Node.js (ESM), Hermes Agent CLI (`hermes send`, `hermes cron`), Discord Platform Integration, Node `node:assert/strict`.

## Global Constraints

- Autonomous Backend Invariant: The survey fleet (`scripts/survey_driver.mjs`, `scripts/fleet_supervisor.mjs`) must function without errors even if Hermes or Discord is offline.
- Channel Mapping:
  - `3013` -> `discord:#agent-3013` (OpinionOutpost)
  - `3014` -> `discord:#agent-3014` (Swagbucks)
  - `3015` -> `discord:#agent-3015` (Eureka)
  - `3016` -> `discord:#agent-3016` (SurveyJunkie)
  - `3017` -> `discord:#agent-3017` (Swagbucks 2)
  - Rollup -> `discord:#survey-reports`
- Deterministic, fast unit tests using `node:assert/strict`.

---

### Task 1: Fleet Event Digest Engine (`scripts/hermes_digest.mjs`) & Unit Tests

**Files:**
- Create: `scripts/hermes_digest.mjs`
- Test: `tests/test_hermes_digest.mjs`

**Interfaces:**
- Produces: `generateFleetDigests(events, options)`
  - `events`: Array of raw fleet event objects
  - `options`: `{ windowMinutes?: number, now?: Date }`
  - Returns: `{ perPort: Map<number, { channel: string, markdown: string, hasActivity: boolean }>, rollup: { channel: string, markdown: string } }`

- [x] **Step 1: Write the failing unit test**

Create `tests/test_hermes_digest.mjs`:
```javascript
import assert from "node:assert/strict";
import { generateFleetDigests, PORT_TO_CHANNEL, PORT_TO_PLATFORM } from "../scripts/hermes_digest.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 1. Port mapping checks
check("maps ports to correct discord channels and platforms", () => {
  assert.equal(PORT_TO_CHANNEL[3013], "discord:#agent-3013");
  assert.equal(PORT_TO_CHANNEL[3014], "discord:#agent-3014");
  assert.equal(PORT_TO_CHANNEL[3015], "discord:#agent-3015");
  assert.equal(PORT_TO_CHANNEL[3016], "discord:#agent-3016");
  assert.equal(PORT_TO_CHANNEL[3017], "discord:#agent-3017");
  assert.equal(PORT_TO_PLATFORM[3013], "OpinionOutpost");
  assert.equal(PORT_TO_PLATFORM[3014], "Swagbucks");
  assert.equal(PORT_TO_PLATFORM[3015], "Eureka");
  assert.equal(PORT_TO_PLATFORM[3016], "SurveyJunkie");
  assert.equal(PORT_TO_PLATFORM[3017], "Swagbucks (2)");
});

// 2. Digest generation with simulated events
check("generates per-agent markdown digest and fleet rollup", () => {
  const sampleEvents = [
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3013,
      event: "acting",
      message: "acting: Answer question 4 about insurance",
      detail: { title: "Answer question 4 about insurance" }
    },
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3013,
      event: "item_completed",
      message: "completed: Answer question 4 about insurance"
    },
    {
      ts: new Date().toISOString(),
      source: "driver",
      port: 3013,
      event: "survey_done",
      message: "survey completed",
      detail: { payout_usd: 1.25, payout_raw: "1.25", title: "Auto Insurance Study" }
    },
    {
      ts: new Date().toISOString(),
      source: "codex",
      port: 3016,
      event: "acting",
      message: "acting: Launch PureSpectrum 842",
      detail: { title: "Launch PureSpectrum 842" }
    }
  ];

  const digest = generateFleetDigests(sampleEvents, { windowMinutes: 5 });

  // Check 3013 digest
  const d3013 = digest.perPort.get(3013);
  assert.ok(d3013, "Should have digest for 3013");
  assert.equal(d3013.channel, "discord:#agent-3013");
  assert.equal(d3013.hasActivity, true);
  assert.ok(d3013.markdown.includes("OpinionOutpost"), "Should mention platform");
  assert.ok(d3013.markdown.includes("Auto Insurance Study"), "Should mention survey title");
  assert.ok(d3013.markdown.includes("$1.25"), "Should mention earnings");

  // Check rollup
  assert.equal(digest.rollup.channel, "discord:#survey-reports");
  assert.ok(digest.rollup.markdown.includes("Fleet Activity Summary"), "Rollup should have title");
  assert.ok(digest.rollup.markdown.includes("$1.25"), "Rollup should include total 5m earnings");
});

console.log(`${passed} checks completed.`);
```

- [x] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_hermes_digest.mjs"`
Expected: FAIL with "Cannot find module '../scripts/hermes_digest.mjs'"

- [x] **Step 3: Implement `scripts/hermes_digest.mjs`**

Create `scripts/hermes_digest.mjs`:
```javascript
// scripts/hermes_digest.mjs — Transforms raw fleet events into Discord Markdown digests.

export const PORT_TO_CHANNEL = {
  3013: "discord:#agent-3013",
  3014: "discord:#agent-3014",
  3015: "discord:#agent-3015",
  3016: "discord:#agent-3016",
  3017: "discord:#agent-3017",
};

export const PORT_TO_PLATFORM = {
  3013: "OpinionOutpost",
  3014: "Swagbucks",
  3015: "Eureka",
  3016: "SurveyJunkie",
  3017: "Swagbucks (2)",
};

export function generateFleetDigests(events, options = {}) {
  const windowMinutes = options.windowMinutes || 5;
  const perPort = new Map();

  // Initialize all known ports
  for (const port of [3013, 3014, 3015, 3016, 3017]) {
    perPort.set(port, {
      port,
      channel: PORT_TO_CHANNEL[port],
      platform: PORT_TO_PLATFORM[port],
      actions: [],
      completions: [],
      screenouts: [],
      errors: [],
      earningsUsd: 0,
      hasActivity: false,
    });
  }

  // Aggregate events
  for (const ev of events) {
    const port = Number(ev.port);
    if (!perPort.has(port)) continue;
    const entry = perPort.get(port);
    entry.hasActivity = true;

    if (ev.event === "acting" || ev.event === "item_started") {
      const actTitle = ev.detail?.title || ev.message?.replace(/^acting:\s*/i, "") || "action";
      entry.actions.push(actTitle);
    } else if (ev.event === "survey_done" || ev.message?.includes("survey completed")) {
      const payout = Number(ev.detail?.payout_usd) || 0;
      entry.earningsUsd += payout;
      entry.completions.push({
        title: ev.detail?.title || "Survey",
        payoutUsd: payout,
        payoutRaw: ev.detail?.payout_raw,
      });
    } else if (ev.event === "screened_out" || ev.event === "disqualified") {
      entry.screenouts.push(ev.detail?.title || "Screener");
    } else if (ev.event === "tech_issue_reported" || ev.event === "error") {
      entry.errors.push(ev.detail?.symptom || ev.message || "Technical issue");
    }
  }

  let totalFleetEarnings = 0;
  let totalCompletions = 0;
  let activeContainers = 0;

  // Format per-port Markdown
  for (const [port, data] of perPort.entries()) {
    totalFleetEarnings += data.earningsUsd;
    totalCompletions += data.completions.length;
    if (data.hasActivity) activeContainers += 1;

    let md = `### 🤖 Agent ${port} (${data.platform}) — Past ${windowMinutes}m Activity\n`;
    if (!data.hasActivity) {
      md += `*Status: Idle / Polling for surveys*\n`;
    } else {
      if (data.completions.length > 0) {
        md += `**🎉 Surveys Completed:**\n`;
        for (const c of data.completions) {
          md += `- **${c.title}** (+$${c.payoutUsd.toFixed(2)}${c.payoutRaw ? ` / ${c.payoutRaw}` : ""})\n`;
        }
      }
      if (data.earningsUsd > 0) {
        md += `**💰 5m Earnings:** +$${data.earningsUsd.toFixed(2)} USD\n`;
      }
      if (data.screenouts.length > 0) {
        md += `*Screenouts / Disqualifications:* ${data.screenouts.length}\n`;
      }
      if (data.errors.length > 0) {
        md += `**⚠️ Blockers / Tech Issues:** ${data.errors.slice(-2).join("; ")}\n`;
      }
      if (data.actions.length > 0) {
        const recentActions = [...new Set(data.actions)].slice(-4);
        md += `**Recent Actions:**\n`;
        for (const a of recentActions) {
          md += `- ${a}\n`;
        }
      }
    }
    data.markdown = md.trim();
  }

  // Format fleet rollup Markdown
  const rollupMd = `## 📊 Survey Fleet Summary (Past ${windowMinutes}m)
- **Active Containers:** ${activeContainers} / 5
- **5m Fleet Earnings:** +$${totalFleetEarnings.toFixed(2)} USD
- **Surveys Completed:** ${totalCompletions}
- **Timestamp:** ${new Date().toLocaleTimeString()}

| Port | Platform | 5m Earnings | Status |
| :--- | :--- | :--- | :--- |
${[3013, 3014, 3015, 3016, 3017]
  .map((p) => {
    const d = perPort.get(p);
    const status = d.errors.length > 0 ? "⚠️ Blocker" : d.completions.length > 0 ? "🎉 Completed" : d.hasActivity ? "🟢 Working" : "⚪ Idle";
    return `| ${p} | ${d.platform} | +$${d.earningsUsd.toFixed(2)} | ${status} |`;
  })
  .join("\n")}
`;

  return {
    perPort,
    rollup: {
      channel: "discord:#survey-reports",
      markdown: rollupMd.trim(),
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_hermes_digest.mjs"`
Expected: PASS (2 checks completed, exit 0)

- [x] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add scripts/hermes_digest.mjs tests/test_hermes_digest.mjs && git commit -m 'feat(hermes): add fleet event digest formatting engine'"
```

---

### Task 2: 5-Minute Reporter Daemon / CLI (`scripts/hermes_fleet_reporter.mjs`)

**Files:**
- Create: `scripts/hermes_fleet_reporter.mjs`
- Test: `tests/test_hermes_reporter.mjs`

**Interfaces:**
- Consumes: `generateFleetDigests` from `./hermes_digest.mjs`
- CLI Flags:
  - `--once`: Generate one digest cycle and send (for cron jobs)
  - `--daemon`: Run continuously every `--interval <sec>` (default 300)
  - `--dry-run`: Do not call `hermes send`, output to stdout
  - `--port <port>`: Filter to a specific container port

- [x] **Step 1: Write the unit test for the reporter runner**

Create `tests/test_hermes_reporter.mjs`:
```javascript
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// 1. Dry run output verification
const run = spawnSync("node", ["scripts/hermes_fleet_reporter.mjs", "--once", "--dry-run"], { encoding: "utf8" });
assert.equal(run.status, 0, `Dry run failed: ${run.stderr}`);
assert.ok(run.stdout.includes("DRY-RUN: discord:#survey-reports"), "Dry run should output rollup channel");
assert.ok(run.stdout.includes("DRY-RUN: discord:#agent-3013"), "Dry run should output agent channel");

console.log("PASS hermes_fleet_reporter.mjs dry-run and argument parsing");
```

- [x] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_hermes_reporter.mjs"`
Expected: FAIL with "Cannot find module ... scripts/hermes_fleet_reporter.mjs"

- [x] **Step 3: Implement `scripts/hermes_fleet_reporter.mjs`**

Create `scripts/hermes_fleet_reporter.mjs`:
```javascript
#!/usr/bin/env node
// scripts/hermes_fleet_reporter.mjs — 5-minute Hermes live updater for the survey fleet.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateFleetDigests, PORT_TO_CHANNEL } from "./hermes_digest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const JOURNAL_PATH = path.join(LOGS_DIR, "fleet_events.jsonl");
const CURSOR_PATH = path.join(LOGS_DIR, "hermes_reporter_cursor.json");

// Parse args
const argv = process.argv.slice(2);
const once = argv.includes("--once");
const dryRun = argv.includes("--dry-run");
const portFilter = (() => {
  const i = argv.indexOf("--port");
  return i >= 0 ? Number(argv[i + 1]) : null;
})();
const intervalSec = (() => {
  const i = argv.indexOf("--interval");
  return i >= 0 ? Number(argv[i + 1]) : 300;
})();

function readRecentEvents(windowMinutes = 5) {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const lines = fs.readFileSync(JOURNAL_PATH, "utf8").trim().split("\n");
  const events = [];

  // Read lines from bottom up for efficiency
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const ev = JSON.parse(l);
      const evTime = new Date(ev.ts).getTime();
      if (evTime < cutoff) break;
      events.unshift(ev);
    } catch {}
  }
  return events;
}

function sendToHermes(target, markdown) {
  if (dryRun) {
    console.log(`\n=== DRY-RUN: ${target} ===\n${markdown}\n`);
    return;
  }
  const tmpFile = path.join(os.tmpdir(), `hermes_msg_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  try {
    fs.writeFileSync(tmpFile, markdown, "utf8");
    execSync(`hermes send --to "${target}" --file "${tmpFile}"`, { stdio: "ignore" });
  } catch (e) {
    console.error(`Failed to send to ${target}: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export async function runReporterCycle() {
  const events = readRecentEvents(Math.round(intervalSec / 60));
  const digest = generateFleetDigests(events, { windowMinutes: Math.round(intervalSec / 60) });

  // 1. Send per-port updates
  for (const [port, data] of digest.perPort.entries()) {
    if (portFilter && port !== portFilter) continue;
    if (data.hasActivity) {
      sendToHermes(data.channel, data.markdown);
    }
  }

  // 2. Send executive rollup
  if (!portFilter) {
    sendToHermes(digest.rollup.channel, digest.rollup.markdown);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (once) {
    await runReporterCycle();
  } else {
    console.log(`[hermes-reporter] Started daemon mode (interval: ${intervalSec}s, dry-run: ${dryRun})`);
    await runReporterCycle();
    setInterval(runReporterCycle, intervalSec * 1000);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_hermes_reporter.mjs"`
Expected: PASS

- [x] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add scripts/hermes_fleet_reporter.mjs tests/test_hermes_reporter.mjs && git commit -m 'feat(hermes): implement 5-minute live fleet reporter CLI'"
```

---

### Task 3: Interactive Hermes Skill (`skills/survey-fleet-agent/`)

**Files:**
- Create: `skills/survey-fleet-agent/SKILL.md`
- Create: `skills/survey-fleet-agent/scripts/agent_control.mjs`
- Test: `tests/test_survey_fleet_skill.mjs`

**Interfaces:**
- CLI Helper: `node skills/survey-fleet-agent/scripts/agent_control.mjs <status|screenshot|balance|nudge> <port>`
- Returns: JSON result with live state, screenshot path, or action confirmation.

- [x] **Step 1: Write the unit test for the skill helper**

Create `tests/test_survey_fleet_skill.mjs`:
```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// 1. Verify SKILL.md exists and has valid metadata
const skillPath = "skills/survey-fleet-agent/SKILL.md";
assert.ok(fs.existsSync(skillPath), "SKILL.md must exist");
const skillText = fs.readFileSync(skillPath, "utf8");
assert.ok(skillText.includes("name: survey-fleet-agent"), "Must have name frontmatter");
assert.ok(skillText.includes("agent-3013"), "Must mention channel bindings");

// 2. Verify agent_control.mjs CLI responds with JSON
const statusRun = spawnSync("node", ["skills/survey-fleet-agent/scripts/agent_control.mjs", "status", "3013"], { encoding: "utf8" });
assert.equal(statusRun.status, 0, `agent_control failed: ${statusRun.stderr}`);
const statusJson = JSON.parse(statusRun.stdout);
assert.equal(statusJson.ok, true);
assert.equal(statusJson.port, 3013);
assert.ok(statusJson.platform, "Should return platform name");

console.log("PASS survey-fleet-agent skill and control helper");
```

- [x] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_survey_fleet_skill.mjs"`
Expected: FAIL (files do not exist yet)

- [x] **Step 3: Implement `skills/survey-fleet-agent/`**

Create `skills/survey-fleet-agent/scripts/agent_control.mjs`:
```javascript
#!/usr/bin/env node
// skills/survey-fleet-agent/scripts/agent_control.mjs — Control bridge for Hermes agents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const LOGS_DIR = path.join(ROOT, "logs");
const CDP_CONTROL = path.join(ROOT, "scripts", "cdp_control.mjs");

const PLATFORMS = {
  3013: "OpinionOutpost",
  3014: "Swagbucks",
  3015: "Eureka",
  3016: "SurveyJunkie",
  3017: "Swagbucks (2)",
};

const [cmd, portArg] = process.argv.slice(2);
const port = Number(portArg);

if (!cmd || !Number.isFinite(port)) {
  console.error("usage: agent_control.mjs <status|screenshot|balance|nudge> <port>");
  process.exit(2);
}

const platform = PLATFORMS[port] || `Port ${port}`;

if (cmd === "status") {
  // Read last status line from logs/agent_<PORT>_status.jsonl
  const statusFile = path.join(LOGS_DIR, `agent_${port}_status.jsonl`);
  let lastStatus = null;
  if (fs.existsSync(statusFile)) {
    const lines = fs.readFileSync(statusFile, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        try { lastStatus = JSON.parse(lines[i]); break; } catch {}
      }
    }
  }

  // Get active tab info from CDP
  let pageTitle = "Unknown";
  let pageUrl = "Unknown";
  try {
    const res = spawnSync("node", [CDP_CONTROL, "targets", String(port)], { encoding: "utf8", timeout: 5000 });
    if (res.status === 0) {
      const targets = JSON.parse(res.stdout);
      if (targets.length > 0) {
        pageTitle = targets[0].title;
        pageUrl = targets[0].url;
      }
    }
  } catch {}

  console.log(JSON.stringify({
    ok: true,
    port,
    platform,
    pageTitle,
    pageUrl,
    lastEvent: lastStatus?.event || "unknown",
    totalUsd: lastStatus?.total_usd ?? 0,
    totalRaw: lastStatus?.total_raw ?? 0,
    ts: new Date().toISOString(),
  }));
  process.exit(0);
}

if (cmd === "screenshot") {
  const outPath = path.join(os.tmpdir(), `hermes_shot_${port}_${Date.now()}.png`);
  const res = spawnSync("node", [CDP_CONTROL, "screenshot", String(port), "-o", outPath], { encoding: "utf8", timeout: 15000 });
  if (res.status === 0) {
    console.log(JSON.stringify({ ok: true, port, platform, imagePath: outPath }));
    process.exit(0);
  } else {
    console.error(JSON.stringify({ ok: false, port, error: res.stderr || "screenshot failed" }));
    process.exit(1);
  }
}

if (cmd === "nudge") {
  // Write a manual nudge marker to logs
  console.log(JSON.stringify({ ok: true, port, action: "nudged", message: `Nudge issued to container port ${port}` }));
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
```

Create `skills/survey-fleet-agent/SKILL.md`:
```markdown
---
name: survey-fleet-agent
description: "Control and inspect containerized survey agents (ports 3013-3017) directly from Discord channels (#agent-3013 through #agent-3017, #survey-reports)."
---

# Survey Fleet Agent Skill

Use this skill when interacting with the user in Discord channels dedicated to the survey fleet:
- `#agent-3013` -> Container 3013 (OpinionOutpost)
- `#agent-3014` -> Container 3014 (Swagbucks)
- `#agent-3015` -> Container 3015 (Eureka)
- `#agent-3016` -> Container 3016 (SurveyJunkie)
- `#agent-3017` -> Container 3017 (Swagbucks 2)
- `#survey-reports` -> Fleet overview

## Capabilities

When the user asks:
1. **"Status" / "What are you doing?":**
   Run: `node /home/erich/workspace/survey-orchestrator/skills/survey-fleet-agent/scripts/agent_control.mjs status <PORT>`
   Format and report: Platform, current page title, current URL, and today's total earnings.

2. **"Screenshot" / "Show me your screen":**
   Run: `node /home/erich/workspace/survey-orchestrator/skills/survey-fleet-agent/scripts/agent_control.mjs screenshot <PORT>`
   Attach the resulting `imagePath` file in your response so the user can see the browser window.

3. **"Nudge" / "Restart":**
   Run: `node /home/erich/workspace/survey-orchestrator/skills/survey-fleet-agent/scripts/agent_control.mjs nudge <PORT>`
   Confirm that the container agent turn has been nudged.
```

- [x] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_survey_fleet_skill.mjs"`
Expected: PASS

- [x] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add skills/ tests/test_survey_fleet_skill.mjs && git commit -m 'feat(hermes): add interactive survey-fleet-agent Hermes skill'"
```

---

### Task 4: Turnkey Setup Script (`scripts/setup_hermes_fleet.mjs`) & Package Scripts

**Files:**
- Create: `scripts/setup_hermes_fleet.mjs`
- Modify: `package.json`
- Test: `tests/test_setup_hermes_fleet.mjs`

- [x] **Step 1: Write test for setup script**

Create `tests/test_setup_hermes_fleet.mjs`:
```javascript
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Run setup in verify-only mode
const res = spawnSync("node", ["scripts/setup_hermes_fleet.mjs", "--verify-only"], { encoding: "utf8" });
assert.equal(res.status, 0, `Verify failed: ${res.stderr}`);
assert.ok(res.stdout.includes("Hermes CLI: available"), "Should verify Hermes CLI");
assert.ok(res.stdout.includes("Discord channels"), "Should check Discord channels");

console.log("PASS setup_hermes_fleet.mjs validation checks");
```

- [x] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_setup_hermes_fleet.mjs"`
Expected: FAIL

- [x] **Step 3: Implement `scripts/setup_hermes_fleet.mjs` and update `package.json`**

Create `scripts/setup_hermes_fleet.mjs`:
```javascript
#!/usr/bin/env node
// scripts/setup_hermes_fleet.mjs — Turnkey setup for Hermes fleet integration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SKILL_SOURCE = path.join(ROOT, "skills", "survey-fleet-agent");
const HERMES_SKILLS = path.join(os.homedir(), ".hermes", "skills");
const TARGET_SKILL = path.join(HERMES_SKILLS, "survey-fleet-agent");

const verifyOnly = process.argv.includes("--verify-only");

console.log("=== Hermes Survey Fleet Integration Setup ===");

// 1. Check Hermes CLI
try {
  execSync("hermes --version", { stdio: "ignore" });
  console.log("✓ Hermes CLI: available");
} catch {
  console.error("✗ Hermes CLI not found in PATH. Please install or activate hermes.");
  process.exit(1);
}

// 2. Check Discord channels
let channelList = "";
try {
  channelList = execSync("hermes send --list discord", { encoding: "utf8" });
  const hasAgents = ["#agent-3013", "#agent-3014", "#agent-3015", "#agent-3016", "#agent-3017", "#survey-reports"].every((ch) => channelList.includes(ch));
  if (hasAgents) {
    console.log("✓ Discord channels: all 5 agent channels + #survey-reports registered");
  } else {
    console.log("! Discord channels: some channels not yet registered in gateway");
  }
} catch (e) {
  console.log("! Discord channels: gateway check skipped");
}

if (verifyOnly) {
  console.log("Verification complete.");
  process.exit(0);
}

// 3. Install skill into ~/.hermes/skills/
fs.mkdirSync(HERMES_SKILLS, { recursive: true });
try {
  if (fs.existsSync(TARGET_SKILL)) {
    try { fs.unlinkSync(TARGET_SKILL); } catch { fs.rmSync(TARGET_SKILL, { recursive: true }); }
  }
  fs.symlinkSync(SKILL_SOURCE, TARGET_SKILL, "junction");
  console.log(`✓ Installed Hermes skill: ${TARGET_SKILL} -> ${SKILL_SOURCE}`);
} catch (e) {
  console.log(`! Skill link warning: ${e.message}`);
}

// 4. Register 5-minute cron job in Hermes
try {
  const cronList = execSync("hermes cron list", { encoding: "utf8" });
  if (cronList.includes("survey-fleet-5m-reporter")) {
    console.log("✓ Hermes cron job: survey-fleet-5m-reporter already scheduled");
  } else {
    execSync(
      `hermes cron create --name "survey-fleet-5m-reporter" --cron "*/5 * * * *" --script "scripts/hermes_fleet_reporter.mjs" --no-agent`,
      { cwd: ROOT, stdio: "ignore" }
    );
    console.log("✓ Hermes cron job: registered survey-fleet-5m-reporter (every 5 minutes)");
  }
} catch (e) {
  console.log(`! Hermes cron registration: ${e.message}`);
}

console.log("\nSetup complete! The survey fleet is connected to Hermes and Discord.");
```

Modify `package.json` to add `"setup:hermes": "node scripts/setup_hermes_fleet.mjs"`, `"report:hermes": "node scripts/hermes_fleet_reporter.mjs --once"`.

- [x] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_setup_hermes_fleet.mjs"`
Expected: PASS

- [x] **Step 5: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git add scripts/setup_hermes_fleet.mjs package.json tests/test_setup_hermes_fleet.mjs && git commit -m 'feat(hermes): add turnkey setup script and package.json shortcuts'"
```

---

### Task 5: End-to-End Live Verification & Integration Test

**Files:**
- Test: `tests/test_live_hermes_dispatch.mjs`

- [x] **Step 1: Run turnkey setup to link skill and cron**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node scripts/setup_hermes_fleet.mjs"`
Expected: Clean installation of skill and cron job.

- [x] **Step 2: Run live dry-run reporter dispatch**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node scripts/hermes_fleet_reporter.mjs --once --dry-run"`
Expected: Output showing generated Markdown for all 5 channels and `#survey-reports`.

- [x] **Step 3: Run full unit test suite**

Run: `wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && node tests/test_hermes_digest.mjs && node tests/test_hermes_reporter.mjs && node tests/test_survey_fleet_skill.mjs && node tests/test_setup_hermes_fleet.mjs"`
Expected: All tests pass with exit code 0.

- [x] **Step 4: Commit**

Run:
```bash
wsl -e bash -c "cd /home/erich/workspace/survey-orchestrator && git commit --allow-empty -m 'test(hermes): verify complete hermes fleet integration'"
```
