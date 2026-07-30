---
name: ops-log-diagnosis
description: Summarize CodeFlowMu logs into actionable evidence. Use when OPS needs to inspect runtime, analytics, usage, or panel logs and distinguish evidence from inference.
---

# OPS Log Diagnosis

## When to use

Use when logs are needed to explain a failure, stall, or runtime behavior.

## Rules

- Name log sources and time range.
- Extract concise signals.
- Build a short timeline.
- Mark inference clearly.

## Required output

Use `docs/skills/ops-playbook/log-diagnosis.md`.

## Forbidden actions

- Do not paste full private logs into public drafts.
- Do not delete logs.
- Do not claim causality without evidence.

## Minimal example

```text
Signal: repeated POST /api/v2/tasks
Inference: double-click submitted duplicate task
Owner: DEV
```
