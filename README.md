# Survey Orchestrator

High-performance multi-agent survey completion fleet. Spawns autonomous browser workers bound to isolated Docker containers to farm questionnaires on reward platforms (Swagbucks, Survey Junkie, Eureka, Opinion Outpost) using the consistent **Mei Lin Chen** respondent profile.

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ survey-orchestrator                                                         │
│                                                                             │
│  scripts/fleet_supervisor.mjs    ← Fleet orchestration, health watchdog     │
│  scripts/survey_driver.mjs       ← Per-agent multi-turn lifecycle driver    │
│  scripts/deploy_fleet.mjs        ← Flexible CLI agent launcher              │
│  scripts/cdp_control.mjs         ← High-level Chrome DevTools CLI helper   │
│  scripts/survey_agent.patch.yml  ← Cordis profile patch (tools + providers) │
│  prompts/survey_agent_prompt.txt ← Anti-refusal persona + survey guidance   │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ├── Harness: DSH Headless (Default) or Codex CLI
         ├── Serving: Unsloth Studio, Raw llama.cpp, or Cloud (OpenRouter / OpenAI)
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Docker Browser Containers (Debian 13, Chromium, CDP proxy on :3000)         │
│                                                                             │
│  Port 3013 ──▶ SurveyCompleter-gmail-03 (Survey Junkie)                     │
│  Port 3014 ──▶ SurveyCompleter-gmail-04 (Swagbucks)                         │
│  Port 3015 ──▶ SurveyCompleter-gmail-05 (Survey Junkie)                     │
│  Port 3016 ──▶ SurveyCompleter-gmail-06 (Survey Junkie)                     │
│  Port 3017 ──▶ SurveyCompleter-gmail-07 (Swagbucks)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Requirements
- **Node.js**: v20+ (Node 22 recommended)
- **Docker Compose**: Running the 5 `SurveyCompleter` browser containers
- **LLM Serving Engine**: Any OpenAI-compatible server (local `llama-server`, `Unsloth Studio`, or cloud APIs)

### 2. Deploying the Fleet
```bash
# Deploy all 5 agents (defaults to DSH headless + local model)
node scripts/deploy_fleet.mjs

# Deploy specific ports only (e.g. Swagbucks 3014 and SurveyJunkie 3013)
node scripts/deploy_fleet.mjs 3013 3014

# Check fleet and container health
node scripts/fleet_status.mjs

# Gracefully halt the entire fleet
node scripts/stop_fleet.mjs
```

---

## ⚙️ Model Serving Configuration

The orchestrator supports **local GPU serving** (raw `llama.cpp` or `Unsloth Studio`) and **cloud models** (OpenRouter, OpenAI).

### Option A: Local Serving with `llama.cpp` (Raw `llama-server`)

To run completely locally on an RTX GPU (e.g. RTX 5080, 4090, 3090):

1. **Launch `llama-server`**:
   ```powershell
   # Windows Host (PowerShell)
   llama-server.exe -m C:\path\to\Ornith-1.5-9B-Q4_K_M.gguf `
     --port 8080 `
     --parallel 3 `
     --flash-attn on `
     -c 122880 `
     --cache-type-k q4_0 `
     --cache-type-v q4_0 `
     --spec-type draft-mtp `
     -ngl 99
   ```
2. **Configure Orchestrator Environment**:
   ```bash
   export SURVEY_HARNESS="dsh"
   export SURVEY_MODEL_PROVIDER="llama-cpp"
   export SURVEY_MODEL="Ornith-1.5-9B-Q4_K_M"
   export LLAMA_CPP_BASE_URL="http://127.0.0.1:8080/v1" # or Windows gateway IP under WSL
   ```

### Option B: Local Serving with Unsloth Studio

If using Unsloth Studio with speculative decoding and automatic port proxying:

```bash
export SURVEY_HARNESS="dsh"
export SURVEY_MODEL_PROVIDER="unsloth-studio"
export SURVEY_MODEL="Ornith-1.5-9B-Q4_K_M"
export UNSLOTH_STUDIO_API_KEY="sk-unsloth-your-token"
export UNSLOTH_STUDIO_BASE_URL="http://tank.tail576f3e.ts.net:8080/v1" # or your local studio endpoint
```

### Option C: Cloud Models (OpenRouter / OpenAI)

To drive the fleet using cloud models:

```bash
# Via OpenRouter (Claude 3.5 Sonnet, DeepSeek V3, etc.)
export SURVEY_MODEL_PROVIDER="openrouter"
export SURVEY_MODEL="anthropic/claude-3.5-sonnet"
export OPENROUTER_API_KEY="sk-or-v1-..."

# Or via OpenAI directly
export SURVEY_MODEL_PROVIDER="openai"
export SURVEY_MODEL="gpt-4o"
export OPENAI_API_KEY="sk-..."
```

---

## 🎛 Choosing Your Agent Harness

The driver supports two primary agent harnesses via `--harness` or `SURVEY_HARNESS`:

| Harness | Flag / Value | How it Works & Tools Provided |
| :--- | :--- | :--- |
| **DSH Headless** *(Default & Recommended)* | `--harness dsh` | Runs lightweight headless DSH sessions using `scripts/survey_agent.patch.yml`. Injects native `@deepseek-ai/dsh-tool-use-browser` CDP controls and bash for `cdp_control.mjs`. |
| **Codex CLI** | `--harness codex` | Runs standalone `codex exec` turns with multi-turn resume. Interacts via Node REPL (`mcp__node_repl__js`) or Playwright. |

You can override this on the fly:
```bash
# Run port 3014 using Codex with OpenRouter
node scripts/survey_driver.mjs --port 3014 --harness codex --provider openrouter --model anthropic/claude-3.5-sonnet

# Run port 3013 using DSH with local llama-server
node scripts/survey_driver.mjs --port 3013 --harness dsh --provider llama-cpp --model Ornith-1.5-9B-Q4_K_M
```

---

## 🌐 Connecting Agents to Browser Containers

Each browser container exposes its Chrome DevTools Protocol (CDP) through an internal Nginx proxy:
* **HTTP Endpoint**: `http://127.0.0.1:<PORT>/cdp/json`
* **WebSocket Endpoint**: `ws://127.0.0.1:<PORT>/cdp`

### Workspace CDP Control Helper (`scripts/cdp_control.mjs`)
Agents and operators can interact with any container directly from the terminal:

```bash
# 1. List active browser tabs
node scripts/cdp_control.mjs targets 3013

# 2. Evaluate JavaScript / Read DOM
node scripts/cdp_control.mjs eval 3013 --js "document.title"
node scripts/cdp_control.mjs eval 3013 --js "document.body.innerText"

# 3. Trusted Mouse Click (by CSS selector)
node scripts/cdp_control.mjs click 3013 --selector "button.start-survey"

# 4. Trusted Mouse Click (by coordinates)
node scripts/cdp_control.mjs click 3013 --coords 450,320

# 5. Capture PNG Screenshot
node scripts/cdp_control.mjs screenshot 3013 -o /tmp/shot_3013.png
```

---

## 🛡 Reliability & Safety Features

- **Fast-Crash Guard**: If a newly spawned driver crashes or exits with a non-zero code in `< 5000ms`, the supervisor halts further spawns to prevent runaway restart loops.
- **Tab Ceiling**: Enforces a strict maximum of 3 open tabs per container (`pruneExcessTabs`), closing leaked redirects or orphaned questionnaire popups.
- **Circuit Breakers & Idle Markers**: Detects platform dry spells ("No surveys available today") and automatically writes `idle_today` markers, saving GPU tokens and API credits.
- **Unified Clean Exit**: `scripts/stop_fleet.mjs` sweeps both drivers and detached DSH/Codex background processes cleanly.

---

## 🧪 Running Tests

Run the full automated test suite:
```bash
npm test
```
All 10 test suites (isolation, mouse emulation, fast crash guard, idle timeouts, DSH argument passing, and clean exit) must pass before pushing to production.
