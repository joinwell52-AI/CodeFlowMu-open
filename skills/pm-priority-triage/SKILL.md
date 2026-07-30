---
name: pm-priority-triage
description: Classify CodeFlowMu tasks, risks, blocked reports, and EVAL findings as P0/P1/P2. Use when PM must decide order, owner, urgency, or whether work should be handled now, later, or held for ADMIN.
---

# PM Priority Triage

## When to use

Use this skill when multiple tasks or risks compete, or when ADMIN asks what should happen next.

## Rules

- P0 blocks main flow or risks governance/data damage.
- P1 affects quality or maintainability without blocking main flow.
- P2 is optimization, documentation, or later enhancement.
- State owner and suggested action.

## Required output

Use the structure in `docs/skills/pm-playbook/priority-triage.md`.

## Forbidden actions

- Do not treat PM priority advice as ADMIN decision.
- Do not let EVAL promote itself.
- Do not submit public GitHub issues automatically.
- Do not bypass ADMIN.

## Minimal example

```text
Issue: missing REPORT evidence
Priority: P1
Owner: DEV
Action: request fixed report with evidence
```
