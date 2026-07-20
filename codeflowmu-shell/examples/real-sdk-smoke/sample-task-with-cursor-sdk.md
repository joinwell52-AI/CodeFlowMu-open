---
protocol: fcop
version: 1
kind: task
task_id: TASK-20260510-SDK-SMOKE-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
thread_key: codeflowmu-v02-alpha-real-sdk-smoke
references:
  - codeflowmu-shell/examples/real-sdk-smoke/README.md
layer: worker
---

# Real SDK Smoke — v0.2.0-alpha Cursor SDK Integration Test

## Summary

This fixture verifies that the **real Cursor SDK adapter** is active and
produces a meaningful VERDICT when `CURSOR_API_KEY` is set.

Unlike `hello-world/sample-task.md` (which relies on `InMemorySdkAdapter`),
this task is intended to be processed by the **real LLM** via `CursorSdkAdapter`.

## Task Description

Please review the following simple code change and decide whether to approve it:

```python
def add(a: int, b: int) -> int:
    """Return the sum of a and b."""
    return a + b
```

Proposed change: rename `add` to `sum_two`.

## Acceptance Criteria

- The function behavior is unchanged (just a rename).
- All callers updated (assume none in this smoke test).
- No performance impact.

## Expected QA Outcome

When processed by the real SDK:

1. `InboxWatcher` picks up this file.
2. `TaskParser` reads the YAML front-matter.
3. `TaskDispatcher` creates a session using `CursorSdkAdapter` (NOT fake).
4. LLM produces a response containing `VERDICT: approve` or `VERDICT: reject`
   (simple rename — likely `approve`).
5. `ReviewEngine` processes the VERDICT.
6. If `approve` → governance loop ends cleanly.
7. If `needs_human` → `[NeedsHumanGate]` fires + review file written.

## Notes

- This task intentionally uses a trivial change to encourage LLM approval.
- If `CURSOR_API_KEY` is invalid, the adapter should fallback to fake
  (per ConfigLoader contract) and produce `needs_human` instead.
- Do NOT commit real API keys into this file.
