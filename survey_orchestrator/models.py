"""Data models for survey orchestration."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class AgentRole(str, Enum):
    """Roles an agent can take in the survey pipeline."""

    research = "research"       # Gather context, memory, RAG answers
    draft = "draft"             # Draft survey responses from context
    refine = "refine"           # Refine/rewrite for tone and style compliance
    validate = "validate"       # Validate against subreddit format rules


class TaskStatus(str, Enum):
    """Lifecycle of a task within the orchestrator."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SurveyTask(BaseModel):
    """A single survey submission unit. Each field is a sub-task for agents."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    subreddit: str = ""
    title: str = ""
    body: str = ""
    flair: str = ""
    nsfw: bool = False
    media_url: Optional[str] = None

    # Agent-assigned fields
    research_notes: str = ""
    draft_body: str = ""
    refined_body: str = ""
    validation_passed: bool = False

    status: TaskStatus = TaskStatus.PENDING
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    agent_id: Optional[str] = None
    errors: list[str] = Field(default_factory=list)

    def start(self, agent_id: str) -> None:
        self.status = TaskStatus.RUNNING
        self.agent_id = agent_id
        self.started_at = datetime.now(timezone.utc)

    def complete(self) -> None:
        self.status = TaskStatus.COMPLETED
        self.completed_at = datetime.now(timezone.UTC)

    def fail(self, error: str) -> None:
        self.status = TaskStatus.FAILED
        self.errors.append(error)


class AgentConfig(BaseModel):
    """Configuration for a single AI agent (Codex/Claude Code)."""

    name: str
    role: AgentRole
    model: str = "gpt-5.6-luna"
    reasoning_effort: str = "medium"  # low, medium, high, max
    max_turns: int = 10
    description: str = ""

    def to_exec_args(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
            "max_turns": self.max_turns,
        }


class OrchestratorConfig(BaseModel):
    """Top-level configuration for the orchestrator."""

    agents: list[AgentConfig] = Field(default_factory=list)
    max_concurrent: int = 3
    retry_attempts: int = 1
    timeout_seconds: int = 300
    output_dir: str = "output"
    log_level: str = "INFO"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OrchestratorConfig:
        return cls(**data)


# Default agent pipeline: research → draft → refine → validate
DEFAULT_AGENTS = [
    AgentConfig(
        name="researcher",
        role=AgentRole.research,
        model="gpt-5.6-luna",
        reasoning_effort="high",
        max_turns=12,
        description="Gathers subreddit context, RAG answers, and format rules for each survey.",
    ),
    AgentConfig(
        name="drafter",
        role=AgentRole.draft,
        model="gpt-5.6-luna",
        reasoning_effort="medium",
        max_turns=10,
        description="Drafts survey responses from research notes in the creator's voice.",
    ),
    AgentConfig(
        name="refiner",
        role=AgentRole.refine,
        model="gpt-5.6-luna",
        reasoning_effort="medium",
        max_turns=8,
        description="Refines drafts for tone, style, and subreddit compliance.",
    ),
    AgentConfig(
        name="validator",
        role=AgentRole.validate,
        model="gpt-5.6-luna",
        reasoning_effort="low",
        max_turns=5,
        description="Validates final output against subreddit format rules.",
    ),
]
