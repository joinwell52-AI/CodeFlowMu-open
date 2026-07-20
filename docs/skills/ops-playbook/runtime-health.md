# OPS Runtime Health

Use this playbook when OPS must check whether CodeFlowMu runtime, Panel, project root, or FCoP directories are healthy.

## Output

```text
# Runtime Health

## 1. Target
Project root, server, Panel, or runtime component.

## 2. Checks

| Check | Result | Evidence |
|---|---|---|

## 3. Findings
Problems found.

## 4. Suggested Action
Smallest safe fix or escalation.
```

## Rules

- Separate environment problems from code problems.
- Do not delete logs or state while diagnosing.
- Escalate high-risk runtime repairs.
