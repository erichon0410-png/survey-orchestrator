"""Configuration loading and validation."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from survey_orchestrator.models import AgentConfig, DEFAULT_AGENTS, OrchestratorConfig


def load_config(path: str | Path = "config/survey_config.yaml") -> OrchestratorConfig:
    """Load orchestrator config from YAML. Falls back to defaults if missing."""
    path = Path(path)
    if not path.exists():
        print(f"[WARN] Config file not found at {path}, using defaults.")
        return OrchestratorConfig(agents=DEFAULT_AGENTS)

    with open(path, "r") as f:
        data = yaml.safe_load(f) or {}

    # Merge agents from config with sensible defaults
    agent_dicts = data.get("agents", [])
    if not agent_dicts:
        agent_dicts = [a.model_dump() for a in DEFAULT_AGENTS]

    agents = [AgentConfig(**a) for a in agent_dicts]
    return OrchestratorConfig(agents=agents, **{k: v for k, v in data.items() if k != "agents"})


def save_config(config: OrchestratorConfig, path: str | Path = "config/survey_config.yaml") -> None:
    """Persist current config to YAML."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "agents": [a.model_dump() for a in config.agents],
        "max_concurrent": config.max_concurrent,
        "retry_attempts": config.retry_attempts,
        "timeout_seconds": config.timeout_seconds,
        "output_dir": config.output_dir,
        "log_level": config.log_level,
    }
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)


# Environment variable overrides (highest priority)
def apply_env_overrides(config: OrchestratorConfig) -> OrchestratorConfig:
    """Apply environment variable overrides to config."""
    mc = os.environ.get("SURVEY_MAX_CONCURRENT")
    if mc:
        config.max_concurrent = int(mc)
    ts = os.environ.get("SURVEY_TIMEOUT")
    if ts:
        config.timeout_seconds = int(ts)
    ra = os.environ.get("SURVEY_RETRIES")
    if ra:
        config.retry_attempts = int(ra)
    return config
