# Product Brief Contract

## Contents

1. Authority and revision
2. Required content
3. Validation and writing
4. Prohibited shortcuts

## 1. Authority and revision

The only authoritative Level 3 path is `fcop/internal/product-briefs/PRODUCT-BRIEF-<ROOT_TASK_ID>.md`. History snapshots are append-only, marked `superseded/non-authoritative`, and never become a second current Brief.

Frontmatter is Runtime-owned. It records root task/thread/session, artifact status, validation status/digest, source digest, revision, previous/new body digest, planning gate state, created/updated times, and writer identity.

## 2. Required content

Keep existing product-design content and add:

1. Overall plan.
2. WP task tree.
3. Dependency/resource matrix.
4. Absolute schedule and gates.
5. Tests and experiment plan.
6. Risk register.
7. Preservation, recovery, and rollback.
8. Planning status and revision log.
9. Requirement Coverage Appendix.
10. Validation Summary.

Every current revision must independently contain all required facts, calculations, decisions, risks, and recovery instructions.

## 3. Validation and writing

1. Render from a validated Planning IR.
2. Compute the body digest from exact Markdown bytes.
3. Bind semantic validation to task/root/thread/session, source digest, body digest, validation digest, and fact snapshot time.
4. Use `pm.write_planning_artifact` for atomic replacement.
5. Snapshot the previous revision before replacement.
6. Read the new file back and verify its digest.
7. Mark old approval stale whenever revision or body digest changes.

## 4. Prohibited shortcuts

- No hand-written frontmatter or protected-path shell/Python write.
- No `TBD`, `TODO`, unknown placeholder, “same as previous”, or “see rN”.
- No structure-only claim that content is semantically valid.
- No target-state claim presented as an observed fact.
- No direct destructive Git recovery without preservation evidence.
- No remote push, PR, tag, release, or production action from this workflow.
