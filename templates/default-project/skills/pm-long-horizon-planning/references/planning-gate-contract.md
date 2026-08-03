# Planning Gate Contract

## Contents

1. Decision identity
2. State transitions
3. Staleness and delivery
4. Separation from operation approval

## 1. Decision identity

A decision requires `decision_id`, root `task_id`, `thread_key`, current `revision`, `body_digest`, `validation_digest`, decision enum, non-empty reason, `decided_by=ADMIN`, decision time, notice status, and wake status.

Allowed decisions only:

- `approve_wp00`
- `request_plan_change`
- `pause`
- `replan`
- `terminate`

## 2. State transitions

- `approve_wp00`: set gate approved and `dispatch_scope=wp00_only` only when validation passed for the exact current body.
- `request_plan_change`: keep root open and request a new revision.
- `pause`: preserve state and dispatch nothing.
- `replan`: preserve history and restart full source ingestion/audit.
- `terminate`: record the business decision; PM does not archive the task.

## 3. Staleness and delivery

Persist decisions append-only. A new revision or body/validation digest mismatch marks all earlier approvals stale. Never apply a stale decision to a new artifact.

After persistence, deliver to the original task/thread/session, wake the original PM, record both outcomes, and allow bounded retry after restart. A failed notice never erases the decision and never terminates the Session/Task.

## 4. Separation from operation approval

Planning Gate is a business decision, not `.codeflowmu/operation-approvals`. Planning findings do not become `NEG.*` operations. Operation approval covers only a proven, specific high-impact mutation and only its exact operation digest.
