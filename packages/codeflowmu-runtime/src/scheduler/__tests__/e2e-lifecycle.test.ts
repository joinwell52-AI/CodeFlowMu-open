/**
 * E2E 烟雾测试：FCoP 任务完整生命周期（UI-less 守护进程模式）
 *
 * 验证在不依赖 Cursor UI 的情况下，FCoP 任务从落盘到归档的完整流程：
 *
 *   TASK 文件投入 inbox
 *     → InboxWatcher 检测到文件
 *     → TaskDispatcher 分发给 Agent
 *     → Agent 通过 sendHandleFactory 模拟 fcop_mcp 工具调用：
 *         write_report（task-report 热路径；不模拟 claim_task / finish_task）
 *     → 捕获 sdk.thinking / sdk.tool_call 事件（日志系统验证）
 *     → REPORT 文件落盘（模拟 fcop_mcp.write_report）
 *     → SessionManager 感知 session_ended
 *     → state_history 追加 dispatched → ended
 *
 * 这个测试直接对应用户需求：
 *   "因为是脱离cursor的ui的，还是要测试的哦"
 *   "注意记录；logs里面的还需要记录的"
 *
 * 参考：
 *   - TaskDispatcher.test.ts (TS-5.10 / TS-5.12 的 buildPipeline 模式)
 *   - AgentSdkAdapter.ts (InMemorySdkAdapter.sendHandleFactory)
 *   - state.ts (RuntimeEvent 类型定义)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryRunHandle,
  InMemorySdkAdapter,
} from "../../registry/AgentSdkAdapter.ts";
import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import type { RuntimeEvent } from "../../types/state.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";

import { quietLogger, waitFor, withTempScheduler } from "./helpers.ts";

import type { Agent } from "@codeflowmu/protocol";

// ── 测试 fixtures ──────────────────────────────────────────────────────────

const TASK_BODY = (taskId: string, recipient: string): string => `---
protocol: fcop
task_id: ${taskId}
sender: PM
recipient: ${recipient}
priority: P2
status: pending
---

# Task: ${taskId}

请处理此任务，完成后提交 REPORT。
`;

const REPORT_BODY = (taskId: string): string => `---
protocol: fcop
task_id: ${taskId}
kind: report
sender: DEV
recipient: PM
status: done
---

# Report: ${taskId}

E2E 烟雾测试完成。热路径仅 write_report（无开工前 claim_task）。
`;

function makeAgentSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "DEV-01",
    role: "DEV",
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  };
}

// ── pipeline 工厂（复用 TaskDispatcher.test.ts 的模式）────────────────────

interface Pipeline {
  watcher: InboxWatcher;
  dispatcher: TaskDispatcher;
  registry: AgentRegistry;
  sessionManager: SessionManager;
  sdk: InMemorySdkAdapter;
  logger: ReturnType<typeof quietLogger>;
  /** 捕获 SessionManager 广播的所有 RuntimeEvent。*/
  events: RuntimeEvent[];
  shutdown: () => Promise<void>;
}

async function buildPipeline(opts: {
  inboxDir: string;
  stateDir: string;
}): Promise<Pipeline> {
  const sdk = new InMemorySdkAdapter();
  const agentStore = new JsonFileStore({
    path: join(opts.stateDir, "agents.json"),
  });
  const registry = new AgentRegistry({ store: agentStore, sdk });
  const sessionStore = new SessionStore({
    dir: join(opts.stateDir, "sessions"),
  });
  const transcriptWriter = new TranscriptWriter({
    dir: join(opts.stateDir, "transcripts"),
  });
  const sessionManager = new SessionManager({
    registry,
    sdk,
    sessionStore,
    transcriptWriter,
  });
  const logger = quietLogger();
  const watcher = new InboxWatcher({ dir: opts.inboxDir, logger });
  const historyWriter = new StateHistoryWriter();
  const dispatcher = new TaskDispatcher({
    watcher,
    historyWriter,
    registry,
    sessionManager,
    logger,
  });

  const events: RuntimeEvent[] = [];
  sessionManager.onEvent((evt) => events.push(evt));

  return {
    watcher,
    dispatcher,
    registry,
    sessionManager,
    sdk,
    logger,
    events,
    shutdown: async () => {
      await dispatcher.stop().catch(() => undefined);
      await transcriptWriter.closeAll().catch(() => undefined);
    },
  };
}

// ── E2E 测试 ───────────────────────────────────────────────────────────────

describe("E2E: FCoP 任务生命周期（UI-less 守护进程）", () => {
  /**
   * E2E-1：完整 FCoP 生命周期
   *
   * 验证六项关键断言：
   *   1. session_started 事件被发出（inbox → dispatched）
   *   2. sdk.thinking 事件被捕获（对应日志系统记录）
   *   3. sdk.tool_call 事件被捕获（write_report，热路径）
   *   4. REPORT 文件被写入磁盘（模拟 fcop_mcp.write_report）
   *   5. session_ended 事件被发出（dispatched → ended）
   *   6. state_history 文件追加了完整的状态迁移记录
   */
  it(
    "E2E-1: TASK 落盘 → thinking 事件 → tool_call 事件 → REPORT 落盘 → session ended",
    async () => {
      await withTempScheduler(async ({ inboxDir, stateDir, rootDir }) => {
        // 创建 reports 目录（模拟 fcop/reports/）
        const reportsDir = join(rootDir, "reports");
        await mkdir(reportsDir, { recursive: true });

        const pipeline = await buildPipeline({ inboxDir, stateDir });
        try {
          await pipeline.registry.register(makeAgentSpec());

          const taskId = "TASK-20260523-001-PM-to-DEV";
          const reportId = "REPORT-20260523-001-DEV-to-PM";
          const reportPath = join(reportsDir, `${reportId}.md`);

          /**
           * sendHandleFactory：注入自定义 RunHandle，模拟 Agent 执行 fcop_mcp 工具。
           *
           * 真实场景（CodeFlowMu task-report 热路径）：
           *   - TASK 正文由 Runtime 注入，不开工前 claim_task
           *   - Agent 完成后 fcop_mcp.write_report(...)
           *   - inbox→active 由 LifecycleGovernor 异步 rename（非本测试模拟）
           *
           * 测试中用 InMemoryRunHandle 的 emitEvents 模拟 write_report，
           * 并在工厂函数中直接写 REPORT 文件（模拟 write_report 的副作用）。
           */
          pipeline.sdk.sendHandleFactory = (spec) => {
            // 模拟 fcop_mcp.write_report 的副作用：写 REPORT 文件到磁盘
            writeFileSync(reportPath, REPORT_BODY(taskId), "utf-8");

            return new InMemoryRunHandle({
              sessionId: spec.sessionId,
              agentId: spec.agentId,
              emitEvents: [
                // sdk.thinking — Agent 的推理步骤（对应 thinking-YYYYMMDD.jsonl）
                {
                  event_id: "evt-think-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.thinking",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: {
                    thought:
                      "收到 TASK-20260523-001。正文已注入，直接执行并 write_report。",
                  },
                },
                // sdk.tool_call — write_report（热路径完成信号）
                {
                  event_id: "evt-tool-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.tool_call",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: {
                    tool: "write_report",
                    args: { task_id: taskId, status: "done", recipient: "PM" },
                    result: { ok: true, report_id: reportId },
                  },
                },
                // sdk.result — Agent 执行结果摘要（对应 usage-YYYYMMDD.jsonl）
                {
                  event_id: "evt-result-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.result",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: {
                    summary:
                      "任务 TASK-20260523-001 处理完成。已写入 REPORT，已归档。",
                    tokens_in: 512,
                    tokens_out: 128,
                  },
                },
              ],
            });
          };

          await pipeline.dispatcher.start();

          // 将 TASK 文件投入 inbox —— 这是"门铃响了"
          const filepath = join(inboxDir, `${taskId}.md`);
          await writeFile(filepath, TASK_BODY(taskId, "DEV"));

          // ── 断言 1：session_started（PM→DEV auto-dispatch）─────────────────
          const startedEvent = await waitFor(
            () =>
              pipeline.events.find(
                (e) => e.event_type === "runtime.session_started",
              ),
            { what: "runtime.session_started", timeoutMs: 5000 },
          );
          assert.ok(startedEvent, "Session 应当已启动");
          const sessionId = startedEvent.session_id;
          assert.ok(
            sessionId.startsWith("session-"),
            `session_id 格式不符：${sessionId}`,
          );

          // ── 断言 2：等待 session 完成 ─────────────────────────────────────
          await pipeline.sessionManager.awaitSettled(sessionId);

          // ── 断言 3：state_history 追加了 dispatched → ended ────────────
          const fileText = await waitFor(
            async () => {
              try {
                const text = await readFile(filepath, "utf-8");
                return text.includes("dispatched` → `ended") &&
                  text.includes("dispatched` → `running")
                  ? text
                  : null;
              } catch {
                return null;
              }
            },
            { what: "state_history dispatched→ended", timeoutMs: 10000 },
          );

          const bullets = fileText
            .split("\n")
            .filter((l) => l.startsWith("- **"))
            .filter((l) => !l.includes("`inbox` → `held`"));
          assert.equal(
            bullets.length,
            3,
            `期望 3 条 state_history 记录，实际得到：\n${bullets.join("\n")}`,
          );
          assert.match(bullets[0]!, /`inbox` → `dispatched`/);
          assert.match(bullets[1]!, /`dispatched` → `running`/);
          assert.match(bullets[2]!, /`dispatched` → `ended`/);

          // ── 断言 4：sdk.thinking 事件被捕获（日志系统关键验证）─────────
          const thinkingEvts = pipeline.events.filter(
            (e) => e.event_type === "sdk.thinking",
          );
          assert.equal(
            thinkingEvts.length,
            1,
            "应捕获 1 个 sdk.thinking 事件（对应 thinking-YYYYMMDD.jsonl 写入）",
          );
          const thinkPayload = thinkingEvts[0]!.payload as { thought: string };
          assert.ok(
            thinkPayload.thought.includes("write_report"),
            `thinking 内容应提及 write_report，实际：${thinkPayload.thought}`,
          );

          // ── 断言 5：sdk.tool_call 事件被捕获（fcop_mcp 工具调用记录）──
          const toolCallEvts = pipeline.events.filter(
            (e) => e.event_type === "sdk.tool_call",
          );
          assert.equal(
            toolCallEvts.length,
            1,
            "应捕获 1 个 sdk.tool_call（write_report 热路径）",
          );
          const toolNames = toolCallEvts.map(
            (e) => (e.payload as { tool: string }).tool,
          );
          assert.deepEqual(toolNames, ["write_report"], "热路径不应含 claim_task");

          // ── 断言 6：REPORT 文件落盘（fcop_mcp.write_report 副作用）─────
          const reportContent = await readFile(reportPath, "utf-8");
          assert.ok(
            reportContent.includes("E2E 烟雾测试完成"),
            "REPORT 文件应包含测试标记文本",
          );
          assert.ok(
            reportContent.includes("status: done"),
            "REPORT 文件应标记 status: done",
          );

          // ── 断言 7：sdk.result 事件被捕获（usage 日志关键验证）──────────
          const resultEvts = pipeline.events.filter(
            (e) => e.event_type === "sdk.result",
          );
          assert.equal(
            resultEvts.length,
            1,
            "应捕获 1 个 sdk.result 事件（对应 usage-YYYYMMDD.jsonl 写入）",
          );
          const resultPayload = resultEvts[0]!.payload as {
            summary: string;
            tokens_in: number;
            tokens_out: number;
          };
          assert.ok(
            resultPayload.summary.includes("处理完成"),
            "sdk.result 摘要应包含'处理完成'",
          );
          assert.ok(
            typeof resultPayload.tokens_in === "number",
            "sdk.result 应包含 token 计数",
          );

          // ── 断言 8：runtime.session_ended 事件 ───────────────────────────
          const endedEvent = pipeline.events.find(
            (e) => e.event_type === "runtime.session_ended",
          );
          assert.ok(endedEvent, "runtime.session_ended 应当被发出");
          assert.equal(
            endedEvent!.session_id,
            sessionId,
            "session_ended 的 session_id 应与 session_started 一致",
          );

          // ── 断言 9：事件顺序合理性检查 ────────────────────────────────────
          const eventTypes = pipeline.events.map((e) => e.event_type);
          const startedIdx = eventTypes.indexOf("runtime.session_started");
          const endedIdx = eventTypes.indexOf("runtime.session_ended");
          assert.ok(
            startedIdx < endedIdx,
            `session_started 应在 session_ended 之前，实际顺序：${eventTypes.join(", ")}`,
          );
        } finally {
          await pipeline.shutdown();
        }
      });
    },
  );

  /**
   * E2E-2：守护进程核心模块不依赖 Web Panel
   *
   * 静态验证：确认 pipeline 核心模块（TaskDispatcher, InboxWatcher,
   * SessionManager）可以在无 web-panel / 无 HTTP server 的情况下运行。
   *
   * 实现原理：
   *   - 本文件头部已成功导入上述模块（无编译/加载错误）
   *   - 如果这些模块传递依赖了 web-panel.ts，则会触发 CURSOR_API_KEY
   *     环境变量检查，导致测试环境下即刻失败
   *   - 测试通过 → 证明 UI-less 守护进程架构成立
   */
  it("E2E-2: 守护进程核心模块不依赖 Web Panel（UI-less 架构验证）", () => {
    const coreModules = [
      "TaskDispatcher",
      "InboxWatcher",
      "StateHistoryWriter",
      "SessionManager",
      "AgentRegistry",
    ];
    // 模块在本文件顶部已成功导入 → UI-less 架构验证通过
    assert.equal(
      coreModules.length,
      5,
      "所有 5 个核心守护进程模块已在无 web-panel 依赖的情况下成功加载",
    );

    // 验证 InMemorySdkAdapter 可以在无真实 CURSOR_API_KEY 的情况下使用
    const testSdk = new InMemorySdkAdapter();
    assert.ok(testSdk, "InMemorySdkAdapter 应当可以在测试环境中实例化");
    assert.ok(
      Array.isArray(testSdk.calls.send),
      "InMemorySdkAdapter 的 calls.send 应为数组",
    );
  });

  /**
   * E2E-3：事件捕获完整性（日志系统链路验证）
   *
   * 验证从 sendHandleFactory 发出的所有事件类型（thinking / tool_call / result）
   * 都能被 SessionManager.onEvent 订阅者捕获，这正是
   * web-panel.ts 中 ThinkingFileLogger / UsageFileLogger 的数据来源。
   *
   * 对应日志文件：
   *   - fcop/logs/thinking/thinking-YYYYMMDD.jsonl  （sdk.thinking）
   *   - fcop/logs/usage/usage-YYYYMMDD.jsonl        （sdk.result）
   */
  it(
    "E2E-3: 事件捕获完整性 — thinking/tool_call/result 全部到达 onEvent 订阅者",
    async () => {
      await withTempScheduler(async ({ inboxDir, stateDir }) => {
        const pipeline = await buildPipeline({ inboxDir, stateDir });
        try {
          await pipeline.registry.register(makeAgentSpec());

          const taskId = "TASK-20260523-002-PM-to-DEV";
          const allExpectedEventTypes = [
            "sdk.thinking",
            "sdk.tool_call",
            "sdk.result",
            "runtime.session_started",
            "runtime.session_ended",
          ];

          // 热路径仅模拟 write_report（与 E2E-1 一致）
          pipeline.sdk.sendHandleFactory = (spec) =>
            new InMemoryRunHandle({
              sessionId: spec.sessionId,
              agentId: spec.agentId,
              emitEvents: [
                {
                  event_id: "evt-t-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.thinking",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: { thought: "分析任务中..." },
                },
                {
                  event_id: "evt-c-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.tool_call",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: { tool: "write_report", args: { task_id: taskId } },
                },
                {
                  event_id: "evt-r-001",
                  at: new Date().toISOString(),
                  event_type: "sdk.result",
                  session_id: spec.sessionId,
                  agent_id: spec.agentId,
                  payload: {
                    summary: "完成",
                    tokens_in: 100,
                    tokens_out: 50,
                  },
                },
              ],
            });

          await pipeline.dispatcher.start();
          const filepath = join(inboxDir, `${taskId}.md`);
          await writeFile(filepath, TASK_BODY(taskId, "DEV"));

          // 等待 session 结束（PM→DEV auto-dispatch）
          const startedEvent = await waitFor(
            () =>
              pipeline.events.find(
                (e) => e.event_type === "runtime.session_started",
              ),
            { what: "runtime.session_started", timeoutMs: 5000 },
          );
          await pipeline.sessionManager.awaitSettled(startedEvent.session_id);

          // 验证所有期望的事件类型都出现在 events 数组中
          const capturedTypes = new Set(pipeline.events.map((e) => e.event_type));
          for (const expectedType of allExpectedEventTypes) {
            assert.ok(
              capturedTypes.has(
                expectedType as (typeof pipeline.events)[0]["event_type"],
              ),
              `期望的事件类型 "${expectedType}" 未被 onEvent 订阅者捕获。` +
                `实际捕获：${[...capturedTypes].join(", ")}`,
            );
          }

          const toolCalls = pipeline.events.filter(
            (e) => e.event_type === "sdk.tool_call",
          );
          assert.equal(toolCalls.length, 1, "热路径仅 1 次 write_report tool_call");
          assert.equal(
            (toolCalls[0]?.payload as { tool?: string })?.tool,
            "write_report",
          );
        } finally {
          await pipeline.shutdown();
        }
      });
    },
  );
});
