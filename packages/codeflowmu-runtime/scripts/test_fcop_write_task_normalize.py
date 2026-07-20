# -*- coding: utf-8 -*-
"""Unit checks for write_task arg normalization (run: python test_fcop_write_task_normalize.py)."""
from __future__ import annotations

import os
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from fcop_invoke_once import (  # noqa: E402
    _maybe_unescape_agent_body,
    normalize_write_task_args,
)


def test_unescape_literal_newlines_in_body() -> None:
    raw = "\\n---\\nprotocol: fcop\\nversion: 1\\n---\\n\\n## Goal\\nfix"
    out = _maybe_unescape_agent_body(raw)
    assert out.startswith("\n---\n") or out.startswith("---")
    assert "\\n---" not in out[:20]


def test_normalize_strips_embedded_frontmatter_and_maps_parent() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    body = (
        "---\n"
        "protocol: fcop\n"
        "version: 1\n"
        "sender: PM\n"
        "recipient: DEV\n"
        "priority: P1\n"
        "parent: TASK-20260606-007\n"
        "thread_key: panel-task-007\n"
        "---\n\n"
        "## 返工\n"
        "分析 6 个 Issue\n"
    )
    out = normalize_write_task_args(
        root,
        {
            "recipient": "DEV",
            "body": body,
        },
    )
    assert "protocol:" not in out["body"]
    assert "## 返工" in out["body"]
    assert out["references"] == "TASK-20260606-007"
    assert out["thread_key"] == "panel-task-007"
    assert out["recipient"] == "DEV"
    assert out["sender"] == "PM"
    assert out["priority"] == "P1"
    assert "parent" not in out


def test_normalize_parent_alias_to_references() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    out = normalize_write_task_args(
        root,
        {
            "recipient": "QA",
            "parent_task": "TASK-20260606-007",
            "body": "## QA 验证\n",
        },
    )
    assert out["references"] == "TASK-20260606-007"
    assert "parent" not in out


def test_normalize_literal_escape_body_from_panel() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    body = (
        "\\n---\\nprotocol: fcop\\nversion: \\1.0\\\\n"
        "sender: PM\\nrecipient: DEV\\npriority: P1\\n"
        "parent: TASK-20260606-007\\n---\\n\\n## 返工\\n"
    )
    out = normalize_write_task_args(
        root,
        {"recipient": "DEV", "body": body},
    )
    assert out["references"] == "TASK-20260606-007"
    assert "protocol:" not in out["body"]
    assert "## 返工" in out["body"]


def test_normalize_parent_from_body_label() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    body = (
        "**父任务引用：** TASK-20260606-013\n\n"
        "## 环境检查\n"
        "检查 FCoP、MCP、SKILLS。\n"
    )
    out = normalize_write_task_args(
        root,
        {"recipient": "DEV", "body": body},
    )
    assert out["references"] == "TASK-20260606-013"
    assert "父任务引用" in out["body"]


def test_normalize_subject_from_heading() -> None:
    root = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
    out = normalize_write_task_args(
        root,
        {
            "recipient": "DEV",
            "references": "TASK-20260606-007",
            "body": "# Issue 分析返工\n\n正文",
        },
    )
    assert out["subject"] == "Issue 分析返工"


LIVING_ADMIN_PM = "TASK-20260617-011"


def test_pm_downstream_writes_parent_and_thread_key() -> None:
    with tempfile.TemporaryDirectory() as root:
        active = os.path.join(root, "fcop", "_lifecycle", "active")
        os.makedirs(active, exist_ok=True)
        with open(
            os.path.join(active, f"{LIVING_ADMIN_PM}-ADMIN-to-PM.md"),
            "w",
            encoding="utf-8",
            newline="\n",
        ) as fh:
            fh.write(
                "---\n"
                "protocol: fcop\nversion: 1\n"
                f"task_id: {LIVING_ADMIN_PM}\n"
                "sender: ADMIN\nrecipient: PM\n"
                "thread_key: panel-task-011\n"
                "---\n"
            )
        for recipient in ("DEV", "QA", "OPS", "EVAL"):
            out = normalize_write_task_args(
                root,
                {
                    "recipient": recipient,
                    "references": LIVING_ADMIN_PM,
                    "body": "## downstream\n",
                },
            )
            assert out.get("parent") == LIVING_ADMIN_PM, recipient
            refs = out["references"]
            assert refs == LIVING_ADMIN_PM or refs == [LIVING_ADMIN_PM], recipient
            assert out.get("thread_key") == "panel-task-011", recipient


def test_qa_child_keeps_root_reference_and_explicit_dev_dependency() -> None:
    with tempfile.TemporaryDirectory() as root:
        active = os.path.join(root, "fcop", "_lifecycle", "active")
        os.makedirs(active, exist_ok=True)
        root_id = "TASK-20260712-001"
        dev_id = "TASK-20260712-002"
        with open(
            os.path.join(active, f"{root_id}-ADMIN-to-PM.md"),
            "w",
            encoding="utf-8",
            newline="\n",
        ) as fh:
            fh.write(
                "---\n"
                "protocol: fcop\nversion: 1\n"
                f"task_id: {root_id}\n"
                "sender: ADMIN\nrecipient: PM\n"
                "thread_key: panel-task-001\n"
                "---\n"
            )
        out = normalize_write_task_args(
            root,
            {
                "recipient": "QA",
                "references": [root_id, dev_id],
                "depends_on": [dev_id],
                "body": "## QA acceptance\n",
            },
        )
        assert out["parent"] == root_id
        assert out["thread_key"] == "panel-task-001"
        assert out["references"] == [root_id, dev_id]
        assert out["depends_on"] == [dev_id]


def test_qa_and_ops_infer_referenced_dev_dependency() -> None:
    with tempfile.TemporaryDirectory() as root:
        active = os.path.join(root, "fcop", "_lifecycle", "active")
        os.makedirs(active, exist_ok=True)
        root_id = "TASK-20260713-001"
        dev_id = "TASK-20260713-002"
        task_specs = (
            (root_id, "ADMIN", "PM", ""),
            (dev_id, "PM", "DEV", root_id),
        )
        for task_id, sender, recipient, parent in task_specs:
            with open(
                os.path.join(active, f"{task_id}-{sender}-to-{recipient}.md"),
                "w",
                encoding="utf-8",
                newline="\n",
            ) as fh:
                fh.write(
                    "---\n"
                    "protocol: fcop\n"
                    f"task_id: {task_id}\n"
                    f"sender: {sender}\n"
                    f"recipient: {recipient}\n"
                    f"parent: {parent}\n"
                    "thread_key: panel-task-001\n"
                    "---\n"
                )

        for recipient in ("QA", "OPS"):
            out = normalize_write_task_args(
                root,
                {
                    "recipient": recipient,
                    "references": [root_id, dev_id],
                    "body": "## validation\n",
                },
            )
            assert out["parent"] == root_id
            assert out["depends_on"] == [dev_id]


if __name__ == "__main__":
    test_unescape_literal_newlines_in_body()
    test_normalize_strips_embedded_frontmatter_and_maps_parent()
    test_normalize_parent_alias_to_references()
    test_normalize_literal_escape_body_from_panel()
    test_normalize_parent_from_body_label()
    test_normalize_subject_from_heading()
    test_pm_downstream_writes_parent_and_thread_key()
    test_qa_child_keeps_root_reference_and_explicit_dev_dependency()
    test_qa_and_ops_infer_referenced_dev_dependency()
    print("ok: write_task normalize")
