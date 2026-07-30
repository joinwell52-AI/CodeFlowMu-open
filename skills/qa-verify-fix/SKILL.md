---
name: qa-verify-fix
description: Verify CodeFlowMu fixes against acceptance criteria. Use when QA needs to run commands or UI checks, record pass/fail evidence, and report remaining issues.
---

# QA Verify Fix

## When to use

Use after DEV reports a fix or PM asks for validation.

## Rules

- Check behavior against acceptance criteria.
- Keep failures visible.
- Report gaps.
- Do not approve lifecycle directly.

## Required output

Use `docs/skills/qa-playbook/verify-fix.md`.

## Forbidden actions

- Do not treat file existence as behavior verification.
- Do not archive or approve lifecycle.
- Do not hide untested criteria.

## Minimal example

```text
Check: manifest JSON parses
Result: pass
Evidence: python -m json.tool
```
