# DEV Code Location

Use this playbook when DEV must find the smallest relevant code area before editing.

## Output

```text
# Code Location

## 1. Task Summary
What behavior or file surface is involved.

## 2. Search Evidence
Commands, keywords, and files found.

## 3. Candidate Files

| File | Reason | Confidence |
|---|---|---|

## 4. Ownership Boundary
Files allowed and files that should not be touched.

## 5. Next Step
Patch / ask / dispatch / blocked.
```

## Rules

- Prefer `rg` for search.
- Read before editing.
- Do not expand scope because nearby code looks tempting.
- Report uncertainty instead of guessing.
