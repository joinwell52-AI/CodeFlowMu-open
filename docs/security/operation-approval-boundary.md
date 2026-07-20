# CodeFlowMu 操作审批边界与入口清单

版本：V1.1.18  
日期：2026-07-14  
范围：`D:\codeflowmu` 母版受控入口

## 1. 产品边界

全局“审批”只承载 AI 在动作发生前申请的五类临时权限：破坏性操作、外部写入与通信、发布与生产、凭据/权限/安全、Runtime/审批/权限边界变更。

TASK、REPORT、REVIEW、事实核查、EVAL、技术故障和事后知悉不进入操作审批。`high_cost` 在 V1.1.18 只是观察字段，没有额度模型，不创建审批，也不阻断普通执行。

普通、可逆、本地编程默认允许。用户在可信前台对确定目标和影响完成即时二次确认后，只授权该次前台操作，不再生成重复审批卡。

## 2. 授权矩阵

| 发起者与操作 | 决定 | 授权方式 |
| --- | --- | --- |
| AI 在活动项目内进行普通 patch、构建、测试、本地 commit | ALLOW | 任务默认权限 |
| AI 精确执行 `git push [-u] origin <branch>` | REQUIRE_APPROVAL | 操作摘要绑定的一次性令牌 |
| AI 使用强推、复合 push 或无法确定目标的 push | DENY | 不可通过模糊审批放行 |
| AI 调用尚未迁移的生产、安全、外部写、破坏性原生命令 | DENY | 先实现受控执行器再开放 |
| 用户在 Panel 的确定清理、凭据、发布、迁移等入口操作 | ALLOW（确认后） | 原入口可信前台即时确认凭据 |
| REVIEW/事实核查/EVAL | ALLOW（任务平面） | 各自生命周期或事实核查接口 |

## 3. 受控入口清单

| 入口 | 类型 | V1.1.18 状态 | 批准/确认前程序效果 |
| --- | --- | --- | --- |
| `POST /api/v2/git/push` | 外部写入 | 已迁移 | 只读预检并写审批，`executed=false`，不触碰远端 |
| Cursor SDK 原生精确 Git push | 外部写入 | 已迁移 | 在 `tool_call:running` 阶段取消调用并写审批 |
| `git.push` 受控执行器 | 外部写入 | 已迁移 | 校验一次性令牌与最新 SHA 后只推送绑定分支 |
| Review 决策策略保存 | 治理边界 | 已迁移 | Prepare 不保存；令牌消费后才写策略 |
| 干净初始化、Runtime 清理、工作区迁移 | 破坏性 | 用户前台确认 | 取消确认后目标文件不变 |
| API 密钥、Browser/Windows Use 安全设置、Git remote | 安全/权限 | 用户前台确认 | 取消确认后配置不变；确认摘要不显示秘密值 |
| 开源同步、版本调整、发布推送 | 发布/外部写 | 用户前台确认 | 取消确认后不构建、不写版本、不推送 |
| `gh pr merge`、`gh ... comment/create` | 外部写入 | 默认阻断 | 无受控适配器，不执行、不生成死审批卡 |
| `kubectl/helm/terraform` 写操作、`npm publish`、`docker push` | 生产发布 | 默认阻断 | 无受控适配器，不执行 |
| `chmod/chown/icacls/takeown`、Git remote 变更 | 安全/权限 | 默认阻断 | 无受控适配器，不执行 |
| `git reset --hard`、危险 `git clean`、格式化磁盘 | 破坏性 | 默认阻断 | 无受控适配器，不执行 |
| 运行时审批核心、角色工具策略等生效代码 | 治理边界 | 默认阻断 | 原生 Agent 直接修改被拒；测试文件不受影响 |

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
