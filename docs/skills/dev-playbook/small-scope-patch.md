# DEV Small Scope Patch

Use this playbook when DEV must implement a narrowly scoped code or documentation change.

## Output

```text
# Small Scope Patch

## 1. Intended Change
One sentence.

## 2. Files Changed

| File | Change | Why |
|---|---|---|

## 3. Behavior Change
What user/system behavior changed.

## 4. Non-goals
What was intentionally left untouched.

## 5. Verification
Commands, tests, read-back checks, screenshots, or manual checks.
```

## Rules

- Keep edits inside task scope.
- Preserve user changes and unrelated dirty work.
- Use existing project patterns.
- Do not refactor unrelated code.
