# Safe Public Draft

`safe_public_draft`, `classify_issue_scope`, and `create_issue_draft` protect the boundary between internal observations and public issue submission.

## Scope Classification

`classify_issue_scope` suggests a target only:

- `codeflowmu`: local CodeFlowMu implementation issue.
- `fcop`: protocol or FCoP package issue.
- `local_task`: work should stay as a local TASK.
- `hold`: insufficient evidence or unsafe for public draft.

The suggestion does not decide. ADMIN or Panel performs the final action.

## Issue Draft Creation

`create_issue_draft` generates an internal draft. It must not submit to GitHub.

Drafts should include:

- `target_repo`
- `source_eval`
- `admin_approved: false`
- `safety_check.status`
- `safety_check.findings`

## Public Safety Checks

Check for:

- Local absolute paths.
- API keys, tokens, and secrets.
- Full private logs.
- Personal information.
- Customer or project private content.
- Private task body.
- Internal screenshot sensitive information.

## Rules

- A failed safety check blocks public submission only; it does not block internal draft generation.
- ADMIN must see the safety check result.
- Public submission requires explicit ADMIN confirmation.
- EVAL and PM must not silently submit public GitHub issues.
