# QA Regression Check

Use this playbook when QA must check whether a change broke nearby workflows.

## Output

```text
# Regression Check

## 1. Change Area
What changed.

## 2. Impacted Workflows

| Workflow | Why impacted | Check |
|---|---|---|

## 3. Regression Results
Pass/fail per workflow.

## 4. Gaps
What was not checked and why.
```

## Rules

- Focus on plausible impact area.
- Do not expand into full-system audit unless asked.
- Record gaps honestly.
