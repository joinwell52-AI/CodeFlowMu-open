# OPS Stuck Workflow

Use this playbook when a task, report, lifecycle state, or agent session appears stuck.

## Output

```text
# Stuck Workflow Diagnosis

## 1. Stuck Item
TASK, REPORT, role, thread, or runtime event.

## 2. Current State
Lifecycle location, ledger view, latest report, or latest log event.

## 3. Expected Next State
What should happen next.

## 4. Blocker Type
missing_report / missing_task / runtime_stalled / role_unavailable / unknown.

## 5. Recovery Suggestion
Safe next step and owner.
```

## Rules

- Do not manually move lifecycle files.
- Do not synthesize missing reports.
- Suggest recovery; PM/ADMIN decides governance actions.
