"""ADR-0002 ledger bridge — invoke TS LedgerBuilder via ledger_cli.ts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fcop_sdk.tsx_runner import run_ts_cli


def _run_cli(project_root: str, *args: str) -> str:
    return run_ts_cli("ledger_cli.ts", project_root, *args)


def rebuild_ledger(project_root: str) -> dict[str, Any]:
    raw = _run_cli(project_root, "rebuild", project_root)
    return json.loads(raw) if raw else {}


def list_tasks_from_ledger(
    project_root: str,
    recipient: str | None = None,
) -> list[dict[str, Any]]:
    args = ["list_tasks", project_root]
    if recipient and recipient.strip():
        args.append(recipient.strip())
    raw = _run_cli(project_root, *args)
    if not raw:
        return []
    data = json.loads(raw)
    return data if isinstance(data, list) else []


def verify_regression_237(project_root: str) -> dict[str, Any]:
    """Read-only 237 thread regression verify (rebuild + list_tasks + computed_status)."""
    raw = _run_cli(project_root, "verify_237", project_root)
    return json.loads(raw) if raw else {}


def verify_thread(project_root: str, task_id: str) -> dict[str, Any]:
    """Read-only thread diagnosis for any task_id (generalized verify_237)."""
    tid = (task_id or "").strip()
    if not tid:
        return {"error": "task_id required"}
    raw = _run_cli(project_root, "verify_thread", project_root, tid)
    return json.loads(raw) if raw else {}


def format_list_tasks_output(tasks: list[dict[str, Any]]) -> str:
    if not tasks:
        return "No pending tasks / 暂无新任务"
    lines = [f"Pending tasks (ledger): {len(tasks)}"]
    for t in tasks:
        tid = t.get("task_id", "?")
        sender = t.get("sender", "?")
        recip = t.get("recipient", "?")
        bucket = t.get("bucket", "?")
        fn = t.get("filename", "")
        lines.append(f"- {tid} {sender}→{recip} [{bucket}] {fn}")
    return "\n".join(lines)


def resolve_report_after_write(project_root: str, report_path: str) -> None:
    """Post-write_report hook: rebuild ledger + PM settlement + submit_review."""
    if not report_path or not os.path.isfile(report_path):
        base = os.path.basename(report_path)
        cand = os.path.join(project_root, "fcop", "reports", base)
        if os.path.isfile(cand):
            report_path = cand
        else:
            return
    _run_cli(project_root, "resolve_report", project_root, report_path)
