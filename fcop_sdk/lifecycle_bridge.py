"""LifecycleKernel bridge — block bare fcop-mcp lifecycle MV from Python invoke path."""

from __future__ import annotations

import json
import os
from typing import Any

from fcop_sdk.tsx_runner import run_ts_cli

# Tool names (legacy + fcop-mcp canonical + CodeFlowMu semantic) → Kernel action
LIFECYCLE_TOOL_TO_ACTION: dict[str, str] = {
    "submit": "submit_review",
    "submit_task": "submit_review",
    "submit_review": "submit_review",
    "approve": "approve_review",
    "approve_task": "approve_review",
    "approve_review": "approve_review",
    "reject": "reject_review",
    "reject_task": "reject_review",
    "reject_review": "reject_review",
    "archive_task": "archive_task",
    "finish": "finish_task",
    "finish_task": "finish_task",
}

KERNEL_EXCLUSIVE_TOOLS = frozenset(LIFECYCLE_TOOL_TO_ACTION.keys())


def _run_lifecycle_cli(project_root: str, action: str, args: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps(args, ensure_ascii=False)
    raw = run_ts_cli("lifecycle_cli.ts", project_root, action, project_root, payload)
    if not raw:
        raise RuntimeError("lifecycle_cli empty output")
    data = json.loads(raw)
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or "lifecycle_cli failed")
    return data

def resolve_kernel_action(tool: str) -> str | None:
    return LIFECYCLE_TOOL_TO_ACTION.get(tool)


def invoke_lifecycle_kernel(
    project_root: str,
    tool: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Route lifecycle mutation through LifecycleKernel; never call fcop_mcp MV."""
    action = resolve_kernel_action(tool)
    if not action:
        raise ValueError(f"not a kernel lifecycle tool: {tool}")

    norm_args = dict(args)
    # fcop archive_task uses lang= not actor=
    if tool == "archive_task" and not norm_args.get("actor"):
        norm_args.setdefault("actor", os.environ.get("FCOP_ROLE", "PM"))

    result = _run_lifecycle_cli(project_root, action, norm_args)

    try:
        from fcop_sdk.ledger_bridge import rebuild_ledger

        rebuild_ledger(project_root)
    except Exception:
        pass

    return result


def format_kernel_result(data: dict[str, Any]) -> str:
    if data.get("ok"):
        tid = data.get("task_id", "?")
        fr = data.get("from", "?")
        to = data.get("to", "?")
        return f"LifecycleKernel OK: {tid} {fr} → {to}"
    return json.dumps(data, ensure_ascii=False)
