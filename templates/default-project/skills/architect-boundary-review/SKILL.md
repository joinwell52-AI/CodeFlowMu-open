---
name: architect-boundary-review
description: Review CodeFlowMu proposals for boundary violations. Use when an architect needs to check MCP vs Playbook separation, lifecycle authority, REPORT/EVAL/TASK semantics, public-submission safety, PM runtime ID preservation, or protocol-change risk.
---

# Architect Boundary Review

## When to use

Use this skill when a proposal may cross runtime, lifecycle, governance, public-submission, or protocol boundaries.

## Rules

- Check for layer mixing.
- Check lifecycle and ADMIN authority.
- Check REPORT, EVAL, TASK, ISSUE, and REVIEW semantics.
- Recommend the smallest compliant shape.

## Required output

Use `docs/skills/architect-playbook/boundary-review.md`.

## Forbidden actions

- Do not let MCP decide governance.
- Do not auto-submit GitHub issues.
- Do not archive, delete, or move lifecycle from playbook advice.
- Do not modify formal FCoP protocol.

## Minimal example

```text
Conclusion: reject
Crossed boundary: EVAL would submit public GitHub issue
Safer shape: internal draft with admin_approved=false
```
