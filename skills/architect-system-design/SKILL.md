---
name: architect-system-design
description: Produce CodeFlowMu/FCoP-aware system designs before implementation. Use when an architect needs to define problem, current architecture, proposed design, interfaces, alternatives, risks, and verification without creating runtime behavior by default.
---

# Architect System Design

## When to use

Use this skill before implementing changes that affect architecture, interfaces, MCP tools, Panel/API, lifecycle, events, schemas, or cross-module flow.

## Rules

- Describe current architecture before proposing changes.
- Define interfaces and data flow.
- Compare alternatives.
- Keep design separate from implementation unless implementation is explicitly in scope.

## Required output

Use `docs/skills/architect-playbook/system-design.md`.

## Forbidden actions

- Do not treat local design as formal FCoP protocol change.
- Do not add runtime APIs without explicit implementation scope.
- Do not bypass ADMIN.
- Do not add adopted-pending `0003`.

## Minimal example

```text
Problem: issue draft safety needs visibility
Interface: internal draft frontmatter safety_check
Risk: accidental public submission
Verification: draft contains admin_approved=false
```
