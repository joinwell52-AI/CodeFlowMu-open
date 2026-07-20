---
$schema: https://codeflowmu.dev/schemas/task/v0.1.json
protocol: fcop
fcop_version: "1.0-pre"
runtime_protocol_version: "0.1-alpha"

task_id: TASK-20260601-001-PM-to-DEV
sender: PM
recipient: DEV
priority: P2

thread_key: refactor-utils
parent_task: null

status: pending
state_history:
  - { state: pending, at: "2026-06-01T15:00:00Z", by: PM }

review_required: true
review_assignee: QA
risk_level: medium

created_at: "2026-06-01T15:00:00Z"
updated_at: "2026-06-01T15:00:00Z"
deadline: null

labels:
  area: refactor
---

# Task body

请把 `src/utils.ts` 里的字符串拼接重构成模板字符串。

## Constraints

- 不修改公开 API 签名
- 通过现有 unit test
