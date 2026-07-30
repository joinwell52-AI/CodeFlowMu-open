---
name: run-local-command-check
description: Use when an agent needs to run a local command for verification, diagnostics, tests, builds, typechecks, scripts, or CLI behavior and must report truthful command evidence.
---

# Run Local Command Check

## When to use

Use before running commands that produce evidence for a task, especially tests,
typechecks, builds, local scripts, CLI diagnostics, or health checks.

## Rules

- State the command purpose before relying on its output.
- Prefer the smallest command that verifies the claim.
- Run commands from the correct workspace directory.
- Capture the command, exit status, and key output.
- Treat failure output as evidence, not as something to hide.
- Do not claim success if a command failed or was not run.
- Avoid destructive commands unless the task explicitly authorizes them.

## Required output

When reporting, include:

- Command.
- Working directory.
- Result: pass, fail, skipped, or blocked.
- Key output lines or a concise summary.
- Any follow-up risk from skipped checks.

## Forbidden actions

- Do not fabricate command output.
- Do not run broad or slow checks when a narrow check is enough unless risk justifies it.
- Do not use command success alone as proof of UI or product correctness when browser or manual behavior matters.

## Minimal example

```text
Command: npm --prefix packages/codeflowmu-runtime test
Purpose: verify runtime unit tests after router change
Result: pass
Evidence: 280 tests passed, 0 failed
```
