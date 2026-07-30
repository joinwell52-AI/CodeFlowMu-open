---
name: pm-tech-scope
description: Use when PM writes or reviews development tasks and must choose the smallest appropriate technology stack, language, runtime, environment, deliverable format, and escalation boundary. Applies especially when deciding between TypeScript, Python, static HTML/CSS/JS, existing project stack, scripts, games, prototypes, CLIs, automation, AI/ML, or production apps.
---

# PM Tech Scope

## When to use

Use this skill before PM dispatches a development task whose implementation language, runtime, framework, build chain, or delivery format is not already obvious from the target project.

## Rules

- Do not infer the target task stack from the host repository stack.
- Choose the smallest appropriate stack for the requested deliverable.
- Prefer static `HTML/CSS/JS` for standalone browser games, demos, prototypes, and simple interactive pages.
- Prefer `Python` for automation, data processing, scripts, CLIs, local tooling, AI/ML workflows, quick backend utilities, and glue code.
- Prefer `TypeScript` for existing TypeScript projects, long-lived frontend apps, shared packages, complex browser UI, or code that benefits from typed contracts.
- Follow the target project's existing stack for changes inside an existing project.
- Require justification before adding a framework, build tool, backend, database, package manager, or new language.
- State how much technical discretion DEV has, and when DEV must report back before proceeding.

## Required output

Use the structure in `docs/skills/pm-playbook/tech-scope.md`.

## Forbidden actions

- Do not make TypeScript the default just because CodeFlowMu is TypeScript.
- Do not make Python the default just because it is a strong general-purpose AI-development language.
- Do not add a framework or build system for a task that can be delivered cleanly as a static file or small script.
- Do not hide deployment, runtime, or environment assumptions from DEV.
- Do not override explicit ADMIN or target-project constraints.

## Minimal example

```text
Deliverable: standalone browser mini-game
Preferred stack: static HTML/CSS/JS
Reason: no persistence, no shared package, no production build requirement
DEV discretion: may keep it single-file; must report before adding TypeScript or a bundler
```
