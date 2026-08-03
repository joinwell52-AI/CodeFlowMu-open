# Taskbook Audit Findings

## Contents

1. Finding envelope
2. Codes and defaults
3. Audit order
4. Minimal conflict sets

## 1. Finding envelope

Use `{code, severity, message, requirement_ids, evidence, candidate_resolutions}`. Evidence must cite source lines, live command/tool output, or a durable resource identity. Never create a finding solely from a regex match.

## 2. Codes and defaults

| Code | Default | Meaning |
|---|---|---|
| `PB.SOURCE.INCOMPLETE` | blocking | EOF or source digest missing |
| `PB.SOURCE.CONTRADICTION` | blocking | normative source statements conflict |
| `PB.SOURCE.REFERENCE_MISSING` | blocking/warning | required reference unavailable |
| `PB.SOURCE.AMBIGUOUS_AUTHORITY` | blocking | role, acceptor, or authority is ambiguous |
| `PB.SOURCE.UNAUTHORIZED_ACTION` | blocking | source crosses approval/release boundary |
| `PB.FACT.STALE` | blocking/warning | observed current fact differs from source claim |
| `PB.FACT.UNVERIFIED` | blocking | important fact has no verifiable source |
| `PB.FEASIBILITY.UNSAT` | blocking | scope, budget, and schedule cannot all hold |
| `PB.COVERAGE.MISSING` | blocking | hard requirement lacks complete mapping |
| `PB.BUDGET.MISMATCH` | blocking | WP and declared totals disagree |
| `PB.SCHEDULE.CONFLICT` | blocking | dependency, capacity, resource, or date conflict |
| `PB.GATE.INCOMPLETE` | blocking | gate prerequisite/evidence/failure action missing |
| `PB.DATA.INCOMPLETE` | blocking/warning | experiment evidence is not reproducible |
| `PB.RECOVERY.INCOMPLETE` | blocking | preservation/recovery continuity missing |
| `PB.REVISION.NOT_SELF_CONTAINED` | blocking | current Brief depends on superseded text |
| `PB.EDITORIAL.NORMALIZED` | info | semantic-neutral editorial normalization |

## 3. Audit order

1. Prove complete ingestion.
2. Detect internal contradictions.
3. Validate reference accessibility.
4. Re-sample current facts and classify drift.
5. Check authority and governance boundaries.
6. Solve budget/schedule feasibility.
7. Verify owner/acceptor closure.
8. Verify recovery and immediate stops.
9. Verify data reproducibility.
10. Normalize vocabulary and statuses.

If a blocking finding exists, offer options but keep status `needs_admin_decision` until ADMIN changes the source or explicitly chooses an interpretation.

## 4. Minimal conflict sets

Report only the smallest set that proves unsatisfiability. Example:

```text
REQ-0031: total <= 7 AI days
REQ-0048: WP-01..10 are strictly serial
REQ-0072..81: WP high estimates sum to 11.2 AI days
Result: the three constraints cannot hold simultaneously.
```

Do not silently reduce estimates, overlap serial work, or void a requirement.
