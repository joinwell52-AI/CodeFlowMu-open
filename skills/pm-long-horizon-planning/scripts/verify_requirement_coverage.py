#!/usr/bin/env python3
"""Deterministically verify requirement-to-delivery coverage in a Planning IR."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_FINDINGS = 2
EXIT_INPUT = 64
REQ_ID = re.compile(r"^REQ-\d{4,}$")
HARD_MODALITIES = {"MUST"}


def load_model(argv: list[str]) -> dict[str, Any]:
    if len(argv) > 2:
        raise ValueError("usage: verify_requirement_coverage.py [planning-ir.json]")
    raw = Path(argv[1]).read_text(encoding="utf-8") if len(argv) == 2 else sys.stdin.read()
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Planning IR root must be an object")
    return value


def verify_coverage(model: dict[str, Any]) -> dict[str, Any]:
    requirements = model.get("requirements")
    work_packages = model.get("work_packages")
    gates = model.get("gates")
    if not isinstance(requirements, list) or not isinstance(work_packages, list) or not isinstance(gates, list):
        raise ValueError("requirements, work_packages, and gates must be arrays")
    wp_ids = {str(row.get("id", "")) for row in work_packages if isinstance(row, dict)}
    gate_ids = {str(row.get("id", "")) for row in gates if isinstance(row, dict)}
    findings: list[dict[str, Any]] = []
    seen: set[str] = set()
    hard_count = 0
    hard_covered = 0
    for index, raw in enumerate(requirements):
        if not isinstance(raw, dict):
            findings.append({"code": "PB.COVERAGE.MISSING", "requirement": f"index:{index}", "message": "requirement must be an object"})
            continue
        req_id = str(raw.get("id", ""))
        if not REQ_ID.fullmatch(req_id) or req_id in seen:
            findings.append({"code": "PB.COVERAGE.MISSING", "requirement": req_id or f"index:{index}", "message": "requirement id is invalid or duplicated"})
        seen.add(req_id)
        modality = str(raw.get("modality", "")).upper()
        hard = modality in HARD_MODALITIES
        if hard:
            hard_count += 1
        status = str(raw.get("coverage_status", ""))
        wp_refs = raw.get("wp_ids") if isinstance(raw.get("wp_ids"), list) else []
        gate_refs = raw.get("gate_ids") if isinstance(raw.get("gate_ids"), list) else []
        missing_fields = [name for name in ("brief_section", "responsible_role", "acceptor", "tests", "evidence") if not raw.get(name)]
        missing_wps = [value for value in map(str, wp_refs) if value not in wp_ids]
        missing_gates = [value for value in map(str, gate_refs) if value not in gate_ids]
        non_goal_authorized = status == "non_goal" and bool(str(raw.get("admin_authorization", "")).strip())
        covered = status == "covered" and bool(wp_refs) and bool(gate_refs) and not missing_fields and not missing_wps and not missing_gates
        if hard and (covered or non_goal_authorized):
            hard_covered += 1
        if hard and not (covered or non_goal_authorized):
            findings.append({
                "code": "PB.COVERAGE.MISSING",
                "requirement": req_id,
                "message": "hard requirement lacks a complete authorized mapping",
                "missing_fields": missing_fields,
                "missing_work_packages": missing_wps,
                "missing_gates": missing_gates,
            })
    ratio = 1.0 if hard_count == 0 else hard_covered / hard_count
    return {
        "ok": not findings and ratio == 1.0,
        "requirement_count": len(requirements),
        "hard_requirement_count": hard_count,
        "hard_requirement_covered": hard_covered,
        "hard_requirement_coverage": ratio,
        "findings": findings,
    }


def main(argv: list[str]) -> int:
    try:
        result = verify_coverage(load_model(argv))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return EXIT_OK if result["ok"] else EXIT_FINDINGS
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": "PB.INPUT.INVALID", "message": str(error)}, ensure_ascii=False, sort_keys=True))
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
