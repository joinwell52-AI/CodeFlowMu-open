---
id: FCoP-ADOPTED-0002
title: Fixed Work Folders and Ledger Work Ledger
status: adopted
current_protocol: 3.2.5
runtime_effective: true
loaded_by_runtime: true
adopted_by:
  - CodeFlowMu
scope:
  - layout
  - ledger
  - join
  - tasks
  - reports
  - issues
  - attachments
  - lifecycle
  - wake-nudge
authority: ADMIN
created_at: 2026-05-31
updated_at: 2026-06-01
stability: confirmed
can_be_modified: true
agent_must_follow: true
pm_must_follow: true
supersedes: none
related:
  - fcop/adopted/pending/0001-lifecycle-authority-review-done-archive.md
---

# FCoP-ADOPTED-0002：固定工作文件夹 + Ledger 工作账本

## 0. 文档定位

本文是 **CodeFlowMu 已采用（adopted）** 的协议补充条款，编号 **0002**：

- **固定工作文件夹** — Agent 日常读写的协作面（`tasks/`、`reports/`、`issues/`、`ledger/`、`attachments/`）
- **Ledger 工作账本** — 由 Runtime 从磁盘 IPC 文件扫描、聚合出的只读索引与角色视图

**不修改** bundled FCoP 正式规则（当前 **3.2.5**）；**不修改** `D:\FCoP` 上游包。

与 `fcop/adopted/pending/0001-…` 正交：0001 定义 `_lifecycle/` 状态语义与权责；**0002 定义目录双轨、并轨（Join）与 Agent 入口**。

## 1. 核心原则：双轨目录

CodeFlowMu 在 FCoP 3.x 之上采用 **双轨** 布局：

| 轨道 | 路径 | 谁维护 | Agent 怎么用 |
|---|---|---|---|
| **工作文件夹** | `fcop/tasks/`、`fcop/reports/`、`fcop/issues/`、`fcop/ledger/`、`fcop/attachments/` | Agent 通过 MCP / 写文件协作；ledger 视图由 Runtime 重建；附件按日落盘 | **主入口**：读 TASK/REPORT/ISSUE；读 `ledger/views/*.md` 定位待办；图片写 `attachments[]` |
| **生命周期桶** | `fcop/_lifecycle/{inbox,active,review,done,archive}/` | **仅** Runtime / `LifecycleKernel` | **不得**当作主工作入口；不得自行 `mv` / `claim` / `submit` / `archive` 冒充已执行 |

> **第一真相仍在文件**：TASK / REPORT / ISSUE 是 IPC 正文；ledger 是**派生索引**，便于 Agent 少扫盘、少漏单。

### 1.1 并轨（Join）语义

**双轨**描述的是**进行中**的布局：工作面（`tasks/` / `reports/` / `issues/`）、生命周期面（`_lifecycle/`）、派生索引（`ledger/`）**同时存在**，各自有权威域，短期可呈现不同「舱位」——例如支线 TASK 长期留在 `tasks/`，主线 TASK 已在 `_lifecycle/done/`，REVIEW 语义落在 REPORT 或 REVIEW 文件，面板 `scope` 来自 ledger 投影。**这不矛盾**，只要各层权威边界清晰。

**并轨（Join）**描述的是**收敛动作**：在某一触发点，Runtime 把磁盘上的 IPC + `_lifecycle/` 位置 + `ledger/*.jsonl` **对齐到同一套事实**，消除漂移。并轨**不是**第四轨；它是双轨结束前的**强制同步**或**封存后的索引剔除**。

#### 权威顺序（冲突时）

当 ledger、面板投影与磁盘不一致时，按以下顺序取真相：

1. **`_lifecycle/` 内 TASK 的物理路径**（inbox / active / review / done / archive）
2. **YAML `state` 与 `transitions`**（0001）
3. **`tasks/` / `reports/` / `issues/` 内 IPC 正文**
4. **`fcop/ledger/*.jsonl` 事实行**（派生，可 stale）
5. **面板 / API 的 `scope` 投影**（只读展示，不得反写磁盘）

> **反例（禁止当作 archive）**：ledger 中 `bucket: archive` 但 TASK 文件仍在 `_lifecycle/done/` —— 以磁盘路径为准，必须触发 J1 重建 ledger，**不得**把整线线程投影进「归档舱」。

#### 并轨触发器 J1–J5

| ID | 触发 | 动作 | 并轨强度 |
|---|---|---|---|
| **J1** | `LedgerBuilder.rebuild()` / `ensureLedgerFresh({ rebuild: true })` | 全量扫描 `tasks/`、`reports/`、`_lifecycle/` → 重写 `ledger/*.jsonl` 与 `views/` | 索引并轨 |
| **J2** | `write_report` + `ReportResolver.reconcileThreadSettlement` | 更新 `threads.jsonl` 的 `pending_pm_review` / `waiting_pm_consolidation` 等 | 软并轨（thread 级） |
| **J3** | 生命周期 syscall：`submit_review` / `reject_review` / `reopen_task` | Runtime MV + YAML `transitions`；**成功后必须 J1** | 硬并轨（单 TASK 路径） |
| **J4** | `approve_review` / `finish_task` → `done` | TASK 必须在 `_lifecycle/done/`；**成功后必须 J1** | 硬并轨 |
| **J5** | `archive_task` | TASK 必须在 `_lifecycle/archive/`，`frozen: true`（0001）；**成功后必须 J1** | **封存并轨 — 双轨对该 TASK 结束** |

**Runtime 义务**：J3 / J4 / J5  syscall 返回 `ok` 后，Shell / Runtime **必须**调用 J1（`reconcileLedgerAfterJoin`），不得依赖面板 TTL 懒刷新。

#### J5 · Archive = 双轨结束

对**已执行 `archive_task` 的主线 TASK**：

- 文件**只**允许位于 `fcop/_lifecycle/archive/`（0001：`archive` = 最终封存，不可修改、不可打回）。
- **双轨协作对该 TASK 终止**：不再参与 inbox/active/review/done 流转；Agent 不得再对其 `write_task` 派生、不得 `reopen`（除非 ADMIN 显式走协议外人工流程，且不得伪造 syscall 结果）。
- ledger 热索引中该 TASK 的 `bucket` **必须**与磁盘 `archive/` 路径一致；若不一致，视为 **stale**，J1 强制修复。

支线 TASK 可继续留在 `fcop/tasks/` 供历史引用；**是否**随主线一并 deep-archive 由 PM / ADMIN 按 thread 策略决定，但 **J5 只封存 `_lifecycle/` 内被 archive 的那一份 TASK 文件**。

#### 深度归档（history）与热账本

`archive_to_history`（`fcop/history/YYYY-MM-DD/`）在 J5 之后可选执行：

1. 将 `_lifecycle/archive/` 内成对的 TASK+REPORT（及关联 REVIEW）移入 `fcop/history/` 日期桶。
2. **再次 J1**：`LedgerBuilder` **不扫描** `fcop/history/`，热 ledger 中对应行**剔除**——面板「归档舱」展示的是**仍在热路径**的 archive 桶任务，不是 history 冷存储。

**最终态（单 thread 闭环）**：IPC 成对落盘 → lifecycle 到达 `archive/` →（可选）history 深归档 → 热 ledger 无该 thread 活跃行 → 双轨对该 thread **完全结束**。

#### 与 0001 的分工

| 概念 | 0001 | 0002 |
|---|---|---|
| `done` / `archive` 语义、`frozen`、YAML | ✓ | 引用 |
| 双轨目录、ledger 扫描范围 | 引用 | ✓ |
| **并轨 J1–J5、archive 结束双轨** | — | ✓ |

## 2. `fcop init` 必须生成的目录

项目初始化（`init_project` / `init_solo` / CodeFlowMu `ensureLedgerLayout` / Desktop `init_project_dirs`）**必须** idempotent 创建以下路径（相对项目根）：

```
fcop/
├── tasks/
├── reports/
├── issues/
├── attachments/
│   └── YYYYMMDD/
├── ledger/
│   └── views/
└── _lifecycle/
    ├── inbox/
    ├── active/
    ├── review/
    ├── done/
    └── archive/
```

**最低保证：**

- 上述目录存在（可空）。
- `fcop/ledger/tasks.jsonl`、`reports.jsonl`、`threads.jsonl` 存在（可空文件）。
- `fcop/ledger/views/` 下角色视图占位存在（由 `LedgerBuilder.rebuild()` 刷新内容）。

其它 `fcop/` 子目录（如 `shared/`、`internal/`、`history/`）仍按 FCoP 与项目模板约定，**不在 0002 强制清单内**。

## 3. Agent 看什么

Agent **默认从工作文件夹 + ledger 读**，而不是从 `_lifecycle/` 猜待办：

| 角色 | 首选入口 | 补充 |
|---|---|---|
| **PM** | `fcop/ledger/views/PM.todo.md` | open tasks + `pending_pm_review` |
| **OPS / DEV / QA** | `fcop/ledger/views/{ROLE}.todo.md` | 按 recipient 过滤 |
| **ADMIN** | `fcop/ledger/views/ADMIN.inbox.md`、`ADMIN.review.md` | 主线收件与待验收 |
| **全员** | `fcop/tasks/`、`fcop/reports/`、`fcop/issues/` | 读到 TASK 正文后再执行 |
| **索引** | `fcop/ledger/tasks.jsonl`、`reports.jsonl`、`threads.jsonl` | 机器可读事实行 |

**禁止口径：**

- 不得声称「已自行把 TASK 移入 `active/review/done/archive`」——生命周期 MV 归 Runtime。
- 不得仅扫 `_lifecycle/inbox/` 替代 PM 的 ledger-first 入口（见 `fcop/shared/TEAM-OPERATING-RULES.md` §1.5）。

## 4. Ledger 工作账本

### 4.1 职责

Ledger 是 **工作账本（work ledger）**：

1. **扫描** — 从 `fcop/tasks/`、`fcop/reports/`、`fcop/issues/` 及 `_lifecycle/` 各 stage 收集 TASK/REPORT 元数据（frontmatter + 路径）。
2. **记账** — 追加/重写 `fcop/ledger/*.jsonl` 事实行（task / report / thread 记录）。
3. **出视图** — 生成 `fcop/ledger/views/*.md` 供人类与 Agent 首读。

### 4.2 JSONL 文件

| 文件 | 内容 |
|---|---|
| `tasks.jsonl` | 每条 TASK 的 `task_id`、路径、`bucket`、`thread_key`、`sender`/`recipient` 等 |
| `reports.jsonl` | 每条 REPORT 的 `report_id`、关联 `task_id`、`status`、路径等 |
| `threads.jsonl` | 按 `thread_key` 聚合的 `task_ids`、`report_ids`、`pending_pm_review` |
| `journal.jsonl`（可选） | Runtime 催办 / wake 审计行；**不**替代 TASK / REPORT |

Ledger **不替代** REPORT；缺少 REPORT 时 thread 可标记 pending，但验收仍以 REPORT 文件为准（0001）。

### 4.3 视图文件（`ledger/views/`）

| 视图 | 受众 | 用途 |
|---|---|---|
| `PM.todo.md` | PM | 待处理 TASK + 待审 REPORT 列表 |
| `OPS.todo.md` / `DEV.todo.md` / `QA.todo.md` | 执行角色 | 发给自己的 open TASK |
| `ADMIN.inbox.md` | ADMIN | 新进/待 PM 处理的主线 |
| `ADMIN.review.md` | ADMIN | 待 ADMIN 验收的 review 项 |

视图带 `_generated` 时间戳；内容 stale 时 Runtime 或 `LedgerBuilder.rebuild()` 刷新。

## 催办 / Wake-Nudge

**催办不是重新派单**——不生成新的 TASK，也不生成 REPORT。

催办定义为 Runtime / Shell 调用：

```
wake_agent(role, task_id, reason="nudge")
```

被唤醒的 Agent **必须**先读取：

- `fcop/ledger/views/{ROLE}.todo.md`
- 原 TASK（`task_id` 对应文件）
- 相关 REPORT（同 `thread_key` / `parent` / `task_id` 链路）

然后 **继续执行** 既有工作，或 **补写** 缺失的 REPORT（仍走正常 `write_report`，不是催办本身产出的文件）。

**Runtime 边界：**

- 可选追加一行 `fcop/ledger/journal.jsonl`（催办时间、`role`、`task_id`、`reason` 等），供审计与排障。
- **不得**因催办修改 `fcop/_lifecycle/`（无 claim / submit / archive MV）。
- **不得**因催办调用 `write_task` 或重复派单。

## 5. `_lifecycle/` 与 LifecycleKernel

`fcop/_lifecycle/` 表示 **Runtime 管辖的生命周期状态**（与 FCoP 3.x 一致）：

```
inbox → active → review → done → archive
```

- **唯一 MV 权威**：`LifecycleKernel` / `LifecycleStateMachine`（及 Shell 调度的等价 syscall）。
- Agent 通过 MCP 表达的 `submit_review`、`approve_review`、`archive_task` 等，由 Runtime **代为**在 `_lifecycle/` 上移动文件并写 YAML `transitions`（见 0001）。
- Agent **不得**用 shell `mv`、IDE 拖拽或手写路径变更 `_lifecycle/` 内 TASK 位置。

支线 TASK（`fcop/tasks/TASK-*-PM-to-OPS.md` 等）可长期留在 `tasks/`；主线 ADMIN→PM TASK 可在 `_lifecycle/` 与 ledger 中同时可见——**ledger 统一索引，lifecycle 管状态 MV**。

## 6. 与 FCoP 3.x 五桶 / `_lifecycle` 的关系

FCoP 3.2.x bundled 规则以 `fcop/_lifecycle/` 为 v3 协调主拓扑。CodeFlowMu **0002** 额外固定：

- **`fcop/tasks/`、`reports/`、`issues/`** — 保留 v2 式 Agent 工作面，兼容 PM 派单、ReportWatcher、MCP `list_tasks` 扫描习惯。
- **`fcop/ledger/`** — CodeFlowMu 扩展，非 bundled FCoP 强制桶。

二者并存：**Agent 协作写 tasks/reports/issues；Runtime 维护 lifecycle + ledger 索引**。

## 7. 实现锚点（CodeFlowMu 仓库内）

| 能力 | 位置 |
|---|---|
| init 落盘 | `fcop_sdk/ledger_layout.py` · `ensure_ledger_layout()` |
| init 落盘 | `packages/codeflowmu-runtime/src/ledger/paths.ts` · `ensureLedgerLayout()` |
| 账本重建 | `packages/codeflowmu-runtime/src/ledger/LedgerBuilder.ts` |
| 并轨 J1（syscall 后） | `codeflowmu-shell/src/ledger-api-helpers.ts` · `reconcileLedgerAfterJoin()` |
| ledger bucket 与磁盘对齐 | `codeflowmu-shell/src/ledger-api-helpers.ts` · `effectiveLedgerTaskBucket()` |
| 生命周期 MV | `packages/codeflowmu-runtime/src/lifecycle/LifecycleKernel.ts` |
| 生命周期 syscall 收尾 | `codeflowmu-shell/src/lifecycle-runtime-bridge.ts` · J3/J4/J5 后 J1 |
| hot-path J5 archive | `packages/codeflowmu-runtime/src/ledger/hotPathTaskLifecycle.ts` · `archiveHotPathTask()` |
| 面板 thread scope 投影 | `codeflowmu-desktop/panel/home-reactor.js` · `rebuildThreadScopeProjection()` |
| Agent 首读注入 | `codeflowmu-shell/src/web-panel.ts` · `buildDirectSessionPrompt()` |
| 催办 wake | `codeflowmu-shell/src/web-panel.ts` · `POST /api/v2/sessions/wake`（`reason=nudge`） |
| HTTP 视图 | `GET /api/v2/ledger/views/:role` |

## 8. 验收清单

- [ ] 新项目 `fcop init` 后 §2 目录树全部存在。
- [ ] Agent prompt 首条指向 `fcop/ledger/views/{ROLE}.todo.md`（PM 为 `PM.todo.md`）。
- [ ] `LedgerBuilder.rebuild()` 后 JSONL 与 views 与磁盘 TASK/REPORT 一致。
- [ ] J3/J4/J5 syscall 成功后热 ledger 与 `_lifecycle/` 路径一致（§1.1 J1 义务）。
- [ ] ledger `bucket: archive` 仅当 TASK 物理路径含 `/_lifecycle/archive/`；否则 rebuild 修正。
- [ ] `archive_task`（J5）后该 TASK 双轨结束；可选 `archive_to_history` 后热 ledger 无对应行。
- [ ] **hot-path J5**：已 `review_status: approved` 的 TASK 仍在 `fcop/tasks/` 时，`POST .../archive` 成功移入 `fcop/_lifecycle/archive/` 且 frontmatter 含 `frozen: true`（集成测试 WP-22）。
- [ ] 无 Agent 直接 `mv` `_lifecycle/` 下 TASK 的合规路径（违规应被 Kernel / 审计拦截或 WARN）。

## 9. 最终规则（摘要）

1. **0002 = 固定工作文件夹 + ledger 工作账本 + 并轨（Join）语义。**
2. **`fcop init` 必须生成** §2 所列目录与 ledger 骨架。
3. 图片附件统一落盘到 `fcop/attachments/YYYYMMDD/`（按自然日分桶）。
4. TASK / REPORT frontmatter 必须使用 `attachments[]` 引用附件（优先 `local_path`）。
5. Markdown 正文插入相对路径图片引用（由工具函数按文件位置自动计算，禁止手写硬编码）。
6. **禁止**在正文或 frontmatter 写入 base64 / 二进制内嵌图片。
7. **Agent 看** `tasks/`、`reports/`、`issues/`、`ledger/`（含 `views/`）。
8. **`_lifecycle/` 由 Runtime / LifecycleKernel 管**；Agent 不直 MV、不以其为主入口。
9. Ledger 是派生索引，IPC 文件仍是协议正文；与 0001 生命周期语义一并生效。
10. **催办（nudge）** 只 `wake_agent`，不新 TASK、不新 REPORT、不改 `_lifecycle`；Agent 读 ledger 视图 + 原 TASK/REPORT 后继续或补写 REPORT。
11. **并轨 J1–J5**（§1.1）：syscall 后必须 J1；**J5 archive = 双轨对该 TASK 结束**；history 深归档后热 ledger 剔除。

## 10. CodeFlowMu 操作手册（PM / ADMIN）

本节是 §1.1 并轨机制在**日常操作**中的落地说明；团队运行规则见 `fcop/shared/TEAM-OPERATING-RULES.md` §8.1。

### 10.1 角色分工

| 角色 | 日常入口 | 生命周期动作 |
|---|---|---|
| **DEV / OPS** | `fcop/tasks/`、`fcop/ledger/views/{ROLE}.todo.md` | 写 REPORT；`submit_review`（syscall） |
| **PM** | 同上 + 面板 | `approve_review` / `reject_review`；**archive_task**（J5） |
| **ADMIN** | 全项目 | 初始化、深度归档、`archive_authority` 为 ADMIN 时的 J5 |
| **Agent（通用）** | tasks / reports / ledger views | **不得**直 MV `_lifecycle/` |

### 10.2 主线闭环 → 归档（推荐顺序）

```
派单 (tasks/) → 执行 → write_report → submit_review (J3)
    → PM approve (J4, done 语义) → PM archive (J5) → [可选] history 深归档
```

每一步 syscall 成功后 Runtime **自动 J1**；面板 scope 以磁盘路径为准（`effectiveLedgerTaskBucket`）。

### 10.3 面板「归档」按钮

**面板操作（PM）**

1. 打开 CodeFlowMu 桌面面板 → 选中线程 / 任务卡片 → 进入详情。
2. 确认状态为 **已验收**（`review_status: approved` 或面板显示「待归档」）；子任务 settlement 未满足时按钮会禁用。
3. 点击 **「归档」**，在弹窗中填写 **归档理由**（必填，写入 TASK `archive_reason`）。
4. 成功后任务从热列表消失或进入「已归档」视图；磁盘上 TASK 位于 `fcop/_lifecycle/archive/`。

**API（与面板等价）**

- 路径：`POST /api/v2/tasks/{task_id}/archive`
- Body：`{ "actor": "PM", "reason": "验收通过，主线封存" }`
- 成功响应：`{ "ok": true, "to": "archive", ... }`

示例（Shell 默认端口 3847，按实际配置调整）：

```bash
curl -s -X POST "http://127.0.0.1:3847/api/v2/tasks/TASK-20260601-002-PM-to-OPS/archive" \
  -H "Content-Type: application/json" \
  -d "{\"actor\":\"PM\",\"reason\":\"验收通过，主线封存\"}"
```

**两条物理路径（J5 语义相同）**

| TASK 当前位置 | 前置条件 | 归档后 |
|---|---|---|
| `fcop/_lifecycle/done/` | lifecycle 轨已 finish/approve | → `_lifecycle/archive/` + `frozen: true` |
| **`fcop/tasks/`（hot-path）** | frontmatter 已 `review_status: approved` 或 `lifecycle_projection: done` | → `_lifecycle/archive/` + `frozen: true` |

hot-path 适用于：Agent 在 `tasks/` 写 IPC、PM 在面板验收但未走 `_lifecycle/` MV 的支线。**2026-06-01 起** Runtime 通过 `archiveHotPathTask()` 支持，不再返回 `task not found`。

**失败常见原因**

| 现象 / 响应 | 处理 |
|---|---|
| `task not found` | 核对 `task_id`；查 `fcop/tasks/` 与 `_lifecycle/{inbox,active,review,done,archive}/` 是否仍存在该文件 |
| `expected state done` | lifecycle 轨 TASK 不在 `done/`；先 **approve**（J4） |
| hot-path 未 approved | 在面板 **通过验收** 或 patch frontmatter 后再归档 |
| `authority` / 403 | 操作者须匹配 TASK `archive_authority`（默认 PM） |
| 缺少 `reason` | Body 必须带非空 `reason` |

### 10.4 Agent 硬约束（违反 = 协议违规）

1. **不得**用 shell / IDE 把 TASK 移入或移出 `_lifecycle/` 各桶。
2. **不得**伪造 `frozen` / `state: archive` 而不经 syscall。
3. 读待办优先 **`fcop/ledger/views/{ROLE}.todo.md`**，正文仍以 IPC 文件为准。
4. 归档后的 TASK：**不得**再派生子 TASK、不得 `reopen`（除非 ADMIN 走协议外人工流程，且不得伪造 syscall 结果）。

### 10.5 深度归档（history）

J5 之后可选：

1. 面板或 `POST /api/v2/archive/to-history` 将 `_lifecycle/archive/` 内**昨日及更早**成对 TASK+REPORT 移入 `fcop/history/YYYY-MM-DD/`。
2. 再次 **J1**：热 ledger **不扫描** `fcop/history/`，对应 thread 从面板热视图剔除。

### 10.6 归档后自检（PM / ADMIN）

归档 syscall 成功后，建议核对以下三项（**以磁盘为准**，ledger 为派生索引）：

1. **物理路径**：`fcop/_lifecycle/archive/TASK-*.md` 存在；`fcop/tasks/` 与 `_lifecycle/done/` 中**不再**有同名文件。
2. **frontmatter**：`frozen: true`；含 `archived_at` / `archived_by` / `archive_reason`（或等价字段）。
3. **ledger**：触发 J1 后 `fcop/ledger/tasks.jsonl` 中该 `task_id` 的 `bucket` 为 `archive`；面板 thread scope 不再将其计为 active/done。

若 ledger 仍显示旧 bucket 而磁盘已在 `archive/`：在面板触发一次刷新或调用 ledger rebuild（J1），**不要**手工改 JSONL。
