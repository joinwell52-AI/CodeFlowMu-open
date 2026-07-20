# Technical Manager Review Routing

Use this playbook to route work to the right reviewer and avoid mixing PM, QA, OPS, EVAL, and ARCH review duties.

## Output

```text
# Review Routing

## 1. Change Summary
What changed or is proposed.

## 2. Review Type

| Review type | Owner | Trigger |
|---|---|---|
| PM review | PM | scope, acceptance, governance summary |
| QA review | QA | behavior, regression, UI verification |
| OPS review | OPS | runtime, environment, logs, health |
| Architect review | Architect Playbook | system boundaries, coupling, protocol risk |
| ADMIN decision | ADMIN | public submission, archive, protocol adoption |

## 3. Required Evidence
Files, tests, logs, screenshots, reports.

## 4. Missing Review
Who still needs to review.

## 5. Next Handoff
TASK, REPORT, or ADMIN decision.
```

## FCoP Boundaries

- Routing is advice, not approval.
- REPORT does not equal QA pass or ADMIN acceptance.
- EVAL observations are not lifecycle decisions.
