# Detect Blocked Contract

Agents must decide whether work is blocked before reporting. Blocked work must be written into the REPORT and must not be swallowed.

Blocked is not failed. It is a recoverable coordination state that needs an owner and next step.

## Blocked Types

```text
permission_blocked
missing_file
missing_dependency
missing_upstream_report
tool_unavailable
task_conflict
needs_admin_decision
runtime_stalled
rate_limited
unknown_blocked
```

## Output Shape

```yaml
blocked:
  is_blocked: true
  type: missing_upstream_report
  reason: "Downstream REPORT has not landed, so PM cannot close the parent task."
  owner: PM
  needs_admin_decision: false
```

## Rules

- Always state whether the task is blocked.
- Write blocked status into the REPORT.
- Give a next-step owner.
- Do not auto-kill a session because it is blocked.
- Do not auto-write a missing downstream report.
- Keep this contract compatible with the FCoP Failure protocol; do not invent new lifecycle states here.
