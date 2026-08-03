# Planning Model Contract

## Contents

1. Root object
2. Requirements and findings
3. Facts
4. Work packages and schedule
5. Evidence, recovery, and status

## 1. Root object

The Planning IR is non-authoritative JSON in task scratch. Required keys:

```json
{
  "task_id": "TASK-...",
  "root_task_id": "TASK-...",
  "thread_key": "...",
  "session_id": "...",
  "source": {},
  "requirements": [],
  "findings": [],
  "facts": [],
  "goals": [],
  "non_goals": [],
  "work_packages": [],
  "gates": [],
  "tests": [],
  "risks": [],
  "experiment_data_plan": {},
  "recovery_plan": {},
  "stop_conditions": [],
  "schedule": {},
  "budget": {},
  "body_markdown": "..."
}
```

`source` requires `path`, `version`, `digest` (`sha256:<64 hex>`), `line_count`, `read_at`, `read_complete`, `read_ranges`, and `references`.

## 2. Requirements and findings

Each requirement requires:

- `id`: stable `REQ-0001` form.
- `source_line_start`, `source_line_end`, `quote`.
- `statement_type`: one of the seven types in the Skill.
- `modality`: `MUST`, `SHOULD`, or `MAY`.
- `responsible_role`, `acceptor`.
- `brief_section`, `wp_ids`, `gate_ids`, `tests`, `evidence`.
- `coverage_status`: `covered`, `non_goal`, or `uncovered`.
- For `non_goal`, `admin_authorization` must be non-empty.

Each finding requires `code`, `severity`, `message`, `requirement_ids`, and `evidence`. Blocking findings prevent `ready_for_review`.

## 3. Facts

Each fact requires `fact_id`, `name`, `value`, `source`, `observed_at`, `confidence`, `stability`, `taskbook_value`, `difference`, and `planning_effect`.

Suggested TTLs:

- process, port, Gateway, Writer Lock: 5 minutes;
- Git HEAD/worktree: sample immediately before validation;
- static code paths: valid for the sampled commit;
- source digest: fixed for the whole revision.

## 4. Work packages and schedule

Each WP requires:

```json
{
  "id": "WP-00",
  "title": "...",
  "recipient": "DEV",
  "parent": "TASK-...",
  "dependencies": [],
  "inputs": [],
  "outputs": [],
  "allowed_files": [],
  "forbidden_files": [],
  "tests": [],
  "evidence": [],
  "acceptor": "PM",
  "budget": {"ai_days_low": 0.5, "ai_days_high": 1, "tokens": 10000, "tool_calls": 30},
  "max_rework": 1,
  "failure_conditions": [],
  "rollback": [],
  "start_at": "2026-08-04T09:00:00+08:00",
  "end_at": "2026-08-04T18:00:00+08:00",
  "parallel_with": [],
  "parallel_reason": ""
}
```

`schedule` requires `t0`, `timezone`, `daily_capacity_ai_days`, `d7_health_check_at`, `d10_disposition_at`, `delay_threshold`, and `reschedule_rule`.

`budget` requires declared `ai_days_low`, `ai_days_high`, `tokens`, and `tool_calls`. Optional `reserve_explanation` explains a declared low floor below the WP sum.

## 5. Evidence, recovery, and status

Research plans require append-only raw path, event identity keys, timestamps/timezone, derivation script/version, redaction, checksum/line count, missing/duplicate/order checks, retention, controls/repetitions/faults, and traceability. Non-research plans set `applicable=false` and provide `rationale`.

`recovery_plan` requires preservation steps before rollback plus coverage for Session, agent, Runtime, Shell, machine, Gateway, Writer Lock, candidate rebuild, report projection, and decision notice loss.

Use separate `artifact_status`, `validation_status`, `planning_gate_status`, and `dispatch_scope`. Never use one “completed” flag for all four meanings.
