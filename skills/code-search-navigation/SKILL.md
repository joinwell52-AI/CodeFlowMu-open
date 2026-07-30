---
name: code-search-navigation
description: Use when an agent needs to locate relevant files, symbols, call sites, routes, tests, configs, or ownership boundaries before editing or explaining code.
---

# Code Search Navigation

## When to use

Use before changing or explaining code when the relevant entry point, module,
test, route, or ownership boundary is not already known.

## Rules

- Prefer `rg` and `rg --files` for text and file discovery.
- Search for exact identifiers, route paths, filenames, error text, and user-visible labels.
- Read nearby code before editing.
- Follow existing patterns before adding new abstractions.
- Keep the discovered evidence narrow: file paths, line numbers, and why they matter.
- Stop searching once the implementation boundary is clear.

## Required output

When reporting, include:

- Search terms or discovery method.
- Key files inspected.
- Chosen edit boundary.
- Any relevant files intentionally left untouched.

## Forbidden actions

- Do not edit before locating the owning module unless the task is trivial and file ownership is explicit.
- Do not perform broad refactors just because search found related code.
- Do not cite files you did not inspect.

## Minimal example

```text
Search: rg "resolveAndInject" packages/codeflowmu-runtime/src
Found: TaskDispatcher.ts builds the agent prompt prefix
Boundary: route skill injection there, not in Panel rendering
```
