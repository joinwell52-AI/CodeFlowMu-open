---
name: tm-delivery-governance
description: Coordinate technical delivery across CodeFlowMu roles without taking ADMIN authority. Use when a technical manager needs to split workstreams, sequence dependencies, define handoff points, track technical risks, or coordinate DEV/QA/OPS/PM/EVAL delivery.
---

# Technical Manager Delivery Governance

## When to use

Use this skill when technical work spans multiple roles or requires delivery sequencing.

## Rules

- Define workstreams, owner, file scope, dependency, and acceptance.
- Identify handoff points for TASK, REPORT, QA, PM, and ADMIN.
- Keep coordination separate from approval.
- Escalate governance decisions to PM or ADMIN.

## Required output

Use `docs/skills/technical-manager-playbook/delivery-governance.md`.

## Forbidden actions

- Do not archive, delete, or move lifecycle.
- Do not submit public GitHub issues.
- Do not assign unrelated file scope.
- Do not change PM runtime skills.
- Do not modify formal FCoP protocol.

## Minimal example

```text
Workstream: docs skill catalog
Owner: DEV
Dependency: PM review
Acceptance: manifest parses, skill validation passes
```
