#!/usr/bin/env python3
"""Validate WP budgets, dependencies, critical path, and absolute scheduling."""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_FINDINGS = 2
EXIT_INPUT = 64


def load_model(argv: list[str]) -> dict[str, Any]:
    if len(argv) > 2:
        raise ValueError("usage: check_budget_schedule.py [planning-ir.json]")
    raw = Path(argv[1]).read_text(encoding="utf-8") if len(argv) == 2 else sys.stdin.read()
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Planning IR root must be an object")
    return value


def number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) < 0:
        raise ValueError(f"{label} must be a finite non-negative number")
    return float(value)


def instant(value: Any, label: str) -> datetime:
    text = str(value or "")
    if not text or ("+" not in text[10:] and not text.endswith("Z")):
        raise ValueError(f"{label} must be an ISO-8601 timestamp with timezone")
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def check_budget_schedule(model: dict[str, Any]) -> dict[str, Any]:
    raw_wps = model.get("work_packages")
    if not isinstance(raw_wps, list) or not raw_wps:
        raise ValueError("work_packages must be a non-empty array")
    findings: list[dict[str, Any]] = []
    wps: dict[str, dict[str, Any]] = {}
    totals = {"ai_days_low": 0.0, "ai_days_high": 0.0, "tokens": 0.0, "tool_calls": 0.0}
    starts: dict[str, datetime] = {}
    ends: dict[str, datetime] = {}
    for index, raw in enumerate(raw_wps):
        if not isinstance(raw, dict):
            raise ValueError(f"work_packages[{index}] must be an object")
        wp_id = str(raw.get("id", ""))
        if not wp_id or wp_id in wps:
            raise ValueError(f"work_packages[{index}].id is missing or duplicated")
        wps[wp_id] = raw
        budget = raw.get("budget")
        if not isinstance(budget, dict):
            raise ValueError(f"{wp_id}.budget must be an object")
        for key in totals:
            totals[key] += number(budget.get(key), f"{wp_id}.budget.{key}")
        starts[wp_id] = instant(raw.get("start_at"), f"{wp_id}.start_at")
        ends[wp_id] = instant(raw.get("end_at"), f"{wp_id}.end_at")
        if ends[wp_id] <= starts[wp_id]:
            findings.append({"code": "PB.SCHEDULE.CONFLICT", "work_package": wp_id, "message": "end_at must be after start_at"})
        if number(budget.get("ai_days_low"), f"{wp_id}.low") > number(budget.get("ai_days_high"), f"{wp_id}.high"):
            findings.append({"code": "PB.BUDGET.MISMATCH", "work_package": wp_id, "message": "low estimate exceeds high estimate"})
        if raw.get("includes_admin_wait") is True:
            findings.append({"code": "PB.BUDGET.MISMATCH", "work_package": wp_id, "message": "ADMIN wait must not be included in AI-effective time"})

    edges: dict[str, list[str]] = {}
    for wp_id, raw in wps.items():
        deps = [str(value) for value in raw.get("dependencies", [])] if isinstance(raw.get("dependencies"), list) else []
        edges[wp_id] = deps
        for dep in deps:
            if dep not in wps:
                findings.append({"code": "PB.SCHEDULE.CONFLICT", "work_package": wp_id, "message": f"missing dependency {dep}"})
            elif ends[dep] > starts[wp_id]:
                findings.append({"code": "PB.SCHEDULE.CONFLICT", "work_package": wp_id, "message": f"starts before dependency {dep} ends"})

    visiting: set[str] = set()
    visited: set[str] = set()
    cycle = False
    order: list[str] = []
    def visit(node: str) -> None:
        nonlocal cycle
        if node in visiting:
            cycle = True
            return
        if node in visited:
            return
        visiting.add(node)
        for dep in edges.get(node, []):
            if dep in wps:
                visit(dep)
        visiting.remove(node)
        visited.add(node)
        order.append(node)
    for wp_id in wps:
        visit(wp_id)
    if cycle:
        findings.append({"code": "PB.SCHEDULE.CONFLICT", "message": "dependency graph contains a cycle"})

    longest: dict[str, float] = {}
    if not cycle:
        for wp_id in order:
            own = float(wps[wp_id]["budget"]["ai_days_high"])
            longest[wp_id] = own + max((longest.get(dep, 0.0) for dep in edges[wp_id]), default=0.0)
    critical = max(longest.values(), default=0.0)
    declared = model.get("budget")
    if not isinstance(declared, dict):
        raise ValueError("budget must be an object")
    tolerance = 1e-9
    for key, actual in totals.items():
        expected = number(declared.get(key), f"budget.{key}")
        if abs(actual - expected) > tolerance:
            findings.append({"code": "PB.BUDGET.MISMATCH", "field": key, "declared": expected, "calculated": actual})

    schedule = model.get("schedule")
    if not isinstance(schedule, dict):
        raise ValueError("schedule must be an object")
    for key in ("t0", "d7_health_check_at", "d10_disposition_at"):
        instant(schedule.get(key), f"schedule.{key}")
    for key in ("timezone", "delay_threshold", "reschedule_rule"):
        if not str(schedule.get(key, "")).strip():
            findings.append({"code": "PB.SCHEDULE.CONFLICT", "field": key, "message": "required schedule field is empty"})
    return {
        "ok": not findings,
        "wp_count": len(wps),
        "calculated_budget": totals,
        "critical_path_ai_days_high": critical,
        "topological_order": order if not cycle else [],
        "findings": findings,
    }


def main(argv: list[str]) -> int:
    try:
        result = check_budget_schedule(load_model(argv))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return EXIT_OK if result["ok"] else EXIT_FINDINGS
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": "PB.INPUT.INVALID", "message": str(error)}, ensure_ascii=False, sort_keys=True))
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
