---
name: qa-reproduce-issue
description: Reproduce CodeFlowMu bugs or reported behavior. Use when QA needs to capture environment, steps, actual result, expected result, and reproducibility before fix verification.
---

# QA Reproduce Issue

## When to use

Use before diagnosing or verifying a bug report.

## Rules

- Record environment and steps.
- Separate actual and expected results.
- Attach concise evidence.
- State reproducibility.

## Required output

Use `docs/skills/qa-playbook/reproduce-issue.md`.

## Forbidden actions

- Do not mark fixed from code inspection alone.
- Do not invent reproduction.
- Do not move lifecycle state.

## Minimal example

```text
Reproducibility: always
Step: click publish task twice
Actual: two TASK files
Expected: one TASK file
```
