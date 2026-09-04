"""Survey task orchestrator — manages agent pipeline per submission."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from survey_orchestrator.models import (
    AgentConfig,
    AgentRole,
    OrchestratorConfig,
    SurveyTask,
    TaskStatus,
)
from survey_orchestrator.workers import WorkerPool

logger = logging.getLogger(__name__)


class SurveyOrchestrator:
    """Coordinates the research → draft → refine → validate pipeline."""

    def __init__(self, config: OrchestratorConfig) -> None:
        self.config = config
        self.pool = WorkerPool(config)
        self._tasks: dict[str, SurveyTask] = {}

    @property
    def agents(self) -> list[AgentConfig]:
        return self.config.agents

    def get_agent_for_role(self, role: AgentRole) -> AgentConfig | None:
        """Return the agent configured for the given role, or None."""
        for a in self.agents:
            if a.role == role:
                return a
        return None

    async def submit(self, task: SurveyTask) -> str:
        """Queue a survey task and return its ID."""
        self._tasks[task.id] = task
        await self._run_pipeline(task)
        return task.id

    async def _run_pipeline(self, task: SurveyTask) -> None:
        """Execute the full pipeline: research → draft → refine → validate."""
        roles = [
            AgentRole.research,
            AgentRole.draft,
            AgentRole.refine,
            AgentRole.validate,
        ]

        for role in roles:
            agent = self.get_agent_for_role(role)
            if agent is None:
                logger.warning("No agent configured for role %s — skipping", role.value)
                continue

            try:
                result = await self.pool.execute(task, agent)
                # Apply results back to the task
                if "research_notes" in result:
                    task.research_notes = result["research_notes"]
                if "draft_body" in result:
                    task.draft_body = result["draft_body"]
                if "refined_body" in result:
                    task.refined_body = result["refined_body"]
                if "validation_passed" in result:
                    task.validation_passed = bool(result["validation_passed"])

                # Pipeline stops at first validation failure
                if role == AgentRole.validate and not task.validation_passed:
                    task.fail("Validation failed — content does not match subreddit format")
                    return

            except Exception as e:
                task.fail(f"Agent {agent.name} ({role.value}) error: {e}")
                logger.error("Task %s failed at role %s: %s", task.id, role.value, e)
                return

        task.complete()

    def get_task(self, task_id: str) -> SurveyTask | None:
        return self._tasks.get(task_id)

    def list_tasks(self) -> list[SurveyTask]:
        return list(self._tasks.values())

    async def run_batch(self, tasks: list[SurveyTask]) -> dict[str, SurveyTask]:
        """Run a batch of survey tasks concurrently (bounded by max_concurrent)."""
        semaphore = asyncio.Semaphore(self.config.max_concurrent)

        async def _run_with_limit(task: SurveyTask) -> SurveyTask:
            async with semaphore:
                await self._run_pipeline(task)
                return task

        results = await asyncio.gather(
            *[_run_with_limit(t) for t in tasks],
            return_exceptions=True,
        )

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                if i < len(tasks):
                    tasks[i].fail(f"Batch execution error: {result}")
            else:
                task_id = result.id if hasattr(result, "id") else str(i)
                self._tasks[task_id] = result

        return dict(self._tasks)

    def export_results(self, output_dir: str | None = None) -> Path:
        """Write all completed/failed tasks to JSON in the output directory."""
        target = Path(output_dir or self.config.output_dir)
        target.mkdir(parents=True, exist_ok=True)

        results = []
        for task in self._tasks.values():
            results.append({
                "id": task.id,
                "subreddit": task.subreddit,
                "title": task.title,
                "body": task.refined_body or task.draft_body or task.body,
                "flair": task.flair,
                "nsfw": task.nsfw,
                "status": task.status.value,
                "validation_passed": task.validation_passed,
                "errors": task.errors,
            })

        out_path = target / "results.json"
        with open(out_path, "w") as f:
            json.dump(results, f, indent=2)

        logger.info("Wrote %d results to %s", len(results), out_path)
        return out_path
