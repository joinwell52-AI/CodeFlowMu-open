#!/usr/bin/env python3
"""Aggregate deterministic Planning IR validation without replacing semantic review."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from check_budget_schedule import check_budget_schedule
from verify_requirement_coverage import verify_coverage

EXIT_OK = 0
EXIT_FINDINGS = 2
EXIT_INPUT = 64
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def load_model(argv: list[str]) -> dict[str, Any]:
    if len(argv) > 2:
        raise ValueError("usage: validate_planning_model.py [planning-ir.json]")
    raw = Path(argv[1]).read_text(encoding="utf-8") if len(argv) == 2 else sys.stdin.read()
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Planning IR root must be an object")
    return value


def validate_model(model: dict[str, Any]) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    required = [
        "task_id", "root_task_id", "thread_key", "session_id", "source", "requirements",
        "findings", "facts", "work_packages", "gates", "tests", "risks",
        "experiment_data_plan", "recovery_plan", "stop_conditions", "schedule", "budget", "body_markdown",
    ]
    for key in required:
        if key not in model or model[key] in (None, ""):
            findings.append({"code": "PB.MODEL.INCOMPLETE", "field": key})
    source = model.get("source")
    if not isinstance(source, dict):
        raise ValueError("source must be an object")
    if source.get("read_complete") is not True or not SHA256.fullmatch(str(source.get("digest", ""))):
        findings.append({"code": "PB.SOURCE.INCOMPLETE", "message": "source must be read through EOF and have a SHA-256 digest"})
    for key in ("path", "version", "read_at", "read_ranges", "references"):
        if not source.get(key):
            findings.append({"code": "PB.SOURCE.INCOMPLETE", "field": f"source.{key}"})
    if not isinstance(source.get("line_count"), int) or source.get("line_count", 0) <= 0:
        findings.append({"code": "PB.SOURCE.INCOMPLETE", "field": "source.line_count"})
    source_path = Path(str(source.get("path", "")))
    try:
        source_bytes = source_path.read_bytes()
        observed_digest = "sha256:" + hashlib.sha256(source_bytes).hexdigest()
        observed_lines = len(source_bytes.decode("utf-8").splitlines())
        if observed_digest != source.get("digest"):
            findings.append({
                "code": "PB.SOURCE.DIGEST_MISMATCH",
                "declared": source.get("digest"),
                "observed": observed_digest,
            })
        if observed_lines != source.get("line_count"):
            findings.append({
                "code": "PB.SOURCE.INCOMPLETE",
                "field": "source.line_count",
                "declared": source.get("line_count"),
                "observed": observed_lines,
            })
    except (OSError, UnicodeError) as error:
        findings.append({"code": "PB.SOURCE.INCOMPLETE", "field": "source.path", "message": str(error)})

    coverage = verify_coverage(model)
    schedule = check_budget_schedule(model)
    findings.extend(coverage["findings"])
    findings.extend(schedule["findings"])
    semantic = model.get("findings") if isinstance(model.get("findings"), list) else []
    blocking = [row for row in semantic if isinstance(row, dict) and str(row.get("severity", "")).lower() == "blocking"]
    findings.extend(blocking)

    body = str(model.get("body_markdown", ""))
    if re.search(r"\b(?:TBD|TODO)\b|详见\s*r\d+|同(?:上|前)(?:一)?(?:版|稿)|same as previous|see r\d+", body, re.I):
        findings.append({"code": "PB.REVISION.NOT_SELF_CONTAINED", "message": "body contains a placeholder or superseded-revision dependency"})
    if re.search(r"\b(?:git\s+push|git\s+tag|release|production deploy)\b|远程\s*push|生产发布", body, re.I):
        findings.append({"code": "PB.SOURCE.UNAUTHORIZED_ACTION", "message": "body contains an unauthorized release action"})
    recovery = model.get("recovery_plan")
    if not isinstance(recovery, dict) or not recovery.get("preservation_steps") or not recovery.get("continuity_cases"):
        findings.append({"code": "PB.RECOVERY.INCOMPLETE", "message": "preservation steps and continuity cases are required"})
    if not isinstance(model.get("stop_conditions"), list) or not model.get("stop_conditions"):
        findings.append({"code": "PB.RECOVERY.INCOMPLETE", "message": "stop conditions are required"})
    experiment = model.get("experiment_data_plan")
    if not isinstance(experiment, dict) or (experiment.get("applicable") is False and not str(experiment.get("rationale", "")).strip()):
        findings.append({"code": "PB.DATA.INCOMPLETE", "message": "experiment plan or non-applicability rationale is required"})

    body_digest = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    unique_findings = list({json.dumps(row, ensure_ascii=False, sort_keys=True): row for row in findings}.values())
    result_core = {
        "task_id": model.get("task_id"),
        "root_task_id": model.get("root_task_id"),
        "thread_key": model.get("thread_key"),
        "session_id": model.get("session_id"),
        "source_digest": source.get("digest"),
        "body_digest": body_digest,
        "requirement_count": coverage["requirement_count"],
        "hard_requirement_coverage": coverage["hard_requirement_coverage"],
        "wp_count": schedule["wp_count"],
        "budget_low": schedule["calculated_budget"]["ai_days_low"],
        "budget_high": schedule["calculated_budget"]["ai_days_high"],
        "critical_path_days": schedule["critical_path_ai_days_high"],
        "fact_snapshot_at": model.get("fact_snapshot_at"),
        "blocking_findings": unique_findings,
        "warnings": [row for row in semantic if isinstance(row, dict) and str(row.get("severity", "")).lower() == "warning"],
    }
    validation_digest = "sha256:" + hashlib.sha256(json.dumps(result_core, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {**result_core, "validation_digest": validation_digest, "ready_for_review": not unique_findings, "ok": not unique_findings}


def main(argv: list[str]) -> int:
    try:
        result = validate_model(load_model(argv))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return EXIT_OK if result["ok"] else EXIT_FINDINGS
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": "PB.INPUT.INVALID", "message": str(error)}, ensure_ascii=False, sort_keys=True))
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
