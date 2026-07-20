# PM Tech Scope

Use this playbook when PM needs to decide the technical boundary of a development task before dispatching it.

The goal is not to pick a fashionable stack. The goal is to keep the task honest: match the language, runtime, and environment to the deliverable, the target project, and the maintenance burden.

## Output

```text
# Tech Scope

## 1. Deliverable Type
Classify the work: static page, standalone browser game, prototype, existing project change, frontend app, backend service, CLI, automation script, data workflow, AI/ML workflow, library/package, documentation/tooling, or other.

## 2. Target Runtime
Where it should run: browser, Node.js, Python, desktop, server, local shell, mobile, CI, or existing project runtime.

## 3. Preferred Stack
Name the smallest appropriate stack.

Examples:
- Static HTML/CSS/JS for small browser games, demos, prototypes, and simple interactive pages.
- Python for automation, data processing, scripts, CLIs, local tools, AI/ML workflows, and quick backend utilities.
- TypeScript for existing TypeScript projects, long-lived frontend apps, shared packages, complex browser UI, and typed integration surfaces.
- Existing project stack for modifications inside an established codebase.

## 4. Reasoning
Explain why this stack is appropriate in one to three sentences.

## 5. Explicit Non-defaults
Name stacks or tools that should not be introduced unless justified.

Examples:
- Do not add TypeScript or a bundler for a single-file mini-game unless there is a maintenance requirement.
- Do not add Python for browser-only UI.
- Do not add a backend, database, or framework unless the acceptance criteria require it.

## 6. DEV Discretion Boundary
State what DEV may decide independently and what requires a report before proceeding.

## 7. Acceptance Impact
State how the stack choice affects the acceptance check: open in browser, run Python script, run tests, inspect generated artifact, run CLI command, or verify inside existing app.
```

## Decision Guide

Prefer `HTML/CSS/JS` when the work is browser-native, small, standalone, visual, and does not need a package boundary.

Prefer `Python` when the work is local, procedural, data-heavy, automation-heavy, AI/ML-oriented, or primarily a command-line/tooling problem.

Prefer `TypeScript` when the work lives in an existing TypeScript codebase, needs durable frontend structure, typed APIs, shared package contracts, or maintainable complex UI logic.

Prefer the target project's existing stack when editing an established project. The host repository's stack is not evidence about the target project's stack.

## Hard Rules

- PM must not leave stack choice implicit when multiple reasonable stacks exist.
- PM must not assume CodeFlowMu's stack applies to generated projects.
- PM must expose runtime assumptions in the task.
- DEV must report before introducing a new language, framework, bundler, backend, database, or deployment model outside the PM boundary.
