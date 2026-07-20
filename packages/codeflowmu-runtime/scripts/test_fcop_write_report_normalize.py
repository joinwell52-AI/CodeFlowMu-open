# -*- coding: utf-8 -*-
"""Unit checks for write_report arg normalization (run: python test_fcop_write_report_normalize.py)."""
from __future__ import annotations

import os
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from fcop_invoke_once import (  # noqa: E402
    _collect_pm_admin_references,
    _fallback_write_report,
    _read_file_frontmatter_fields,
    _ensure_fcop_sdk_importable,
    _enrich_pm_admin_report_frontmatter,
    _infer_root_task_from_body,
    _normalize_report_status,
    _strip_markdown_frontmatter,
    _task_id_token_for_mcp,
    normalize_write_report_args,
)


def test_strip_frontmatter() -> None:
    body = "---\nprotocol: fcop\nsender: PM\n---\n\n## Summary\nok"
    clean, had = _strip_markdown_frontmatter(body)
    assert had
    assert "## Summary" in clean
    assert "protocol:" not in clean
    assert "sender:" not in clean


def test_normalize_drops_aliases_and_maps_sender() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    out = normalize_write_report_args(
        root,
        {
            "taskId": "TASK-20260531-239-ADMIN-to-PM",
            "sender": "PM",
            "recipient": "ADMIN",
            "body": "纯 Markdown",
            "subject": "ignored",
            "filename": "ignored.md",
        },
    )
    assert "taskId" not in out
    assert "sender" not in out
    assert "subject" not in out
    assert out["reporter"] == "PM"
    assert out["body"] == "纯 Markdown"


def test_task_id_token_for_mcp_strips_absolute_path() -> None:
    win_path = r"D:\codeflowmu\fcop\_lifecycle\review\TASK-20260606-006-ADMIN-to-PM.md"
    posix_path = "/proj/fcop/_lifecycle/review/TASK-20260606-006-ADMIN-to-PM.md"
    assert _task_id_token_for_mcp(win_path) == "TASK-20260606-006"
    assert _task_id_token_for_mcp(posix_path) == "TASK-20260606-006"
    assert _task_id_token_for_mcp("TASK-20260606-006") == "TASK-20260606-006"


def test_normalize_report_status_aliases() -> None:
    assert _normalize_report_status("completed") == "done"
    assert _normalize_report_status("COMPLETE") == "done"
    assert _normalize_report_status("in-progress") == "in_progress"
    assert _normalize_report_status("blocked") == "blocked"
    assert _normalize_report_status(None) is None


def test_normalize_write_report_maps_completed_status() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    out = normalize_write_report_args(
        root,
        {
            "task_id": "TASK-20260606-006-ADMIN-to-PM",
            "reporter": "PM",
            "recipient": "ADMIN",
            "status": "completed",
            "body": "done",
        },
    )
    assert out["status"] == "done"


def test_fcop_sdk_importable() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    _ensure_fcop_sdk_importable(root)
    import fcop_sdk.ledger_bridge  # noqa: F401


def test_infer_root_task_prefers_labeled_main_task() -> None:
    body = (
        "thread_key: panel-task-001\n"
        "主任务: `TASK-20260608-001`\n"
        "子任务 TASK-20260608-002-PM-to-OPS 已完成\n"
        "REPORT-20260608-002-OPS-to-PM.md\n"
    )
    assert _infer_root_task_from_body(body) == "TASK-20260608-001"


def test_normalize_pm_admin_infers_root_task_id() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    body = (
        "## 执行结果\n\n"
        "thread_key: `panel-task-001`\n"
        "主任务: `TASK-20260608-001`\n\n"
        "子任务回执 TASK-20260608-002-PM-to-OPS\n"
    )
    out = normalize_write_report_args(
        root,
        {
            "reporter": "PM",
            "recipient": "ADMIN",
            "status": "done",
            "body": body,
        },
    )
    assert out.get("task_id") == "TASK-20260608-001"


def test_collect_pm_admin_references_from_draft() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    draft_path = os.path.join(
        root, ".codeflowmu", "pm-governance", "drafts", "close-TASK-20260608-001.json"
    )
    if not os.path.isfile(draft_path):
        return
    import json

    with open(draft_path, encoding="utf-8") as f:
        draft = json.load(f)
    refs = _collect_pm_admin_references(
        root, "TASK-20260608-001-ADMIN-to-PM", draft
    )
    assert "TASK-20260608-001-ADMIN-to-PM" in refs
    assert "TASK-20260608-002-PM-to-OPS" in refs or any(
        "002" in r for r in refs
    )


def test_protocol_serializes_references_list() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    _ensure_fcop_sdk_importable(root)
    from fcop_sdk.protocol import serialize_frontmatter

    text = serialize_frontmatter(
        {
            "references": [
                "TASK-20260608-001-ADMIN-to-PM",
                "REPORT-20260608-002-OPS-to-PM",
            ]
        },
        "body",
    )
    assert "references:" in text
    assert "  - TASK-20260608-001-ADMIN-to-PM" in text
    assert "  - REPORT-20260608-002-OPS-to-PM" in text


def _write_test_task(root: str, *, reopened_count: int = 0) -> str:
    path = os.path.join(
        root,
        "fcop",
        "_lifecycle",
        "active",
        "TASK-20260711-001-ADMIN-to-PM.md",
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(
            "---\n"
            "protocol: fcop\n"
            "version: 1\n"
            "sender: ADMIN\n"
            "recipient: PM\n"
            f"reopened_count: {reopened_count}\n"
            "review_status: rejected\n"
            "---\n\nroot task\n"
        )
    return path


def test_fallback_report_revision_after_admin_reject() -> None:
    with tempfile.TemporaryDirectory() as root:
        task_path = _write_test_task(root, reopened_count=0)
        base = {
            "task_id": "TASK-20260711-001",
            "reporter": "PM",
            "recipient": "ADMIN",
            "status": "done",
        }
        first = _fallback_write_report(
            root, {**base, "body": "first delivery"}, RuntimeError("mcp failed")
        )
        assert first["ok"] is True
        assert first["revision"] == 1

        retry = _fallback_write_report(
            root, {**base, "body": "first delivery"}, RuntimeError("mcp failed")
        )
        assert retry["ok"] is True
        assert retry["deduplicated"] is True
        assert retry["filename"] == first["filename"]

        raw = open(task_path, encoding="utf-8").read()
        raw = raw.replace("reopened_count: 0", "reopened_count: 1")
        with open(task_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(raw)

        revised = _fallback_write_report(
            root,
            {**base, "body": "second delivery with DEV and QA evidence"},
            RuntimeError("TaskNotFoundError"),
        )
        assert revised["ok"] is True
        assert revised["filename"] != first["filename"]
        assert revised["revision"] == 2
        assert revised["rework_round"] == 1
        assert revised["revision_of"] == first["filename"].removesuffix(".md")
        fm = _read_file_frontmatter_fields(revised["path"])
        assert fm["revision_of"] == first["filename"].removesuffix(".md")
        assert fm["supersedes"] == first["filename"].removesuffix(".md")
        assert fm["rework_round"] == "1"


def test_fallback_report_rejects_missing_task() -> None:
    with tempfile.TemporaryDirectory() as root:
        result = _fallback_write_report(
            root,
            {
                "task_id": "TASK-20260711-999",
                "reporter": "PM",
                "recipient": "ADMIN",
                "status": "done",
                "body": "must not land",
            },
            RuntimeError("TaskNotFoundError"),
        )
        assert result["ok"] is False
        assert result["reason"] == "task_not_found"
        reports = os.path.join(root, "fcop", "reports")
        assert not os.path.isdir(reports) or not os.listdir(reports)


def test_fallback_report_preserves_runtime_evidence_metadata() -> None:
    with tempfile.TemporaryDirectory() as root:
        _write_test_task(root, reopened_count=0)
        result = _fallback_write_report(
            root,
            {
                "task_id": "TASK-20260711-001",
                "reporter": "QA",
                "recipient": "PM",
                "status": "done",
                "body": "QA evidence",
                "session_id": "session-d-mrhjbg2a",
                "run_id": "run-qa-2",
                "evidence_refs": ["qa-evidence/TASK-20260711-001/result-summary.json"],
            },
            RuntimeError("mcp failed"),
        )
        assert result["ok"] is True
        fm = _read_file_frontmatter_fields(result["path"])
        assert fm["session_id"] == "session-d-mrhjbg2a"
        assert fm["run_id"] == "run-qa-2"
        assert "TASK-20260711-001" in fm["evidence_refs"]


if __name__ == "__main__":
    test_strip_frontmatter()
    test_normalize_drops_aliases_and_maps_sender()
    test_task_id_token_for_mcp_strips_absolute_path()
    test_normalize_report_status_aliases()
    test_normalize_write_report_maps_completed_status()
    test_fcop_sdk_importable()
    test_infer_root_task_prefers_labeled_main_task()
    test_normalize_pm_admin_infers_root_task_id()
    test_collect_pm_admin_references_from_draft()
    test_protocol_serializes_references_list()
    test_fallback_report_revision_after_admin_reject()
    test_fallback_report_rejects_missing_task()
    test_fallback_report_preserves_runtime_evidence_metadata()
    print("ok: write_report normalize + fcop_sdk import")
