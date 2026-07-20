# UI Usability Acceptance

Use this playbook when QA, PM, or UI reviewer needs to accept a UI change.

## Output

```text
# UI Usability Acceptance

## 1. Workflow Under Test
What user task is being checked.

## 2. Viewports
Desktop and mobile sizes checked.

## 3. Interaction Checks

| Interaction | Expected | Result | Evidence |
|---|---|---|---|

## 4. Visual Checks
No overlap, readable labels, stable layout, correct state colors.

## 5. Semantic Checks
UI labels match lifecycle/report/task meaning.

## 6. Remaining Gaps
What still needs testing.
```

## Rules

- Verify the actual UI when possible.
- Check mobile and desktop for overlap.
- Do not accept a UI that misstates FCoP state.
