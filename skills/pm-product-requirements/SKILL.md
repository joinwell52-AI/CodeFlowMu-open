---
name: pm-product-requirements
description: Turn vague ADMIN requests, chat feedback, screenshots, and workflow complaints into scoped CodeFlowMu product requirements. Use when PM needs PRD-style clarification, user stories, goals, non-goals, constraints, risks, or task input while preserving FCoP boundaries.
---

# PM Product Requirements

## When to use

Use this skill when a request is fuzzy, a UI or workflow complaint needs structure, or PM needs to prepare a TASK input.

## Rules

- Separate background, problem, goal, scope, non-scope, constraints, acceptance, risks, and split.
- Keep requirements inside CodeFlowMu/FCoP boundaries.
- Mark assumptions and unknowns.
- Preserve existing PM runtime skill IDs.

## Required output

Use the structure in `docs/skills/pm-playbook/product-requirements.md`.

## Forbidden actions

- Do not turn requirements into protocol changes.
- Do not add adopted-pending `0003`.
- Do not claim unimplemented runtime features exist.
- Do not submit public GitHub issues automatically.
- Do not bypass ADMIN.

## Minimal example

```text
Goal: make PM review evidence visible
Scope: docs and manifest only
Non-scope: Panel/API runtime changes
Acceptance: docs exist, manifest parses
```
