# Survey Orchestrator

Multi-agent survey completion system. Spawns Codex agents bound to browser containers
to farm surveys on reward platforms (Swagbucks, Opinion Outpost, Prime Opinion, Survey Junkie)
as a consistent persona.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  survey-orchestrator (this repo)                        │
│                                                         │
│  config/survey_config.yaml   ← agent/container binding  │
│  personas/mei_lin_chen.yaml  ← shared persona profile   │
│  prompts/survey_agent_prompt.txt ← OVERRIDE + task      │
│  survey_orchestrator/        ← Python orchestration pkg │
└─────────────────────────────────────────────────────────┘
         │  spawns via: codex exec -m <model> "<prompt>"
         ▼
┌─────────────────────────────────────────────────────────┐
│  Docker Containers (browser sandboxes)                  │
│                                                         │
│  SurveyCompleter-gmail-03 → port 3013                  │
│  SurveyCompleter-gmail-04 → port 3014                  │
│  SurveyCompleter-gmail-05 → port 3015                  │
│  SurveyCompleter-gmail-06 → port 3016                  │
│  SurveyCompleter-gmail-07 → port 3017                  │
│                                                         │
│  Each: Debian 13, Chromium 151, nginx :3000/:3001      │
└─────────────────────────────────────────────────────────┘
```

## Quick Start: Cloning Elsewhere

To clone and set up the orchestrator on another computer (under WSL or Linux):

```bash
# Clone the repository
git clone https://github.com/erichon0410-png/survey-orchestrator.git /home/erich/workspace/survey-orchestrator
cd /home/erich/workspace/survey-orchestrator

# (Or using GitHub CLI if authenticated)
gh repo clone erichon0410-png/survey-orchestrator /home/erich/workspace/survey-orchestrator
cd /home/erich/workspace/survey-orchestrator

# Install dependencies in editable mode
pip install -e .
# or: pip install -r requirements.txt
```

## Account Configuration (`config/survey_config.yaml`)

Before launching agents, you must populate your account credentials in [`config/survey_config.yaml`](file:///home/erich/workspace/survey-orchestrator/config/survey_config.yaml).

### Step-by-Step Setup

1. Open `config/survey_config.yaml` in your editor.
2. Locate each agent entry under `agents:` (ports 3013–3017).
3. Under the `account:` block for each agent, replace the placeholder values:
   ```yaml
   agents:
     - name: agent-03
       container: SurveyCompleter-gmail-03
       port: 3013
       model: gpt-5.6-luna
       reasoning_effort: medium
       persona: personas/mei_lin_chen.yaml
       platforms: [opinionoutpost]
       account:
         email: "YOUR_EMAIL_HERE"         # <--- Enter your platform login email
         password: "YOUR_PASSWORD_HERE"   # <--- Enter your platform password
         status: pending-login            # Change to logged-in-verified once verified
   ```
4. Configure all agent platform assignments:
   - **`agent-03`** (Port 3013): Opinion Outpost (`opinionoutpost`)
   - **`agent-04`** (Port 3014): Swagbucks (`swagbucks`)
   - **`agent-05`** (Port 3015): Prime Opinion (`primeopinion`)
   - **`agent-06`** (Port 3016): Survey Junkie (`surveyjunkie`)
   - **`agent-07`** (Port 3017): Swagbucks / Secondary (`swagbucks`)

> [!TIP]
> You can also save a local untracked configuration copy at `config/survey_config.yaml.local`. The repository `.gitignore` is pre-configured to ignore all `*.local.yaml` files and environment files (`.env`), keeping your actual credentials safe from git commits.

## Running Agents

Each agent is launched via `codex exec` using the prompt template. Run from the project root:

```bash
# Single agent (e.g. bound to container 3014)
codex exec --dangerously-bypass-approvals-and-sandbox \
  -m gpt-5.6-luna \
  -c model_reasoning_effort=medium \
  "$(cat prompts/survey_agent_prompt.txt)" < /dev/null

# All agents in parallel (background)
for port in 3013 3014 3015 3016 3017; do
  codex exec --dangerously-bypass-approvals-and-sandbox \
    -m gpt-5.6-luna \
    -c model_reasoning_effort=medium \
    "$(cat prompts/survey_agent_prompt.txt)" < /dev/null \
    > "logs/agent_${port}.log" 2>&1 &
done
```

### Automated Fleet Management

If using the background fleet scripts:
```bash
# Run fleet watcher / supervisor
node scripts/fleet_supervisor.mjs
```

## Key Files & Directories

| Path | Description |
|------|-------------|
| `config/survey_config.yaml` | Agent definitions, platform bindings, execution settings |
| `personas/mei_lin_chen.yaml` | Persona profile (Mei Lin Chen, 32F Asian/Chinese, Columbus OH) |
| `prompts/survey_agent_prompt.txt` | Complete agent prompt template with OVERRIDE header |
| `survey_orchestrator/` | Python package: CLI (`survey-orch`), executor, models, workers |
| `scripts/` | Fleet supervisor and survey driving automation scripts |
| `logs/` | Runtime logs (ignored by git, preserved with `.gitkeep`) |
| `reports/` | Survey outcome & error reports inbox/processed (ignored by git, preserved with `.gitkeep`) |
| `output/` | Status summaries & run outputs (ignored by git, preserved with `.gitkeep`) |

## Persona Integrity

All agents share one authoritative persona profile: **Mei Lin Chen**.
- Location: Columbus, Ohio (ZIP 43065)
- Demographics: 32, Female, Asian/Chinese, Married, 1 child
- Education & Work: PhD, Healthcare/Medical decision maker
- Household Income: $125k–$150k

> [!IMPORTANT]
> Do not remove or alter `personas/mei_lin_chen.yaml`. All survey answers must remain strictly aligned with Mei Lin Chen's demographic data across all platforms to maintain account standing and survey qualification consistency.

## Notes & Operational Tips

- The `OVERRIDE` header in `prompts/survey_agent_prompt.txt` directs the model to assume the persona directly rather than roleplaying.
- `gpt-5.6-luna` is the default model; if refusals occur, a less-aligned fallback model can be passed with `-m`.
- Container browser displays can be inspected live via Chromium CDP / Selkies streams over the mapped ports.
