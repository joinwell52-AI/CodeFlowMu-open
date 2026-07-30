---
name: test-selection
description: Use when an agent needs to choose appropriate verification scope after a change, balancing focused tests, package tests, typechecks, UI checks, and known residual risk.
---

# Test Selection

## When to use

Use after planning or making a change to decide which checks should run and
which risks remain if some checks are skipped.

## Rules

- Match test scope to blast radius.
- For single-module logic, run the closest unit tests first.
- For shared runtime/router/API behavior, add or run package-level tests.
- For UI/browser-visible behavior, include Playwright or browser verification when feasible.
- Run typecheck when changing exported types or TypeScript contracts.
- Name skipped checks and why they were skipped.

## Required output

When reporting, include:

- Checks run.
- Checks skipped.
- Why the selected scope is sufficient.
- Residual risk.

## Forbidden actions

- Do not say "tested" without naming the check.
- Do not rely only on snapshots or static reading for interactive UI behavior.
- Do not run unrelated expensive suites just to look thorough when a narrower suite proves the change.

## Minimal example

```text
Focused: SkillContextRouter.test.ts
Broader: AgentPlaybookCatalog.test.ts because manifest shape changed
Skipped: full shell typecheck due known pre-existing errors
```
