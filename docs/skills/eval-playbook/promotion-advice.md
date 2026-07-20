# EVAL Promotion Advice

Use this playbook when EVAL suggests whether an observation should become a local task, CodeFlowMu issue draft, FCoP issue draft, or hold item.

## Output

```text
# Promotion Advice

## 1. Source Observation
ID and summary.

## 2. Suggested Target
local_task / codeflowmu_issue_draft / fcop_issue_draft / hold.

## 3. Reason
Why this target fits.

## 4. Safety Check
Private path, secret, private log, task body, screenshot sensitivity.

## 5. Required Authority
PM / ADMIN / protocol governance.
```

## Rules

- EVAL advises only.
- Public submission requires ADMIN.
- `admin_approved` must default to false for issue drafts.
