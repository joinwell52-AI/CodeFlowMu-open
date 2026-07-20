# Role Skills

## PM

Status: implemented runtime sample.

- `pm.summarize_thread`
- `pm.detect_thread_stall`
- `pm.close_admin_task`
- `pm.wake_downstream`
- `pm.review_check`
- `pm.write_planning_artifact`
- `pm.record_planning_skill_evidence`

PM is the first productized role skill sample. PM Playbook skills guide product, architecture, and delivery thinking; `pm.write_planning_artifact` writes the canonical PLAN/Product Brief without shell access, while the Runtime evidence tool records real skill application and does not turn `auto_inject` into completion.

### PM Product Design Gate

- `pm-product-design-brief`

For product, UI, PWA, mobile, Gateway, app merge, and feature upgrade tasks, PM must first create a product design brief before broad DEV / QA / OPS dispatch. The brief defines product positioning, user value, information architecture, interaction, visual direction, technical/delivery boundary, role split, acceptance criteria, and v2 suggestions.

Professional UI design is part of PM's product-planning responsibility in v1. PM can reference UI playbook personas, but no new runtime UI role is introduced by this gate.

## Technical Manager

Status: `playbook_stub_only`.

- `tm-delivery-governance`
- `tm-risk-dependency`
- `tm-review-routing`

Technical Manager is a Playbook persona, not a new runtime role in v1. It coordinates delivery, dependencies, and review routing across DEV, QA, OPS, PM, EVAL, and ADMIN boundaries.

## Architect

Status: `playbook_stub_only`.

- `architect-system-design`
- `architect-boundary-review`
- `architect-decision-record`

Architect is a Playbook persona, not a new runtime role in v1. It reviews system design and boundary risk without changing formal FCoP protocol or adding runtime APIs by itself.

## UI Designer / UI Reviewer

Status: `playbook_stub_only`.

- `ui-requirements`
- `ui-information-architecture`
- `ui-visual-consistency`
- `ui-usability-acceptance`

UI Designer / Reviewer is a Playbook persona, not a new runtime role in v1. It helps clarify interface needs, organize operational screens, review visual consistency, and verify usability without adding UI code by itself.

## OPS

Status: `playbook_stub_only`.

- `ops-runtime-health`
- `ops-log-diagnosis`
- `ops-stuck-workflow`

## DEV

Status: `playbook_stub_only`.

- `dev-code-location`
- `dev-small-scope-patch`
- `dev-test-and-explain`

## QA

Status: `playbook_stub_only`.

- `qa-reproduce-issue`
- `qa-verify-fix`
- `qa-regression-check`

## EVAL

Status: `playbook_stub_only`.

- `eval-observation-writing`
- `eval-risk-gap-analysis`
- `eval-promotion-advice`

EVAL suggests promotion only. It does not submit public GitHub issues, archive tasks, or change lifecycle state.

## ADMIN

Status: human control only.

- `admin_review_task`
- `admin_approve_promotion`
- `admin_archive_task`
- `admin_submit_issue`
- `admin_reject_or_hold`

ADMIN decisions are not agent runtime skills in v1.
