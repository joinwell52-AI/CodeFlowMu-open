---
status: adopted-pending-release
id: FCoP-PENDING-0003
title: 任务关系与证据归属 / Task Relations and Evidence Ownership
version: 0003
scope: runtime
effective: pending
runtime_effective: true
target_bundle: next
bilingual: true
languages:
  - zh-CN
  - en-US
---

# FCoP-PENDING-0003 · 任务关系与证据归属 / Task Relations and Evidence Ownership

## 1. 目的 / Purpose

FCoP 核心生命周期保持不变。本条款只补充最小关系字段，用于表达长期任务、后续任务、子任务、报告、观察和问题之间的关系。

FCoP core lifecycle remains unchanged. This rule only adds the minimum relation fields required to trace continued tasks, child tasks, reports, evaluations, and issues.

生命周期仍然是 / The lifecycle remains:

```text
inbox / active / review / done / archive
```

## 2. 非目标 / Non-goals

0003 不定义新目录、workspace 模型、iteration 模型、Git branch / merge / rebase、PM 编排策略、自动恢复策略、自定义数字员工团队、Panel UI 具体布局或新生命周期状态。

0003 does not define new folders, workspace models, iterations, Git-like branches, orchestration strategy, recovery strategy, custom team development, Panel layout, or new lifecycle states.

## 3. TASK 关系字段 / TASK relation fields

TASK 可以包含 / A TASK may contain:

```yaml
thread_key:
parent:
references: []
```

- `thread_key`：同一条任务线，用于分组和展示。
- `parent`：强父子关系，用于生成 Tree 和归档控制。
- `references`：弱引用、承接、参考或历史依据。
- `thread_key`: groups tasks into the same task line.
- `parent`: declares a strong parent-child relation.
- `references`: declares weak continuation, citation, or historical reference.

## 4. REPORT / EVAL / ISSUE 归属字段 / Evidence ownership fields

REPORT、EVAL、ISSUE 可以包含 / REPORT, EVAL, and ISSUE may contain:

```yaml
source_task_id:
references: []
```

- `source_task_id`：表示该证据归属于哪个 TASK。
- `references`：表示引用了哪些相关 TASK / REPORT / EVAL / ISSUE。
- `source_task_id`: points to the TASK this evidence belongs to.
- `references`: points to related TASK / REPORT / EVAL / ISSUE evidence.

## 5. 强关系与弱关系 / Strong and weak relations

只有 `parent` 是强关系。如果某个任务存在未完成子任务：

```yaml
parent: TASK-X
```

则 `TASK-X` 不得归档。`references` 只用于承接、引用和追溯，`thread_key` 只用于同线分组；二者均不得阻止归档。

Only `parent` is a strong relation. If unfinished child tasks exist with `parent: TASK-X`, then `TASK-X` must not be archived. `references` and `thread_key` are weak relations and must not block archive.

## 6. Tree 规则 / Tree rule

任务树只能由 `parent` 推导。Tree 是视图，不是新的事实来源。事实来源仍然是 TASK / REPORT / EVAL / ISSUE 文件及其 frontmatter。

A tree view may only be derived from `parent`. The tree is a view, not a new source of truth. The source of truth remains the files and their frontmatter.

## 7. 接着做规则 / Continuation rule

如果一个新任务是基于旧任务继续、二期、升级或后续开发，应使用 `references`，不得使用 `parent`。

```yaml
thread_key: grid-runner
parent:
references:
  - TASK-20260613-020
```

该任务承接旧任务，但不会重新打开旧任务，也不会阻止旧任务归档。

A continued task must use `references`, not `parent`. The referenced task is not reopened and is not blocked.

## 8. 加到此任务规则 / Child task rule

如果一个新任务是当前未归档任务下的补充、检查、复验或修复任务，应使用 `parent`。

```yaml
thread_key: grid-runner
parent: TASK-20260614-004
references:
  - TASK-20260614-004
```

在该子任务未完成前，父任务不得归档。

A child task must use `parent`. The parent task must not be archived while the child task remains open.

## 9. 归档控制 / Archive control

归档某个任务前，只检查 `parent == 当前任务ID` 且子任务仍处于 `inbox / active / review`。如果存在未完成子任务，应阻止归档并返回 `CHILD_TASKS_OPEN`。禁止因为 `references` 或 `thread_key` 阻止归档。

Before archiving a task, runtime only checks unfinished child tasks where `parent == current task id`. Open children in `inbox / active / review` return `CHILD_TASKS_OPEN`. `references` and `thread_key` must not block archive.

## 10. 兼容规则 / Compatibility

旧任务没有 `parent` 时视为普通顶层任务；没有 `references` 时视为无承接关系；没有 `thread_key` 时 Runtime 可以沿用现有 task/thread 规则兜底。REPORT / EVAL / ISSUE 没有 `source_task_id` 时保持现有展示逻辑，不得影响原有流转。

Missing relation fields must not break existing tasks, reports, evaluations, issues, or lifecycle behavior.

## 11. 最终规则 / Final rules

- 任务树只由 `parent` 推导。
- 未完成子任务阻止父任务归档并返回 `CHILD_TASKS_OPEN`。
- `references` 与 `thread_key` 是弱关系，不阻止归档。
- REPORT / EVAL / ISSUE 使用 `source_task_id` 表达证据归属，缺失时保持兼容。
- Task trees are derived only from `parent`.
- Open child tasks block parent archive with `CHILD_TASKS_OPEN`.
- `references` and `thread_key` never block archive.
- Evidence uses `source_task_id`; missing fields remain backward-compatible.
