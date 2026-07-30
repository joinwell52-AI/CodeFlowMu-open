---
name: tm-review-routing
description: Route CodeFlowMu work to the right reviewer. Use when a technical manager needs to decide whether PM, QA, OPS, Architect, EVAL, or ADMIN should review a change, report, risk, or proposal.
---

# Technical Manager Review Routing

## When to use

Use this skill when a change needs review and the right review owner is unclear.

## Rules

- Identify review type and owner.
- State required evidence.
- Name missing reviews.
- Keep routing advice separate from approval.

## Required output

Use `docs/skills/technical-manager-playbook/review-routing.md`.

## Forbidden actions

- Do not treat routing as approval.
- Do not treat REPORT as QA pass or ADMIN acceptance.
- Do not let EVAL decide lifecycle.
- Do not bypass PM or ADMIN.

## Minimal example

```text
Review type: OPS
Trigger: runtime log behavior changed
Evidence: tests and runtime logs
Next handoff: OPS task
```
