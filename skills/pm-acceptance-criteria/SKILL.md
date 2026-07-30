---
name: pm-acceptance-criteria
description: Convert "done" into checkable CodeFlowMu acceptance criteria. Use before PM dispatch, PM review, QA verification, or ADMIN closure to define functional, file, behavior, evidence, and forbidden-item checks.
---

# PM Acceptance Criteria

## When to use

Use this skill before sending work downstream or when reviewing a REPORT.

## Rules

- Make acceptance checkable.
- Include function, file, behavior, evidence, and forbidden item checks.
- Require REPORT evidence when work claims completion.
- Keep lifecycle acceptance separate from business acceptance.

## Required output

Use the checklist in `docs/skills/pm-playbook/acceptance-criteria.md`.

## Forbidden actions

- Do not treat lifecycle state as business acceptance.
- Do not accept completion without evidence.
- Do not archive automatically.
- Do not delete audit files.
- Do not add adopted-pending `0003`.

## Minimal example

```text
- [ ] JSON parses
- [ ] Required SKILL.md files exist
- [ ] Existing pm.* IDs unchanged
- [ ] No Panel/API changes
```
