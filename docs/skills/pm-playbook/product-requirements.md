# PM Product Requirements

Use this playbook to turn ADMIN conversation, screenshots, and rough feedback into a clear product requirement.

## Output

```text
# Product Requirements

## 1. Background
Why this is needed.

## 2. Users / Roles
ADMIN / PM / OPS / DEV / QA / EVAL / external users.

## 3. Problem
Current pain or ambiguity.

## 4. Goal
Expected outcome after delivery.

## 5. Scope
What this round should do.

## 6. Non-scope
What this round explicitly will not do.

## 7. Constraints
FCoP, CodeFlowMu, permissions, lifecycle, UI, and data boundaries.

## 8. Acceptance Criteria
How completion will be checked.

## 9. Risks
Potentially affected modules or flows.

## 10. Suggested Split
P0 / P1 / P2.
```

## FCoP Boundaries

- Do not turn product requirements directly into protocol changes.
- Do not add adopted-pending `0003`.
- Do not claim unimplemented abilities as implemented.
- Do not bypass ADMIN.
- Do not generate or submit public GitHub issues automatically.
