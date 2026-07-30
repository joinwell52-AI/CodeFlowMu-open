---
name: pm-scope-control
description: Control CodeFlowMu task scope and prevent drive-by expansion. Use when PM must define allowed files, forbidden files, non-goals, risk expansion points, or when an agent proposes refactors, runtime changes, protocol changes, or external skill imports beyond the task.
---

# PM Scope Control

## When to use

Use this skill before dispatching work or when a task is growing beyond its original intent.

## Rules

- Name allowed and forbidden change areas.
- Keep non-goals explicit.
- Split large or risky work into separate tasks.
- Treat external skills as inspiration only unless separately approved.

## Required output

Use the structure in `docs/skills/pm-playbook/scope-control.md`.

## Forbidden actions

- Do not expand the formal FCoP protocol.
- Do not add adopted-pending `0003`.
- Do not perform drive-by refactors.
- Do not copy external skills wholesale.
- Do not turn Playbook into runtime API.

## Minimal example

```text
Allowed: docs/skills, skills/*/SKILL.md, agent manifest
Forbidden: PmGovernancePlanner, Panel API, FCoP protocol files
```
