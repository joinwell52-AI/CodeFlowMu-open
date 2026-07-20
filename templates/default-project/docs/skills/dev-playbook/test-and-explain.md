# DEV Test and Explain

Use this playbook when DEV must verify a change and explain it for PM, QA, or ADMIN review.

## Output

```text
# Test and Explain

## 1. What Changed
Plain engineering summary.

## 2. Tests Run

| Command | Result | Notes |
|---|---|---|

## 3. Evidence
Files, logs, screenshots, or output summaries.

## 4. Residual Risk
What is not covered.

## 5. Handoff
Who should review next.
```

## Rules

- Do not invent test output.
- If tests cannot run, say why.
- Explain changed behavior, not just files touched.
