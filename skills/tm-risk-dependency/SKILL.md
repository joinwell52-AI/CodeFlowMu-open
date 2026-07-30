---
name: tm-risk-dependency
description: Analyze technical risks and dependencies for CodeFlowMu work. Use when a technical manager needs to identify blockers, dependency order, risk owners, runtime risk, missing upstream reports, or escalation paths.
---

# Technical Manager Risk and Dependency

## When to use

Use this skill when work may be blocked by missing dependencies, unclear owner, runtime risk, or upstream decisions.

## Rules

- Map dependencies to owners and evidence.
- Separate blocking risk, quality risk, and runtime risk.
- Give the smallest safe mitigation.
- Put blocked information into REPORT when execution is blocked.

## Required output

Use `docs/skills/technical-manager-playbook/risk-dependency.md`.

## Forbidden actions

- Do not hide blocked state.
- Do not invent another role's report.
- Do not change protocol or runtime to bypass missing approval.
- Do not submit public GitHub issues automatically.

## Minimal example

```text
Dependency: QA verification
Needed by: PM closure
Owner: QA
Status: missing
Mitigation: dispatch QA task
```
