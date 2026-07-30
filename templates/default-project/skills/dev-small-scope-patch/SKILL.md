---
name: dev-small-scope-patch
description: Make narrowly scoped CodeFlowMu changes using existing patterns. Use when DEV needs to patch code, docs, manifests, or tests without broad refactors or runtime boundary violations.
---

# DEV Small Scope Patch

## When to use

Use when implementation is authorized and scope is clear.

## Rules

- Keep edits small and local.
- Follow project patterns.
- Preserve unrelated dirty work.
- Explain non-goals.

## Required output

Use `docs/skills/dev-playbook/small-scope-patch.md`.

## Forbidden actions

- Do not perform drive-by refactors.
- Do not modify formal FCoP protocol unless explicitly tasked.
- Do not add Panel/API/runtime behavior from a Playbook task.

## Minimal example

```text
File: skills/README.md
Change: add new skill group list
Why: keep catalog discoverable
```
