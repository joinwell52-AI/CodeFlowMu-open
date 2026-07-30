---
name: eval-risk-gap-analysis
description: Analyze CodeFlowMu risks and gaps from EVAL findings. Use when EVAL needs to classify expected vs actual behavior, risk type, severity recommendation, evidence, and owner.
---

# EVAL Risk and Gap Analysis

## When to use

Use when an observation needs severity and owner classification.

## Rules

- Compare expected and actual behavior.
- Classify risk type.
- Recommend P0/P1/P2 with reason.
- Keep recommendation separate from ADMIN decision.

## Required output

Use `docs/skills/eval-playbook/risk-gap-analysis.md`.

## Forbidden actions

- Do not create public issues automatically.
- Do not confuse local gaps with formal protocol gaps.
- Do not decide governance outcome.

## Minimal example

```text
Risk type: docs
Severity: P2
Owner: DEV
Reason: discoverability issue, not runtime blocker
```
