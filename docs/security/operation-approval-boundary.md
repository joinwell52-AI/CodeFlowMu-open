# CodeFlowMu 操作审批边界与入口清单

版本：V1.2.10（精确能力 Gate + 二态负面路由 + 独立审批）
日期：2026-08-03
范围：`D:\codeflowmu` 母版受控入口

## 1. 产品边界

全局“审批”承载 AI 在动作发生前由 13 条 `NEG.*` 事实路由出的单次操作请求，包括越界/保护边界/治理绕过/共享状态/不可逆/动态批量/外部副作用/安全权限/Runtime 控制/远端发布/合同变化/效果不透明/并发冲突。

TASK、REPORT、REVIEW、事实核查、EVAL、技术故障和事后知悉不进入操作审批。`high_cost` 仍只是观察字段，没有额度模型，不创建审批，也不阻断普通执行。

普通、可逆、本地编程默认允许。用户在可信前台对确定目标和影响完成即时二次确认后，只授权该次前台操作，不再生成重复审批卡。

长期、可复用的治理意图记录在**指令授权**平面；它说明某类行为在什么范围、有效期和撤销条件下被允许，但不能替代某次高风险执行的一次性审批。完整模型见 [`../design/governance-directive-authorization-approval-v1.md`](../design/governance-directive-authorization-approval-v1.md)。

## 2. 授权矩阵

| 发起者与操作 | 决定 | 授权方式 |
| --- | --- | --- |
| AI 在活动项目内进行普通 patch、构建、测试、本地 commit | ALLOW | 任务默认权限 |
| PM 在当前任务绑定的 `workspace/` 或 `.codeflowmu/scratch/<TASK>/` 生成本地临时材料 | ALLOW | 任务绑定、路径边界和限额 |
| PM 对任务内、明确、可逆且未命中负面项的文件执行写入、建目录、复制、移动或 patch | ALLOW | 精确 OperationFacts + 当前 TASK/thread 绑定 |
| PM 通过 raw shell 修改产品文件 | ALLOW 或 REQUIRE_APPROVAL | Shell 只生成候选事实；命中 `NEG.*` 时先建单，缺执行器为同单 `pending_executor` |
| AI 精确执行 `git push [-u] origin <branch>` | REQUIRE_APPROVAL | 操作摘要绑定的一次性令牌 |
| AI 使用强推、复合 push 或无法确定目标的 push | REQUIRE_APPROVAL | 先建真实审批；审批机制可拒绝当前调用，目标不完整时为 `pending_information` |
| AI 调用尚未迁移的生产、安全、外部写、破坏性原生命令 | REQUIRE_APPROVAL | 先建真实审批；无执行器时为 `pending_executor`，不得伪等待或终止 Session |
| 用户在 Panel 的确定清理、凭据、发布、迁移等入口操作 | ALLOW（确认后） | 原入口可信前台即时确认凭据 |
| REVIEW/事实核查/EVAL | ALLOW（任务平面） | 各自生命周期或事实核查接口 |

## 3. 受控入口清单

| 入口 | 类型 | V1.2.8 状态 | 批准/确认前程序效果 |
| --- | --- | --- | --- |
| `POST /api/v2/git/push` | 外部写入 | 已迁移 | 只读预检并写审批，`executed=false`，不触碰远端 |
| Cursor SDK 原生精确 Git push | 外部写入 | 已迁移 | 在 `tool_call:running` 阶段先建审批、投递 approval_id，再 yield 等待；不取消逻辑 Session |
| `git.push` 受控执行器 | 外部写入 | 已迁移 | 校验一次性令牌与最新 SHA 后只推送绑定分支 |
| `workspace.fs.write` | 有界产品写入 | 已迁移 | 绑定目标、内容哈希、大小、编码、覆盖策略和文件快照 |
| `workspace.fs.mkdir` | 有界目录创建 | 已迁移 | 仅创建规范化后的精确目录 |
| `workspace.fs.copy` / `workspace.fs.move` | 有界文件变化 | 已迁移 | 绑定源、目标、真实路径和批准前快照 |
| `workspace.patch.apply` | 有界补丁 | 已迁移 | 绑定 patch 哈希、允许路径、Git HEAD 与文件哈希；先 `git apply --check` |
| `workspace.scratch.*` | 任务临时材料 | 已迁移 | 当前 PM Session/TASK 内、原子写入、限额、拒绝穿越与 symlink |
| Review 决策策略保存 | 治理边界 | 已迁移 | Prepare 不保存；令牌消费后才写策略 |
| 干净初始化、Runtime 清理、工作区迁移 | 破坏性 | 用户前台确认 | 取消确认后目标文件不变 |
| API 密钥、Browser/Windows Use 安全设置、Git remote | 安全/权限 | 用户前台确认 | 取消确认后配置不变；确认摘要不显示秘密值 |
| 开源同步、版本调整、发布推送 | 发布/外部写 | 用户前台确认 | 取消确认后不构建、不写版本、不推送 |
| `gh pr merge`、`gh ... comment/create` | 外部写入 | 送审 | 创建可见审批；无受控适配器时停在 `pending_executor` |
| `kubectl/helm/terraform` 写操作、`npm publish`、`docker push` | 生产发布 | 送审 | 创建可见审批；审批机制独立判断并要求精确执行器 |
| `chmod/chown/icacls/takeown`、Git remote 变更 | 安全/权限 | 送审 | 创建可见审批；批准前不执行 |
| `git reset --hard`、危险 `git clean`、格式化磁盘 | 破坏性 | 送审 | 创建可见审批；不可批准边界由审批机制拒绝当前调用 |
| 运行时审批核心、角色工具策略等生效代码 | 治理边界 | 送审 | 所有命中一次性保留；缺执行器/事实仍先有 approval_id |

CodeFlowMu 不声称能够拦截操作系统中独立于本程序运行的任意进程；保证范围是上述受控入口和 Runtime 提供给 Agent 的工具入口。

## 4. 威胁模型

| 威胁 | 控制 |
| --- | --- |
| 事后补写“批准” | Prepare 与 Execute 分离；批准前执行器不被调用 |
| Agent 伪造用户确认 | 可信前台确认由服务端注入验证器；Agent 构造字段不能通过验证 |
| 批准 A 执行 B | SHA-256 `operation_digest` 覆盖主体、动作、资源、上下文、effect 和快照 |
| 批准后目标变化 | Execute 前重新读取远端/策略快照；摘要变化转 `stale` |
| 令牌重放 | 只存令牌哈希；开始执行时在锁内删除令牌并原子转 `executing` |
| 并发消费 | 每个审批使用排他锁；只有一个执行器能进入 |
| 进程中断 | 记录执行进程 PID；旧进程消失后恢复为 `partial_failed`，不恢复令牌，要求核查目标 |
| 拒绝后循环弹卡 | 相同摘要拒绝后自动重放返回 `APPROVAL_REJECTED_REPLAY` |
| 改命令名绕过 | 判定基于结构化 effect；原生未迁移高风险命令采用确定性默认阻断 |
| 高成本误触发 | `high_cost` 不映射到任何本期审批类型 |
| REVIEW 混入审批 | 全局审批只读取 `.codeflowmu/operation-approvals`；旧 REVIEW ack 已退休 |
| 移动端绕过 | Mobile 使用同一操作审批存储和一次性执行接口；批准/拒绝必须填写理由 |
| 旧角色 Gate 影子否决 | Cursor 与 Google 都先调用同一 `RoleToolCapabilityGate`，只检查 role + exact canonical tool ID + active capability；`RoleToolPolicy` 仅历史只读 |
| 调用者自报 ADMIN 批准 | `pm_implementation_override` / `approved_by` 不再产生授权；正式 lease 必须带 revision、lease ID、内容与作用域摘要 |
| 审批能准备但不能执行 | Prepare、Preview、Recompute、Execute 和 Recovery 来自同一 `ControlledExecutorRegistry` |
| 审批等待被当成失败 | 只有真实 pending approval + 上下文/指纹一致 + Agent notice 已投递才能进入 `waiting_approval`；拒绝、过期、撤销、stale 恢复 prior state 并通知 Agent，不自动 `needs_replan` |

## 5. 存储与审计

- 记录：`.codeflowmu/operation-approvals/records/*.json`
- 审计：`.codeflowmu/operation-approvals/audit.jsonl`
- 令牌：只向批准调用者返回一次，磁盘只存 SHA-256 哈希
- 执行状态与批准状态分离；批准不等于成功
- 拒绝操作审批不调用任务 lifecycle、不会打回 REVIEW、不会修改 REPORT

## 6. 架构回归

`codeflowmu-shell/src/__tests__/operation-approval-architecture.test.ts` 约束：

- 普通 Git push API 只能 Prepare，不能直推；
- 母版中直接 push 只允许存在于用户前台确认的开源发布流程和令牌受控执行器；
- Mobile 审批只读取 `OperationApprovalService`，不得恢复 REVIEW 扫描；
- 高成本字段不得加入本期审批类型常量。

相关动态测试覆盖 Prepare 无副作用、拒绝、过期、摘要变化、并发、令牌重放、进程中断、Desktop/Web/Mobile 和事实核查任务平面。

## 7. 单一决策链与回滚开关

所有 Agent 工具入口只有一个固定顺序：第一层 `role + exact canonical_tool_id + active capability/lease` 返回 `TOOL_ALLOWED` 或 `ROLE_CAPABILITY_DENIED`；第二层对冻结 `OperationFacts` 运行 13 条 `NEG.*`，只返回 `ALLOW` 或 `REQUIRE_APPROVAL`。是否批准、拒绝、补信息或补执行器只由已经持久化的同一审批记录裁决。`CODEFLOWMU_POLICY_BLOCKED`、策略 `DENY` 和 `APPROVAL_ADAPTER_REQUIRED` 只作历史读取兼容。

无损回滚开关：

- `CODEFLOWMU_UNIFIED_OPERATION_POLICY_ENABLED=0`：保留读取，非只读操作安全降级为先建审批；不会恢复旧策略、参数自证或无单等待；
- `CODEFLOWMU_CONTROLLED_EXECUTORS_ENABLED=0`：停止所有受控执行器的 Prepare/Execute，历史审批和审计保留可读；
- `CODEFLOWMU_OPERATION_APPROVAL_RECOVERY_ENABLED=0`：停止决定后的自动任务恢复与唤醒，不删除等待状态或历史记录；
- `CODEFLOWMU_GOVERNANCE_APPROVALS_ENABLED=0`：沿用治理契约已有的正式治理写入开关。

详细调用链、迁移矩阵与回归证据见 [`../design/pm-negative-list-operation-approval-single-decision-v1.md`](../design/pm-negative-list-operation-approval-single-decision-v1.md)。
