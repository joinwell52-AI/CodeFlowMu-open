---
name: ui-visual-consistency
description: Review CodeFlowMu UI for visual consistency, component fit, readable typography, responsive layout, and operational clarity. Use when checking Panel screens, modals, tables, filters, cards, buttons, or icons.
---

# UI Visual Consistency

## When to use

Use during UI review or before accepting a UI design/patch.

## Rules

- Match existing component patterns.
- Keep text readable and non-overlapping.
- Use familiar controls for common actions.
- Keep operational tools calm, dense, and scannable.

## Required output

Use `docs/skills/ui-playbook/visual-consistency.md`.

## Forbidden actions

- Do not create card-in-card layouts.
- Do not rely on viewport-scaled text.
- Do not accept UI copy that misstates state.

## Minimal example

```text
Issue: action label wraps into icon
Impact: mobile overlap
Fix: icon-only button with tooltip
```
