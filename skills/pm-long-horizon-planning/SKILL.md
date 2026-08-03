---
name: pm-long-horizon-planning
description: Audit long, complex, and potentially inconsistent PM taskbooks and compile them into one self-contained, semantically validated Product Brief with a requirement ledger, WP dependency graph, budgets, absolute schedule, gates, tests, experiment evidence, risks, recovery, and stop conditions. Use for long-horizon or full-plan requests, taskbook-to-plan work, planning_method=long_horizon, Level 3 tasks over 12,000 characters or 200 lines, or Level 3 work with at least three signals among cross-module architecture, WP/task trees, human gates, multiple runtimes, recovery, experiments, and explicit AI-day/token/tool budgets.
---

# PM Long-Horizon Planning

## Non-negotiable outcome

Compile the source taskbook as governed input. Do not treat it as infallible prose. Produce exactly one current Product Brief, or stop with `needs_admin_decision` when a blocking source or feasibility finding exists.

Auto-injection is recommendation only. It is never evidence that this skill was executed.

## Required resources

Read these files completely at the named phase:

- Before building the IR, read [references/planning-model-contract.md](references/planning-model-contract.md) and [references/taskbook-audit-findings.md](references/taskbook-audit-findings.md).
- Before rendering the artifact, read [references/product-brief-contract.md](references/product-brief-contract.md) and [assets/long-horizon-product-brief-template.md](assets/long-horizon-product-brief-template.md).
- Before submitting or acting on a decision, read [references/planning-gate-contract.md](references/planning-gate-contract.md).

## Workflow

### 0. Bind identity and target

1. Confirm the caller is PM and is in an active Runtime session.
2. Resolve one root `task_id`, non-empty `thread_key`, and canonical Brief path.
3. Accept a child rework only when `parent`, `planning_target_task_id`, thread, and an ADMIN/Planning-Gate rework authorization all bind it to the root.
4. Reject only the invalid operation when binding fails. Do not terminate the Session or Task.
5. Do not write a root Brief from `CHAT-*` with an empty thread.

### 1. Ingest the complete taskbook

1. Read from the first byte through EOF, in chunks when necessary.
2. Record absolute source identity, version, SHA-256, byte/line counts, read time, ranges read, reference set, and `read_complete=true` only after EOF.
3. Resolve file paths, URLs, commits, ports, versions, task IDs, and named authorities.
4. Check references read-only. Do not draft a summary Brief before ingestion completes.

### 2. Audit before planning

1. Classify each substantive statement as `normative_constraint`, `target_design`, `current_fact`, `estimate`, `assumption`, `reference`, or `authority_boundary`.
2. Assign stable `REQ-0001` IDs with source lines and modality.
3. Audit structure, contradictions, references, fact drift, authority, feasibility, roles/acceptance, recovery, reproducibility, and state vocabulary in that order.
4. Record findings using the finding contract. Distinguish `blocking`, `warning`, and `info`.
5. For infeasibility, show a minimal conflicting requirement set and candidate resolutions. Never choose which requirement becomes void.
6. Normalize editorial errors only when scope, role, budget, date, gate, acceptance, and authority stay unchanged.
7. On any blocking finding, set artifact status to `needs_admin_decision`, report the finding, and stop for ADMIN. Do not silently repair intent.

### 3. Freeze live facts

1. Prefer `pm.inspect_project_baseline`, `pm.inspect_runtime_topology`, project registry views, and read-only Git/process/port/Gateway/Writer-Lock/Data-Root checks.
2. Record value, source, observed time, confidence, volatility, taskbook difference, and planning effect for every fact.
3. Re-sample volatile facts at their TTL and Git/worktree facts immediately before validation.
4. Keep current state separate from target state. Never copy an old observation as a current fact.

### 4. Build Planning IR

1. Create a non-authoritative JSON IR only in Runtime-assigned task scratch.
2. Include source, requirements, findings, facts, goals/non-goals, WPs, edges, schedules, budgets, gates, tests, risks, experiments, recovery, stop conditions, coverage, and validation summary.
3. Map every hard requirement through:

```text
REQ -> Brief section -> WP -> dependency -> role -> Gate -> test -> evidence -> acceptor -> recovery
```

4. Map an excluded requirement to a non-goal only with explicit ADMIN authorization.

### 5. Solve bottom-up

1. Define every WP before declaring totals.
2. Include recipient, parent, dependencies, inputs/outputs, allowed/forbidden files, tests/evidence, acceptor, low/high AI days, token/tool budgets, rework cap, failure, rollback, absolute start/end, and justified parallelism.
3. Sum all budgets; derive the DAG critical path; enforce daily capacity and write/resource isolation.
4. Keep ADMIN wait, queues, approvals, cooldown, and human restart time outside AI-effective days.
5. Declare ISO-8601 T0 with timezone, every WP/Gate slot, D7 health check, D10 disposition, delay threshold, and rescheduling rule.

### 6. Validate deterministically

Run all three scripts against the IR before rendering:

```text
python scripts/verify_requirement_coverage.py planning-ir.json
python scripts/check_budget_schedule.py planning-ir.json
python scripts/validate_planning_model.py planning-ir.json
```

Treat stdout JSON as calculation evidence, not as semantic authorship. The scripts do not decide statement types or ADMIN intent. Exit `0` means the checked contract passed, `2` means semantic findings exist, and `64` means invalid input or tool usage.

Do not mark ready when validation finds missing coverage, malformed WPs, budget mismatch, cycles, missing dependencies, resource/date conflicts, stale facts, incomplete experiment/recovery/stop contracts, placeholders, superseded-revision dependencies, or unauthorized release actions.

### 7. Render and write the one Brief

1. Render the full current IR with the supplied template. Keep every revision independently readable.
2. Ban “see r3”, “same as previous”, TBD/TODO placeholders, and any required dependence on overwritten text.
3. Call `pm.validate_long_horizon_plan` with root/task/thread/session, source identity, body, IR, and fact snapshot.
4. For `ready_for_review`, require a current validation digest bound to the body digest and source digest.
5. Call `pm.write_planning_artifact`; never write `fcop/internal/product-briefs` through shell, Python, or native editing.
6. Re-read the canonical artifact and verify its digest. Treat revision history as superseded/non-authoritative evidence.
7. Submit the M0 `in_progress` REPORT, then stop. A REPORT is the handoff signal.

### 8. Wait for Planning Gate

1. Accept only `approve_wp00`, `request_plan_change`, `pause`, `replan`, or `terminate` with a non-empty ADMIN reason.
2. Require task, thread, revision, body digest, and validation digest to match the current canonical artifact.
3. Treat decisions for an older revision/digest as stale.
4. Open only WP-00 after `validation_status=passed` and the matching decision is `approve_wp00`.
5. Keep Planning Gate separate from operation approval. A planning finding is not a `NEG.*` operation.
6. After a decision, use persisted notice/wake state to resume the original PM session. Do not infer approval from chat.

## Mutation and stop boundaries

- Allow read-only inspection, deterministic calculation, and current-session task scratch without approval.
- Use the formal writer for the canonical Brief; formal writer use is not governance bypass.
- Stop for ADMIN before changing scope/parent/gate/acceptance, touching stable Runtime/Gateway, active delivery, cross-project files, remote push/PR/tag/release/production, whole-machine restart, or destructive recovery.
- Preserve task/thread/session, worktree, formal records, raw evidence, locks, roots, processes, and the last safe commit before rollback.
- Never let an operation approval freeze, cancel, or terminate the surrounding Session/Task.
