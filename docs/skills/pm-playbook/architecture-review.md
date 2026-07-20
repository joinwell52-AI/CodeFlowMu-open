# PM Architecture Review

Use this playbook when a proposal may affect FCoP semantics, runtime boundaries, lifecycle behavior, Panel actions, or issue promotion.

## Checklist

1. Is MCP being turned into a decision brain?
2. Are Playbook Skill and MCP Skill being mixed?
3. Does the proposal bypass ADMIN?
4. Does it submit public GitHub issues automatically?
5. Does it move lifecycle directly?
6. Does it let EVAL change lifecycle?
7. Does it make REPORT behave like delete or archive authority?
8. Does it add excessive centralized governance?
9. Does it mistake a CodeFlowMu local issue for an FCoP protocol change?
10. Does it affect the existing five PM runtime skills?

## Output

```text
# Architecture Review

## 1. Conclusion
Pass / risky / not recommended.

## 2. Affected Modules
Files, modules, API, and UI.

## 3. Architecture Risks
Explain risks.

## 4. FCoP Boundary Check
Check each item.

## 5. Suggested Adjustment
Minimal change.

## 6. Needs ADMIN Decision
Yes / no.
```
