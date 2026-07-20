# QA Verify Fix

Use this playbook when QA must verify that a fix satisfies acceptance criteria.

## Output

```text
# Verify Fix

## 1. Fix Under Test
Task, report, PR, files, or build.

## 2. Acceptance Criteria
Checklist copied or derived from PM.

## 3. Verification Steps
Commands or UI steps.

## 4. Results

| Check | Pass/Fail | Evidence |
|---|---|---|

## 5. Remaining Issues
Anything still failing or untested.
```

## Rules

- Verify behavior, not just file presence.
- Keep failed checks visible.
- Do not archive or approve lifecycle; report findings upstream.
