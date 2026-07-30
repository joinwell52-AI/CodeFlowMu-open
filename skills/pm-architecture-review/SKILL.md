---
name: pm-architecture-review
description: Review CodeFlowMu/FCoP proposals for architecture and governance boundary risk. Use when adding tools, skills, runtime logic, Panel buttons, lifecycle behavior, report/eval/issue-draft behavior, or anything that might mix MCP Skill with Agent Playbook Skill.
---

# PM Architecture Review

## When to use

Use this skill before accepting a proposal that touches architecture, runtime governance, lifecycle, Panel/API, or FCoP semantics.

## Rules

- Check whether MCP is being turned into a decision brain.
- Check Playbook vs MCP layer separation.
- Check ADMIN, lifecycle, EVAL, REPORT, and public submission boundaries.
- Prefer minimal adjustments.

## Required output

Use the structure in `docs/skills/pm-playbook/architecture-review.md`.

## Forbidden actions

- Do not let PM Playbook become runtime API.
- Do not bypass ADMIN.
- Do not auto-submit GitHub issues.
- Do not modify FCoP formal protocol.
- Do not add adopted-pending `0003`.

## Minimal example

```text
Conclusion: risky
Risk: proposal lets EVAL submit public GitHub issues
Adjustment: create internal draft with admin_approved=false
```
