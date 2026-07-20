---
id: FCoP-PENDING-0001
title: Lifecycle Authority, Review, Done and Archive Semantics
status: adopted-pending-release
current_protocol: 3.2.5
target_version: 3.2.6
runtime_effective: true
loaded_by_runtime: true
adopted_by:
  - CodeFlowMu
scope:
  - lifecycle
  - authority
  - review
  - done
  - archive
  - yaml-transitions
authority: ADMIN
created_at: 2026-05-30
updated_at: 2026-05-30
stability: experimental-confirmed
can_be_modified: true
can_be_withdrawn: true
agent_must_follow: true
pm_must_follow: true
admin_review_required_for_release: true
---

# FCoP-PENDING-0001：生命周期权责、Review / Done / Archive 语义与 YAML 状态记录

## 0. 文档定位

本文**不是** FCoP 3.2.6 正式发布内容。

本文是 FCoP 3.2.5 运行中的第一条 **adopted-pending** 补充条款：

- **已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版**
- Agent、PM、ADMIN **现在就要遵守**
- 未来可修改、合并或撤回

在运行时，本文等同于协议补充规则。

正式 FCoP bundled 规则版本号不变（当前 **3.2.5**）；是否并入正式版（计划字段 `target_version: 3.2.6` 或后续版本）由 **ADMIN 决定**。

## 1. 生命周期状态语义

FCoP 生命周期目录表示任务当前状态。

| 目录 | 语义 |
|---|---|
| `inbox` | 待认领 |
| `active` | 正在执行 / 派发 / 跟踪 |
| `review` | 已提交 REPORT，等待上级验收 |
| `done` | 上级验收通过，但尚未封存；可被授权上级重开 |
| `archive` | 最终封存，不可修改，不可打回 |

- **文件位置**是当前状态的第一真相。
- YAML frontmatter **必须**同步记录当前状态快照。
- YAML `transitions` **必须**记录每一次状态变化。

## 2. 主线与支线

FCoP 团队协作分为两类任务线。

### 2.1 主线：ADMIN ↔ PM

主线任务格式：`TASK-*-ADMIN-to-PM.md`

主线责任链：

1. ADMIN 创建 TASK
2. PM 认领
3. PM 执行 / 拆分 / 跟踪
4. PM 写 REPORT 给 ADMIN
5. ADMIN 验收
6. ADMIN 决定 done / archive

**默认规则：**

- PM 可以 `claim` / `execute` / `delegate` / `write_report` / `submit_review`
- PM **默认不得**将主线任务推进 `done`
- PM **默认不得** `archive` 主线任务
- ADMIN **默认**拥有主线 `done_authority`
- ADMIN **默认**拥有主线 `archive_authority`

### 2.2 支线：PM ↔ DEV / QA / OPS

支线任务格式：`TASK-*-PM-to-DEV.md` / `TASK-*-PM-to-QA.md` / `TASK-*-PM-to-OPS.md`

支线责任链：

1. PM 创建子 TASK
2. Agent 认领
3. Agent 执行
4. Agent 写 REPORT 给 PM
5. PM 验收
6. PM 决定 done / archive

**默认规则：**

- Agent 可以 `claim` / `execute` / `write_report` / `submit_review`
- Agent **不得**将自己的任务推进 `done`
- Agent **不得** `archive` 自己的任务
- PM **默认**拥有支线 `done_authority`
- PM **默认**拥有支线 `archive_authority`

## 3. Review 语义

`review` 是**验收门**，不是装饰状态。

进入 `review` 的条件：

1. 已有正式 REPORT
2. REPORT `references` 当前 TASK
3. REPORT 包含执行结果
4. REPORT 包含证据
5. REPORT 说明未完成项 / 阻塞项
6. 执行者声明 `ready_for_review`

执行者完成工作后，**不应**直接将任务推进 `done`。

正确流程：`active → review`

## 4. Done 语义

`done` 表示：**上级验收通过**——不是执行者自己说完成。

因此：

- OPS 写 REPORT 后 → `review`，不是 `done`
- PM 写 REPORT 后 → `review`，不是 `done`
- PM 验收 OPS 后 → OPS 支线任务可进入 `done`
- ADMIN 验收 PM 后 → PM 主线任务可进入 `done`

`done` 可以被授权上级重开。允许：`done → active`

条件：

1. 验收后发现遗漏
2. 产物失效
3. 新证据证明 done 不成立
4. 上级明确要求重开
5. ADMIN 对 PM done 的授权撤销或重开指令

### 5. delegated_done（低风险主线授权）

为了降低 ADMIN 工作量，ADMIN 可以显式授权 PM 对**低风险**主线任务执行 done 判断，但必须写入 TASK YAML。

示例：

```yaml
delegated_done: true
delegated_by: ADMIN
delegation_scope: routine_inspection
risk_level: low
reviewer: PM
done_authority: PM
archive_authority: ADMIN
```

**可授权 PM done 的任务类型：** 例行巡检、信息收集、状态统计、低风险环境检查、无代码修改、无生产变更、无权限变更、无安全影响、无费用影响。

**不得授权 PM done 的任务类型：** 代码修改、协议修改、发布上线、生产运维、删除/迁移文件、权限变更、安全相关、成本相关、数据影响、高风险架构调整。

**重要规则：** `delegated_done` **不等于** archive 授权。PM 被授权 done，也**不自动**获得主线 archive 权限。

## 6. Archive 语义

`archive` 是**最终封存**。

进入 `archive` 的前提：

1. 当前 state 必须是 `done`
2. actor 必须拥有 `archive_authority`
3. 没有 open ISSUE
4. 没有 pending review
5. 没有 blocker
6. 所有关联 REPORT 已存在
7. 子任务 REPORT 已被吸收
8. YAML `transitions` 完整
9. `archive_reason` 非空

**archive 后：**

- 不可修改
- 不可打回
- 不可继续追加 transitions
- 不可覆盖文件
- 不可移动回 inbox / active / review / done

归档后发现新问题，**不能**修改旧 archive 文件，只能创建新 TASK 引用旧归档任务：

```yaml
related_to:
  - archived_task: TASK-20260530-002-ADMIN-to-PM
reason: "归档后发现新问题，创建后续任务"
```

## 7. YAML transitions 必须记录在案

每一次生命周期变化，都必须写入 TASK YAML 的 `transitions` 数组。

最小格式：

```yaml
transitions:
  - at: 2026-05-30T20:04:27+08:00
    from: active
    to: review
    by: PM
    action: submit_review
    report: REPORT-20260530-002-PM-to-ADMIN.md
    reason: "巡检完成，提交 ADMIN 验收"
```

文件移动与 YAML 更新**必须**保持一致。**禁止**只移动文件而不更新 YAML。

## 8. 主线 YAML 示例

```yaml
---
task_id: TASK-20260530-002-ADMIN-to-PM
kind: task
from: ADMIN
to: PM
line: main
state: review
lifecycle_path: fcop/_lifecycle/review
driver: PM
reviewer: ADMIN
done_authority: ADMIN
archive_authority: ADMIN
current_owner: ADMIN
parent_task:
children:
  - TASK-20260530-003-PM-to-OPS
reports:
  - REPORT-20260530-002-PM-to-ADMIN.md
review_status: pending
delegated_done: false
risk_level: low
frozen: false
reopened_count: 0
transitions:
  - at: 2026-05-30T19:48:00+08:00
    from: null
    to: inbox
    by: ADMIN
    action: create_task
  - at: 2026-05-30T19:48:21+08:00
    from: inbox
    to: active
    by: PM
    action: claim_task
  - at: 2026-05-30T19:50:00+08:00
    from: active
    to: active
    by: PM
    action: create_child_task
    child_task: TASK-20260530-003-PM-to-OPS
  - at: 2026-05-30T20:04:27+08:00
    from: active
    to: review
    by: PM
    action: submit_review
    report: REPORT-20260530-002-PM-to-ADMIN.md
---
```

## 9. 支线 YAML 示例

```yaml
---
task_id: TASK-20260530-003-PM-to-OPS
kind: task
from: PM
to: OPS
line: branch
parent_task: TASK-20260530-002-ADMIN-to-PM
children: []
state: review
lifecycle_path: fcop/_lifecycle/review
driver: OPS
reviewer: PM
done_authority: PM
archive_authority: PM
current_owner: PM
reports:
  - REPORT-20260530-003-OPS-to-PM.md
review_status: pending
frozen: false
reopened_count: 0
transitions:
  - at: 2026-05-30T19:50:00+08:00
    from: null
    to: inbox
    by: PM
    action: create_task
    parent_task: TASK-20260530-002-ADMIN-to-PM
  - at: 2026-05-30T19:51:00+08:00
    from: inbox
    to: active
    by: OPS
    action: claim_task
  - at: 2026-05-30T20:02:00+08:00
    from: active
    to: review
    by: OPS
    action: submit_review
    report: REPORT-20260530-003-OPS-to-PM.md
---
```

## 10. 权限总表

| 任务类型 | 执行者 | REPORT 给谁 | 谁验收 done | 谁 archive |
|---|---|---|---|---|
| ADMIN→PM 主线，默认 | PM | ADMIN | ADMIN | ADMIN |
| ADMIN→PM 主线，低风险授权 | PM | ADMIN | PM | ADMIN |
| PM→DEV 支线 | DEV | PM | PM | PM |
| PM→QA 支线 | QA | PM | PM | PM |
| PM→OPS 支线 | OPS | PM | PM | PM |

## 11. 最终规则

- **review** 是验收门。
- **done** 是上级验收通过。
- **done** 可被授权上级重开。
- **archive** 是最终封存，不可修改、不可打回。
- 主线 ADMIN→PM 默认由 ADMIN done / archive。
- 低风险主线可授权 PM done，但 archive 默认仍由 ADMIN。
- 支线 PM→Agent 默认由 PM done / archive。
- 每次状态变化必须写入 YAML `transitions`。
- archive 文件必须 `frozen: true`。
