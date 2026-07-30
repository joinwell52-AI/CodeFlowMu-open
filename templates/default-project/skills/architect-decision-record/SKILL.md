---
name: architect-decision-record
description: Prepare or review architecture decision notes without adopting ADRs automatically. Use when an architect needs to compare options, recommend a decision, name authority, or ensure a decision note does not become an FCoP protocol change without governance.
---

# Architect Decision Record Review

## When to use

Use this skill when a technical decision needs structure but is not yet an adopted ADR.

## Rules

- Compare options and risks.
- Name required authority.
- State that the note is not adopted until governance accepts it.
- Keep local CodeFlowMu decisions separate from formal FCoP protocol changes.

## Required output

Use `docs/skills/architect-playbook/decision-record.md`.

## Forbidden actions

- Do not auto-create or auto-adopt ADRs.
- Do not add adopted-pending `0003`.
- Do not rewrite protocol docs.
- Do not bypass ADMIN.

## Minimal example

```text
Decision candidate: add playbook catalog
Authority: PM/ADMIN
Non-adoption: this is not an adopted ADR
```
