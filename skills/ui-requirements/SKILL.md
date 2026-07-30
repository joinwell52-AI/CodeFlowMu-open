---
name: ui-requirements
description: Turn rough CodeFlowMu UI feedback into clear interface requirements. Use when designing Panel, desktop, task/report/log, lifecycle, or workflow UI needs user role, workflow, state semantics, constraints, and acceptance criteria.
---

# UI Requirements

## When to use

Use when UI feedback is vague or before dispatching UI work.

## Rules

- Identify role and workflow.
- State current problem and desired behavior.
- Define FCoP state semantics.
- Keep ADMIN control explicit.

## Required output

Use `docs/skills/ui-playbook/requirements.md`.

## Forbidden actions

- Do not claim unimplemented UI behavior exists.
- Do not bypass ADMIN for governance actions.
- Do not modify runtime/UI code from this Playbook alone.

## Minimal example

```text
Role: ADMIN
Workflow: review DEV report
Problem: evidence buried
Desired: show files/tests near accept action
```
