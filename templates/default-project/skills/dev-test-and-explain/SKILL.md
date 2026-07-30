---
name: dev-test-and-explain
description: Verify and explain DEV changes for PM, QA, or ADMIN review. Use when DEV needs to run tests, summarize evidence, list residual risk, and prepare a truthful FCoP REPORT.
---

# DEV Test and Explain

## When to use

Use after implementation and before reporting.

## Rules

- Run relevant tests when feasible.
- Say when tests cannot run.
- Summarize evidence and residual risk.
- Do not invent output.

## Required output

Use `docs/skills/dev-playbook/test-and-explain.md`.

## Forbidden actions

- Do not claim unrun tests passed.
- Do not hide failed tests.
- Do not archive after reporting unless authorized.

## Minimal example

```text
Command: npm test
Result: failed
Reason: unrelated existing fixture missing
Next: PM decide whether to split fix
```
