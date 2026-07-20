"""ADR-0002 fixed work folders + ledger skeleton (idempotent)."""

from __future__ import annotations

from pathlib import Path

_LIFECYCLE_STAGES = ("inbox", "active", "review", "done", "archive")

_LEDGER_JSONL = ("tasks.jsonl", "reports.jsonl", "threads.jsonl")

_VIEW_FILES = (
    "ADMIN.inbox.md",
    "ADMIN.review.md",
    "PM.todo.md",
    "OPS.todo.md",
    "DEV.todo.md",
    "QA.todo.md",
)


def ensure_ledger_layout(project_dir: Path) -> Path:
    """Create fcop/tasks, reports, issues, ledger, _lifecycle, and empty jsonl/views."""
    fcop_dir = project_dir / "fcop"
    dirs = [
        fcop_dir / "tasks",
        fcop_dir / "reports",
        fcop_dir / "issues",
        fcop_dir / "ledger",
        fcop_dir / "ledger" / "views",
        *(fcop_dir / "_lifecycle" / stage for stage in _LIFECYCLE_STAGES),
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)

    for name in _LEDGER_JSONL:
        p = fcop_dir / "ledger" / name
        if not p.exists():
            p.write_text("", encoding="utf-8")

    for name in _VIEW_FILES:
        p = fcop_dir / "ledger" / "views" / name
        if not p.exists():
            slug = name.replace(".md", "")
            p.write_text(
                f"# {slug}\n\n_ledger view — run LedgerBuilder.rebuild() to refresh_\n",
                encoding="utf-8",
            )

    return fcop_dir
