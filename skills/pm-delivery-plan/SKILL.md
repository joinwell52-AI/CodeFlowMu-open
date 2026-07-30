---
name: pm-delivery-plan
description: Split CodeFlowMu requirements into P0/P1/P2 delivery plans with owners, file scope, acceptance criteria, risks, and dependencies. Use when PM needs to dispatch work to OPS/DEV/QA/EVAL while preserving scope and FCoP boundaries.
---

# PM Delivery Plan

## When to use

Use this skill when a large request needs executable phases, owners, file ranges, and acceptance criteria.

## Rules

- Split work by priority and owner.
- Include file scope and acceptance criteria per stage.
- Name forbidden items.
- Keep public issue submission and archive decisions with ADMIN.

## Required output

Use the structure in `docs/skills/pm-playbook/delivery-plan.md`.

## Forbidden actions

- Do not dispatch unrelated files.
- Do not replace ADMIN final confirmation.
- Do not submit public issues automatically.
- Do not change lifecycle without authority.

## Minimal example

```text
P0: add manifest and mapping docs, owner DEV
P1: add PM Playbook docs, owner DEV
P2: validate and report, owner DEV
```
