# Architect Boundary Review

Use this playbook to check whether a proposal crosses CodeFlowMu, FCoP, runtime, lifecycle, UI, or public-submission boundaries.

## Checklist

1. Does the proposal mix MCP Tool registration with Agent Playbook behavior?
2. Does it make MCP decide PM/EVAL/ADMIN outcomes?
3. Does it alter lifecycle state without authorized tools?
4. Does it let REPORT act as approval, archive, or delete?
5. Does it let EVAL promote itself into public issue or protocol change?
6. Does it change existing PM runtime skill IDs?
7. Does it add Panel/API behavior without explicit implementation task?
8. Does it expose private paths, logs, keys, or task body to public drafts?
9. Does it introduce large migration or core runtime rewrite?
10. Does it add adopted-pending entries without governance?

## Output

```text
# Boundary Review

## 1. Conclusion
Pass / risky / reject.

## 2. Crossed Boundaries
List boundary issues.

## 3. Required Authority
PM / OPS / DEV / QA / ADMIN.

## 4. Safer Shape
Smallest compliant design.
```
