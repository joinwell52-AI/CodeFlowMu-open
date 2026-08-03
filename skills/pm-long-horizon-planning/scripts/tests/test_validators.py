from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
SOURCE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "source-taskbook.md"
sys.path.insert(0, str(SCRIPTS))

from check_budget_schedule import check_budget_schedule
from validate_planning_model import validate_model
from verify_requirement_coverage import verify_coverage


def valid_model() -> dict:
    body = "# Product Brief\n\n## Validation Summary\nAll contracts satisfied."
    source_bytes = SOURCE_FIXTURE.read_bytes()
    return {
        "task_id": "TASK-20260803-001",
        "root_task_id": "TASK-20260803-001",
        "thread_key": "thread-1",
        "session_id": "session-1",
        "source": {
            "path": str(SOURCE_FIXTURE), "version": "v1", "digest": "sha256:" + hashlib.sha256(source_bytes).hexdigest(),
            "line_count": len(source_bytes.decode("utf-8").splitlines()), "read_at": "2026-08-03T20:00:00+08:00", "read_complete": True,
            "read_ranges": ["1-3"], "references": [str(SOURCE_FIXTURE)],
        },
        "requirements": [{
            "id": "REQ-0001", "source_line_start": 1, "source_line_end": 2, "quote": "must",
            "statement_type": "normative_constraint", "modality": "MUST", "responsible_role": "DEV",
            "acceptor": "PM", "brief_section": "总体规划", "wp_ids": ["WP-00"], "gate_ids": ["Gate-A"],
            "tests": ["unit"], "evidence": ["test log"], "coverage_status": "covered",
        }],
        "findings": [],
        "facts": [{"fact_id": "FACT-0001"}],
        "goals": ["goal"], "non_goals": ["release"],
        "work_packages": [{
            "id": "WP-00", "title": "contract", "recipient": "DEV", "parent": "TASK-20260803-001",
            "dependencies": [], "inputs": ["source"], "outputs": ["code"], "allowed_files": ["src/**"],
            "forbidden_files": ["fcop/**"], "tests": ["unit"], "evidence": ["log"], "acceptor": "PM",
            "budget": {"ai_days_low": 1, "ai_days_high": 2, "tokens": 1000, "tool_calls": 10},
            "max_rework": 1, "failure_conditions": ["test fail"], "rollback": ["revert patch"],
            "start_at": "2026-08-04T09:00:00+08:00", "end_at": "2026-08-05T18:00:00+08:00",
            "parallel_with": [], "parallel_reason": "none", "includes_admin_wait": False,
        }],
        "gates": [{"id": "Gate-A", "prerequisites": ["WP-00"], "evidence": ["log"], "failure_action": "rework"}],
        "tests": ["unit"], "risks": ["drift"],
        "experiment_data_plan": {"applicable": False, "rationale": "not research"},
        "recovery_plan": {"preservation_steps": ["status"], "continuity_cases": ["runtime restart"]},
        "stop_conditions": ["digest mismatch"],
        "schedule": {
            "t0": "2026-08-04T09:00:00+08:00", "timezone": "Asia/Shanghai", "daily_capacity_ai_days": 1,
            "d7_health_check_at": "2026-08-10T18:00:00+08:00", "d10_disposition_at": "2026-08-13T18:00:00+08:00",
            "delay_threshold": "0.5 AI day", "reschedule_rule": "recompute DAG",
        },
        "budget": {"ai_days_low": 1, "ai_days_high": 2, "tokens": 1000, "tool_calls": 10},
        "body_markdown": body,
        "fact_snapshot_at": "2026-08-03T20:00:00+08:00",
    }


class ValidatorTests(unittest.TestCase):
    def test_valid_model_passes(self) -> None:
        model = valid_model()
        self.assertTrue(verify_coverage(model)["ok"])
        self.assertTrue(check_budget_schedule(model)["ok"])
        self.assertTrue(validate_model(model)["ready_for_review"])

    def test_budget_mismatch_and_cycle_fail(self) -> None:
        model = valid_model()
        model["work_packages"][0]["dependencies"] = ["WP-00"]
        model["budget"]["ai_days_high"] = 1
        result = check_budget_schedule(model)
        self.assertFalse(result["ok"])
        self.assertIn("PB.BUDGET.MISMATCH", {row["code"] for row in result["findings"]})
        self.assertIn("PB.SCHEDULE.CONFLICT", {row["code"] for row in result["findings"]})

    def test_uncovered_hard_requirement_fails(self) -> None:
        model = valid_model()
        model["requirements"][0]["wp_ids"] = []
        result = verify_coverage(model)
        self.assertEqual(result["hard_requirement_coverage"], 0)
        self.assertFalse(result["ok"])

    def test_superseded_reference_fails(self) -> None:
        model = valid_model()
        model["body_markdown"] += "\n详见 r3。"
        result = validate_model(model)
        self.assertFalse(result["ready_for_review"])
        self.assertIn("PB.REVISION.NOT_SELF_CONTAINED", {row["code"] for row in result["blocking_findings"]})

    def test_source_digest_mismatch_fails(self) -> None:
        model = valid_model()
        model["source"]["digest"] = "sha256:" + "0" * 64
        result = validate_model(model)
        self.assertFalse(result["ready_for_review"])
        self.assertIn("PB.SOURCE.DIGEST_MISMATCH", {row["code"] for row in result["blocking_findings"]})


if __name__ == "__main__":
    unittest.main()
