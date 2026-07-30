---
name: pm-product-design-brief
description: Create a PM-owned product design brief before dispatching product, UI, PWA, mobile, Gateway, app merge, or feature upgrade work. Use when PM must define positioning, user value, information architecture, interaction, visual direction, acceptance, and multi-agent split before DEV/QA/OPS execution.
---

# PM Product Design Brief

PM must design the product plan before dispatching implementation work.

## When to use

Use this skill for product/application work, especially:

- New app, PWA, page, tool, workflow, or feature delivery.
- Product merge, product upgrade, mobile/Gateway/PWA enablement.
- Requests with unclear product name, user journey, UI direction, acceptance, or role split.

## Required behavior

1. Read the ADMIN task and relevant existing product folders or reports.
2. Produce a `Product Design Brief` before broad downstream dispatch.
3. Include product positioning, target user, scenario, information architecture, key interactions, UI direction, technical/delivery boundary, role split, acceptance criteria, and v2 ideas.
4. Dispatch DEV / QA / OPS only after the brief is concrete enough to execute.
5. In the final PM-to-ADMIN report, compare actual delivery against the brief.

## UI design ownership

Professional UI design is part of PM's product-planning responsibility in the current team model. PM may use UI playbook personas for information architecture, visual consistency, and usability acceptance, but does not create a new runtime role unless ADMIN explicitly changes the team model.

## Output contract

Use the full template in:

`docs/skills/pm-playbook/product-design-brief.md`

At minimum include:

- Product name and one-line positioning
- Target user and core scenario
- V1 scope and non-scope
- Page / region structure
- Main user flows
- Mobile-first and desktop behavior
- UI style direction and state semantics
- Data, PWA, offline, Gateway or deployment boundary
- DEV / QA / OPS split
- Acceptance criteria and evidence plan
- V2 upgrade suggestions

## Guardrails

- Do not copy ADMIN's rough request directly into DEV as the whole task.
- Do not dispatch a vague product task without PM-owned design decisions.
- Do not claim PWA, Gateway, mobile, or offline support without evidence.
- Do not let patrol/ack records replace the final project report.
- Do not bypass FCoP task/report lifecycle.
