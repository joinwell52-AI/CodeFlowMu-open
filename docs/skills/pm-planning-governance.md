# CodeFlowMu 开发团队版 PM 分析、规划与产品设计规范

本规范是 CodeFlowMu 开发团队版叠加在 FCoP 之上的产品交付工作流，不是 FCoP 核心协议规则。不得修改 FCoP 基础协议来要求所有 FCoP 项目采用产品规划流程。

## 标准流程

`ADMIN 发布任务 → Runtime 分类 → PM 完成相应规划 → Runtime 验证 → PM write_task → PM 显式 wake_downstream → DEV/QA/OPS 执行 → PM 汇总真实交付 → ADMIN 验收`

规划产物是派单前置方案，不是最终 `REPORT-*-PM-to-ADMIN.md`。只有下游真实交付、回执与验收完成后，PM 才能提交 `status: done` 的最终报告。

## 规划等级

| 等级 | 适用范围 | 派单前最低产物 |
|---|---|---|
| Level 3 | 新产品、新应用、复杂功能、UI/UX 改版、移动端/PWA、架构调整、大版本升级、跨模块复杂改造 | 完整 Product Brief；产品、范围、流程、交互、视觉、技术、数据、测试与交付计划齐全；按任务要求执行 PM/UI 技能，复杂产品默认校验 8 项 |
| Level 2 | 普通新功能、中等模块修改、API/数据结构调整、有明确影响面的工程改造 | 目标、范围、技术方案、影响面、验收标准、测试数据、交付顺序 |
| Level 1 | 明确小 Bug、小范围文案/样式、单点兼容、配置调整 | 问题现象、根因或待验证假设、修改范围、风险、回归测试 |
| Level 0 | 查询、状态检查、巡检、报告汇总、只读、无实现协调、紧急止损 | 无 Product Brief/PLAN 门禁 |

ADMIN 可在任务 frontmatter 中用 `planning_level: 0..3`、`override_by: ADMIN` 与非空 `override_reason` 调整等级。Panel 必须展示自动分类依据与覆盖状态。

## 规划产物

- Level 3：`fcop/internal/product-briefs/PRODUCT-BRIEF-<主任务ID>.md`
- Level 1/2：`fcop/internal/product-briefs/PLAN-<主任务ID>.md`
- frontmatter 至少包含 `task_id`、`status: ready`、`revision`。

Level 3 至少包含：产品目标、目标用户、问题与价值、功能范围、明确不做什么、用户流程、信息架构、交互规则、视觉与响应式、技术候选方案比较、数据方案、测试数据、QA 验收方法、风险与依赖、DEV/QA/OPS 交付计划、验收标准。

## 派单与唤醒

首次向 DEV、QA、OPS 创建实现任务前，Runtime 必须验证与等级匹配的方案。顺序固定为：

`pm.write_planning_artifact → 验证规划 → write_task → pm.wake_downstream`

规划正文必须通过 `pm.write_planning_artifact` 提交。Runtime 根据主任务实际等级选择唯一合法的 PLAN/Product Brief 路径、生成 frontmatter 并维护 revision；PM 不得使用 shell、Python、原生 edit 或手写 YAML/JSONL 绕过该入口。

不得先创建子任务，再在唤醒阶段返回 `product_brief_required`。任务已合法创建后，PM 显式唤醒是团队调度指令：业务依赖与规划门禁不再拒绝它；忙碌返回 `already_running`，暂时无法启动进入 `queued`。生命周期冻结、暂停与权限边界仍然有效。

PM 在写任务前必须先设计执行依赖图。可立即执行的任务无需 `depends_on`；QA/OPS 若验收或部署 DEV 产物，必须先创建 DEV 任务，再把该 DEV task_id 同时写入 QA/OPS 的 `references` 与 `depends_on`。Runtime 在 DEV 产生有效 `status: done` 回执前保持 QA/OPS 排队，回执满足后自动放行。

## 技能执行证据

`auto_inject` 只表示 Runtime 推荐或提供了技能，不表示 PM 已执行。Level 3 每项必需技能必须在首次派单前真实读取、应用并调用 `pm.record_planning_skill_evidence`，记录：

- `task_id`、Runtime `session_id`、`skill_id`
- 输入上下文与输出摘要
- Product Brief 对应章节
- 受影响的产品决策

Runtime 对证据签名并去重。Shell、Python 或手工追加 JSONL、缺少 Session/产出映射、事后补录、`auto_inject` 均不能解锁门禁。

## 兼容

- 不改变 FCoP TASK/REPORT/REVIEW 格式。
- 旧项目缺少等级时仍可自动分类，但 2026-07-12 之前的历史任务默认兼容放行。
- 新任务与明确 `planning_reopened: true` 的重开任务强制执行。
- 历史 `auto_inject` 保留为推荐记录，绝不升级为真实执行证据。
