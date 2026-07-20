# PM Runtime Skill Mapping

The existing PM runtime skills are already implemented in `.codeflowmu/pm-skills.manifest.json`. They keep their original `pm.*` IDs and remain the first productized PM skill sample.

| Panel display | Runtime skill ID | Planning alias | Common Playbook skill |
|---|---|---|---|
| 线程摘要 | `pm.summarize_thread` | 开工前读 thread | `read_context` |
| 线程卡顿检测 | `pm.detect_thread_stall` | 治理诊断 | `detect_blocked` |
| ADMIN 关单草稿 | `pm.close_admin_task` | `pm_merge_results` / `pm_report_to_admin` | `write_report` |
| 下游唤醒 | `pm.wake_downstream` | 派单后催促 | `create_followup_request` |
| 回执验收检查 | `pm.review_check` | `pm_review_report` | `attach_evidence`, `write_report` |
| 受控规划产物写入 | `pm.write_planning_artifact` | 派单前写 PLAN/Product Brief | Runtime canonical writer |
| 规划技能真实证据 | `pm.record_planning_skill_evidence` | 派单前逐项留证 | PM/UI Playbook skills |

## Product Design Gate

完整规范见 [CodeFlowMu 开发团队版 PM 分析、规划与产品设计规范](./pm-planning-governance.md)。这是 CodeFlowMu 开发团队版工作规范，不是 FCoP 核心协议要求。

`pm-product-design-brief` is the PM product-planning gate for product, UI, PWA, mobile, Gateway, app merge, and feature upgrade tasks. It is a Playbook skill, not a new `pm.*` runtime skill.

Runtime first assigns Level 0–3. PM must call `pm.write_planning_artifact` to complete the matching PLAN/Product Brief before the first DEV / QA / OPS task is created; shell, Python, native edit, hand-written YAML, and direct JSONL writes are not valid planning paths. `auto_inject` is recommendation evidence only; real Level 3 execution is recorded one skill at a time through `pm.record_planning_skill_evidence`.

Professional UI design belongs to this PM gate in v1: UI playbook personas can be referenced by PM, but they do not create a new runtime role.

## Rules

- Do not rename existing `pm.*` IDs.
- Do not add `pm_review_report` as a runtime ID.
- Do not rebuild PM Panel/API or `PmGovernancePlanner`.
- Map the existing runtime skills into the global playbook manifest only.
- Keep `pm-product-design-brief` as Playbook guidance unless separately productized into runtime automation later.
- OPS, DEV, QA, EVAL, and ADMIN skills are `playbook_stub_only` in v1 unless separately productized later.
