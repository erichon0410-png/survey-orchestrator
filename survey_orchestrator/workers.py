"""Worker pool — manages concurrent Codex/Claude Code agent invocations."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from typing import Any, Optional

from survey_orchestrator.models import AgentConfig, OrchestratorConfig, SurveyTask

logger = logging.getLogger(__name__)


class WorkerPool:
    """Manages concurrent agent invocations via the Codex CLI."""

    def __init__(self, config: OrchestratorConfig) -> None:
        self.config = config
        self._max_concurrent = config.max_concurrent

    async def execute(
        self,
        task: SurveyTask,
        agent: AgentConfig,
        prompt_override: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute a single agent on a survey task. Returns structured results."""
        result: dict[str, Any] = {}

        # Build the prompt for this agent role
        if prompt_override:
            prompt = prompt_override
        else:
            prompt = self._build_prompt(task, agent)

        exec_args = agent.to_exec_args()
        cmd = (
            f"codex exec --dangerously-bypass-approvals-and-sandbox "
            f"-m {agent.model} "
            f"-c model_reasoning_effort={exec_args['reasoning_effort']} "
            f"\"{prompt}\" < /dev/null"
        )

        logger.info("Running agent %s (%s) on task %s", agent.name, agent.role.value, task.id)

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                timeout=self.config.timeout_seconds,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                raise RuntimeError(f"Exit code {proc.returncode}: {stderr.decode()[:500]}")

            output = stdout.decode("utf-8", errors="replace")
            result = self._parse_output(output, agent.role)

        except asyncio.TimeoutError:
            logger.error("Agent %s timed out on task %s", agent.name, task.id)
            raise RuntimeError(f"Timeout after {self.config.timeout_seconds}s")
        except Exception as e:
            logger.error("Agent %s error on task %s: %s", agent.name, task.id, e)
            raise

        return result

    def _build_prompt(self, task: SurveyTask, agent: AgentConfig) -> str:
        """Build the prompt string for a given agent role."""
        parts = []

        if agent.role.value == "research":
            parts.append(f"Research the subreddit r/{task.subreddit}.")
            parts.append(f"Title: {task.title}")
            parts.append("Return JSON with keys: research_notes, format_rules.")

        elif agent.role.value == "draft":
            notes = task.research_notes or "(none)"
            parts.append(f"Draft a survey response for r/{task.subreddit}.")
            parts.append(f"Title: {task.title}")
            parts.append(f"Research notes: {notes}")
            parts.append("Use the creator's shy 19F persona. Return JSON with key: draft_body.")

        elif agent.role.value == "refine":
            draft = task.draft_body or "(none)"
            parts.append(f"Refine this survey response for r/{task.subreddit}.")
            parts.append(f"Title: {task.title}")
            parts.append(f"Draft body: {draft}")
            parts.append("Match tone and style. Return JSON with key: refined_body.")

        elif agent.role.value == "validate":
            body = task.refined_body or (task.draft_body or "(none)")
            notes = task.research_notes or "(none)"
            parts.append(f"Validate this survey response for r/{task.subreddit}.")
            parts.append(f"Title: {task.title}")
            parts.append(f"Body: {body}")
            parts.append(f"Research/Format notes: {notes}")
            parts.append("Return JSON with key: validation_passed (boolean).")

        return "\n\n".join(parts)

    @staticmethod
    def _parse_output(output: str, role: AgentRole) -> dict[str, Any]:
        """Extract JSON from Codex output. Returns empty dict on failure."""
        # Try to find JSON block in output
        start = output.find("{")
        if start == -1:
            return {}

        end = output.rfind("}") + 1
        if end == 0:
            return {}

        try:
            data = json.loads(output[start:end])
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
