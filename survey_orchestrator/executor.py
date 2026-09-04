"""Task executor — handles retries, timeouts, and result aggregation."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from survey_orchestrator.models import AgentConfig, SurveyTask
from survey_orchestrator.workers import WorkerPool

logger = logging.getLogger(__name__)


class TaskExecutor:
    """Wraps WorkerPool with retry logic and result aggregation."""

    def __init__(self, pool: WorkerPool, max_retries: int = 1) -> None:
        self.pool = pool
        self.max_retries = max_retries

    async def execute_with_retry(
        self,
        task: SurveyTask,
        agent: AgentConfig,
        prompt_override: str | None = None,
    ) -> dict[str, Any]:
        """Execute an agent call with retry on failure."""
        last_error: Exception | None = None

        for attempt in range(1, self.max_retries + 2):
            try:
                result = await self.pool.execute(task, agent, prompt_override)
                if attempt > 1:
                    logger.info("Task %s succeeded on retry %d", task.id, attempt)
                return result

            except Exception as e:
                last_error = e
                logger.warning(
                    "Task %s failed (attempt %d/%d): %s",
                    task.id, attempt, self.max_retries + 1, e,
                )
                if attempt <= self.max_retries:
                    await asyncio.sleep(min(2 ** attempt, 10))

        logger.error("Task %s exhausted all retries: %s", task.id, last_error)
        raise last_error or RuntimeError("Unknown error")
