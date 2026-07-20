# EVAL Risk and Gap Analysis

Use this playbook when EVAL needs to classify a gap, risk, or mismatch between intended and actual behavior.

## Output

```text
# Risk and Gap Analysis

## 1. Gap
Expected vs actual.

## 2. Risk Type
governance / UX / data / runtime / docs / security / maintainability.

## 3. Severity
P0 / P1 / P2 with reason.

## 4. Evidence
Sources.

## 5. Recommended Owner
PM / DEV / QA / OPS / ADMIN.
```

## Rules

- Severity is recommendation, not ADMIN decision.
- Keep local implementation gaps separate from formal protocol gaps.
- Do not create public issues automatically.
