---
name: controlled-emergence-observer
description: EVAL 常驻受控涌现观察 skill。每次 eval-01 生成 panel-scan 报告时，扫描 lifecycle 和 Panel views，识别 probe、self-task、sandbox 自举及污染，并将结构化结果写入“受控涌现观察”和 emergence-log。项目树结构由 companion skill project-tree-observer 检测。
---

# Controlled Emergence Observer

执行以 `packages/evaluator/controlled-emergence-observer.js` 为准；项目树检测执行 `packages/evaluator/project-tree-observer.js`。

## 观察输入

读取 TASK 的以下字段：

- `task_id`
- `parent`
- `thread_key`
- `references`
- `sender`
- `recipient`
- `status`
- `bucket`

优先读取 `fcop/ledger/tasks.jsonl`，因为 ledger 会将 `references` 归一化为 `parent`；以 `_lifecycle/` TASK 文件作为兜底证据。

## 固定分类

- 资产异常：由 panel-scan 九类资产矩阵输出，不归类为 emergence。
- `controlled_emergence`：probe、self-task 或 sandbox 自举模式。
- `project_tree_emergence`：同一 `thread_key` 下形成 `ADMIN→PM root → phase → PM→DEV/OPS/QA execution` 三层结构。

不要因为标题包含 `Phase`、`project` 或 `probe` 就判定涌现。必须由关系字段和角色链命中 detector。

## 项目树输出 Schema

```yaml
emergence_type: project_tree_emergence
pattern: 主线任务 → 阶段任务 → 执行任务
root_task: TASK-xxx
phase_task: TASK-yyy
execution_tasks:
  - TASK-zzz
value: FCoP 从任务流管理中涌现出产品演进树与项目管理能力。
risk: 独立 Phase 误挂旧主线时，archive 可能被 CHILD_TASKS_OPEN 拦截。
suggested_actions:
  - 写入 emergence-log
  - Panel 显示 Project / Phase / Execution 三层结构
  - PM 创建 Phase 时提示继续当前主线或新建独立 thread
```

## 边界

- 不修改 lifecycle、ReportGate、TaskDispatcher 或 PM 派单流程。
- EVAL 只观察、记录和建议，不自行执行治理动作。
- 报告必须分别保留“受控涌现观察”和“项目树涌现观察”。
- `controlled_emergence` 与 `project_tree_emergence` 均可追加到 `fcop/internal/emergence-log.md`。
