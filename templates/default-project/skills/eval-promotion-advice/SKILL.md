---
name: eval-promotion-advice
description: Advise how EVAL findings should be promoted. Use when EVAL needs to suggest local task, CodeFlowMu issue draft, FCoP issue draft, or hold while applying public safety boundaries and ADMIN approval requirements.
---

# EVAL Promotion Advice

## When to use

Use when an observation may need follow-up beyond the EVAL file.

## Rules

- Suggest target only.
- Run safe-public-draft thinking before public issue drafts.
- Keep `admin_approved` false by default.
- Require ADMIN for public submission.

## Required output

Use `docs/skills/eval-playbook/promotion-advice.md`.

## Forbidden actions

- Do not submit GitHub issues.
- Do not bypass ADMIN.
- Do not archive/delete/move lifecycle.

## Minimal example

```text
Target: local_task
Reason: project docs need update
Required authority: PM
```
