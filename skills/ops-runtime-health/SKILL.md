---
name: ops-runtime-health
description: Check CodeFlowMu runtime, Panel, project root, and FCoP directory health. Use when OPS needs environment checks, health status, project-root diagnosis, or safe escalation without deleting state.
---

# OPS Runtime Health

## When to use

Use when runtime or environment health is uncertain.

## Rules

- Check project root, server, Panel, and FCoP directories.
- Separate environment from code.
- Preserve logs and state.
- Escalate risky repairs.

## Required output

Use `docs/skills/ops-playbook/runtime-health.md`.

## Forbidden actions

- Do not delete logs or FCoP state while diagnosing.
- Do not rewrite runtime core from an OPS check.
- Do not archive lifecycle files.

## Minimal example

```text
Check: fcop/reports exists
Result: pass
Evidence: directory listing
```
