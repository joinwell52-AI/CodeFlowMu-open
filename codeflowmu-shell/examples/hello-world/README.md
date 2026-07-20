# Hello World demo — codeflowmu v0.1.0-rc.1

Minimal smoke-test that exercises the **full v0.1 governance loop** in one drop-and-watch cycle. No external dependencies (`@cursor/sdk` is stubbed out via `InMemorySdkAdapter` in v0.1).

## What you'll see

When you drop `sample-task.md` into the shell's inbox, you should see (in order):

1. `[InboxWatcher] add: TASK-...-HELLO-PM-to-DEV.md`
2. `[TaskDispatcher] dispatching ... → DEV-01`
3. `[StateHistoryWriter] appending: dispatched`
4. `[SessionManager] starting session for DEV-01`
5. `[SessionManager] session ended` (synthetic settle from `InMemorySdkAdapter`)
6. `[ReviewEngine] starting review for session ...`
7. `[NeedsHumanGate] cli push: { decision: "needs_human", trigger_reason: "verdict_parse_failed", ... }`
8. `[ReviewWriter] wrote REVIEW-...-REVIEW-on-TASK-...-HELLO.md`
9. `[StateHistoryWriter] appending: review_pending → review_done`

The `decision="needs_human"` is **expected** — the in-memory adapter's reviewer doesn't emit a `VERDICT:` line, so the verdict parser falls back to `needs_human` per TS-6.9. That's by design: the demo proves the safety net works.

## Run it

### Option A — via npm (works today)

```powershell
cd codeflowmu-shell
npm install
npm start
```

In another PowerShell window:

```powershell
$inbox = "$env:USERPROFILE\.codeflowmu\v2\inbox"
# IMPORTANT: drop with the EXACT filename matching the frontmatter task_id,
# so the runtime's state_history append finds the file again on review settle.
copy codeflowmu-shell\examples\hello-world\sample-task.md `
  $inbox\TASK-20260509-999-PM-to-DEV.md
```

Watch the main window's stdout. To stop, press **Ctrl+C** — you should see `[shell] runtime stopped cleanly. Goodbye.`

### Option B — via single-EXE (Node SEA, Windows)

```powershell
cd codeflowmu-shell
npm install
npm run build
.\pack.cmd
```

Then double-click `dist\codeflowmu-v0.1.0-rc.1.exe`. Same drop-the-file flow as Option A.

If `pack.cmd` fails on your environment (Node SEA is still maturing — see [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) and design doc §11.7 + §11.8), fall back to **Option A**. v0.1 internal RC is OK with that — see `codeflowmu-shell/README.md` for the explicit fallback policy.

## Inspect the artifacts

After the demo runs, look at:

- `~/.codeflowmu/v2/inbox/TASK-20260509-999-PM-to-DEV.md` — bottom should have a fresh `## state_history (auto-appended by runtime)` section
- `~/.codeflowmu/v2/reviews/REVIEW-*-REVIEW-on-TASK-*-999.md` — schema-valid review verdict
- `~/.codeflowmu/v2/transcripts/*.md` — per-run streaming events
- `~/.codeflowmu/v2/sessions/*.json` — per-session metadata
- `~/.codeflowmu/v2/agents.json` — DEV-01 + REVIEW-01 records

## Reset the state

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.codeflowmu\v2"
```

Next launch will re-plant fixture skills and re-register the default agent kit.
