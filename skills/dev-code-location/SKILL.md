---
name: dev-code-location
description: Locate relevant CodeFlowMu code and documentation before editing. Use when DEV needs to search with rg, identify candidate files, understand ownership boundaries, or decide whether a task is ready for patching.
---

# DEV Code Location

## When to use

Use before editing code or docs for a DEV task.

## Rules

- Prefer `rg` and targeted file reads.
- Read before editing.
- List candidate files and confidence.
- Stop if scope or role is unclear.

## Required output

Use `docs/skills/dev-playbook/code-location.md`.

## Forbidden actions

- Do not edit before locating scope.
- Do not expand into unrelated refactors.
- Do not overwrite user changes.

## Minimal example

```text
Candidate: codeflowmu-shell/src/web-panel.ts
Reason: owns Panel route
Confidence: medium
```
