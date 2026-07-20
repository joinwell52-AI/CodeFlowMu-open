---
protocol: fcop
version: 1
kind: task
task_id: TASK-20260509-999-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
thread_key: codeflowmu-v01-rc1-internal-preview-hello-world
references:
  - codeflowmu-shell/README.md
layer: worker
---

# Hello World — first task on codeflowmu v0.1.0-rc.1

## 背景

This is the smoke-test task that exercises the full v0.1 governance loop:

1. `InboxWatcher` notices this file (chokidar `add` event).
2. `TaskParser` reads the YAML front-matter.
3. `TaskDispatcher` resolves `recipient: DEV` → `DEV-01` and starts a session.
4. `InMemorySdkAdapter` synthetically settles the session via `setImmediate`.
5. `ReviewEngine` picks up `runtime.session_ended` and starts a `REVIEW-01`
   reviewer subtask.
6. `REVIEW-01` settles too (no `VERDICT:` line → `decision="needs_human"`).
7. `NeedsHumanGate` logs the human-push payload to stdout.
8. `ReviewWriter` persists `REVIEW-*-REVIEW-on-TASK-*-HELLO.md` to disk.
9. `StateHistoryWriter` appends bullets to *this file* (look at the bottom
   after the demo runs).

If you see ALL nine steps in the shell stdout, v0.1 is working end-to-end.

## 验收

- `<dataDir>/reviews/` 下出现一个新的 `REVIEW-*-REVIEW-on-TASK-*-HELLO.md`
- 本文件末尾出现 `## state_history (auto-appended by runtime)` 段落

## 备注

Run by ADMIN via:

```powershell
cd codeflowmu-shell
npm start
# In another window — IMPORTANT: drop with the exact filename matching
# the frontmatter task_id above, so state_history append finds the file
# again on review settle.
copy examples\hello-world\sample-task.md `
  "$env:USERPROFILE\.codeflowmu\v2\inbox\TASK-20260509-999-PM-to-DEV.md"
```

For real `@cursor/sdk` calls (set `CURSOR_API_KEY` first — see `codeflowmu-shell/README.md` § "Quick start: getting a Cursor API key"), the reviewer will emit a real `VERDICT:` line and `decision` will be one of `approved` / `changes_requested` etc., not `needs_human`.
