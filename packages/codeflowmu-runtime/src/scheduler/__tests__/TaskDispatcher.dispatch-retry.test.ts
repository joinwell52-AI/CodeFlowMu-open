/**
 * P0 总线闭环 — SDK 投递失败短随机退避 + ADMIN 决策（admin-retry / force-archive）
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AgentRegistry } from "../../registry/AgentRegistry.ts";
import { UniversalApprovalStore } from "../../approval/UniversalApprovalStore.ts";
import { InMemorySdkAdapter } from "../../registry/AgentSdkAdapter.ts";
import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { DispatchRetryRegistry } from "../../_internal/DispatchRetryRegistry.ts";
import { SessionManager } from "../../session/SessionManager.ts";
import { SessionStore } from "../../session/SessionStore.ts";
import { TranscriptWriter } from "../../session/TranscriptWriter.ts";
import { InboxWatcher } from "../InboxWatcher.ts";
import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskDispatcher } from "../TaskDispatcher.ts";
import type { DispatchOutcome } from "../TaskDispatcher.ts";

import { quietLogger, waitFor, withTempScheduler } from "./helpers.ts";

import type { Agent } from "@codeflowmu/protocol";

const AGENT_ID = "DEV-01";

const TASK_BODY = (taskId: string, recipient: string): string => `---
protocol: fcop
task_id: ${taskId}
sender: PM
recipient: ${recipient}
priority: P2
status: pending
---

# Body of ${taskId}
`;

function makeAgentSpec(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: AGENT_ID,
    role: "DEV",
    layer: "worker",
    node: "local",
    runtime: "local",
    skills: ["fcop"],
    status: "idle",
    ...overrides,
  };
}

function patchFmState(raw: string, val: string): string {
  const re = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;
  const m = raw.match(re);
  if (!m) return raw;
  const open = m[1] ?? "---\n";
  const yamlBody = m[2] ?? "";
  const close = m[3] ?? "\n---";
  const newYaml = /^state:/m.test(yamlBody)
    ? yamlBody.replace(/^state:.*$/m, `state: ${val}`)
    : `${yamlBody}\nstate: ${val}`;
  return raw.replace(re, `${open}${newYaml}${close}`);
}

function countHistoryTo(text: string, to: string): number {
  return (text.match(new RegExp(`→ \`${to}\``, "g")) ?? []).length;
}

function zeroBackoffRegistry(): DispatchRetryRegistry {
  return new DispatchRetryRegistry({
    backoffRangesMs: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    randomInt: () => 0,
  });
}

async function buildPipeline(inboxDir: string, stateDir: string) {
  const sdk = new InMemorySdkAdapter();
  const registry = new AgentRegistry({
    store: new JsonFileStore({ path: join(stateDir, "agents.json") }),
    sdk,
  });
  const sessionManager = new SessionManager({
    registry,
    sdk,
    sessionStore: new SessionStore({ dir: join(stateDir, "sessions") }),
    transcriptWriter: new TranscriptWriter({
      dir: join(stateDir, "transcripts"),
    }),
  });
  const logger = quietLogger();
  const watcher = new InboxWatcher({ dir: inboxDir, logger });
  const dispatcher = new TaskDispatcher({
    watcher,
    historyWriter: new StateHistoryWriter(),
    registry,
    sessionManager,
    logger,
    dispatchRetryRegistry: zeroBackoffRegistry(),
    minScheduleRetryDelayMs: 0,
  });
  return {
    dispatcher,
    registry,
    sessionManager,
    shutdown: async () => {
      await dispatcher.stop().catch(() => undefined);
    },
  };
}

async function driveToWaitingAdmin(
  pipeline: Awaited<ReturnType<typeof buildPipeline>>,
  taskId: string,
  filepath: string,
) {
  const canonicalTaskId = /^TASK-\d{8}-\d{3,}/i.exec(taskId)?.[0] ?? taskId;
  const retryKey = `${AGENT_ID}:${canonicalTaskId.toUpperCase()}`;
  // PM→DEV auto-dispatches on inbox add; retries run without explicit dispatch_task.
  const rec = await waitFor(
    () => {
      const r = pipeline.dispatcher.getDispatchRetryRecord(retryKey);
      return r?.decisionRequired ? r : null;
    },
    { what: "decisionRequired after 4 failures", timeoutMs: 10_000 },
  );
  const text = await waitFor(
    async () => {
      try {
        const t = await readFile(filepath, "utf-8");
        return countHistoryTo(t, "waiting_admin_decision") === 1 ? t : null;
      } catch {
        return null;
      }
    },
    { what: "waiting_admin_decision history append", timeoutMs: 5000 },
  );
  assert.equal(rec.failureCount, 4);
  assert.equal(countHistoryTo(text, "retry_waiting"), 3);
  assert.equal(countHistoryTo(text, "waiting_admin_decision"), 1);
  assert.doesNotMatch(text, /blocked_runtime/);
  assert.doesNotMatch(text, /`inbox` → `blocked`/);
  return { retryKey, rec };
}

describe("TaskDispatcher dispatch-retry (P0)", () => {
  it("auto-retries 3 times then enters waiting_admin_decision on 4th failure", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        await pipeline.registry.register(makeAgentSpec());
        (
          pipeline.sessionManager as unknown as {
            startSession: SessionManager["startSession"];
          }
        ).startSession = async () => {
          throw new Error("boom");
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-010-PM-to-DEV";
        const filepath = join(inboxDir, `${taskId}.md`);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));

        await driveToWaitingAdmin(pipeline, taskId, filepath);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("adminRetryDispatch succeeds after waiting_admin_decision", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        await pipeline.registry.register(makeAgentSpec());
        const originalStart = pipeline.sessionManager.startSession.bind(
          pipeline.sessionManager,
        );
        let failStart = true;
        (
          pipeline.sessionManager as unknown as {
            startSession: SessionManager["startSession"];
          }
        ).startSession = async (...args) => {
          if (failStart) throw new Error("boom");
          return originalStart(...args);
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-011-PM-to-DEV";
        const filename = `${taskId}.md`;
        const filepath = join(inboxDir, filename);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));

        const { retryKey } = await driveToWaitingAdmin(pipeline, taskId, filepath);
        failStart = false;

        const outcome = await pipeline.dispatcher.adminRetryDispatch(
          filepath,
          filename,
          "DEV",
          retryKey,
        );
        assert.equal(outcome.kind, "dispatched");

        const cleared = pipeline.dispatcher.getDispatchRetryRecord(retryKey);
        assert.equal(cleared, undefined, "registry cleared after success");

        const text = await readFile(filepath, "utf-8");
        assert.match(text, /`inbox` → `dispatched`/);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("adminForceArchiveDispatch blocks further startSession attempts", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        await pipeline.registry.register(makeAgentSpec());
        let startCalls = 0;
        (
          pipeline.sessionManager as unknown as {
            startSession: SessionManager["startSession"];
          }
        ).startSession = async () => {
          startCalls += 1;
          throw new Error("boom");
        };
        await pipeline.dispatcher.start();

        const taskId = "TASK-20260509-012-PM-to-DEV";
        const filename = `${taskId}.md`;
        const filepath = join(inboxDir, filename);
        await writeFile(filepath, TASK_BODY(taskId, "DEV"));

        const { retryKey } = await driveToWaitingAdmin(pipeline, taskId, filepath);
        assert.equal(startCalls, 4);

        await pipeline.dispatcher.adminForceArchiveDispatch(filepath, retryKey);

        const afterArchive = await readFile(filepath, "utf-8");
        assert.equal(countHistoryTo(afterArchive, "admin_force_archive"), 1);

        const rec = pipeline.dispatcher.getDispatchRetryRecord(retryKey);
        assert.ok(rec?.forceArchived);

        const patched = patchFmState(afterArchive, "inbox");
        await writeFile(filepath, patched, "utf-8");

        const dispatch = (
          pipeline.dispatcher as unknown as {
            _dispatch: (
              fp: string,
              fn: string,
              recipient: string,
            ) => Promise<DispatchOutcome>;
          }
        )._dispatch.bind(pipeline.dispatcher);

        const outcome = await dispatch(filepath, filename, "DEV");
        assert.equal(outcome.kind, "force_archived");
        assert.equal(startCalls, 4, "startSession must not run after force archive");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("historical policy rejection is recovered without creating a manual governance freeze", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        await pipeline.registry.register(makeAgentSpec());
        const taskId = "TASK-20260509-013-PM-to-DEV";
        const filename = `${taskId}.md`;
        const filepath = join(inboxDir, filename);
        await writeFile(
          filepath,
          patchFmState(TASK_BODY(taskId, "DEV"), "dispatched"),
          "utf-8",
        );

        const restore = (
          pipeline.dispatcher as unknown as {
            _maybeRestoreInboxAfterFailedSession: (
              event: {
                event_id: string;
                at: string;
                event_type: "runtime.session_ended";
                session_id: string;
                agent_id: string;
                payload: Record<string, unknown>;
              },
              filepath: string,
              filename: string,
            ) => Promise<void>;
          }
        )._maybeRestoreInboxAfterFailedSession.bind(pipeline.dispatcher);

        await restore(
          {
            event_id: "evt-policy-1",
            at: new Date().toISOString(),
            event_type: "runtime.session_ended",
            session_id: "session-policy-1",
            agent_id: AGENT_ID,
            payload: {
              status: "failed",
              task_id: taskId,
              failure_code: "CODEFLOWMU_POLICY_BLOCKED",
              failure_category: "policy_blocked",
              report_written: false,
            },
          },
          filepath,
          filename,
        );

        const retryKey = `${AGENT_ID}:TASK-20260509-013`;
        const rec = pipeline.dispatcher.getDispatchRetryRecord(retryKey);
        assert.equal(rec, undefined);

        const text = await readFile(filepath, "utf-8");
        assert.match(text, /^state: dispatched$/m);
        assert.doesNotMatch(text, /^state: waiting_admin_decision$/m);
        assert.doesNotMatch(text, /^state: needs_replan$/m);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("historical operation boundary denial is recovered without needs_replan", async () => {
    await withTempScheduler(async ({ inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        await pipeline.registry.register(makeAgentSpec());
        const taskId = "TASK-20260731-002-PM-to-QA";
        const filename = `${taskId}.md`;
        const filepath = join(inboxDir, filename);
        await writeFile(
          filepath,
          patchFmState(TASK_BODY(taskId, "DEV"), "dispatched"),
          "utf-8",
        );

        const restore = (
          pipeline.dispatcher as unknown as {
            _maybeRestoreInboxAfterFailedSession: (
              event: {
                event_id: string;
                at: string;
                event_type: "runtime.session_ended";
                session_id: string;
                agent_id: string;
                payload: Record<string, unknown>;
              },
              filepath: string,
              filename: string,
            ) => Promise<void>;
          }
        )._maybeRestoreInboxAfterFailedSession.bind(pipeline.dispatcher);

        await restore(
          {
            event_id: "evt-operation-denied-1",
            at: new Date().toISOString(),
            event_type: "runtime.session_ended",
            session_id: "session-operation-denied-1",
            agent_id: AGENT_ID,
            payload: {
              status: "completed",
              task_id: taskId,
              failure_code: "OPERATION_BOUNDARY_DENIED",
              failure_category: "policy_denied",
              retry_policy: "none",
              operation_fingerprint: "cleanup-deadbeef",
              next_safe_action: "write_report_or_replan_without_replaying_operation",
              report_required: true,
              report_written: false,
            },
          },
          filepath,
          filename,
        );

        const text = await readFile(filepath, "utf-8");
        assert.match(text, /^state: dispatched$/m);
        assert.doesNotMatch(text, /^state: needs_replan$/m);
        assert.doesNotMatch(text, /^dispatch_state: blocked$/m);
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  it("operation approval pause enters waiting_approval without requiring a failure report", async () => {
    await withTempScheduler(async ({ rootDir, inboxDir, stateDir }) => {
      const pipeline = await buildPipeline(inboxDir, stateDir);
      try {
        (pipeline.dispatcher as unknown as { _projectRoot: string })._projectRoot = rootDir;
        await pipeline.registry.register(makeAgentSpec());
        const taskId = "TASK-20260731-003-PM-to-DEV";
        const canonicalTaskId = "TASK-20260731-003";
        const threadKey = "thread-operation-approval";
        const filename = `${taskId}.md`;
        const filepath = join(inboxDir, filename);
        await writeFile(
          filepath,
          patchFmState(TASK_BODY(taskId, "DEV").replace("priority: P2", `priority: P2\nthread_key: ${threadKey}`), "dispatched"),
          "utf-8",
        );
        const fingerprint = "sha256:dispatcher-approval";
        const approvalStore = new UniversalApprovalStore(rootDir);
        const created = approvalStore.createPending({
          request: {
            subject: {
              actor: AGENT_ID,
              role: "DEV",
              project_id: "dispatcher-test",
              agent_id: AGENT_ID,
              session_id: "session-operation-approval-1",
              task_id: canonicalTaskId,
            },
            action: { capability: "git.push", operation: "push", executor: "git.push" },
            resource: { type: "git_remote", targets: ["origin/main"] },
            context: {
              workspace: rootDir,
              environment: "test",
              initiated_by: "agent",
              authorization_source: "none",
            },
            effect: { external_write: true },
            snapshot: {},
          },
          reason: "test approval wait",
          effects: ["remote write"],
          non_effects: ["no task lifecycle mutation"],
          recovery: "resume prior task state",
          rule_ids: ["NEG.EXTERNAL.SIDE_EFFECT"],
          operation_fingerprint: fingerprint,
          thread_key: threadKey,
        });
        assert.equal(created.outcome, "APPROVAL_REQUIRED");
        if (created.outcome !== "APPROVAL_REQUIRED") throw new Error("approval fixture failed");
        approvalStore.deliverAgentNotice(created.notice);
        const restore = (
          pipeline.dispatcher as unknown as {
            _maybeRestoreInboxAfterFailedSession: (
              event: {
                event_id: string;
                at: string;
                event_type: "runtime.session_ended";
                session_id: string;
                agent_id: string;
                payload: Record<string, unknown>;
              },
              filepath: string,
              filename: string,
            ) => Promise<void>;
          }
        )._maybeRestoreInboxAfterFailedSession.bind(pipeline.dispatcher);

        await restore(
          {
            event_id: "evt-operation-approval-1",
            at: new Date().toISOString(),
            event_type: "runtime.session_ended",
            session_id: "session-operation-approval-1",
            agent_id: AGENT_ID,
            payload: {
              status: "waiting_approval",
              task_id: taskId,
              failure_code: "OPERATION_APPROVAL_REQUIRED",
              failure_category: "approval_required",
              operation_fingerprint: fingerprint,
              operation_outcome: {
                approval_id: created.approval.approval_id,
                project_id: created.notice.project_id,
                task_id: created.notice.task_id,
                thread_key: created.notice.thread_key,
                role: created.notice.role,
                operation_fingerprint: created.notice.operation_fingerprint,
              },
              report_required: false,
              report_written: false,
            },
          },
          filepath,
          filename,
        );

        const text = await readFile(filepath, "utf-8");
        assert.match(text, /^state: waiting_approval$/m);
        assert.match(text, /^dispatch_state: waiting_approval$/m);
        assert.match(text, /^failure_category: approval_required$/m);
        assert.match(text, new RegExp(`^approval_id: ${created.approval.approval_id}$`, "m"));
        assert.doesNotMatch(text, /^report_required: true$/m);
        assert.doesNotMatch(text, /^state: inbox$/m);
      } finally {
        await pipeline.shutdown();
      }
    });
  });
});
