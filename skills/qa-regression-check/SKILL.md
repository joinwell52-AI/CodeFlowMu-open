---
name: qa-regression-check
description: Check plausible regressions from a CodeFlowMu change. Use when QA needs to identify impacted workflows, run focused checks, and record gaps without expanding into full-system audit.
---

# QA Regression Check

## When to use

Use when a change may affect nearby workflows.

## Rules

- Define impacted workflows.
- Keep regression scope focused.
- Record gaps honestly.
- Escalate broad audit requests to PM.

## Required output

Use `docs/skills/qa-playbook/regression-check.md`.

## Forbidden actions

- Do not expand into full audit unless tasked.
- Do not claim untested workflows are safe.
- Do not mutate lifecycle.

## Minimal example

```text
Workflow: skill validation
Why impacted: new SKILL.md folders
Check: quick_validate.py over skills/*
```
