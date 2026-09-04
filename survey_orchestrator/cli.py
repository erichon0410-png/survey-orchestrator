"""CLI entry point for survey-orchestrator."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from survey_orchestrator.config import load_config, save_config
from survey_orchestrator.models import AgentConfig, AgentRole, SurveyTask
from survey_orchestrator.orchestrator import SurveyOrchestrator


def _add_task(args: argparse.Namespace) -> None:
    """Add a new survey task."""
    config = load_config(args.config)
    orch = SurveyOrchestrator(config)

    task = SurveyTask(
        subreddit=args.subreddit,
        title=args.title,
        body=args.body or "",
        flair=args.flair or "",
        nsfw=args.nsfw,
    )
    task_id = asyncio.run(orch.submit(task))
    print(json.dumps({"id": task_id, "status": task.status.value}, indent=2))


def _run_batch(args: argparse.Namespace) -> None:
    """Run a batch of tasks from a JSON file."""
    config = load_config(args.config)
    orch = SurveyOrchestrator(config)

    with open(args.batch_file) as f:
        tasks_data = json.load(f)

    tasks = [
        SurveyTask(
            subreddit=str(d.get("subreddit", "")),
            title=str(d.get("title", "")),
            body=str(d.get("body", "")),
            flair=str(d.get("flair", "")),
            nsfw=bool(d.get("nsfw", False)),
        )
        for d in tasks_data
    ]

    results = asyncio.run(orch.run_batch(tasks))
    output_path = orch.export_results(args.output_dir)
    print(f"Results written to {output_path}")


def _status(args: argparse.Namespace) -> None:
    """Show status of all tracked tasks."""
    config = load_config(args.config)
    orch = SurveyOrchestrator(config)

    # Rebuild state from output dir if exists
    import os
    output_dir = args.output_dir or config.output_dir
    results_path = Path(output_dir) / "results.json"
    if not results_path.exists():
        print("No results found. Run a batch first.")
        return

    with open(results_path) as f:
        results = json.load(f)

    for r in results:
        status_marker = "✓" if r["status"] == "completed" else "✗"
        sub = r["subreddit"]
        st = r["status"]
        title = r["title"]
        print(f"  {status_marker} [{st}] r/{sub} — {title}")


def _show_config(args: argparse.Namespace) -> None:
    """Show current config."""
    config = load_config(args.config)
    print(json.dumps({
        "agents": [a.model_dump() for a in config.agents],
        "max_concurrent": config.max_concurrent,
        "timeout_seconds": config.timeout_seconds,
    }, indent=2))


def _set_config(args: argparse.Namespace) -> None:
    """Update a single config value."""
    config = load_config(args.config)
    if args.key == "max_concurrent":
        config.max_concurrent = int(args.value)
    elif args.key == "timeout":
        config.timeout_seconds = int(args.value)
    elif args.key == "retries":
        config.retry_attempts = int(args.value)
    else:
        print(f"Unknown key: {args.key}")
        return

    save_config(config, args.config)
    print(f"Updated {args.key} = {args.value}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="survey-orch",
        description="Multi-agent survey completion orchestrator",
    )
    parser.add_argument("-c", "--config", default="config/survey_config.yaml", help="Config path")

    subparsers = parser.add_subparsers(dest="command", help="Command")

    # add-task
    p_add = subparsers.add_parser("add", help="Add a survey task")
    p_add.add_argument("--subreddit", required=True)
    p_add.add_argument("--title", required=True)
    p_add.add_argument("--body", default="")
    p_add.add_argument("--flair", default="")
    p_add.add_argument("--nsfw", action="store_true", default=False)
    p_add.set_defaults(func=_add_task)

    # run-batch
    p_batch = subparsers.add_parser("batch", help="Run a batch of tasks from JSON")
    p_batch.add_argument("batch_file", help="Path to JSON file with task definitions")
    p_batch.add_argument("--output-dir", default=None, help="Output directory for results")
    p_batch.set_defaults(func=_run_batch)

    # status
    p_status = subparsers.add_parser("status", help="Show task statuses")
    p_status.add_argument("--output-dir", default=None)
    p_status.set_defaults(func=_status)

    # show-config
    subparsers.add_parser("config", help="Show current config").set_defaults(func=_show_config)

    # set-config
    p_set = subparsers.add_parser("set", help="Update a config value")
    p_set.add_argument("key", help="Config key (max_concurrent, timeout, retries)")
    p_set.add_argument("value", help="New value")
    p_set.set_defaults(func=_set_config)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        args.func(args)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
