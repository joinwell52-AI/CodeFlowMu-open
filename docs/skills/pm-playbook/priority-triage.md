# PM Priority Triage

Use this playbook to classify tasks, risks, and EVAL findings as P0, P1, or P2.

## Priority Scale

| Priority | Meaning |
|---|---|
| P0 | Blocks the main flow, risks wrong operation, data damage, or governance escalation. |
| P1 | Affects experience, accuracy, or maintainability but does not block the main flow. |
| P2 | Optimization, documentation, or later enhancement. |

## Output

```text
# Priority Triage

## 1. Issue List

| Issue | Priority | Reason | Owner | Suggested action |
|---|---|---|---|---|

## 2. P0
Handle immediately.

## 3. P1
Schedule soon.

## 4. P2
Record or handle later.

## 5. Hold
Explain why not now.
```

## FCoP Boundaries

- Priority advice is not ADMIN decision.
- EVAL can suggest promotion only.
- PM must not submit public GitHub issues without ADMIN.
