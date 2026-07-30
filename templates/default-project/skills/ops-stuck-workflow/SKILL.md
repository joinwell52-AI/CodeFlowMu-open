---
name: ops-stuck-workflow
description: Diagnose stuck CodeFlowMu tasks, reports, lifecycle states, or agent sessions. Use when OPS needs to identify current state, expected next state, blocker type, and safe recovery owner.
---

# OPS Stuck Workflow

## When to use

Use when work appears stalled in lifecycle, reports, ledger views, or runtime events.

## Rules

- Identify stuck item and current state.
- Compare to expected next state.
- Classify blocker type.
- Suggest safe recovery owner.

## Required output

Use `docs/skills/ops-playbook/stuck-workflow.md`.

## Forbidden actions

- Do not manually move lifecycle files.
- Do not synthesize missing reports.
- Do not archive or delete state.

## Minimal example

```text
Stuck item: TASK-...
Current: inbox
Expected: claimed by DEV
Recovery: PM wake downstream
```
