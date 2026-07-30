---
name: ui-usability-acceptance
description: Accept or reject CodeFlowMu UI changes based on usability evidence. Use when QA, PM, or UI reviewer needs desktop/mobile checks, interaction results, visual overlap checks, and FCoP semantic correctness.
---

# UI Usability Acceptance

## When to use

Use after UI implementation or when reviewing a UI report.

## Rules

- Check the workflow, not just screenshots.
- Verify desktop and mobile where relevant.
- Record interaction results and evidence.
- Reject UI that misstates lifecycle, task, report, or review state.

## Required output

Use `docs/skills/ui-playbook/usability-acceptance.md`.

## Forbidden actions

- Do not accept untested interactions.
- Do not ignore mobile overlap.
- Do not archive or approve lifecycle from UI review alone.

## Minimal example

```text
Viewport: 390x844
Interaction: open report details
Result: pass
Evidence: screenshot path
```
