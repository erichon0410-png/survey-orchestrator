---
name: survey-fleet-agent
description: "Control and inspect containerized survey agents (ports 3013-3017) directly from Discord channels (#agent-3013 through #agent-3017, #survey-reports)."
---

# Survey Fleet Agent Skill

Control and inspect containerized survey agents running across local ports 3013 through 3017 directly from Discord channels.

## Port to Channel and Platform Mappings

- **3013: SurveyJunkie** (`#agent-3013`) — SurveyJunkie worker (1)
- **3014: Swagbucks** (`#agent-3014`) — Primary Swagbucks worker
- **3015: SurveyJunkie** (`#agent-3015`) — SurveyJunkie worker (2)
- **3016: SurveyJunkie** (`#agent-3016`) — SurveyJunkie worker (3)
- **3017: Swagbucks 2** (`#agent-3017`) — Secondary Swagbucks worker
- **All: Fleet summary** (`#survey-reports`) — Fleet overview and executive rollup

## Control Script

The control CLI helper is located at:
`skills/survey-fleet-agent/scripts/agent_control.mjs`

Usage:
```bash
node skills/survey-fleet-agent/scripts/agent_control.mjs <status|screenshot|balance|nudge> <PORT>
```

## Concrete Handling Instructions for LLM

When interacting with a user in a Discord channel (or when responding to fleet commands):

1. **"status" / "what are you doing?":**
   - Run: `node skills/survey-fleet-agent/scripts/agent_control.mjs status <PORT>`
   - Present a clean markdown response containing:
     - Platform and Port
     - Active Page Title and URL
     - Last event recorded
     - Today's earnings (USD and raw points)
     - Timestamp

2. **"screenshot" / "show screen":**
   - Run: `node skills/survey-fleet-agent/scripts/agent_control.mjs screenshot <PORT>`
   - Parse the JSON output and attach the resulting `imagePath` in your response.

3. **"balance":**
   - Run: `node skills/survey-fleet-agent/scripts/agent_control.mjs balance <PORT>`
   - Report the current total earnings in USD and points for the container.

4. **"nudge" / "restart":**
   - Run: `node skills/survey-fleet-agent/scripts/agent_control.mjs nudge <PORT>`
   - Confirm that the container agent turn has been nudged.
