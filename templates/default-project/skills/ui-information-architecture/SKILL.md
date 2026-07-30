---
name: ui-information-architecture
description: Organize CodeFlowMu UI screens, navigation, panels, filters, and operational workflows. Use when UI work needs information grouping, scan path, state/empty states, or safe navigation for task/report/lifecycle/log surfaces.
---

# UI Information Architecture

## When to use

Use before designing or changing a screen structure.

## Rules

- Start with the primary user goal.
- Group information by decision need.
- Put evidence and lifecycle state near dependent actions.
- Keep operational UI dense but readable.

## Required output

Use `docs/skills/ui-playbook/information-architecture.md`.

## Forbidden actions

- Do not hide governance actions behind ambiguous UI.
- Do not make marketing-style landing pages for operational tools.
- Do not change Panel code unless implementation is explicitly requested.

## Minimal example

```text
Goal: close task
First scan: status, latest report, missing evidence
Action area: approve/reject after evidence
```
