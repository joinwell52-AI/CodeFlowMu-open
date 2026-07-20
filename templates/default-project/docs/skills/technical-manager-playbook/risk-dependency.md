# Technical Manager Risk and Dependency

Use this playbook to identify technical blockers, dependency order, and risk ownership.

## Output

```text
# Risk and Dependency Analysis

## 1. Dependency Map

| Dependency | Needed by | Owner | Status | Evidence |
|---|---|---|---|---|

## 2. Blocking Risks
Risks that can stop delivery.

## 3. Quality Risks
Risks that reduce correctness, maintainability, or user trust.

## 4. Runtime Risks
Risks involving Panel/API, planner, lifecycle, logs, or tool availability.

## 5. Mitigation
Smallest safe action for each risk.

## 6. Escalation Owner
PM / OPS / DEV / QA / ADMIN.
```

## FCoP Boundaries

- Blocked state must be reported truthfully.
- Do not invent another role's report.
- Do not hide dependency gaps.
- Do not change protocol or runtime to work around a missing upstream decision.
