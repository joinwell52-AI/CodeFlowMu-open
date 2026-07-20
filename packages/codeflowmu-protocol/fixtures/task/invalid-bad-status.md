---
$schema: https://codeflowmu.dev/schemas/task/v0.1.json
protocol: fcop
task_id: TASK-20260601-002-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
status: WORKING_ON_IT
---

# Bad task

`status: WORKING_ON_IT` 不在 enum 中（应为 pending/dispatched/in_progress/review/done/blocked/cancelled）。
