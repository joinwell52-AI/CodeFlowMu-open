# Write Report Contract

REPORT is a handoff signal. It records what happened, with evidence, and then the executor stops for upstream review.

REPORT is not EVAL, not TASK, not lifecycle approval, and not archive authority.

## Minimum Frontmatter

```yaml
---
protocol: fcop
version: 1
kind: report
sender: ROLE
recipient: PM
references:
  - TASK-YYYYMMDD-NNN
status: done
created_at: YYYY-MM-DDTHH:mm:ss
---
```

## Minimum Body

```text
# REPORT title

## 1. Source task

- task_id:
- parent:
- thread_key:

## 2. Execution actions

Describe what was actually done.

## 3. Result

- status: done / blocked / needs_fix / needs_admin_decision
- result_summary:

## 4. Evidence

- files:
- log_summary:
- screenshots:
- test_results:

## 5. Blocked information

If not blocked, write: none.

If blocked:
- blocked_reason:
- blocked_by:
- needs_admin_decision: true/false

## 6. Next step

Name who should do what next.
```

## Rules

- Do not claim completion without evidence.
- Do not write a REPORT that changes lifecycle state by itself.
- Do not treat blocked as failure; blocked is a truthful status.
- Do not archive after writing a REPORT unless the task explicitly pre-authorized it.
- Do not mix EVAL observations into REPORT unless clearly labeled as evidence or risk.
