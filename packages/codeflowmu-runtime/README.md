# @codeflowmu/runtime

> **v0.1 Backend Kernel 全量完工** — Sprint S2 (Phase A) + S3 (Phase B + C) + S4 (Phase D) + S5 (Phase E) + S6 (codeflowmu-shell) 14 子系统装配，94/94 tests pass，0× 0 flakes。**当前版本 `0.1.0-rc.1` (internal preview)** —见 [`codeflowmu-shell/README.md`](../../codeflowmu-shell/README.md) 与[`docs/releases/v0.1.0-rc.1.md`](../../docs/releases/v0.1.0-rc.1.md)。
> 🟡 **v1.0 alignment pending** —This release implements codeflowmu protocol v0.1 (5 schemas: agent / task / review / session / skill) with `Review.decision="needs_human"` and a `human_approval` sub-structure. **These v0.1 concepts will be deprecated in v0.2** in favour of FCoP v1.0's Boundary capability —see [FCoP issue #2](https://github.com/joinwell52-AI/FCoP/issues/2#issuecomment-4412811192) for the upstream v1.0 charter (7 abstractions, Boundary, etc.). codeflowmu v0.2 sprint 0 will fully align to `fcop@>=1.0,<2.0`.

codeflowmu AI Runtime ——6 夀kernel 子系统中的**5 与*（Agent Registry + Session Manager + Task Scheduler + Review Engine + Skill Runtime），现已 v0.1 全量落地。
- 上游设计：[`docs/design/codeflowmu-v2-on-fcop-sdk.md`](../../docs/design/codeflowmu-v2-on-fcop-sdk.md) §0.5（fcop-mcp 强依赖）+ §0.7.5（Skill Runtime） §2.1（子系统 1 + 3） §2.4（Inbox watcher） §3（Runtime Protocol & Schemas） §3.4（Review schema） §3.6（Skill schema） §0.9.4（Review Engine 行为）- Phase A 派单：[`fcop/tasks/TASK-20260509-009-PM-to-DEV.md`](../../fcop/tasks/TASK-20260509-009-PM-to-DEV.md)
- Phase B 派单：[`fcop/tasks/TASK-20260509-013-PM-to-DEV.md`](../../fcop/tasks/TASK-20260509-013-PM-to-DEV.md)
- Phase C 派单：[`fcop/tasks/TASK-20260509-018-PM-to-DEV.md`](../../fcop/tasks/TASK-20260509-018-PM-to-DEV.md)
- Phase D 派单：[`fcop/tasks/TASK-20260509-022-PM-to-DEV.md`](../../fcop/tasks/TASK-20260509-022-PM-to-DEV.md)
- Phase E 派单：[`fcop/tasks/TASK-20260509-024-PM-to-DEV.md`](../../fcop/tasks/TASK-20260509-024-PM-to-DEV.md)
- Sprint 路线图：[`docs/design/codeflowmu-v2-on-fcop-sdk.md` §10.2](../../docs/design/codeflowmu-v2-on-fcop-sdk.md)
- 持久化决策：[`docs/crash-recovery.md`](./docs/crash-recovery.md)

## 包内职责（v0.1 全量）
| 子系绀/ 籀| 文件 | OS 类比 | 状怀|
|---|---|---|---|
| **AgentRegistry** | `src/registry/AgentRegistry.ts` | 进程控制块表 (PCB) | ✀Phase A 完成） 方法 + race-defense）|
| **PersistentStore** + `JsonFileStore` | `src/registry/PersistentStore.ts` | 文件系统 + journal log | ✀Phase A 完成（atomic-write + fsync）|
| **RuntimeBootstrap** | `src/registry/RuntimeBootstrap.ts` | init / systemd | ✀Phase A 完成（reconciliation 同步流程 + TS-2.8 SDK.list HARD FAIL）|
| **AgentSdkAdapter** + `CursorSdkAdapter` / `InMemorySdkAdapter` | `src/registry/AgentSdkAdapter.ts` | SDK 适配局| ✀Phase A + Phase B 完成（含 send 接口）|
| **SessionManager** | `src/session/SessionManager.ts` | 进程调度器（会话层） | ✀Phase B 完成） 方法 + emergency stop）|
| **SessionStore** | `src/session/SessionStore.ts` | 區record per file 的PCB 存储 | ✀Phase B 完成（atomic-write 复用 helper）|
| **TranscriptWriter** | `src/session/TranscriptWriter.ts` | 事件浀append-only md | ✀Phase B 完成（streaming + concurrent-close safe）|
| **SdkRunHandle** | `src/session/SdkRunHandle.ts` | SDK Run 包装 + 8→`sdk.*` 事件映射 | ✀Phase B 完成 |
| **InboxWatcher** | `src/scheduler/InboxWatcher.ts` | 进程事件投途doorbell | ✀Phase C 完成（chokidar depth=0 + 严格 regex + handler 隔离）|
| **TaskParser** | `src/scheduler/TaskParser.ts` | 进程描述符解析器 | ✀Phase C 完成（yaml@^2 + 容忍无frontmatter / 半成品） |
| **StateHistoryWriter** | `src/scheduler/StateHistoryWriter.ts` | 进程审计日志（append-only）| ✀Phase C 完成（markdown body 追加；不务schema-约束的frontmatter 数组）|
| **TaskDispatcher** | `src/scheduler/TaskDispatcher.ts` | 调度噀dispatch 链路 | ✀Phase C 完成） 歀dispatch + reject_busy + settle 钩子）|
| **ReviewEngine** | `src/review/ReviewEngine.ts` | 内核审查器（governance loop）| ✀Phase D 完成（订阀session_ended →派发 reviewer subtask →解析 verdict →萀REVIEW-*.md + state_history）|
| **ReviewWriter** | `src/review/ReviewWriter.ts` | 审查回执持久匀| ✀Phase D 完成（schema-light validate + atomic-write + refuse-overwrite）|
| **NeedsHumanGate** | `src/review/NeedsHumanGate.ts` | 人工兜底 push | ✀Phase D 完成（v0.1 sink="cli" 严格白名區+ UnsupportedHumanPushSinkError eager fail）|
| **AgentStatusReconciler** | `src/registry/AgentStatusReconciler.ts` | session 生命周期 →agent.status 同步噀| ✀Phase D 完成（订阀SessionManager 事件 + 不改各层接口 + per-agent 串行匀+ error 序不被覆盖；闭环 REPORT-018 §决策 B'）|
| **SkillRegistry** | `src/skill/SkillRegistry.ts` | 设备驱动表（per-skill JSON 装载 + ajv 校验 + role 反向索引）| ✀Phase E 完成（tolerant-read 复用 SessionStore pattern + 内置 schema 校验 + filename↔skill_id 双校）|
| **KernelDependencyValidator** | `src/skill/KernelDependencyValidator.ts` | 内核 syscall 强依赖闸（v0.1 = `^fcop@.+`）| ✀Phase E 完成） reasons：no_fcop_skill / skill_not_found / no_compatible_runtime；register pre-hook + bootstrap audit 两路皆挂）|
| **MCPInjector** | `src/skill/MCPInjector.ts` | per-agent MCP 装载层（v0.1 stub）| ✀Phase E 完成（stub mode log + live mode ctor eager throw `MCPInjectorLiveModeNotImplementedError`）|
| **Runtime** | `src/Runtime.ts` | 顶层 composition root | ✀Phase E 升级）*14 子系统装酀*；skill 层先亀registry 装配；start/stop 顺序保证 reconciler 先于 dispatcher attach）|
| `ReconciliationReport` / `ReconciliationStrategy` | `src/types/state.ts` | 启动审计 | ✀Phase A 完成 + Phase E 务`kernel_failures: KernelValidationFailureEntry[]` |

### AgentRegistry 6 方法 method-by-method

| 方法 | 状怀| 关键不变釀|
|---|---|---|
| `register(spec)` | ✀完成 | layer=admin 在SDK 调用剀reject；ajv 验证；SDK 失败 →agents.json 不写 |
| `resume(agentId)` | ✀完成 | 找不到→`AgentNotFoundError`；SDK 失败保留厀cause；更斀`runtime_last_reconciled_at` |
| `list(filter?)` | ✀完成 | layer / role / status 三字殀AND-combined |
| `get(agentId)` | ✀完成 | 不存在返 `null`，不技|
| `updateRuntimeBinding(agentId, runtime)` | ✀完成 | 不自动触叀resume（避免副作用串联）|
| `markFailed(agentId, error)` | ✀完成 | 冀`status=error` + `runtime_failure` |

### SessionManager 6 方法 method-by-method（Phase B 新增）
| 方法 | 状怀| 关键不变釀|
|---|---|---|
| `startSession(agentId, taskId, payload)` | ✀完成 | agent 验证先于 SDK 调用；attach 早于 save 阀event race；save 失败 →SDK 反向 cancel + 状态回滀|
| `getSession(sessionId)` | ✀完成 | 不存在返 `null`，不抛（与`AgentRegistry.get` 对称）|
| `listActive()` | ✀完成 | 直接 SessionStore 反映；无内存缓存防止跨重启漂秀|
| `cancelSession(sessionId, reason)` | ✀完成 | **SDK cancel 严格先于持久匀*；幂等（二次取消 →transcript warning）|
| `cancelAllForEmergencyStop()` | ✀完成 | `Promise.allSettled` 语义，单失败不阻塞同伴；EMERGENCY-{ts}.md 畀v0.2 S10 钩子 |
| `onEvent(handler)` | ✀完成 | 12 籀RuntimeEvent fan-out；throw listener 自动 unsubscribe + console.error |

### TaskDispatcher dispatch 4 步流水线（Phase C 新增）
| 步骤 | 失败时落档| 关键不变釀|
|---|---|---|
| **1. 解析 task.md**（`TaskParser`）| `state_history: inbox →parse_failed`（含 reason）| YAML 解析失败 = `TaskParseError`；无 frontmatter 不算失败 |
| **2. 所recipient agent**（`AgentRegistry.list({ role })`）| `state_history: inbox →agent_not_found`（含 recipient）| frontmatter.recipient 优先；fallback filename `-to-XXX` 殀|
| **3. `SessionManager.startSession`** | `state_history: inbox →rejected_busy / start_failed` | `InvalidAgentStatusError` 触发 reject_busy；queue 昀v0.2 |
| **4. 监听 `runtime.session_ended` / `_cancelled`** | `state_history: dispatched →ended / cancelled`（含 status / reason）| filter `session_id` 命中吀unsubscribe；防内存泄漏 |

### Phase B + C + D + E 关键设计决策（实施时锁定）
- **决策 J**（Phase B →C →D →E 一致沿用）：所最named errors 合并到对应子模块的`errors.ts`，不另起 *-errors.ts。Phase D 新增 `ReviewWriteError` / `ReviewerNotFoundError` / `VerdictParseError` / `UnsupportedHumanPushSinkError`；Phase E 再新墀`KernelDependencyError` / `MCPInjectorLiveModeNotImplementedError` / `SkillSchemaError`，全在`registry/errors.ts`（共 17 与named error class：A 6 + B 2 + C 2 + D 4 + E 3）- **决策 M**（Phase B）：`RuntimeEventType` 8 与sdk.* 类型件`_ignore/spike_sdk_doorbell/` 实测为准（system / thinking / assistant / tool_call / status / task / request / user）- **决策 N**（Phase B）：每次 `send` 内部赀`Agent.resume →agent.send →包装戀RunHandle →settled 无dispose`，不在adapter 内持汀- **决策 A**（Phase C ⚠️）：StateHistoryWriter **与*攀frontmatter `state_history` 数组，只在markdown body 末尾追加 `## state_history (auto-appended by runtime)` 段落。原因：`task.schema.json` line 47-60 技`state_history.items` 锁为 `{state, at, by}` 与`additionalProperties: false`，runtime 想记录的 `{at, by, from, to, note}` 不兼容；markdown body 不在 schema 约束范围
- **决策 B**（Phase C）：Phase C 默认 reject_busy，不实现 task queue；ADMIN 后续可手务cancel 耀session 后再 dispatch 斀task。Queue 昀v0.2 范围
- **决策 B' 闭环**（Phase D ⭀—闀REPORT-20260509-018 §五）：S3 `rejected_busy` 路径在Phase C 整改后仍依赖 `agents.json` 的`status="running"`，但 `InMemorySdkAdapter` 不会冀status，导致集成测试只能用预置 fixture 模拟。Phase D 新增 `AgentStatusReconciler` 作为**集成局hook**：订阀`SessionManager.onEvent('runtime.session_started' / '_ended' / '_cancelled')` 并通过 `AgentRegistry.get` + `PersistentStore.upsert` 同步 `Agent.status`。*不改 SessionManager / AgentRegistry 公开接口**，全在装配层缝合。验收：`AgentStatusReconciler.test.ts` 端到端跑途`rejected_busy` 链路，无需手写 fixture
- **决策 K**（Phase D）：Review Engine 落在本包 `src/review/` 耀*不是单独的`@codeflowmu/review-engine` 匀*——理由：与SessionManager / SessionStore / StateHistoryWriter / AgentRegistry 共享 `_internal/atomic-write.ts` + 相同事件总线，单独包会强近export 内部细节，违胀§8.0 硬规到#4。Review schema 仍只在`@codeflowmu/protocol`，不在本包重复定乀- **决策 L**（Phase D）：reviewer 输出协议采用 `VERDICT: <decision>; RATIONALE: <text>` 单行、case-sensitive、accumulator-pattern（buffer 全部 sdk.assistant text，最后一遀regex match）。失贀→`decision="needs_human" + trigger_reason="verdict_parse_failed"`。规约简到能用纯字符串解析，不引第三斀grammar / LLM-as-arbiter
- **决策 O**（Phase D）：`NeedsHumanGate.push(sink="cli")` v0.1 赀`logger.info(...)` 冀stdout（一欀JSON-able payload，含 `subject_ref` / `decision` / `rationale` / `trigger_reason` / `pushed_at` ISO-8601）；`sink="mobile"` 在ctor 釀**eager throw** `UnsupportedHumanPushSinkError`，不讀v0.2 才支挀的代码路径在生产里走过去无人发现
- **决策 P**（Phase E）：`RuntimeBootstrap` 在SDK reconcile loop 之后、`ReconciliationReport` 生成之前插一与kernel-dep audit 阶段。失贀agent 同时近`failed[]`（带 `kernel-dep violation (reason)` 文案）和 `kernel_failures[]`（结构化 `{agent_id, reason, detail}`），`markFailed` 同步落盘 →操作员能件stdout 一血+ 文件双向溯源
- **决策 Q**（Phase E）：`MCPInjector.mount` 在bootstrap 阶段寀success 数组**顺序 await**）*与*用`Promise.all`。理由：stub 模式 log 顺序对操作员可读，v0.2 live 模式也希望失败一台不连累其他（可放慢但不掉单）。不昀fatal 错误（`logger.warn` + 继续），**仅在 register 阶段**所fatal（避免悄悄留下半挂载的新 agent）- **决策 R**（Phase E）：`AgentRegistry` ctor 接受 `kernelValidator` / `mcpInjector` 与*可选参敀*，缺眀= `null` = Phase A-D 行为完全不变（Phase A 18 测试 + Phase B 22 + Phase C 14 + Phase D 13 兀67 条*零回录*验证）。Phase E 钩子只在 `Runtime.create` 装配时被注入
- **决策 S**（Phase E ⭐）：`AgentRegistry.register` 与kernel-dep 检查的位置 = **schema validate 之后、SDK.create 之前**。和 layer=admin reject 同一 pre-flight 槽位。这保证亀SDK quota 在reject 时不被消耗，TS-7.12 测试断言 `sdk.calls.create.length === 0` + `agents.json` 不存在- **决策 T**（Phase E ⭐）：`MCPInjector` ctor 收到 `mode: "live"` 立即 **eager throw** `MCPInjectorLiveModeNotImplementedError`，不留给第一欀`mount` 才发现。同 §决策 O 的`UnsupportedHumanPushSinkError` 原则——composition-root 失败必须比第一次业务调用更早暴需- **决策 U**（Phase E）：`Runtime.start/stop` 顺序**不变**——`SkillRegistry.load` 是同步在 `Runtime.create` 内执行（`await skillRegistry.load()` 在ctor 里完成），`KernelDependencyValidator` 是纯计算无生命周期，`MCPInjector` stub 模式没有需覀start/stop 的资源（v0.2 live 模式才需要）

## 不在本包内（挀§0.7 + §10.2 sprint 边界）
| 子系绀| 在哪与sprint 萀|
|---|---|
| Skill Runtime（per-role MCP 注入）实陀spawn | **v0.2** ——v0.1 stub 模式叀log；`MCPInjector mode="live"` ctor 即抛异常 |
| `@codeflowmu/skill-runtime` 单独匀| **不再单独叀* ——决策 K' (S5)：`src/skill/` 与registry / session 共享 `_internal/atomic-write.ts` + 同事件总线，单独发包会砀§8.0 硬规到#4 |
| Review Engine（手机端 sink）⭐ | **v0.2 S7-S10** ——`NeedsHumanGate.sink="mobile"` 走中继；最sprint 巀eager-throw 占位 |
| codeflowmu-shell EXE 壳子 | **S6** ——Node SEA bundle，import `Runtime.create` 即用 |
| Mobile Console / 中继 | **v0.2 S7-S10** |
| Task queue（同 agent 巀running 时排队） | **v0.2** ——当前默认 reject_busy |
| `inbox/<role>/` 子目录路用| **v0.x+** ——当前 `fcop/tasks/` 平铺，与 §2.4 reference impl 不同 |
| EMERGENCY-{ts}.md 落档（emergency stop 完整审计）| **v0.2 S10**（接钩子）|
| 实际调用 `Agent.create / resume` 的spike | 仍在 [`_ignore/spike_sdk_doorbell/`](../../_ignore/spike_sdk_doorbell/) —作为参考实现保畀|

## 协议依赖纪律（Phase A + B + C 一致）

- 本包**只消贀*`@codeflowmu/protocol`（FCoP spec 的TS 镜像）的类型与schema
- **不允讀*在`src/types/state.ts` 创造任佀schema 字段；只允许 *runtime 私有* 的纯运行时构造（妀`RuntimeEvent` / `ReconciliationReport` / `SessionHandle` / `RunHandle` / `ParsedTask` / `StateHistoryEntry` / `KernelValidationFailureEntry` 等）
- Phase D 的`ReviewVerdict` / `HumanApproval` 接口在`src/review/ReviewWriter.ts` 中是 `review.schema.json` 的TS 镜像 + 必要的可途条件字段补全）*完整 schema 校验仍走 `@codeflowmu/protocol` 的`validate("review", ...)`**（见 `ReviewWriter.test.ts` TS-6.1）- Phase E 的`SkillRecord` / `SkillToolSpec` / `SkillProvider` 接口在`src/skill/SkillRegistry.ts` 中是 `skill.schema.json` 的TS 镜像）*完整 schema 校验仍走 `validate("skill", ...)`**（见 `SkillRegistry.test.ts` TS-7.2）- 任何 schema 缺口 →写到 PM 的回执，**不在本包内私自加**
- Phase A + B + C + D + E 实施过程与**0 与* schema 缺口出现（详见 §决策 A / §决策 K / §决策 R）- 详见设计文档 §8.0 硬规到#4 + §3.3.1.b 唯一合法升级路径

## 目录结构

```
packages/codeflowmu-runtime/
├── package.json                               (吀chokidar^4 + yaml^2)
├── tsconfig.json
├── README.md                                  →本文件├── examples/
─  └── hello-world.ts                         ✀Phase C E2E demo（用 InMemorySdkAdapter）├── src/
─  ├── index.ts                               公开 API barrel（含 Runtime + scheduler）─  ├── Runtime.ts                             ✀Phase C 顶层装配 root） 子系统）
─  ├── _internal/
─  ─  └── atomic-write.ts                    ✀Phase B 抽取的atomicWriteJson helper
─  ├── registry/                              Agent Registry（.1 子系绀3）─  ─  ├── AgentRegistry.ts                   ✀Phase A 完成
─  ─  ├── PersistentStore.ts                 ✀JsonFileStore (atomic-write+fsync)
─  ─  ├── RuntimeBootstrap.ts                ✀Phase A + TS-2.8 SDK.list HARD FAIL
─  ─  ├── AgentSdkAdapter.ts                 ✀+ send + InMemoryRunHandle (Phase B)
─  ─  ├── errors.ts                          ✀10 与named error class（Phase A 6 + Phase B 2 + Phase C 2）─  ─  ├── index.ts
─  ─  └── __tests__/                         18 与node:test，全部通过
─  ─      ├── AgentRegistry.test.ts          场景 1-6
─  ─      ├── RuntimeBootstrap.test.ts       场景 7-9 + 11 + 12 (TS-2.8 B-path)
─  ─      ├── PersistentStore.test.ts        场景 10 + 11 (并发 upsert TS-1.6) + 5 sanity
─  ─      └── helpers.ts
─  ├── session/                               Session Manager（.1 子系绀1）─  ─  ├── SessionManager.ts                  ✀Phase B 完成） 方法）─  ─  ├── SessionStore.ts                    ✀Phase B 完成（单 record per file）─  ─  ├── TranscriptWriter.ts                ✀Phase B 完成（append-only md + 并发 close 安全）─  ─  ├── SdkRunHandle.ts                    ✀Phase B 完成（SDK Run 包装 + 8→sdk.* 映射）─  ─  ├── index.ts
─  ─  └── __tests__/                         22 与node:test，全部通过
─  ─      ├── SessionManager.test.ts         TS-4.1 ~ TS-4.5 + onEvent 隔离
─  ─      ├── SessionStore.test.ts           save/load/listAll/remove + tolerant-read
─  ─      ├── TranscriptWriter.test.ts       attach/append/close/closeAll
─  ─      └── helpers.ts
─  ├── scheduler/                             Task Scheduler（.4 inbox watcher）─  ─  ├── InboxWatcher.ts                    ✀Phase C 完成（chokidar4 doorbell）─  ─  ├── TaskParser.ts                      ✀Phase C 完成（yaml@^2 + tolerant）─  ─  ├── StateHistoryWriter.ts              ✀Phase C 完成（append-only md ⚠️ 决策 A）─  ─  ├── TaskDispatcher.ts                  ✀Phase C 完成） 歀dispatch + settle 钩子）─  ─  ├── index.ts
─  ─  └── __tests__/                         14 与node:test，全部通过
─  ─      ├── InboxWatcher.test.ts           TS-5.1 ~ TS-5.3
─  ─      ├── TaskParser.test.ts             TS-5.4 ~ TS-5.6 + bonus
─  ─      ├── StateHistoryWriter.test.ts     TS-5.7 ~ TS-5.9
─  ─      ├── TaskDispatcher.test.ts         TS-5.10 ~ TS-5.13（含 reject_busy 验收 #5）─  ─      └── helpers.ts
─  ├── review/                                Review Engine（.9.4 + §3.4 —Phase D 新增）─  ─  ├── ReviewEngine.ts                    ✀Phase D 完成（subject →reviewer context 区分 + verdict 解析 + needs_human 兑现 + state_history 闭环 + orphan-event buffering + Phase D-post fix `whenSettled` race-loop）─  ─  ├── ReviewWriter.ts                    ✀Phase D 完成（schema-light validate + atomic-write + refuse-overwrite + renderReviewMarkdown helper）─  ─  ├── NeedsHumanGate.ts                  ✀Phase D 完成（v0.1 sink="cli" →logger.info；sink="mobile" eager throw）─  ─  ├── index.ts
─  ─  └── __tests__/                         13 与node:test (TS-6.1 ~ TS-6.13)
─  ─      ├── ReviewWriter.test.ts           TS-6.1 ~ TS-6.3 + renderReviewMarkdown 单元
─  ─      ├── NeedsHumanGate.test.ts         TS-6.4 / TS-6.5 + ISO-8601 边界
─  ─      ├── ReviewEngine.test.ts           TS-6.6 ~ TS-6.11（含 approved / needs_changes 叀E2E + needs_human 兜底）─  ─      ├── AgentStatusReconciler.test.ts  TS-6.12 / TS-6.13 + rejected_busy 集成（闭 REPORT-018 §决策 B'）─  ─      └── helpers.ts                     withTempReview / waitFor / quietLogger / readReviewFile
─  ├── skill/                                 Skill Runtime（.5 fcop-mcp 强依赀+ §0.7.5 + §3.6 —Phase E 新增）─  ─  ├── SkillRegistry.ts                   ✀Phase E 完成（tolerant-read 复用 SessionStore pattern + role 反向索引 + filename↔skill_id 双校）─  ─  ├── KernelDependencyValidator.ts       ✀Phase E 完成） reasons + compatible_runtimes 缺省 = 默认接受 local）─  ─  ├── MCPInjector.ts                     ✀Phase E 完成（stub mode log + live mode ctor eager throw）─  ─  ├── index.ts
─  ─  └── __tests__/                         17 与node:test (TS-7.1 ~ TS-7.13 + 4 bonus)
─  ─      ├── SkillRegistry.test.ts          TS-7.1 ~ TS-7.4 + 3 bonus（idempotent reload / missing dir / filename mismatch）─  ─      ├── KernelDependencyValidator.test.ts   TS-7.5 ~ TS-7.8 + TS-7.13 bonus + validateAll aggregator
─  ─      ├── MCPInjector.test.ts            TS-7.9 / TS-7.10 + 2 bonus（unknown skill / empty skills agent）─  ─      └── helpers.ts                     withTempSkill / quietLogger / plantSkill / plantRaw
─  └── types/
─      └── state.ts                           AgentRecord / SessionRecord / RuntimeEvent
─                                             + Phase A: ReconciliationReport
─                                             + Phase B: RunHandle.onEvent + RuntimeEventType 12 籀─                                             + Phase E: ReconciliationReport.kernel_failures + KernelValidationFailureEntry
├── fixtures/                                  样例数据（设讀review，非测试）─  ├── agents.json                            §2.1 子系绀3 的agents.json 样例
─  └── sessions/
─      └── valid-runtime-session-001.json
└── docs/
    ├── crash-recovery.md                      4 个崩溃恢复设计决筀    └── test-strategy-s3.md                    S3 测试策略（Phase A/B/C 测试场景对照）```

## 验收

| 顀| 验证方式 |
|---|---|
| 包编译通过 | `npx tsc --noEmit`（零报错）|
| 单元测试 | `npm test`）*94/94** 全过 —Phase A 18 + Phase B 22 + Phase C 14 + Phase D 13 + Phase E **17** + 10 跨阶殀sanity）|
| `@codeflowmu/protocol` 包未受影哀| `cd ../codeflowmu-protocol && npm test`（仍 8/8 通过）|
| atomic-write 模式 | `PersistentStore.ts` + `_internal/atomic-write.ts` 吀`writeFile(*.tmp)` + `rename` + 父目录`fsync` |
| layer=admin 拒绝在SDK 调用剀| 测试场景 3 spy 验证 `sdk.calls.create.length === 0` |
| RuntimeNotReady 防御 | 测试场景 11 |
| TS-2.8 SDK.list HARD FAIL | 测试场景 12 |
| TS-1.6 并发 upsert 不损址JSON | 测试场景 11（PersistentStore）|
| SessionManager 串行不变釀| TS-4.4：`SDK cancel 时间戀≀store cancelled 时间戳` |
| Phase B emergency stop allSettled | TS-4.5） 失败 + 1 成功 = `cancelled.length + failed.length === 2` |
| InboxWatcher 严格 regex 匹配 | TS-5.2：REPORT-*.md / HANDOFF-*.md 静默忽略） warning |
| TaskDispatcher reject_busy | TS-5.13：同 agent status=running 时第二个 task →`state_history: inbox →rejected_busy` |
| StateHistoryWriter 写法核对 | TS-5.7/5.8：首次加标题，后续只务bullet；frontmatter 不变 |
| ReviewWriter atomic + refuse-overwrite | TS-6.1：valid verdict 萀REVIEW-*.md，frontmatter 绀`validate("review", ...)` 验证 valid=true；TS-6.2：同 review_id 二次写入 →`ReviewWriteError`；TS-6.3：schema 违规 throw 之前文件不存在|
| NeedsHumanGate sink 严格 | TS-6.4：cli sink →`logger.info` 吀trigger_reason 且返囀stub `HumanApproval`；TS-6.5：`pushed_at` 通过 `Date.parse` |
| ReviewEngine governance loop | TS-6.6：subject session_ended 同步引发 reviewer `sdk.send` 调用；TS-6.7：policy.shouldReview=false 时不冀REVIEW-*.md；TS-6.8：reviewer 未注冀→NeedsHumanGate 兜底；TS-6.9：reviewer 输出无VERDICT 血→`decision="needs_human" + trigger_reason="verdict_parse_failed"`；TS-6.10/6.11：approved + needs_changes 端到端，REVIEW-*.md schema-valid + state_history 在subject 上追务|
| AgentStatusReconciler 闭环 REPORT-018 §B' | TS-6.12：`session_started` →`Agent.status="running"`；TS-6.13：`session_ended` / `_cancelled` →`idle`，但 `error` 序不被覆盖；集成路径：注冀→赀session A（手务settle）→ 赀session B →第二欀dispatch 命中 `rejected_busy`）*无需手写 fixture**）|
| SkillRegistry tolerant-read | TS-7.1） valid skill 全部装载，`logger.info` 一行总结；TS-7.2：schema 不合泀→`skipped[]` 收录；TS-7.3：`.tmp` / 靀`.json` / 损坏 JSON / 空文件全跳近|
| SkillRegistry 索引一臀| TS-7.4：`getById` / `listForRole` / `list` / `size` 全对（`available_to_roles` 重叠多角色覆盖反向索引） |
| KernelDependencyValidator 3 reasons | TS-7.5：fcop 在→null；TS-7.6/7.13：empty skills →`no_fcop_skill`；TS-7.7：unknown skill_id →`skill_not_found`；TS-7.8：`compatible_runtimes` 不含 `local` →`no_compatible_runtime`；TS-7.8b：缺 `compatible_runtimes` 字段 = 默认接受 local |
| MCPInjector stub 严格 | TS-7.9：mount 件`logger.info`，不 spawn，`sdk.calls.create.length === 0`；TS-7.10：`mode="live"` ctor 區`MCPInjectorLiveModeNotImplementedError` |
| RuntimeBootstrap kernel-dep audit | TS-7.11：违反 agent 同时近`failed[]`（带 `kernel-dep violation`） `kernel_failures[]` + summary 血`🚫 1 kernel-dep`；TS-7.11b：未注入 validator 无`kernel_failures=[]` 行为零变 |
| AgentRegistry register pre-hook | TS-7.12：unknown skill →`KernelDependencyError` 抛出 + `sdk.calls.create.length === 0` + `agents.json` 不存在；TS-7.12b：注兀`mcpInjector` 吀register 成功路径触发 mount 日志 |
| 协议依赖纪律 | `src/registry`/`src/session`/`src/scheduler`/`src/review`/`src/skill`/`src/types` 不重新声昀schema 字段，仅 `import type` from `@codeflowmu/protocol` |

## 跑测诀+ Demo

```bash
cd packages/codeflowmu-runtime
npm install         # 一次怀npm run typecheck   # 0 错误
npm test            # 94/94 PASS

# Phase E E2E demo（无需真实 Cursor SDK，用 InMemorySdkAdapter；plant fixture skill）npx tsx examples/hello-world.ts
# Drop a TASK-*-XXX-to-DEV.md into examples/inbox/ to trigger the pipeline.
# 如果 inbox 里同时有 reviewer agent（角艀= REVIEW）注册到 registry）# subject 任务 settled 后会**自动**触发 review subtask；REVIEW-*.md
# 落到 `<persistDir>/reviews/`，state_history 同步写到 subject 任务 md 末尾。# Ctrl+C to stop.
```

## v0.1 起未条sprint 路径

- ✀**Phase A**（commit `407cfa5`）：AgentRegistry + PersistentStore + RuntimeBootstrap
- ✀**Phase B**（commit `8c49907`）：SessionManager + SessionStore + TranscriptWriter + TS-2.8 patch + L2 文档落档
- ✀**Phase C**（commit `bd7d3d8`）：InboxWatcher + TaskParser + StateHistoryWriter + TaskDispatcher + Runtime 顶层装配 + E2E mini demo
- ✀**Phase D / Sprint S4**（commit `1ba2aa6`）：ReviewEngine + ReviewWriter + NeedsHumanGate + AgentStatusReconciler + Runtime 11-子系统装配；闭环 REPORT-20260509-018 §决策 B'
- ✀**Phase E / Sprint S5**（本里程碑）：SkillRegistry + KernelDependencyValidator + MCPInjector + Runtime 14-子系统装配；fcop-mcp 强依赖闸落地（design doc §0.5/§0.7.5/§3.6 兑现） Phase D `whenSettled` race-loop 兜底） 秀deadline）- ⏀**S6**：E2E 跑途§0.8.3 Hello World demo + v2 EXE 出厂（codeflow-shell + Node SEA） MCPInjector live mode

详见 [`docs/design/codeflowmu-v2-on-fcop-sdk.md` §10.2](../../docs/design/codeflowmu-v2-on-fcop-sdk.md) + [§11 v2 Packaging](../../docs/design/codeflowmu-v2-on-fcop-sdk.md)。
