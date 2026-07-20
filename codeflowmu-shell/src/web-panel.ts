/**
 * codeflowmu Web Panel — Express server v1.2 (v0.3 doorbell persistence).
 *
 * Responsibilities:
 *   1. Serve `codeflowmu-desktop/panel/` as static assets on :18766.
 *   2. Mount /api/v2/ REST endpoints — agents, tasks, reviews, sessions.
 *   3. GET /api/v2/events — Server-Sent Events stream (v1.1):
 *      Pushes all RuntimeEvents + custom codeflowmu events to connected browsers.
 *      Event types pushed:
 *        - runtime.session_started / runtime.session_ended / runtime.session_cancelled
 *        - sdk.assistant / sdk.tool_call  (text + tool calls from agent)
 *        - codeflowmu.task_dispatched       (InboxWatcher picked up a file)
 *        - codeflowmu.report_detected       (ReportWatcher picked up a report)
 *        - codeflowmu.heartbeat             (every 15 s, keeps connection alive)
 *   4. GET /api/v2/doorbell/* — Persistent event query (v1.2 NEW):
 *      /doorbell/events   — tool-call events (sdk.tool_call)
 *      /doorbell/failures — failure events   (codeflowmu.failure)
 *      /doorbell/system   — system events    (sdk.thinking, sdk.status)
 *      All three share the same ring buffer (max 1000 entries, LRU eviction).
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, basename as pathBasename, resolve as pathResolve } from "node:path";
import * as path from "node:path";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { execFile as execFileCb, exec as execCb, spawn as spawnProc } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import { CursorUsageSyncer } from "./cursor-usage-syncer.ts";
import { enrichIssueMetadata } from "./issue-enrichment.ts";
import {
  fcopV3Paths,
  fcopV3TaskSearchDirs,
  findTaskFile,
  findTaskFileByIdPrefix,
  checkFcop0002WorkFolders,
  checkRoleTemplateHealth,
  detectFcopLayoutRisks,
  detectLegacyV2OnlyDirs,
  countInboxTasks,
  countLifecycleTasks,
  verifyFcopProjectInit,
  checkSkillsManifestHealth,
} from "./fcop-v3-paths.ts";
import {
  loadProjectRegistry,
  saveProjectRegistry,
} from "./project-registry.ts";
import { formatDevelopmentProjectContextBlock } from "./project-context-prompt.ts";
import {
  executeSingleWorkspaceMigration,
  listWorkspaceSlugs,
  planSingleWorkspaceMigration,
  resolveArtifactRoot,
  writeWorkspaceMode,
  type WorkspaceMode,
} from "./artifact-layout.ts";
import { pickDirectoryNative } from "./pick-directory.ts";
import { pickExecutableNative, sanitizeExecutablePickerInitialPath } from "./pick-executable.ts";
import { listCommonWindowsUseAppCandidates } from "./windows-use-app-catalog.ts";
import {
  cleanProjectRuntime,
  listCleanRuntimeTargets,
  verifyPostCleanRuntime,
} from "./project-clean-runtime.ts";
import {
  DEFAULT_AGENT_RECYCLE_CONFIG,
  getAgentSessionStats as countSessionsFromThinkingLog,
  loadRecycleState,
  saveRecycleState,
  sessionsSinceLastRecycle,
  shouldAutoRecycleAgent,
  type AgentRecycleConfig,
} from "./agent-recycle.ts";
import {
  decidePmHeartbeatPolicy,
  readPmHeartbeatConfig,
  writePmHeartbeatConfig,
  type PmHeartbeatConfig,
} from "./pm-heartbeat-config.ts";
import {
  formatAdoptedRuntimeEffectiveWakeSection,
  loadAdoptedPendingReport,
} from "./fcop-adopted-pending.ts";
import {
  buildAdoptedBootstrapHealthCheck,
  ensureAdoptedFromSource,
} from "./fcop-adopted-bootstrap.ts";
import { executeLifecycleRuntimeAction, setLifecyclePanelSink } from "./lifecycle-runtime-bridge.ts";
import {
  ingestRuntimeAlertFromSse,
  registerRuntimeAlertRoutes,
} from "./runtime-alerts.ts";
import { callWindowsUseHost } from "./windows-use-host-client.ts";
import {
  readWindowsUseSettings,
  deleteWindowsUseTarget,
  listWindowsUseTargets,
  resolveEffectiveWindowsUseSettings,
  upsertWindowsUseTarget,
  writeWindowsUseAllowedTargetIds,
  writeWindowsUseSettings,
} from "./windows-use-settings.ts";
import {
  deleteBrowserUseTarget,
  listBrowserUseTargets,
  readBrowserUseSettings,
  upsertBrowserUseTarget,
  writeBrowserUseSettings,
} from "./browser-use-settings.ts";
import {
  browserUseLoginRecordingStatus,
  cancelBrowserUseLoginRecording,
  finishBrowserUseLoginRecording,
  startBrowserUseLoginRecording,
} from "./browser-use-recorder.ts";
import {
  ensureLedgerFresh,
  invalidateLedgerFreshCache,
  finalizeTaskCreateAfterDiskWrite,
  readLedgerThreadsAuto,
  readLedgerViewMarkdownAuto,
  listTasksFromLedgerAuto,
  listReportsFromLedgerAuto,
  readTaskReportScopes,
  readAdminTaskCloseout,
  generateAdminTaskCloseoutEval,
  aggregateApprovalHistoryFromLedger,
  enrichApprovalHistoryFromReviews,
} from "./ledger-api-helpers.ts";
import { enrichTasksWithReviewAttention } from "./review-attention.ts";
import {
  buildTaskStats,
  clearOrphanDiagnostic,
  getDiagnosticById,
  getDiagnosticsListResponseConfirmed,
  rescanDiagnostics,
} from "./diagnostics-api-helpers.ts";
import { resolveReportPathForAfterWrite } from "./panel-report-path.ts";
import {
  inferredBodyTaskMentionsFromMarkdown,
  structuredLinkedTaskIdsFromReport,
} from "./panel-report-aggregation.ts";
import {
  resolveReportAfterWrite,
  buildSdkFailurePayloadFields,
  pickSdkFailureFieldsFromPayload,
  findTaskPathByIdSync,
  getAdminTaskCloseout,
  type AdminTaskCloseout,
  evaluateWorkerReceiptWaiting,
  type WorkerReceiptWaitingPhase,
  type LedgerTaskRecord,
  type LedgerReportRecord,
  isPmToWorkerDispatch,
  resolveTaskCurrentBucket,
  isWorkerReceiptWaitingBucket,
  resolveWorkerReceiptDurableHints,
  mergeWorkerReceiptSignals,
  persistWorkerReceiptFailed,
  clearWorkerReceiptFailed,
  pruneStaleDownstreamReceiptFailures,
  pickQueueWorkerReceiptState,
  recoverTaskExecution,
  scheduleDelayedPmWakeRetry,
  adminForceRecovery,
  evaluateSequentialDispatchGuard,
  markPmStop,
  shouldEscalateAdminForceRecovery,
  ADMIN_FORCE_RECOVERY_POLICY,
  PM_STOP_POLICY,
  reconcileAgentTaskState,
  findPmSummaryBlockers,
  appendAgentReconcileEvent,
  isRecoverableSessionFailure,
  aggregateLifecycleCountsFromPhysical,
  collectPmOpenMainlineTasks,
  shouldShowThreadOnTeamDynamics,
  listExecutingEvidence,
  terminateSingleChildAsParentResidue,
  TaskFrontmatterStore,
  trimTaskTransitions,
} from "@codeflowmu/runtime";
import {
  detectClosedParentResidueTasks,
  hasStateBucketMismatch,
  isClosedParentResidueMarked,
  taskIdFromFilename,
} from "./panel-task-thread-visibility.ts";
import { isReworkResubmitUnblocked } from "./panel-task-rework-report.ts";
import {
  promoteEvalToLocalTask,
  readEvalPromotionState,
  promoteEvalToCodeflowMuIssueDraft,
  promoteEvalToFcopIssueDraft,
  submitEvalIssueDraft,
  submitEvalLocalTaskDraft,
  deleteEvalPromotionDraft,
  formatEvalTaskPromoteGateError,
} from "./eval-promotion.ts";
import { logPanelApiTiming, panelApiPathLabel } from "./panel-api-timing.ts";
import {
  appendPanelRuntimeAction,
  queryPanelRuntimeActions,
  maybeRecordPanelRuntimeActionFromSse,
  fcopLogsPanelActionsPath,
  type PanelRuntimeActionInput,
} from "./panel-runtime-actions.ts";
import { resolveTaskRelPath } from "./panel-task-path.ts";
import { createMobileRoutes } from "./mobile/index.ts";
import { filterReachableLanInterfaces } from "./mobile/lanNetwork.ts";
import { formatMobileSseEvent } from "./mobile/mobileEvents.ts";
import { isMobileGatewayOnline, startMobileGatewayClient, stopMobileGatewayClient } from "./mobile/mobileGatewayClient.ts";
import {
  ingestMobileSse,
  ingestMobileThinking,
  ingestMobileToolCall,
} from "./mobile/mobileActivityIngest.ts";
import type { MobilePanelContext } from "./mobile/types.ts";
import { evaluateUnstickOutcome, type UnstickStepResult } from "./task-unstick.ts";
import {
  runAgentReconcile,
  handleSwapAiWithReconcile,
  checkPmSummaryAllowed,
} from "./agent-reconcile-hooks.ts";
import {
  initAutoRecoveryBridge,
  stopAutoRecoveryBridge,
  triggerPanelAutoRecovery,
  getPanelAutoRecoverySnapshot,
  scheduleSessionStartedStallCheck,
} from "./autoRecoveryBridge.ts";
import { taskRouteFromFilename as wpTaskRouteFromFilename } from "./fcop-filename-route.ts";
import {
  summarizeThread,
  resolveThreadContext,
  detectThreadStall,
  closeAdminTaskDraft,
  buildWakeDownstreamRequest,
  appendWakeJournal,
  reviewCheck,
  listPmSkillsForRole,
  readPmSkillManifest,
  formatPmBuiltinSkillsPlaybookBlock,
  runPmGovernanceCycle,
  readRecentPmGovernanceCycles,
  formatPmGovernanceCycleBlock,
  flattenRecentPmGovernanceDecisions,
  readRecentSkillInvocations,
  enrichSkillInvocationsForDisplay,
  skillInvocationToLogCenterRow,
  skillInvocationJournalPath,
  readRecentActionEvidence,
  actionEvidenceToLogCenterRow,
  actionEvidenceDisplayPath,
  invokePmSkillWithJournal,
  recordSkillInvocation,
  recordPlanningSkillEvidence,
  maybeRecordPlaybookSkillFromToolCall,
  maybeRecordActionEvidenceFromToolCall,
  resolveAndInjectPmPlaybookSkills,
  CheckThrottle,
  isTransientSdkError,
  TransientSdkDelayedError,
  findReportForTaskOnDisk,
  ensureLedgerLayout,
  buildAdminRejectPmWakeRequest,
  buildPmAdminRejectReworkPromptBlock,
  extractPmAdminRejectTodoSection,
  extractTaskIdPrefixesFromText,
  resolveAdminRejectExecutionMode,
  shouldEscalatePmChatToAdminRejectColdPath,
  shouldEscalatePmChatToAdminRejectHotPath,
  type WakeDownstreamExecutor,
  type WakeDownstreamExecutorResult,
  type WakeDownstreamRequest,
  parseMarkdownFrontmatter,
  strField,
  type SessionSdkImage,
  normalizeUiLang,
  writePanelUiLang,
  readPanelUiLang,
  alignChatReplyWithThinking,
  type UiLang,
  loadAgentSkillsCatalog,
  AgentSkillsManifestMissingError,
  AgentSkillsManifestReadError,
  AgentSkillsManifestInvalidError,
  plantPmSkillManifestIfMissing,
  plantAgentSkillsManifestIfMissing,
  isTaskReopenedForReworkFromLedger,
  stageFromPath,
  isCanonicalReportMarkdownFilename,
  atomicWriteFcopMarkdown,
  TaskParser,
  validateDurableTaskForDispatch,
  agentWakeMutex,
  evaluateAgentWakeGate,
  evaluateTaskDispatchWakeGate,
  humanApprovalApprovedAt,
  isReviewPendingHuman,
  reviewMatchesScope,
  loadReviewDecisionPolicy,
  saveReviewDecisionPolicy,
  buildReviewGateApprovalCard,
  findReportPathForTaskOnDisk,
  REVIEW_GATE_RED_FLAG_LABELS,
  DownstreamAutoNudge,
  getAgentQueueApiSnapshot,
  enqueueTaskWhenAgentBusy,
  advanceAgentQueue,
  getTaskDispatchStatus,
  evaluateProductDeliveryGate,
  writePlanningArtifact,
  recordPlanningLevelOverride,
  evaluatePmSummaryGate,
  OperationApprovalError,
  OperationApprovalService,
  type CapabilityRequest,
  type OperationApprovalStatus,
} from "@codeflowmu/runtime";
import { buildGitPushApprovalInput, executeGitPushApproval } from "./git-operation-approval.ts";
import { confirmOperationDecisionNative, confirmOperationImpactNative } from "./native-operation-confirm.ts";
import { RuntimeEventFileLogger, RUNTIME_EVENT_TYPES } from "./runtime-event-logger.ts";
import { ensureFcopLogsAssetLayout } from "./logs-paths.ts";
import {
  fcopChatDir,
  fcopChatPathForDate,
  listChatReadPaths,
} from "./chat-paths.ts";
import {
  queryLogCenter,
  type LogCenterQueryParams,
  type LogCenterRow,
} from "./log-center.ts";
import {
  appendGatewayLog,
  gatewayLogToLogCenterRow,
  readRecentGatewayLogs,
  fcopLogsGatewayPath,
} from "./gateway-log.ts";
import {
  readEvalObserverConfig,
  writeEvalObserverConfig,
  stopEvalWatcher,
  getEvalWatcherStatus,
  spawnEval01,
  startEvalWatcherIfConfigured,
  createEvalScheduleChecker,
  type EvalObserverConfig,
} from "./eval-observer-config.ts";
import { readEvalRunProgress } from "./eval-run-progress.ts";
import {
  AnalyticsLedger,
  analyticsFieldsFromDimensions,
  type AnalyticsDimensions,
  type AnalyticsQueryParams,
} from "./analytics-ledger.ts";
import {
  ThinkingFileLogger,
  type ThinkingChannel,
} from "./thinking-file-logger.ts";
import {
  isTeamVisibleReportFilename,
  listEvalAuditFiles,
  fcopInternalEvalDir,
} from "./fcop-governance.ts";
import { formatPanelRuntimeIdentityBlock } from "./panel-runtime-identity.ts";
import { extractSdkThinkingText } from "./chat-thinking-align.ts";
import { collectFormalChatHistory } from "./chat-formal-history.ts";

const execFile = promisify(execFileCb);
const execAsync = promisify(execCb);
const WEB_PANEL_PROCESS_STARTED_AT_TS = Math.round(Date.now() - process.uptime() * 1000);

/** 同一 task_id / thread_key 30–60s 内最多一次 PM 治理状态检查。 */
const statusCheckThrottle = CheckThrottle.forStatusChecks();

/** 同一 task_id / thread_key / agent_id 30–60s 内最多一次 wake / startSession。 */
const wakeCheckThrottle = CheckThrottle.forWakes();

/** REPORT 落盘后 PM 治理周期节流（避免 chokidar 连发）。 */
const reportArrivalGovernanceThrottle = new CheckThrottle(3_000);

/** ADMIN 打回后 PM 唤醒节流（避免连点 reject）。 */

/** 普通 wake / 巡检 / 未显式传参的 session 默认工具轮次（避免过早 TURN_LIMIT）。 */
const DEFAULT_SESSION_MAX_TOOL_ROUNDS = 100;
/** Patrol / 巡检：限制工具轮次，避免 Gemini 重复 function call 导致会话卡死。 */
const PATROL_SESSION_MAX_TOOL_ROUNDS = 8;

function wakeThrottleKey(
  taskId: string,
  threadKey: string | undefined,
  agentId: string,
): string {
  return [taskId, threadKey ?? "", agentId].join("|");
}

/** Skip Cursor Admin API billing sync; today panel uses local usage JSONL only. */
function isCursorAdminUsageSyncDisabled(): boolean {
  const v = (process.env["CODEFLOW_CURSOR_USAGE_SYNC"] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

// ── UsageFileLogger — auto-save sdk.result events to fcop/logs/usage/ ─────
/**
 * Appends sdk.result events (containing SDKResultMessage with usage + cost)
 * to a daily JSONL file under <projectRoot>/fcop/logs/usage/.
 *
 * File naming: usage-YYYYMMDD.jsonl
 * Schema: per SPEC-codeflowmu-token-tracking §2 — same envelope as thinking-*.jsonl
 *         but event_type is "sdk.result" and payload.raw is SDKResultMessage.
 */
class UsageFileLogger {
  private readonly _dir: string;
  private _currentDate = "";
  private _currentPath = "";
  /** session_id → task_id binding from runtime.session_started / wake API */
  private _sessionTasks = new Map<string, string>();
  /** session_id → thread_key binding from wake API */
  private _sessionThreads = new Map<string, string>();

  constructor(projectRoot: string) {
    this._dir = join(projectRoot, "fcop", "logs", "usage");
    try { mkdirSync(this._dir, { recursive: true }); } catch {}
  }

  noteSessionTask(sessionId: string, taskId: string): void {
    const sid = String(sessionId ?? "").trim();
    const tid = String(taskId ?? "").trim();
    if (sid && tid) this._sessionTasks.set(sid, tid);
  }

  getSessionTask(sessionId: string): string | undefined {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return undefined;
    const tid = this._sessionTasks.get(sid);
    return tid?.trim() || undefined;
  }

  noteSessionThread(sessionId: string, threadKey: string): void {
    const sid = String(sessionId ?? "").trim();
    const tk = String(threadKey ?? "").trim();
    if (sid && tk) this._sessionThreads.set(sid, tk);
  }

  append(event: Record<string, unknown>, dims?: AnalyticsDimensions): void {
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      if (today !== this._currentDate) {
        this._currentDate = today;
        this._currentPath = join(this._dir, `usage-${today}.jsonl`);
      }
      const sessionId = String(event["session_id"] ?? "");
      const payload = (event["payload"] ?? {}) as Record<string, unknown>;
      const raw = (payload["raw"] ?? {}) as Record<string, unknown>;
      let taskId = String(payload["task_id"] ?? raw["task_id"] ?? "");
      if (!taskId && sessionId) taskId = this._sessionTasks.get(sessionId) ?? "";
      let threadKey = String(payload["thread_key"] ?? raw["thread_key"] ?? "");
      if (!threadKey && sessionId) threadKey = this._sessionThreads.get(sessionId) ?? "";
      const line = JSON.stringify({
        ts: Date.now(),
        at: new Date().toISOString(),
        event_type: "sdk.result",
        agent_id: event["agent_id"] ?? "",
        session_id: sessionId,
        task_id: taskId || undefined,
        thread_key: threadKey || undefined,
        ...(dims ? analyticsFieldsFromDimensions(dims) : {}),
        payload,
      });
      // Defer write to I/O idle slot to avoid blocking the run-close path.
      const path = this._currentPath;
      setImmediate(() => {
        try { appendFileSync(path, line + "\n", "utf-8"); } catch { /* best-effort */ }
      });
    } catch {
      // Best-effort — never crash the runtime for a log write failure.
    }
  }

  /** Aggregate today's records for dashboard. */
  aggregateToday(): {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_estimated_input_tokens: number;
    total_estimated_tool_schema_tokens: number;
    total_runs: number;
    by_agent: Record<string, { cost: number; runs: number }>;
    by_thread: Record<string, { cost: number; runs: number }>;
    by_task: Record<string, { cost: number; runs: number }>;
    by_model: Record<string, { cost: number; input_tokens: number; output_tokens: number; estimated_input_tokens: number; estimated_tool_schema_tokens: number }>;
  } {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filePath = join(this._dir, `usage-${today}.jsonl`);
    const result = {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_estimated_input_tokens: 0,
      total_estimated_tool_schema_tokens: 0,
      total_runs: 0,
      by_agent: {} as Record<string, { cost: number; runs: number }>,
      by_thread: {} as Record<string, { cost: number; runs: number }>,
      by_task: {} as Record<string, { cost: number; runs: number }>,
      by_model: {} as Record<string, { cost: number; input_tokens: number; output_tokens: number; estimated_input_tokens: number; estimated_tool_schema_tokens: number }>,
    };
    if (!existsSync(filePath)) return result;
    try {
      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        const rec = JSON.parse(line) as {
          agent_id?: string;
          task_id?: string;
          thread_key?: string;
          session_id?: string;
          payload?: { raw?: {
            total_cost_usd?: number;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              estimated_input_tokens?: number;
              estimated_tool_schema_tokens?: number;
            };
            modelUsage?: Record<string, {
              costUSD?: number;
              inputTokens?: number;
              outputTokens?: number;
              estimatedInputTokens?: number;
              estimatedToolSchemaTokens?: number;
            }>;
            thread_key?: string | null;
            task_id?: string | null;
          }};
        };
        const raw = rec.payload?.raw;
        if (!raw) continue;
        const cost = raw.total_cost_usd ?? 0;
        const inp = raw.usage?.input_tokens ?? 0;
        const out = raw.usage?.output_tokens ?? 0;
        const estimatedInp = raw.usage?.estimated_input_tokens ?? 0;
        const estimatedToolSchema = raw.usage?.estimated_tool_schema_tokens ?? 0;
        const agentId = rec.agent_id ?? "(unknown)";
        const threadKey =
          rec.thread_key ??
          raw.thread_key ??
          (rec.session_id ? this._sessionThreads.get(rec.session_id) : undefined) ??
          "(no thread)";
        const taskKey =
          rec.task_id ??
          raw.task_id ??
          (rec.session_id ? this._sessionTasks.get(rec.session_id) : undefined) ??
          "(no task)";
        result.total_cost_usd += cost;
        result.total_input_tokens += inp;
        result.total_output_tokens += out;
        result.total_estimated_input_tokens += estimatedInp;
        result.total_estimated_tool_schema_tokens += estimatedToolSchema;
        result.total_runs += 1;
        result.by_agent[agentId] ??= { cost: 0, runs: 0 };
        result.by_agent[agentId].cost += cost;
        result.by_agent[agentId].runs += 1;
        result.by_thread[threadKey] ??= { cost: 0, runs: 0 };
        result.by_thread[threadKey].cost += cost;
        result.by_thread[threadKey].runs += 1;
        if (taskKey && taskKey !== "(no task)") {
          const tk = String(taskKey);
          result.by_task[tk] ??= { cost: 0, runs: 0 };
          result.by_task[tk].cost += cost;
          result.by_task[tk].runs += 1;
        }
        for (const [model, mu] of Object.entries(raw.modelUsage ?? {})) {
          result.by_model[model] ??= { cost: 0, input_tokens: 0, output_tokens: 0, estimated_input_tokens: 0, estimated_tool_schema_tokens: 0 };
          result.by_model[model].cost += mu.costUSD ?? 0;
          result.by_model[model].input_tokens += mu.inputTokens ?? 0;
          result.by_model[model].output_tokens += mu.outputTokens ?? 0;
          result.by_model[model].estimated_input_tokens += mu.estimatedInputTokens ?? 0;
          result.by_model[model].estimated_tool_schema_tokens += mu.estimatedToolSchemaTokens ?? 0;
        }
      }
    } catch {
      // Corrupt line — skip gracefully.
    }
    return result;
  }

  /** List available usage log files (newest first). */
  listFiles(): Array<{ filename: string; date: string; size_bytes: number }> {
    try {
      return readdirSync(this._dir)
        .filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"))
        .map((f) => {
          const full = join(this._dir, f);
          const stat = statSync(full);
          return { filename: f, date: f.replace("usage-", "").replace(".jsonl", ""), size_bytes: stat.size };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch { return []; }
  }
}

// ── Sprint-7: Multi-project store ─────────────────────────────────────────
interface Project {
  id: string;
  name: string;
  root: string;
  active: boolean;
}
const projectStore = new Map<string, Project>();
let activeProjectId = "default";
let projectStoreHydrated = false;

function persistProjectStore(): void {
  saveProjectRegistry(
    activeProjectId,
    Array.from(projectStore.values()).map(({ id, name, root }) => ({
      id,
      name,
      root,
    })),
  );
}

function samePath(a: string, b: string): boolean {
  return pathResolve(a).toLowerCase() === pathResolve(b).toLowerCase();
}

function isPathWithinOrSame(parent: string, child: string): boolean {
  const parentResolved = pathResolve(parent);
  const childResolved = pathResolve(child);
  if (samePath(parentResolved, childResolved)) return true;
  const relative = path.relative(parentResolved, childResolved);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function openEditionProtectedHostRoot(): string | null {
  if (process.env["CODEFLOW_OPEN_EDITION"] !== "1") return null;
  const explicit = process.env["CODEFLOW_OPEN_HOST_ROOT"];
  if (explicit?.trim()) return pathResolve(explicit);
  return resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
}

function openEditionProjectsRoot(protectedRoot: string): string {
  return pathResolve(protectedRoot, "projects");
}

/**
 * Resolve the installation-level independent-project collection.
 * It must stay stable when the active project changes; otherwise switching to
 * projects/foo would incorrectly suggest projects/foo/projects/bar.
 */
function projectsCollectionRoot(bootstrapProjectRoot: string): string {
  const explicit = process.env["CODEFLOW_PROJECTS_ROOT"]?.trim();
  if (explicit) return pathResolve(explicit);
  const protectedRoot = openEditionProtectedHostRoot();
  if (protectedRoot) return openEditionProjectsRoot(protectedRoot);
  const bootstrapRoot = pathResolve(bootstrapProjectRoot);
  const parent = dirname(bootstrapRoot);
  if (pathBasename(parent).toLowerCase() === "projects") return parent;
  const monorepoRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
  if (monorepoRoot && isPathWithinOrSame(monorepoRoot, bootstrapRoot)) {
    return pathResolve(monorepoRoot, "projects");
  }
  return pathResolve(parent, "projects");
}

function openEditionDefaultProjectRoot(protectedRoot: string): string {
  return pathResolve(openEditionProjectsRoot(protectedRoot), "newproject");
}

function ensureOpenEditionProjectDirectory(root: string): void {
  mkdirSync(root, { recursive: true });
  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      [
        "# newproject",
        "",
        "This is the default CodeFlowMu Open team project.",
        "Its fcop/ directory stores collaboration records; an internal workspace/ is only used for multi-product business artifacts.",
        "Initialize FCoP here, then ask the PM / DEV / OPS / QA / EVAL agents to work on this project.",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
}

function isOpenEditionInstallLocalProjectPath(root: string): boolean {
  const protectedRoot = openEditionProtectedHostRoot();
  if (!protectedRoot) return false;
  const resolved = pathResolve(root);
  return ["projects", "workspace"].some((collectionName) => {
    const collectionRoot = pathResolve(protectedRoot, collectionName);
    return !samePath(collectionRoot, resolved) && isPathWithinOrSame(collectionRoot, resolved);
  });
}

function isOpenEditionProtectedPath(root: string): boolean {
  const protectedRoot = openEditionProtectedHostRoot();
  if (!protectedRoot) return false;
  if (isOpenEditionInstallLocalProjectPath(root)) return false;
  return isPathWithinOrSame(protectedRoot, root);
}

function ensureOpenEditionDefaultProject(protectedRoot: string): Project {
  const root = openEditionDefaultProjectRoot(protectedRoot);
  ensureOpenEditionProjectDirectory(root);
  const project = {
    id: "open-default-newproject",
    name: "newproject",
    root,
    active: false,
  };
  projectStore.set(project.id, project);
  if (!activeProjectId || !projectStore.has(activeProjectId)) {
    activeProjectId = project.id;
  }
  return project;
}

function hydrateProjectStore(bootstrapRoot: string): void {
  if (projectStoreHydrated) return;
  projectStoreHydrated = true;
  const reg = loadProjectRegistry(bootstrapRoot);
  const protectedRoot = openEditionProtectedHostRoot();
  projectStore.clear();
  activeProjectId = "";
  for (const p of reg.projects) {
    if (protectedRoot && p.id === "default") continue;
    if (!protectedRoot && p.id === "open-default-newproject") continue;
    if (protectedRoot && isOpenEditionProtectedPath(p.root)) continue;
    projectStore.set(p.id, {
      id: p.id,
      name: p.name,
      root: pathResolve(p.root),
      active: false,
    });
  }
  if (!protectedRoot) {
    if (projectStore.has(reg.activeProjectId)) {
      activeProjectId = reg.activeProjectId;
    } else {
      const first = Array.from(projectStore.values()).find((p) => existsSync(p.root));
      activeProjectId = first?.id ?? "";
    }
    if (projectStore.size === 0) {
      const root = pathResolve(bootstrapRoot);
      projectStore.set("default", {
        id: "default",
        name: defaultProjectDisplayName(root),
        root,
        active: false,
      });
      activeProjectId = "default";
    }
    if (!reg.loadedFromDisk) persistProjectStore();
    return;
  }
  if (projectStore.has(reg.activeProjectId)) {
    activeProjectId = reg.activeProjectId;
  } else {
    const first = Array.from(projectStore.values()).find((p) => existsSync(p.root));
    activeProjectId = first?.id ?? "";
  }
  if (projectStore.size === 0 && !protectedRoot) {
    const root = pathResolve(bootstrapRoot);
    projectStore.set("default", {
      id: "default",
      name: defaultProjectDisplayName(root),
      root,
      active: false,
    });
    activeProjectId = "default";
  }
  if (projectStore.size === 0 && protectedRoot) {
    ensureOpenEditionDefaultProject(protectedRoot);
  }
  if (protectedRoot && !projectStore.has("open-default-newproject")) {
    const defaultRoot = openEditionDefaultProjectRoot(protectedRoot);
    if (!Array.from(projectStore.values()).some((p) => samePath(p.root, defaultRoot))) {
      ensureOpenEditionDefaultProject(protectedRoot);
    }
  }
  // Keep a valid persisted active project.  `newproject` is only the fallback
  // created for a first run; it must not overwrite the user's Panel choice on
  // every Open-edition startup.
  if (!reg.loadedFromDisk || protectedRoot) {
    persistProjectStore();
  }
}

/** Walk upward from `start` to find a directory containing `fcop/fcop.json`. */
function findFcopProjectRoot(start: string): string | null {
  let dir = pathResolve(start);
  const startAbs = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "fcop", "fcop.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function defaultProjectDisplayName(root: string): string {
  const base = pathBasename(pathResolve(root));
  return base && base !== "." ? base : "codeflowmu";
}

function initProjectStore(defaultRoot: string): void {
  const root = pathResolve(defaultRoot);
  const protectedRoot = openEditionProtectedHostRoot();
  if (protectedRoot && samePath(root, protectedRoot)) {
    activeProjectId = projectStore.has(activeProjectId) ? activeProjectId : "";
    return;
  }
  const name = defaultProjectDisplayName(root);
  if (projectStore.size === 0) {
    projectStore.set("default", {
      id: "default",
      name,
      root,
      active: true,
    });
    return;
  }
  const existing = projectStore.get("default");
  if (existing && existing.name === "Default" && samePath(existing.root, root)) {
    projectStore.set("default", { ...existing, name });
  }
}

function projectList(): Array<Project & Record<string, unknown>> {
  return Array.from(projectStore.values()).map((p) => {
    const slugs = listWorkspaceSlugs(p.root);
    const layout = resolveArtifactRoot(p.root, slugs.length === 1 ? slugs[0] : undefined);
    const codeRoot = layout.mode === "multi" && slugs.length !== 1
      ? join(layout.projectRoot, "workspace", "<slug>")
      : layout.artifactRoot;
    return {
      ...p,
      active: p.id === activeProjectId,
      workspaceMode: layout.mode,
      workspaceModeExplicit: layout.explicit,
      workspaceModeNeedsSelection: layout.requiresAdminSelection,
      codeRoot,
      artifactLayout: layout.mode === "multi" && slugs.length !== 1
        ? "workspace/<slug>"
        : layout.relativeArtifactRoot,
    };
  });
}

import express, { type Request, type Response } from "express";
import type { Runtime } from "@codeflowmu/runtime";
import type { AgentSdkAdapter } from "@codeflowmu/runtime";
import {
  DoorbellBuffer,
  DOORBELL_BUCKET_TOOLS,
  DOORBELL_BUCKET_FAILURES,
  DOORBELL_BUCKET_SYSTEM,
  type DoorbellQueryOpts,
} from "./doorbell-buffer.js";
import { FailureLogger, type FailureType } from "./failure-logger.js";
import {
  probeFcopPythonPackages,
  readFcopJsonMeta,
  evaluateFcopEnvGate,
  readFcopRulesVersion,
  readShellVersion,
  buildFcopPackageVersionReport,
  buildProtocolUpgradeReport,
  FCOP_MIN_PACKAGE_VERSION,
  __resetFcopProbeCacheForTests,
  type FcopRuntimeSeed,
} from "./fcop-env-probe.ts";
import {
  FCOP_MCP_TOOL_DESC,
  FCOP_MCP_TOOL_GROUPS,
  fcopMcpToolCount,
} from "./fcop-mcp-catalog.ts";
import { readCodeflowmuVersionManifest } from "./mobile/mobileVersion.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** codeflowmu-shell package root (directory containing package.json). */
const SHELL_PKG_ROOT = join(__dirname, "..");

/**
 * If `shellPkgRoot` is …/codeflowmu-shell inside the standard monorepo layout,
 * returns the repo root (parent). Otherwise null.
 */
function resolveMonorepoRootFromShellPkg(shellPkgRoot: string): string | null {
  if (pathBasename(shellPkgRoot) !== "codeflowmu-shell") return null;
  const parent = dirname(shellPkgRoot);
  if (!existsSync(join(parent, "package.json"))) return null;
  if (!existsSync(join(parent, "codeflowmu-shell", "package.json"))) return null;
  return parent;
}

/** Best-effort log when panel restart spawn fails (ignored by git via *.log). */
function appendRestartSpawnLog(line: string): void {
  try {
    appendFileSync(join(SHELL_PKG_ROOT, ".restart-spawn.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Spawns `npm` to bring shell back after this process exits.
 * Windows: uses `shell: true` so `npm` resolves like an interactive terminal.
 * Prefers repo-root `npm --prefix codeflowmu-shell start` to match root `npm start`.
 */
function spawnDetachedShellRestart(): void {
  const win = process.platform === "win32";
  const spawnBase: import("node:child_process").SpawnOptions = {
    detached: true,
    stdio: "ignore",
    windowsHide: win,
    env: process.env,
    shell: win,
  };

  const tryNpm = (args: string[], cwd: string, label: string): boolean => {
    try {
      const child = spawnProc("npm", args, { ...spawnBase, cwd });
      child.on("error", (err) => {
        appendRestartSpawnLog(`${label} child error: ${String(err)}`);
      });
      child.unref();
      appendRestartSpawnLog(`${label} spawned: npm ${args.join(" ")} cwd=${cwd}`);
      return true;
    } catch (err) {
      appendRestartSpawnLog(`${label} throw: ${String(err)}`);
      return false;
    }
  };

  const repoRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
  if (repoRoot && tryNpm(["--prefix", "codeflowmu-shell", "start"], repoRoot, "repo-root")) {
    return;
  }
  tryNpm(["start"], SHELL_PKG_ROOT, "shell-pkg-only");
}

/** Port the web panel listens on. Matches v1 codeflowmu-desktop convention. */
export const WEB_PANEL_PORT = 18766;

/**
 * HTTP bind address for the Panel server.
 * Default `0.0.0.0` so phones on the same LAN can open `/mobile/` (QR URLs use the PC's Wi‑Fi IP).
 * Set `CODEFLOW_PANEL_HOST=127.0.0.1` to restrict to loopback only.
 */
export function resolveWebPanelHost(): string {
  const raw = process.env["CODEFLOW_PANEL_HOST"]?.trim();
  if (raw) return raw;
  return "0.0.0.0";
}

/** Loopback + private LAN origins (mobile PWA may be opened via http://192.168.x.x:PORT/). */
const ALLOWED_PANEL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

/** Error response shape for all /api/v2/ endpoints. */
interface ApiError {
  error: string;
  code: string;
}

function sendError(res: Response, status: number, code: string, msg: string) {
  const body: ApiError = { error: msg, code };
  res.status(status).json(body);
}

function applyPanelCorsHeaders(res: Response, origin: string | undefined): void {
  if (origin && ALLOWED_PANEL_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}

/** ADMIN 聊天页唯一合法对象（FCoP Rule 4：ADMIN ↔ leader/PM）。 */
const ADMIN_CHAT_AGENT_ID = "PM-01";

type DirectSessionIntent = "chat" | "wake" | "patrol";

interface TaskAttachment {
  type: "image" | "file";
  url?: string;
  local_path?: string;
  absolute_path?: string;
  mime?: string;
  original_name?: string;
  size?: number;
  sha256?: string;
}

/** @deprecated alias — chat + task share TaskAttachment */
type ChatImageAttachment = TaskAttachment;

const ALLOWED_ATTACHMENT_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/octet-stream",
]);

function inferAttachmentType(mime: string, filename: string): "image" | "file" {
  if (mime.startsWith("image/")) return "image";
  const lower = filename.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(lower)) return "image";
  return "file";
}

function normalizeAttachments(raw: unknown): TaskAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    const localPath =
      typeof rec.local_path === "string" ? rec.local_path.trim() : "";
    const absolutePath =
      typeof rec.absolute_path === "string" ? rec.absolute_path.trim() : "";
    if (/^data:/i.test(url) || /^data:/i.test(localPath)) continue;
    if (!url && !localPath && !absolutePath) continue;
    const mime = typeof rec.mime === "string" ? rec.mime.trim() : "";
    const originalName =
      typeof rec.original_name === "string" ? rec.original_name.trim() : "";
    const typeRaw = String(rec.type ?? "").toLowerCase();
    const type: "image" | "file" =
      typeRaw === "file"
        ? "file"
        : typeRaw === "image"
          ? "image"
          : inferAttachmentType(mime, originalName || localPath || url);
    out.push({
      type,
      ...(url ? { url } : {}),
      ...(localPath ? { local_path: localPath } : {}),
      ...(absolutePath ? { absolute_path: absolutePath } : {}),
      ...(mime ? { mime } : {}),
      ...(originalName ? { original_name: originalName } : {}),
      ...(typeof rec.size === "number" ? { size: rec.size } : {}),
      ...(typeof rec.sha256 === "string" ? { sha256: rec.sha256.trim() } : {}),
    });
  }
  return out;
}

function normalizeImageAttachments(raw: unknown): TaskAttachment[] {
  return normalizeAttachments(raw).filter((a) => a.type === "image" || !a.type);
}

function enrichImageAttachments(
  projectRoot: string,
  attachments: TaskAttachment[],
): TaskAttachment[] {
  const root = pathResolve(projectRoot);
  return attachments.map((a) => {
    let localPath = a.local_path?.trim() ?? "";
    let absolutePath = a.absolute_path?.trim() ?? "";

    if (localPath && !absolutePath) {
      if (path.isAbsolute(localPath)) {
        absolutePath = pathResolve(localPath);
        if (
          absolutePath.startsWith(root + path.sep) ||
          absolutePath === root
        ) {
          localPath = path.relative(root, absolutePath).replace(/\\/g, "/");
        }
      } else {
        localPath = normalizeAttachmentLocalPath(localPath);
        absolutePath = resolveAttachmentAbsPath(projectRoot, localPath) ?? "";
      }
    } else if (absolutePath && !localPath) {
      const abs = pathResolve(absolutePath);
      if (abs.startsWith(root + path.sep) || abs === root) {
        localPath = path.relative(root, abs).replace(/\\/g, "/");
      }
    } else if (localPath) {
      localPath = normalizeAttachmentLocalPath(localPath);
      if (!absolutePath) {
        absolutePath = resolveAttachmentAbsPath(projectRoot, localPath) ?? "";
      }
    }

    return {
      type: a.type ?? inferAttachmentType(a.mime ?? "", a.original_name ?? localPath),
      ...(a.url ? { url: a.url } : {}),
      ...(localPath ? { local_path: localPath } : {}),
      ...(absolutePath ? { absolute_path: absolutePath } : {}),
      ...(a.mime ? { mime: a.mime } : {}),
    };
  });
}

function normalizeAndEnrichAttachments(
  projectRoot: string,
  raw: unknown,
): TaskAttachment[] {
  return enrichImageAttachments(projectRoot, normalizeAttachments(raw));
}

function loadTaskAttachmentsFromDisk(
  projectRoot: string,
  taskIdPrefix: string,
): TaskAttachment[] {
  const found = findTaskFileByIdPrefix(projectRoot, taskIdPrefix);
  if (!found) return [];
  try {
    const raw = readFileSync(found.path, "utf-8");
    const fm = parseMarkdownFrontmatter(raw);
    const own = enrichImageAttachments(
      projectRoot,
      parseAttachmentsFromFrontmatter(fm),
    );
    const parentRaw = String(fm.parent ?? fm.references ?? "");
    const parentMatch = parentRaw.match(/TASK-\d{8}-\d{3,}/);
    if (!parentMatch?.[0]) return own;
    const parentFound = findTaskFileByIdPrefix(projectRoot, parentMatch[0]);
    if (!parentFound) return own;
    try {
      const parentRawFile = readFileSync(parentFound.path, "utf-8");
      const parentFm = parseMarkdownFrontmatter(parentRawFile);
      const parentOwn = enrichImageAttachments(
        projectRoot,
        parseAttachmentsFromFrontmatter(parentFm),
      );
      const seen = new Set<string>();
      const merged: TaskAttachment[] = [];
      for (const a of [...parentOwn, ...own]) {
        const key = a.local_path || a.absolute_path || a.url || "";
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
      }
      return merged;
    } catch {
      return own;
    }
  } catch {
    return [];
  }
}

function parseAttachmentsFromFrontmatter(
  fm: Record<string, unknown>,
): TaskAttachment[] {
  return normalizeAttachments(fm["attachments"]);
}

function guessImageMimeFromPath(filePath: string, fallback?: string): string {
  const mime = fallback?.trim();
  if (mime?.startsWith("image/")) return mime;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return mime || "application/octet-stream";
}

async function buildSessionImagesFromAttachments(
  projectRoot: string,
  attachments: TaskAttachment[],
): Promise<SessionSdkImage[]> {
  const { readFile } = await import("node:fs/promises");
  const images: SessionSdkImage[] = [];
  const enriched = enrichImageAttachments(projectRoot, attachments);
  for (const a of enriched) {
    if (a.type === "file") continue;
    if (a.url && /^https?:\/\//i.test(a.url)) {
      images.push({ url: a.url });
      continue;
    }
    const abs =
      a.absolute_path?.trim() ||
      (a.local_path
        ? resolveAttachmentAbsPath(projectRoot, a.local_path)
        : null);
    if (!abs || !existsSync(abs)) continue;
    try {
      const buf = await readFile(abs);
      images.push({
        data: buf.toString("base64"),
        mimeType: guessImageMimeFromPath(abs, a.mime),
      });
    } catch {
      /* skip unreadable attachment */
    }
  }
  return images;
}

function normalizeAttachmentLocalPath(localPath: string): string {
  return localPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function resolveAttachmentAbsPath(
  projectRoot: string,
  localPath: string,
): string | null {
  const rel = normalizeAttachmentLocalPath(localPath);
  if (!rel) return null;
  if (path.isAbsolute(rel)) {
    const root = pathResolve(projectRoot);
    const abs = pathResolve(rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    return abs;
  }
  if (rel.startsWith("fcop/")) return join(projectRoot, rel);
  if (rel.startsWith("attachments/")) return join(projectRoot, "fcop", rel);
  return null;
}

function toMarkdownRelPath(fromFileAbs: string, toFileAbs: string): string {
  const rel = path.relative(dirname(fromFileAbs), toFileAbs).replace(/\\/g, "/");
  if (!rel) return "./";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function buildAttachmentMarkdownLines(opts: {
  markdownFilePath: string;
  attachments: ChatImageAttachment[];
  projectRoot: string;
}): string[] {
  const lines: string[] = [];
  for (const a of opts.attachments) {
    const localPath = a.local_path?.trim();
    if (!localPath) continue;
    const abs = resolveAttachmentAbsPath(opts.projectRoot, localPath);
    if (!abs) continue;
    const rel = toMarkdownRelPath(opts.markdownFilePath, abs);
    lines.push(`![image](${rel})`);
  }
  return lines;
}

function appendMarkdownAttachmentRefs(opts: {
  body: string;
  markdownFilePath: string;
  attachments: ChatImageAttachment[];
  projectRoot: string;
}): string {
  const refs = buildAttachmentMarkdownLines(opts);
  if (!refs.length) return opts.body;
  const trimmed = opts.body.trimEnd();
  return `${trimmed}\n\n${refs.join("\n")}`;
}

function formatImageAttachmentPromptBlock(
  attachments: TaskAttachment[] = [],
): string {
  if (attachments.length === 0) return "";
  const lines = ["本次消息包含附件（图片可 Read；文件请 read_file 绝对路径）："];
  for (const a of attachments) {
    const parts: string[] = [];
    if (a.original_name) parts.push(`原名 ${a.original_name}`);
    if (a.local_path) parts.push(`相对路径 ${a.local_path}`);
    if (a.absolute_path) parts.push(`绝对路径 ${a.absolute_path}`);
    if (a.url) parts.push(`URL ${a.url}`);
    const meta: string[] = [];
    if (a.mime) meta.push(a.mime);
    if (a.size != null) meta.push(`${a.size} bytes`);
    if (a.sha256) meta.push(`sha256 ${a.sha256.slice(0, 16)}…`);
    const suffix = meta.length ? ` (${meta.join(", ")})` : "";
    const kind = a.type === "file" ? "file" : "image";
    lines.push(`- [${kind}] ${parts.join(" | ")}${suffix}`);
  }
  return lines.join("\n");
}

function formatAttachmentsYaml(attachments: TaskAttachment[]): string[] {
  if (attachments.length === 0) return [];
  const quote = (s: string) => JSON.stringify(s);
  const lines = ["attachments:"];
  for (const a of attachments) {
    lines.push("  -");
    if (a.local_path) lines.push(`    local_path: ${quote(a.local_path)}`);
    if (a.absolute_path) lines.push(`    absolute_path: ${quote(a.absolute_path)}`);
    if (a.mime) lines.push(`    mime: ${quote(a.mime)}`);
    if (a.original_name) lines.push(`    original_name: ${quote(a.original_name)}`);
    if (typeof a.size === "number") lines.push(`    size: ${a.size}`);
    if (a.sha256) lines.push(`    sha256: ${quote(a.sha256)}`);
    if (a.url) lines.push(`    url: ${quote(a.url)}`);
  }
  return lines;
}

function normalizeDirectOperatorRole(raw: unknown): "ADMIN" | "PM" {
  const op = String(raw ?? "ADMIN").toUpperCase();
  return op === "PM" ? "PM" : "ADMIN";
}

function normalizeDirectIntent(raw: unknown): DirectSessionIntent {
  const v = String(raw ?? "chat").toLowerCase();
  if (v === "wake" || v === "patrol") return v;
  return "chat";
}

function ledgerRoleFromAgentId(agentId: string): string {
  const m = /^([A-Za-z]+)/.exec(String(agentId ?? "").trim());
  return m?.[1] ? m[1].toUpperCase() : "PM";
}

function resolveWakeLedgerRole(opts: {
  operatorRole: "ADMIN" | "PM";
  targetAgentId: string;
}): string {
  const { operatorRole, targetAgentId } = opts;
  if (operatorRole === "PM" && !/^PM/i.test(targetAgentId)) {
    return ledgerRoleFromAgentId(targetAgentId);
  }
  if (/^PM/i.test(targetAgentId)) return "PM";
  return ledgerRoleFromAgentId(targetAgentId);
}

const _LIFECYCLE_WAKE_BAN =
  "禁止在聊天中声称已自行 claim/submit/mv/approve/archive lifecycle 文件；生命周期由 Runtime/UI API 执行。";

function fileFactFirstWakeBlock(
  role: string,
  opts?: {
    /** Hot Path 已预载 TASK 正文：直接 fcop_report → fcop_check，勿重读已预载 TASK */
    adminRejectHotPathPreloaded?: boolean;
    /** Cold Path 已预载 TASK：首动作为 write_task 派下游 */
    adminRejectColdPathPreloaded?: boolean;
  },
): string {
  const r = role.toUpperCase();
  const threadsNote =
    "`fcop/ledger/threads.jsonl` 只用于历史线程关系，不得生成当前任务事实。";
  if (opts?.adminRejectHotPathPreloaded) {
    return [
      `## File-fact-first（Hot Path · TASK 已预载）`,
      `**第一动作**：MCP \`fcop_report\` → \`fcop_check\`（**禁止**再 read_task / read_file 重读已预载 TASK）。`,
      threadsNote,
      _LIFECYCLE_WAKE_BAN,
    ].join("\n");
  }
  if (opts?.adminRejectColdPathPreloaded) {
    return [
      `## File-fact-first（Cold Path · TASK 已预载）`,
      `**第一动作**：MCP \`write_task\` 向 DEV/QA/OPS 派返工子任务（**禁止**先 read_task 重读已预载 id）。`,
      threadsNote,
      _LIFECYCLE_WAKE_BAN,
    ].join("\n");
  }
  return [
    `## File-fact-first（首读待办）`,
    `**第一动作**：通过 MCP \`list_tasks\` / \`get_team_status\` 获取由 \`_lifecycle\` 重建的当前任务视图，再读对应 TASK 正文执行。`,
    `\`fcop/ledger/views/${r}.todo.md\` 仅作历史线索与辅助参考，不得作为当前任务事实入口。`,
    threadsNote,
    _LIFECYCLE_WAKE_BAN,
  ].join("\n");
}

/** PM wake/patrol：若 ledger 有 ADMIN 打回待办，注入 Hot/Cold Path 返工块。 */
function pmAdminRejectReworkBlockForWake(
  projectRoot: string | undefined,
  targetAgentId: string,
  opts?: { taskBodyPreloaded?: boolean; message?: string },
): string {
  if (!projectRoot || !/^PM/i.test(targetAgentId)) return "";
  const section = extractPmAdminRejectTodoSection(projectRoot);
  if (!section) return "";
  const taskIds = opts?.message
    ? resolveAdminRejectTaskIdsToPreload(section, opts.message)
    : [];
  const block = buildPmAdminRejectReworkPromptBlock(projectRoot, {
    taskBodyPreloaded: opts?.taskBodyPreloaded,
    taskId: taskIds[0] ?? null,
  });
  return block ? `\n\n${block}` : "";
}

/** 从 ledger 打回区块 + 用户消息解析要预载的 TASK id（优先消息中且出现在打回区的 id）。 */
function resolveAdminRejectTaskIdsToPreload(
  adminRejectSection: string,
  message: string,
): string[] {
  const sectionUpper = adminRejectSection.toUpperCase();
  const fromMessage = extractTaskIdPrefixesFromText(message).filter((id) =>
    sectionUpper.includes(id),
  );
  if (fromMessage.length > 0) return fromMessage;
  const fromSection = extractTaskIdPrefixesFromText(adminRejectSection);
  return fromSection.length > 0 ? [fromSection[0]!] : [];
}

/** 预载打回 TASK 正文，触发 Runtime 热路径（禁止 read_task 循环）。 */
function buildPreloadedAdminRejectTaskBlock(
  projectRoot: string,
  adminRejectSection: string,
  message: string,
  executionMode: "hot" | "cold",
): string {
  const taskIds = resolveAdminRejectTaskIdsToPreload(adminRejectSection, message);
  if (taskIds.length === 0) return "";

  const isHot = executionMode === "hot";
  const parts: string[] = isHot
    ? [
        "## 当前 TASK 正文（Runtime 已预载 · ADMIN 打回 Hot Path）",
        "",
        "**任务正文已在下方** — 禁止对下列 task_id 再调 read_task / claim_task / read_file。",
        "**必做**：MCP `fcop_report` → `fcop_check` → 只读探针（read/grep/只读 shell）→ `write_report(status=done)`。",
        "**Hot Path = PM 治理核查/协调，不代表可修改产品代码。**",
        "**禁止**：edit 产品代码、shell 写入、创建补丁脚本。",
        "**若需代码/UI/API/测试实现**：必须 `write_task` 派 DEV/OPS/QA/EVAL（按性质，不固定 DEV）。",
      ]
    : [
        "## 当前 TASK 正文（Runtime 已预载 · ADMIN 打回 Cold Path）",
        "",
        "**任务正文已在下方** — 禁止对下列 task_id 再调 read_task / claim_task / read_file。",
        "**第一动作**：MCP `write_task` 向 DEV / QA / OPS 派返工子任务（frontmatter `parent:` 指向上列 task_id）。",
        "**禁止**：仅 write_report 向 ADMIN ack 打回而不派下游；禁止在聊天里向 ADMIN 请示是否 read。",
      ];

  for (const id of taskIds) {
    const found = findTaskFileByIdPrefix(projectRoot, id);
    if (!found) {
      parts.push("", `### ${id}`, "", `_（磁盘未找到 ${id}，请用 read_file 读 ledger 行内 file= 路径）_`);
      continue;
    }
    try {
      const raw = readFileSync(found.path, "utf-8");
      parts.push(
        "",
        `### ${id} · \`${found.path.replace(/\\/g, "/")}\``,
        "",
        "```markdown",
        raw,
        "```",
      );
    } catch {
      parts.push("", `### ${id}`, "", `_（读取失败：${found.path}）_`);
    }
  }
  return parts.join("\n");
}

type AdminRejectPmWakeBundle = {
  section: string | null;
  mode: "hot" | "cold" | null;
  adminRejectBlock: string;
  preloadedTaskBlock: string;
  ledgerBlock: string;
};

/** PM wake/patrol：解析 ADMIN 打回区块、Hot/Cold 模式、预载 TASK 与 file-fact-first 变体。 */
function buildAdminRejectPmWakeBundle(
  projectRoot: string | undefined,
  targetAgentId: string,
  message: string,
  fallbackLedgerRole: string,
): AdminRejectPmWakeBundle {
  const fallbackLedger = fileFactFirstWakeBlock(fallbackLedgerRole);
  const empty: AdminRejectPmWakeBundle = {
    section: null,
    mode: null,
    adminRejectBlock: "",
    preloadedTaskBlock: "",
    ledgerBlock: fallbackLedger,
  };
  if (!projectRoot || !/^PM/i.test(targetAgentId)) return empty;

  const section = extractPmAdminRejectTodoSection(projectRoot);
  if (!section) return empty;

  const mode = resolveAdminRejectExecutionMode({
    projectRoot,
    adminRejectSection: section,
  });
  const executionMode = mode ?? "cold";
  const preloadedTaskBlock = buildPreloadedAdminRejectTaskBlock(
    projectRoot,
    section,
    message,
    executionMode,
  );
  const taskBodyPreloaded = preloadedTaskBlock.length > 0;
  const taskId =
    resolveAdminRejectTaskIdsToPreload(section, message)[0] ?? null;
  const blockRaw = buildPmAdminRejectReworkPromptBlock(projectRoot, {
    taskBodyPreloaded,
    taskId,
  });
  const adminRejectBlock = blockRaw ? `\n\n${blockRaw}` : "";
  const ledgerBlock =
    mode === "hot" && taskBodyPreloaded
      ? fileFactFirstWakeBlock(fallbackLedgerRole, {
          adminRejectHotPathPreloaded: true,
        })
      : mode === "cold" && taskBodyPreloaded
        ? fileFactFirstWakeBlock(fallbackLedgerRole, {
            adminRejectColdPathPreloaded: true,
          })
        : fallbackLedger;

  return {
    section,
    mode,
    adminRejectBlock,
    preloadedTaskBlock,
    ledgerBlock,
  };
}

/**
 * 轻量 session 提示词：聊天 / 唤醒 / 巡查均不落 TASK 文件。
 * 「巡查」「开工」等短句走 wake|patrol，勿 write_task。
 */
function buildDirectSessionPrompt(
  message: string,
  opts: {
    intent: DirectSessionIntent;
    operatorRole: "ADMIN" | "PM";
    targetAgentId: string;
    projectRoot?: string;
    attachments?: ChatImageAttachment[];
    registryModelId?: string;
  },
): { chatPrompt: string; sessionMaxRounds?: number } {
  const { intent, operatorRole, targetAgentId, projectRoot } = opts;
  const attachmentBlock = formatImageAttachmentPromptBlock(opts.attachments);
  const adoptedBlock =
    intent !== "chat" && projectRoot
      ? formatAdoptedRuntimeEffectiveWakeSection(projectRoot)
      : "";
  const pmSkillsBlock =
    intent !== "chat" && /^PM/i.test(targetAgentId)
      ? formatPmBuiltinSkillsPlaybookBlock()
      : "";
  const operatorLabel = operatorRole === "PM" ? "PM" : "ADMIN";
  const isLightPatrol =
    /检查|巡检|巡查|看看.*任务|list_tasks|fcop_report|用\s*MCP/i.test(message) &&
    !/write_report|write_task|派发|正式派单/i.test(message);
  const isFormalUrge =
    !isLightPatrol &&
    /开工|正式开工|执行/i.test(message);
  const isPmAdminClose =
    /^PM/i.test(targetAgentId) &&
    /write_report|PM-to-ADMIN|关单|汇总.*ADMIN/i.test(message);

  if (intent === "chat") {
    const runtimeIdentityBlock = formatPanelRuntimeIdentityBlock(
      projectRoot,
      targetAgentId,
      opts.registryModelId
        ? { registryModelId: opts.registryModelId }
        : undefined,
    );

    const isPmTarget = /^PM/i.test(targetAgentId);
    const adminRejectSection =
      isPmTarget && projectRoot
        ? extractPmAdminRejectTodoSection(projectRoot)
        : null;
    const adminRejectMode =
      adminRejectSection && projectRoot
        ? resolveAdminRejectExecutionMode({
            projectRoot,
            adminRejectSection,
          })
        : null;
    const escalateAdminRejectHotPath =
      adminRejectMode === "hot" &&
      !!adminRejectSection &&
      shouldEscalatePmChatToAdminRejectHotPath({
        message,
        adminRejectSection,
        projectRoot: projectRoot ?? undefined,
      });
    const escalateAdminRejectColdPath =
      adminRejectMode === "cold" &&
      !!adminRejectSection &&
      shouldEscalatePmChatToAdminRejectColdPath({
        message,
        adminRejectSection,
        projectRoot: projectRoot ?? undefined,
      });

    const isAdminSystemCheck =
      /检查.*(系统|fcop|mcp|skills|技能|google|工具箱)|检查系统/i.test(
        message,
      );

    if (isAdminSystemCheck) {
      return {
        sessionMaxRounds: PATROL_SESSION_MAX_TOOL_ROUNDS,
        chatPrompt: [
          `[ADMIN ↔ PM · 系统/FCoP/MCP/Skills 检查 · 须中文汇总]`,
          ...(runtimeIdentityBlock ? ["", runtimeIdentityBlock] : []),
          ``,
          `ADMIN: ${message}`,
          ...(attachmentBlock ? ["", attachmentBlock] : []),
          ``,
          `请用有限次 MCP 完成检查后在**本回复**输出简体中文汇总（禁止只思考不输出正文）：`,
          `1. fcop_report() 与 fcop_check() — FCoP 协议与 ledger 漂移（无 role 参数，可选 lang="zh"）；`,
          `Fallback only when MCP is unavailable: use read-only Python Project.status()/is_initialized()/list_tasks()/list_reports()/list_issues(); do not call Project.report()/Project.check().`,
          `2. 说明当前 MCP/FCoP 工具是否可用（本次会话工具调用即证据）；`,
          `3. 简述 Agent Skills / Google 工具箱能力边界（static tools + fcop MCP）；`,
          `4. 列出阻塞项或下一步建议。`,
          ``,
          `禁止：重复调用相同 patrol 工具超过 2 次；检查完成后禁止 write_task/write_report。`,
          `若工具结果已在缓存中，**立即**基于已有结果写汇总，勿再调 get_team_status/fcop_check。`,
        ].join("\n"),
      };
    }

    if (escalateAdminRejectHotPath && projectRoot && adminRejectSection) {
      const preloadedTaskBlock = buildPreloadedAdminRejectTaskBlock(
        projectRoot,
        adminRejectSection,
        message,
        "hot",
      );
      const adminRejectBlock = buildPmAdminRejectReworkPromptBlock(projectRoot, {
        taskBodyPreloaded: preloadedTaskBlock.length > 0,
        taskId: resolveAdminRejectTaskIdsToPreload(adminRejectSection, message)[0] ?? null,
      });
      const ledgerBlock =
        preloadedTaskBlock.length > 0
          ? fileFactFirstWakeBlock("PM", { adminRejectHotPathPreloaded: true })
          : fileFactFirstWakeBlock("PM");
      return {
        sessionMaxRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
        chatPrompt: [
          `[ADMIN ↔ PM · ADMIN 打回协调 · Hot Path（PM 治理核查/协调 · 不代表可修改产品代码）]`,
          ``,
          ledgerBlock,
          ``,
          adminRejectBlock ?? "",
          preloadedTaskBlock,
          ...(runtimeIdentityBlock ? ["", runtimeIdentityBlock] : []),
          ``,
          `${operatorLabel}: ${message}`,
          ...(attachmentBlock ? ["", attachmentBlock] : []),
          ``,
          `你是 PM（leader）。**禁止**把本回合当「快速聊天」或 Cold Path 派单。`,
          `**必做**：fcop_report → fcop_check → read/grep 只读探针 → write_report(status=done)。`,
          `**禁止**：edit 产品代码、shell 写入、补丁脚本；禁止仅 write_report ack「收到打回」。`,
          `**若需实现性修改**：write_task 派 DEV/OPS/QA/EVAL；无法唤醒时仍 write_task 到 inbox 并报告 ADMIN。`,
          ...(formatPmBuiltinSkillsPlaybookBlock()
            ? ["", formatPmBuiltinSkillsPlaybookBlock()]
            : []),
        ].join("\n"),
      };
    }

    if (escalateAdminRejectColdPath && projectRoot && adminRejectSection) {
      const preloadedTaskBlock = buildPreloadedAdminRejectTaskBlock(
        projectRoot,
        adminRejectSection,
        message,
        "cold",
      );
      const adminRejectBlock = buildPmAdminRejectReworkPromptBlock(projectRoot, {
        taskBodyPreloaded: preloadedTaskBlock.length > 0,
        taskId: resolveAdminRejectTaskIdsToPreload(adminRejectSection, message)[0] ?? null,
      });
      const ledgerBlock =
        preloadedTaskBlock.length > 0
          ? fileFactFirstWakeBlock("PM", { adminRejectColdPathPreloaded: true })
          : fileFactFirstWakeBlock("PM");
      return {
        sessionMaxRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
        chatPrompt: [
          `[ADMIN ↔ PM · ADMIN 打回协调 · Cold Path（PM 派发责任角色 · 非 PM 自己落地）]`,
          ``,
          ledgerBlock,
          ``,
          adminRejectBlock ?? "",
          preloadedTaskBlock,
          ...(runtimeIdentityBlock ? ["", runtimeIdentityBlock] : []),
          ``,
          `${operatorLabel}: ${message}`,
          ...(attachmentBlock ? ["", attachmentBlock] : []),
          ``,
          `你是 PM（leader）。**禁止**把本回合当「快速聊天」：不要向 ADMIN 请示是否 read_task/read_file。`,
          `**必做**：按上方预载 TASK（若有）直接 MCP write_task 派 DEV/QA/OPS；打回未派下游前 **禁止** write_report ack。`,
          `若需读 ledger 其它文件：read_file（workspace）；**勿**口头重复「我将 read_task」而不调工具。`,
          ...(formatPmBuiltinSkillsPlaybookBlock()
            ? ["", formatPmBuiltinSkillsPlaybookBlock()]
            : []),
        ].join("\n"),
      };
    }

    return {
      chatPrompt: [
        `[ADMIN ↔ PM 快速聊天 - 非正式对话]`,
        ...(runtimeIdentityBlock ? ["", runtimeIdentityBlock] : []),
        ``,
        `ADMIN: ${message}`,
        ...(attachmentBlock ? ["", attachmentBlock] : []),
        ``,
        `⚠️ 这是一次 ADMIN 与 PM 的非正式对话。请直接回答；无需 write_task。`,
        `若 ADMIN 问「你是什么模型 / 你是谁」：LIVE 思考流和正式回复都跟随面板语言；中文界面下必须用简体中文表达真实运行身份（例：You are Composer… → Composer，一个由 Cursor 开发的语言模型。），禁止编造 wire/registry/modelUsage/设置说明。`,
        `若 ADMIN 需要正式派单，应走 TASK 文件（本通道不会自动生成）。`,
        adminRejectSection
          ? `\n\n（提示：ledger 仍有「ADMIN 判定打回」待办；若 ADMIN 在本消息提到打回任务或 TASK id，将自动升级为 Hot/Cold Path 返工。）`
          : "",
      ].join("\n"),
    };
  }

  const ledgerRole = resolveWakeLedgerRole({ operatorRole, targetAgentId });
  const ledgerBlock = fileFactFirstWakeBlock(ledgerRole);

  if (isPmAdminClose) {
    return {
      sessionMaxRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
      chatPrompt: [
        `[ADMIN 关单 · 必须 write_report 落盘 · 非聊天回执]`,
        ``,
        ledgerBlock,
        ``,
        adoptedBlock,
        `${operatorLabel}: ${message}`,
        ...(attachmentBlock ? ["", attachmentBlock] : []),
        ``,
        `你是 PM（leader）。这是 PM→ADMIN 汇总/关单场景，不能只在聊天里总结。`,
        ``,
        `目标确认规则：`,
        `1. 只能使用本轮消息明确提到的 task_id / thread_key，或 ledger 当前正在等待 PM 汇总的 root_task_id。`,
        `2. 写 PM-to-ADMIN 报告前，必须先核对该 root_task_id 的子任务与下游 REPORT 是否齐全。`,
        `3. 如果没有明确当前 root task，或发现子任务仍未完成，先写清楚阻塞原因，不要生成 done 总报告。`,
        `4. 禁止复用历史巡检线程、旧 task_id、旧 thread_key；旧线程缺失时不能为了满足关单而补写新 REPORT。`,
        ``,
        `执行要求：`,
        `- 确认当前 root task 后，用 MCP \`write_report\` 写 \`PM-to-ADMIN\` 总报告。`,
        `- \`task_id\` 必须等于当前 ADMIN→PM 主任务；正文必须写明当前 \`thread_key\`、引用下游 REPORT、说明验收结果和遗留风险。`,
        `- 如果本轮只是巡检/催办/等待下游，不得调用 write_report；Runtime 已将过程写入治理日志。接单确认在同一 task 最多一份，禁止重复确认。`,
        ``,
        `只有关单门禁已满足或形成明确终态阻塞升级时，才要求 write_report；否则直接返回本次会话结论。禁止把报告写到未被当前任务引用的旧线程；禁止用 PM 巡检记录冒充正式报告。`,
        ...(pmSkillsBlock ? ["", pmSkillsBlock] : []),
      ].join("\n"),
    };
  }

  if (isLightPatrol || intent === "patrol") {
    const downstream = operatorRole === "PM" && !/^PM/i.test(targetAgentId);
    const wakeBundle = buildAdminRejectPmWakeBundle(
      projectRoot,
      targetAgentId,
      message,
      ledgerRole,
    );
    const adminRejectMode = wakeBundle.mode;
    const adminRejectBlock = wakeBundle.adminRejectBlock;
    const preloadedTaskBlock = wakeBundle.preloadedTaskBlock;
    const effectiveLedgerBlock = wakeBundle.section
      ? wakeBundle.ledgerBlock
      : ledgerBlock;
    const patrolTitle = adminRejectBlock
      ? adminRejectMode === "hot"
        ? `[${operatorLabel} 轻量巡检 - ADMIN 打回优先 · Hot Path 可 write_report]`
        : `[${operatorLabel} 轻量巡检 - ADMIN 打回优先 · Cold Path 可 write_task]`
      : `[${operatorLabel} 轻量巡检/催促 - 非正式派单 · 勿 write_task]`;
    const pmPatrolBody = adminRejectBlock
      ? adminRejectMode === "hot"
        ? [
            `你是 PM（leader）。**第一优先级**：完成上方「ADMIN 判定打回」Hot Path（fcop_report → fcop_check → 只读探针 → write_report(status=done)）。`,
            preloadedTaskBlock
              ? `TASK 正文已预载于上方 — **禁止** read_task / read_file 重读同一 task 或 PM.todo。`
              : "",
            `**Hot Path 禁止**：edit 产品代码、shell 写入、补丁脚本；禁止以「亲自返工/只有一个 agent」为借口直接落地。`,
            `**若需实现性修改**：必须 write_task 派责任角色；禁止仅 write_report ack。`,
            `其余巡检（有限次）：get_team_status / list_tasks 交叉核对 lifecycle。`,
            `v3 状态机：inbox→claim→active→submit→review→approve→done→archive_task→archive/。`,
            `禁止：对同一 TASK 重复 read_task；无必要 finish_task/archive_task。`,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `你是 PM（leader）。**第一优先级**：完成上方「ADMIN 判定打回」Cold Path（write_task 派 DEV/QA/OPS）。`,
            preloadedTaskBlock
              ? `TASK 正文已预载 — **禁止** read_task / read_file 重读同一 task。`
              : `read_file → write_task 派 DEV/QA/OPS。`,
            `打回条目未派下游前：**禁止** write_report 向 ADMIN ack。`,
            `其余巡检（有限次）：fcop_report / get_team_status / list_tasks 交叉核对 lifecycle。`,
            `v3 状态机：inbox→claim→active→submit→review→approve→done→archive_task→archive/。`,
            `禁止：对同一 TASK 重复 read_task；无必要 finish_task/archive_task。`,
          ].join("\n")
      : [
          `你是 PM（leader）。请用有限次 MCP 完成**生命周期巡检**后用中文汇报（不要只贴 JSON）：`,
          `0. 首读 list_tasks / get_team_status，确认 _lifecycle 当前事实；ledger/views 仅作历史参考。`,
          `1. fcop_report() 或 get_team_status（二选一）——看清 _lifecycle 各阶段概况；`,
          `2. list_tasks(recipient=PM) 及下游角色（DEV/QA/OPS）——交叉核对当前分配；`,
          `3. review 中有待审 → 考虑 approve_task / reject_task（或 write_review）；done 中已验收 → leader 执行 archive_task；`,
          `4. 若仅下游 active/inbox 卡住、需催促执行，可对 DEV/OPS/QA 发起**唤醒**（短句即可），勿 write_task。`,
          `v3 状态机：inbox→claim→active→submit→review→approve→done→archive_task→archive/。`,
          `禁止：为本次巡检 write_task；为本次巡检 write_report（除非 ADMIN 关单场景）；对每个 TASK 重复 read_task；无必要 finish_task/archive_task。`,
        ].join("\n");
    return {
      sessionMaxRounds: PATROL_SESSION_MAX_TOOL_ROUNDS,
      chatPrompt: [
        patrolTitle,
        ``,
        effectiveLedgerBlock,
        ``,
        adoptedBlock,
        adminRejectBlock,
        preloadedTaskBlock,
        `${operatorLabel}: ${message}`,
        ...(attachmentBlock ? ["", attachmentBlock] : []),
        ``,
        downstream
          ? [
              `你是 ${targetAgentId}。PM 在催促你处理**已有**任务，不是新派单。`,
              `请：先通过 list_tasks / get_team_status 确认当前分配给自己的真实任务；ledger/views 仅作参考。若会话已带 TASK 正文则直接执行并 write_report；否则按 _lifecycle 定位后再处理。`,
              `禁止：claim_task / 开工前 read_task；禁止为本次催促 write_task。`,
            ].join("\n")
          : pmPatrolBody,
        ...(pmSkillsBlock ? ["", pmSkillsBlock] : []),
      ].join("\n"),
    };
  }

  if (isFormalUrge) {
    return {
      sessionMaxRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
      chatPrompt: [
        `[${operatorLabel} 唤醒催促 - 正式开工 · 仍非 write_task 派单]`,
        ``,
        ledgerBlock,
        ``,
        adoptedBlock,
        `${operatorLabel}: ${message}`,
        ...(attachmentBlock ? ["", attachmentBlock] : []),
        ``,
        `请处理 inbox/active 中发给你的任务：正文已在会话则直接执行 → write_report。`,
        `这是运行催促，不是新 TASK 文件；只有 PM 拆单时才 write_task。`,
        ...(pmSkillsBlock ? ["", pmSkillsBlock] : []),
      ].join("\n"),
    };
  }

  const wakeBundle = buildAdminRejectPmWakeBundle(
    projectRoot,
    targetAgentId,
    message,
    ledgerRole,
  );
  const adminRejectMode = wakeBundle.mode;
  const adminRejectBlock = wakeBundle.adminRejectBlock;
  const preloadedTaskBlock = wakeBundle.preloadedTaskBlock;
  const effectiveLedgerBlock = wakeBundle.section
    ? wakeBundle.ledgerBlock
    : ledgerBlock;
  return {
    sessionMaxRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
    chatPrompt: [
      adminRejectBlock
        ? adminRejectMode === "hot"
          ? `[${operatorLabel} 唤醒 - ADMIN 打回优先 · Hot Path 可 write_report]`
          : `[${operatorLabel} 唤醒 - ADMIN 打回优先 · Cold Path 可 write_task]`
        : `[${operatorLabel} 唤醒 - 轻量会话]`,
      ``,
      effectiveLedgerBlock,
      ``,
      adoptedBlock,
      adminRejectBlock,
      preloadedTaskBlock,
      `${operatorLabel}: ${message}`,
      ...(attachmentBlock ? ["", attachmentBlock] : []),
      ``,
      adminRejectBlock
        ? adminRejectMode === "hot"
          ? `请按上方 Hot Path 完成 fcop_report → fcop_check → 只读探针 → write_report(status=done)；禁止 edit/shell 写产品代码。若需实现性修改则 write_task 派发。`
          : `请按上方 Cold Path 完成 read_file + write_task 派下游；打回未派单前禁止 write_report ack。`
        : `请检查待办并简短回复；无需 write_task，除非确有新的正式派单需求。`,
      ...(pmSkillsBlock ? ["", pmSkillsBlock] : []),
    ].join("\n"),
  };
}

/** PM wake/patrol 前跑 planner cycle，并把最近判断摘要注入 prompt。 */
function inferDownstreamRoleFromMessage(message: string): string | undefined {
  const recipientMatch = message.match(
    /recipient\s*[:=]\s*["']?(DEV|QA|OPS)\b/i,
  );
  if (recipientMatch) return recipientMatch[1]!.toUpperCase();

  const toMatch = message.match(/\bto-(DEV|QA|OPS)\b/i);
  if (toMatch) return toMatch[1]!.toUpperCase();
  return undefined;
}

function mapDirectIntentToPlaybookIntent(
  intent: DirectSessionIntent,
): "patrol" | "wake" | "pm_task" | "chat" {
  if (intent === "patrol") return "patrol";
  if (intent === "wake") return "wake";
  if (intent === "chat") return "chat";
  return "pm_task";
}

async function appendPmPlaybookAutoInject(
  chatPrompt: string,
  opts: {
    projectRoot?: string;
    targetAgentId: string;
    intent: DirectSessionIntent;
    message: string;
    taskId?: string;
    threadKey?: string;
  },
): Promise<string> {
  if (!opts.projectRoot || !/^PM/i.test(opts.targetAgentId)) {
    return chatPrompt;
  }
  const playbookIntent = mapDirectIntentToPlaybookIntent(opts.intent);
  if (playbookIntent === "chat") return chatPrompt;
  try {
    const injected = await resolveAndInjectPmPlaybookSkills(opts.projectRoot, {
      role: "PM",
      message: opts.message,
      intent: playbookIntent,
      downstreamRole: inferDownstreamRoleFromMessage(opts.message),
      taskId: opts.taskId,
      threadKey: opts.threadKey,
    });
    if (!injected.promptBlock) return chatPrompt;
    return `${chatPrompt}\n\n${injected.promptBlock}`;
  } catch (err) {
    console.warn(
      "[pm-playbook] auto_inject failed:",
      err instanceof Error ? err.message : String(err),
    );
    return chatPrompt;
  }
}

async function buildDirectSessionPromptWithGovernance(
  message: string,
  opts: {
    intent: DirectSessionIntent;
    operatorRole: "ADMIN" | "PM";
    targetAgentId: string;
    projectRoot?: string;
    runGovernanceCycle?: boolean;
    taskId?: string;
    threadKey?: string;
    wakeDownstream?: WakeDownstreamExecutor;
    allowAutoWake?: boolean;
    attachments?: ChatImageAttachment[];
    registryModelId?: string;
    pmQueueGuard?: import("@codeflowmu/runtime").PmQueueGuard;
  },
): Promise<{ chatPrompt: string; sessionMaxRounds?: number }> {
  const base = buildDirectSessionPrompt(message, opts);

  async function finalize(result: {
    chatPrompt: string;
    sessionMaxRounds?: number;
  }): Promise<{ chatPrompt: string; sessionMaxRounds?: number }> {
    let chatPrompt = await appendPmPlaybookAutoInject(result.chatPrompt, {
      projectRoot: opts.projectRoot,
      targetAgentId: opts.targetAgentId,
      intent: opts.intent,
      message,
      taskId: opts.taskId,
      threadKey: opts.threadKey,
    });
    if (/^PM/i.test(opts.targetAgentId) && opts.projectRoot) {
      const hostRoot =
        process.env["CODEFLOWMU_HOST_ROOT"]?.trim() ||
        resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT) ||
        opts.projectRoot;
      const projectContext = formatDevelopmentProjectContextBlock({
        hostRoot,
        activeRoot: opts.projectRoot,
      });
      chatPrompt = `${chatPrompt}\n\n${projectContext}`;
    }
    return { ...result, chatPrompt };
  }

  if (!opts.runGovernanceCycle || !opts.projectRoot) {
    return finalize(base);
  }
  const throttleKey =
    String(opts.threadKey ?? "").trim() ||
    String(opts.taskId ?? "").trim() ||
    message.slice(0, 80);
  if (!statusCheckThrottle.shouldRun(throttleKey)) {
    console.warn(
      `[pm-governance] status check throttled (${throttleKey.slice(0, 60)})`,
    );
    return finalize(base);
  }
  try {
    const triggered_by = opts.intent === "patrol" ? "patrol" : "pm_wake";
    const runCycle = async () =>
      runPmGovernanceCycle(opts.projectRoot!, {
        triggered_by,
        wake_downstream: opts.wakeDownstream,
        allow_auto_wake:
          opts.allowAutoWake ?? Boolean(opts.wakeDownstream),
      });
    const cycle = opts.pmQueueGuard
      ? await opts.pmQueueGuard.runGuarded(
          `governance:${triggered_by}`,
          runCycle,
          "completed",
        )
      : await runCycle();
    const block = formatPmGovernanceCycleBlock(cycle);
    return finalize({
      ...base,
      chatPrompt: `${base.chatPrompt}\n\n${block}`,
    });
  } catch (err) {
    console.warn("[pm-governance] cycle failed:", err);
    return finalize(base);
  }
}

// ── Sprint-L2: frontmatter state helpers ─────────────────────────────────────

/** Read the `state:` field from a YAML frontmatter block. Returns undefined if absent. */
function _wpParseFmState(raw: string): string | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const yamlSection = m?.[1] ?? "";
  const sm = yamlSection.match(/^state:\s*(\S+)/m);
  return sm?.[1];
}

/** Rewrite (or insert) the `state:` field in YAML frontmatter, returning updated content. */
function _wpPatchFmState(raw: string, val: string): string {
  return _wpPatchFmFields(raw, { state: val });
}

/** Rewrite (or insert) multiple `key: value` lines in YAML frontmatter. */
function _wpPatchFmFields(raw: string, fields: Record<string, string>): string {
  const fmRe = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;
  const m = fmRe.exec(raw);
  if (!m) {
    const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
    return `---\n${lines}\n---\n${raw}`;
  }
  const open = m[1] ?? "---\n";
  let yamlBody = m[2] ?? "";
  const close = m[3] ?? "\n---";
  const rest = raw.slice((m.index ?? 0) + m[0].length);
  for (const [key, val] of Object.entries(fields)) {
    const re = new RegExp(`^${key}:\\s*.*`, "m");
    yamlBody = re.test(yamlBody)
      ? yamlBody.replace(re, `${key}: ${val}`)
      : `${yamlBody}\n${key}: ${val}`;
  }
  return `${open}${yamlBody}${close}${rest}`;
}

function _wpIssueStatusOpen(fm: Record<string, string>): boolean {
  const st = String(fm["status"] ?? "open").trim().toLowerCase();
  return st !== "closed";
}

function _wpScanIssueFiles(
  issuesDir: string,
  opts: { status?: string; limit: number; projectRoot: string },
): Record<string, unknown>[] {
  if (!issuesDir || !existsSync(issuesDir)) return [];
  const statusFilter = String(opts.status ?? "open").toLowerCase();
  const files = readdirSync(issuesDir)
    .filter((f) => f.startsWith("ISSUE-") && f.endsWith(".md"))
    .sort()
    .reverse();
  const issues: Record<string, unknown>[] = [];
  for (const f of files) {
    if (issues.length >= opts.limit) break;
    try {
      const raw = readFileSync(join(issuesDir, f), "utf-8");
      const fm = _wpParseFmYaml(raw);
      const isOpen = _wpIssueStatusOpen(fm);
      if (statusFilter === "open" && !isOpen) continue;
      if (statusFilter === "closed" && isOpen) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      const preview = _wpFirstBodyParagraph(body).slice(0, 160);
      const enrichment = enrichIssueMetadata(opts.projectRoot, fm, body);
      issues.push({
        filename: f,
        issue_id: f.match(/^(ISSUE-\d{8}-\d{3})/i)?.[1] ?? f.replace(/\.md$/i, ""),
        ...fm,
        ...enrichment,
        preview,
        body,
      });
    } catch {
      /* skip malformed */
    }
  }
  return issues;
}

/** Parse simple `key: value` lines from FCoP YAML frontmatter (first block only). */
function _wpParseFmYaml(raw: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return fm;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
    if (kv) {
      let v = kv[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[kv[1]!] = v;
    }
  }
  return fm;
}

/** Strip runtime-appended state_history block from TASK markdown body. */
function _wpStripTaskRuntimeAppendix(body: string): string {
  const idx = body.search(/\n---\r?\n##\s*state_history\b/i);
  if (idx >= 0) return body.slice(0, idx).trimEnd();
  return body.trimEnd();
}

/** First prose paragraph in markdown body (skips headings, tables, fences). */
function _wpFirstBodyParagraph(body: string): string {
  const parts: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) {
      if (parts.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^[-|`]/.test(t)) continue;
    parts.push(t);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Human-readable title + summary for task/report list APIs.
 * `subject` = title (frontmatter / first heading / slug); `preview` = first body paragraph (not duplicated).
 */
function _wpExtractDocDisplay(raw: string, filename: string): { subject: string; preview: string } {
  const fm = _wpParseFmYaml(raw);
  const body = _wpStripTaskRuntimeAppendix(
    raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
  );
  let subject = String(fm["subject"] ?? "").trim();
  if (!subject) {
    const h1 = body.match(/^#\s+(.+)$/m);
    const h2m = body.match(/^##\s+(.+)$/m);
    const h2 =
      h2m && !/state_history/i.test(h2m[1] ?? "") ? h2m[1] : undefined;
    subject = (h1?.[1] || h2 || "").trim();
  }
  if (!subject) {
    const slugM = filename.match(/-to-[A-Za-z0-9_.-]+-([a-z][a-z0-9-]*)\.md$/i);
    if (slugM?.[1]) subject = slugM[1].replace(/-/g, " ");
  }
  let preview = _wpFirstBodyParagraph(body);
  if (!preview) {
    preview = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || "";
  }
  if (preview && subject && preview === subject) preview = "";
  return { subject, preview };
}

/** Resolve TASK file path across v3 lifecycle, legacy fcop/tasks/, and watcher dirs. */
function _wpResolveTaskFilePath(
  projectRoot: string,
  v3: ReturnType<typeof fcopV3Paths>,
  filename: string,
  pathHint?: string,
  extraDirs: string[] = [],
  taskId?: string,
): string | null {
  const hint = String(pathHint ?? "").trim();
  if (hint) {
    const abs = pathResolve(projectRoot, hint);
    if (existsSync(abs)) return abs;
    if (existsSync(hint)) return hint;
  }
  const stem = String(taskId ?? "").replace(/\.md$/i, "").trim();
  if (stem) {
    const byId = findTaskPathByIdSync(v3.lifecycleRoot, stem);
    if (byId) return byId.path;
  }
  const found = findTaskFile(v3, filename);
  if (found) return found.path;
  const legacy = join(projectRoot, "fcop", "tasks", filename);
  if (existsSync(legacy)) return legacy;
  for (const dir of extraDirs) {
    if (!dir) continue;
    const p = join(dir, filename);
    if (existsSync(p)) return p;
  }
  const historyPath = _wpFindTaskInHistory(projectRoot, filename);
  if (historyPath) return historyPath;
  return null;
}

function _wpIsHistoryTaskPath(fp: string): boolean {
  return /[/\\]fcop[/\\]history[/\\]/i.test(fp.replace(/\\/g, "/"));
}

function _wpDetectForceArchiveFromRaw(
  raw: string,
  fm: Record<string, string>,
  filePath?: string,
): boolean {
  if (/action:\s*force_archive_task/i.test(raw)) return true;
  if (String(fm.archive_mode ?? "").toLowerCase() === "force") return true;
  if (String(fm.task_type ?? "").toLowerCase() === "force_archive") return true;
  // frozen=true alone marks normal _lifecycle/archive/ closure, not force_archive.
  if (String(fm.frozen ?? "").toLowerCase() === "true") {
    if (filePath && _wpIsHistoryTaskPath(filePath)) return true;
  }
  return false;
}

/** Locate TASK under fcop/history/YYYY-MM-DD/<stem>/ (deep archive shards). */
function _wpFindTaskInHistory(
  projectRoot: string,
  filename: string,
): string | null {
  const historyRoot = join(projectRoot, "fcop", "history");
  if (!existsSync(historyRoot)) return null;
  for (const dateBucket of readdirSync(historyRoot)) {
    if (dateBucket === "reviews") continue;
    const bucketPath = join(historyRoot, dateBucket);
    try {
      if (!statSync(bucketPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const shard of readdirSync(bucketPath)) {
      const shardDir = join(bucketPath, shard);
      try {
        if (!statSync(shardDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const candidate = join(shardDir, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** TASK rows present only under fcop/history/ (not in ledger / _lifecycle). */
function _wpListHistoryTaskRows(
  projectRoot: string,
  senderFilter: string,
  recipientFilter: string,
): Record<string, unknown>[] {
  const historyRoot = join(projectRoot, "fcop", "history");
  const rows: Record<string, unknown>[] = [];
  if (!existsSync(historyRoot)) return rows;

  for (const dateBucket of readdirSync(historyRoot)) {
    if (dateBucket === "reviews") continue;
    const bucketPath = join(historyRoot, dateBucket);
    try {
      if (!statSync(bucketPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const shard of readdirSync(bucketPath)) {
      const shardDir = join(bucketPath, shard);
      try {
        if (!statSync(shardDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(shardDir)) {
        if (!f.startsWith("TASK-") || !f.endsWith(".md")) continue;
        try {
          const fullPath = join(shardDir, f);
          const raw = readFileSync(fullPath, "utf-8");
          const fileStat = statSync(fullPath);
          const match = raw.match(/^---\n([\s\S]*?)\n---/);
          const fm: Record<string, string> = {};
          if (match?.[1]) {
            for (const line of match[1].split("\n")) {
              const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
              if (kv) fm[kv[1]!] = kv[2]!.trim();
            }
          }
          if (
            senderFilter &&
            fm["sender"]?.toUpperCase() !== senderFilter.toUpperCase()
          ) {
            continue;
          }
          if (
            recipientFilter &&
            fm["recipient"]?.toUpperCase() !== recipientFilter.toUpperCase()
          ) {
            continue;
          }
          const { subject, preview } = _wpExtractDocDisplay(raw, f);
          const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
          const force = _wpDetectForceArchiveFromRaw(raw, fm, fullPath);
          rows.push({
            filename: f,
            scope: "history",
            bucket: "history",
            physical_scope: "history",
            state: "history",
            source: "history",
            path: relPath,
            mtime: fileStat.mtime.toISOString(),
            ...fm,
            subject,
            preview,
            ...(force ? { archive_mode: "force" } : {}),
          });
        } catch {
          rows.push({
            filename: f,
            scope: "history",
            bucket: "history",
            source: "history",
            error: "parse_failed",
          });
        }
      }
    }
  }
  return rows;
}

function _wpMergeHistoryOnlyTasks(
  rows: Record<string, unknown>[],
  projectRoot: string,
  senderFilter: string,
  recipientFilter: string,
): Record<string, unknown>[] {
  const seen = new Set(
    rows.map((r) => String(r.filename ?? "")).filter(Boolean),
  );
  const merged = [...rows];
  for (const h of _wpListHistoryTaskRows(
    projectRoot,
    senderFilter,
    recipientFilter,
  )) {
    const fn = String(h.filename ?? "");
    if (!fn || seen.has(fn)) continue;
    seen.add(fn);
    merged.push(h);
  }
  return merged;
}

/** Earliest `at:` under YAML `transitions:` (first lifecycle move, not last archive). */
function _wpExtractFirstTransitionAt(raw: string): string {
  const blockMatch = raw.match(/^transitions:\s*\n((?:[ \t].*(?:\r?\n|$))*)/m);
  if (!blockMatch) return "";
  let earliest = "";
  let earliestMs = Infinity;
  for (const m of (blockMatch[1] ?? "").matchAll(/^\s*-\s*at:\s*([^\r\n]+)/gm)) {
    const at = (m[1] ?? "").trim();
    const ms = Date.parse(at);
    if (!Number.isNaN(ms) && ms < earliestMs) {
      earliestMs = ms;
      earliest = at;
    }
  }
  return earliest;
}

/** @internal test hook */
export function wpExtractFirstTransitionAtForTests(raw: string): string {
  return _wpExtractFirstTransitionAt(raw);
}

// ── Git status helpers (panel card + post-commit refresh) ───────────────

type WpGitStatusFile = { path: string; status: string };

export type WpGitStatusPayload = {
  ok: true;
  branch: string;
  lastCommit: { hash: string; short: string; subject: string };
  uncommitted: number;
  rawUncommitted?: number;
  productUncommitted?: number;
  runtimeUncommitted?: number;
  remoteRef?: string;
  remoteHead?: { hash: string; short: string };
  ahead?: number;
  behind?: number;
  pushed?: boolean;
  files: WpGitStatusFile[];
};

export type WpGitDiagnostics = {
  branch: string;
  headShort: string;
  statusShort: string;
};

function wpParseGitStatusShort(stdout: string): WpGitStatusFile[] {
  const statusLines = stdout.split("\n").filter((l) => l.trim().length > 0);
  return statusLines.map((line) => {
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ")
      ? (rawPath.split(" -> ")[1] ?? rawPath).trim()
      : rawPath;
    const status = xy.trim()[0] === "?" ? "?" : xy[0] !== " " ? xy[0] : xy[1];
    return { path: filePath, status: status || "M" };
  });
}

function wpParseGitStatusPorcelainZ(stdout: string): WpGitStatusFile[] {
  const fields = stdout.split("\0");
  const files: WpGitStatusFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] ?? "";
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const status = xy.trim()[0] === "?" ? "?" : xy[0] !== " " ? xy[0] : xy[1];
    const filePath = record.slice(3);
    if (filePath) files.push({ path: filePath, status: status || "M" });
    if (xy.includes("R") || xy.includes("C")) {
      const originalPath = fields[index + 1] ?? "";
      if (originalPath) files.push({ path: originalPath, status: status || "M" });
      index += 1;
    }
  }
  return files;
}

async function wpStageGitPaths(cwd: string, paths: string[]): Promise<void> {
  const pathspecFile = join(
    os.tmpdir(),
    `codeflowmu-git-pathspec-${process.pid}-${Date.now()}.txt`,
  );
  const literalPathspecs = paths.map((file) => `:(literal)${file}`);
  writeFileSync(pathspecFile, `${literalPathspecs.join("\0")}\0`, "utf-8");
  try {
    await execFile(
      "git",
      ["add", "-A", `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul"],
      { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 * 4 },
    );
  } finally {
    try {
      unlinkSync(pathspecFile);
    } catch {
      // Best-effort cleanup only; staging has already completed or failed.
    }
  }
}

function wpGitCommandErrorMessage(error: unknown): string {
  const detail = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const stderr = String(detail?.stderr ?? "").trim();
  const stdout = String(detail?.stdout ?? "").trim();
  const message = error instanceof Error ? error.message : String(error);
  return stderr || stdout || message;
}

function wpIsMotherRuntimeLedgerPath(file: string): boolean {
  const value = file.replace(/\\/g, "/");
  return (
    value === "fcop" ||
    value === "fcop/" ||
    value.startsWith("fcop/ledger/") ||
    value.startsWith("fcop/_lifecycle/") ||
    value.startsWith("fcop/reports/") ||
    value.startsWith("fcop/logs/runtime/") ||
    value.startsWith("fcop/internal/eval/") ||
    value === ".codeflowmu" ||
    value === ".codeflowmu/" ||
    value === ".codeflowmu/panel-ui-lang.json" ||
    value.startsWith(".codeflowmu/pm-governance/") ||
    value.startsWith(".codeflowmu/report-watcher/") ||
    value === ".codeflowmu/skill-invocations.jsonl" ||
    (value.startsWith("workspace/") && value !== "workspace/README.md")
  );
}

export const wpIsMotherRuntimeLedgerPathForTests = wpIsMotherRuntimeLedgerPath;

async function wpReadGitStatusPayload(cwd: string): Promise<WpGitStatusPayload> {
  const opts = { cwd, timeout: 10000 };
  const [branchOut, statusOut] = await Promise.all([
    execFile("git", ["branch", "--show-current"], opts),
    execFile("git", ["status", "--porcelain=v1", "-z"], opts),
  ]);

  const branch = (branchOut.stdout as string).trim();
  let logLine = "";
  try {
    const logOut = await execFile("git", ["log", "-1", "--format=%H %s"], opts);
    logLine = (logOut.stdout as string).trim();
  } catch {
    logLine = "";
  }
  const spaceIdx = logLine.indexOf(" ");
  const hash = spaceIdx > 0 ? logLine.slice(0, spaceIdx) : logLine;
  const subject = spaceIdx > 0 ? logLine.slice(spaceIdx + 1) : "";
  const files = wpParseGitStatusPorcelainZ(statusOut.stdout as string);
  const runtimeFiles = files.filter((file) => wpIsMotherRuntimeLedgerPath(file.path));
  const productFiles = files.filter((file) => !wpIsMotherRuntimeLedgerPath(file.path));
  const tracking = await wpReadGitTrackingState(cwd, branch || "main", hash);

  return {
    ok: true,
    branch,
    lastCommit: { hash, short: hash.slice(0, 7), subject },
    uncommitted: productFiles.length,
    rawUncommitted: files.length,
    productUncommitted: productFiles.length,
    runtimeUncommitted: runtimeFiles.length,
    ...tracking,
    files,
  };
}

async function wpReadGitTrackingState(
  cwd: string,
  branch: string,
  headHash: string,
): Promise<Pick<WpGitStatusPayload, "remoteRef" | "remoteHead" | "ahead" | "behind" | "pushed">> {
  const remoteRef = `origin/${branch || "main"}`;
  try {
    const remoteOut = await execFile("git", ["rev-parse", "--verify", remoteRef], {
      cwd,
      timeout: 10000,
      maxBuffer: 1024 * 64,
    });
    const remoteHash = String(remoteOut.stdout ?? "").trim();
    let ahead = 0;
    let behind = 0;
    try {
      const countOut = await execFile("git", ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`], {
        cwd,
        timeout: 10000,
        maxBuffer: 1024 * 64,
      });
      const [behindRaw, aheadRaw] = String(countOut.stdout ?? "").trim().split(/\s+/);
      behind = Number(behindRaw || 0);
      ahead = Number(aheadRaw || 0);
    } catch {
      ahead = remoteHash && headHash && remoteHash !== headHash ? 1 : 0;
      behind = 0;
    }
    return {
      remoteRef,
      remoteHead: remoteHash ? { hash: remoteHash, short: remoteHash.slice(0, 7) } : undefined,
      ahead,
      behind,
      pushed: !!remoteHash && !!headHash && remoteHash === headHash && ahead === 0,
    };
  } catch {
    return { remoteRef };
  }
}

function wpHasOwnGitRepository(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

async function wpReadGitRemoteUrl(cwd: string): Promise<string> {
  try {
    const out = await execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 10000 });
    return String(out.stdout ?? "").trim();
  } catch {
    return "";
  }
}

async function wpReadGitBranch(cwd: string): Promise<string> {
  try {
    const out = await execFile("git", ["branch", "--show-current"], { cwd, timeout: 10000 });
    return String(out.stdout ?? "").trim();
  } catch {
    return "";
  }
}

async function wpReadGitDiagnostics(cwd: string): Promise<WpGitDiagnostics> {
  const opts = { cwd, timeout: 10000 };
  const [branchOut, statusOut] = await Promise.all([
    execFile("git", ["branch", "--show-current"], opts),
    execFile("git", ["status", "--short"], opts),
  ]);
  let headShort = "";
  try {
    const headOut = await execFile("git", ["rev-parse", "--short", "HEAD"], opts);
    headShort = (headOut.stdout as string).trim();
  } catch {
    headShort = "";
  }
  return {
    branch: (branchOut.stdout as string).trim(),
    headShort,
    statusShort: (statusOut.stdout as string).trim(),
  };
}

function wpLogGitCommitDiagnostics(phase: string, diag: WpGitDiagnostics): void {
  const lineCount = diag.statusShort.split("\n").filter((l) => l.trim()).length;
  console.warn(
    `[git-commit] ${phase}: branch=${diag.branch || "(detached)"} head=${diag.headShort || "—"} uncommitted=${lineCount}`,
  );
  if (diag.statusShort) {
    console.warn(`[git-commit] ${phase} git status --short:\n${diag.statusShort}`);
  } else {
    console.warn(`[git-commit] ${phase} git status --short: (clean)`);
  }
}

const GIT_POST_COMMIT_SETTLE_MS = 500;

async function wpReadGitStatusAfterCommit(cwd: string): Promise<WpGitStatusPayload> {
  await new Promise((r) => setTimeout(r, GIT_POST_COMMIT_SETTLE_MS));
  let status = await wpReadGitStatusPayload(cwd);
  if (status.uncommitted > 0) {
    await new Promise((r) => setTimeout(r, 300));
    status = await wpReadGitStatusPayload(cwd);
  }
  return status;
}

/** @internal test hook */
export function wpParseGitStatusShortForTests(stdout: string): WpGitStatusFile[] {
  return wpParseGitStatusShort(stdout);
}

/** @internal test hook */
export function wpParseGitStatusPorcelainZForTests(stdout: string): WpGitStatusFile[] {
  return wpParseGitStatusPorcelainZ(stdout);
}

/** @internal test hook */
export function wpIsProductGitStatusFileForTests(file: string): boolean {
  return !wpIsMotherRuntimeLedgerPath(file);
}

const TASK_FRONTMATTER_WARN_BYTES = 64 * 1024;
const TASK_TRANSITIONS_WARN = 100;
const TASK_TRANSITIONS_CRITICAL = 300;

function _wpCollectTaskTransitions(
  task: Record<string, unknown>,
): unknown[] {
  if (Array.isArray(task.transitions)) return task.transitions;
  const yaml = task.yaml as { transitions?: unknown[] } | undefined;
  if (Array.isArray(yaml?.transitions)) return yaml.transitions;
  return [];
}

/** List API: never ship full transition history — summary fields only. */
export function wpSummarizeTaskTransitionsForList(
  task: Record<string, unknown>,
): { task: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const transitions = _wpCollectTaskTransitions(task);
  const count = transitions.length;
  const tid = String(task.task_id ?? task.filename ?? "unknown");
  if (count > TASK_TRANSITIONS_CRITICAL) {
    warnings.push(
      `task_transitions_critical:${tid}:count=${count}`,
    );
  } else if (count > TASK_TRANSITIONS_WARN) {
    warnings.push(`task_transitions_warning:${tid}:count=${count}`);
  }
  const latest =
    count > 0
      ? (transitions[count - 1] as Record<string, unknown>)
      : undefined;
  const next: Record<string, unknown> = { ...task };
  delete next.transitions;
  if (next.yaml && typeof next.yaml === "object") {
    const yaml = { ...(next.yaml as Record<string, unknown>) };
    delete yaml.transitions;
    next.yaml = yaml;
  }
  next.transition_count = count;
  if (latest) next.latest_transition = latest;
  return { task: next, warnings };
}

function _wpEnrichTasksFromDisk(
  tasks: Record<string, unknown>[],
  projectRoot: string,
  v3: ReturnType<typeof fcopV3Paths>,
  extraDirs: string[] = [],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of tasks) {
    let row = t;
    const fn = String(row.filename ?? "");
    if (!fn || row.error) {
      out.push(row);
      continue;
    }
    const fp = _wpResolveTaskFilePath(
      projectRoot,
      v3,
      fn,
      String(t.path ?? ""),
      extraDirs,
      String(row.task_id ?? ""),
    );
    if (!fp) {
      if (row._source === "ledger") continue;
      out.push(row);
      continue;
    }
    try {
      const raw = readFileSync(fp, "utf-8");
      const fmBlockMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      const fmBytes = fmBlockMatch
        ? Buffer.byteLength(fmBlockMatch[0], "utf-8")
        : 0;
      if (fmBytes > TASK_FRONTMATTER_WARN_BYTES) {
        row = {
          ...row,
          _frontmatter_warning: `frontmatter_bytes=${fmBytes}`,
        };
      }
      const { subject, preview } = _wpExtractDocDisplay(raw, fn);
      const fm = _wpParseFmYaml(raw);
      const flowStartedAt = _wpExtractFirstTransitionAt(raw);
      const subj = String(row.subject ?? "").trim() || subject;
      const prev = String(row.preview ?? row.summary ?? "").trim() || preview;
      let mtime = row.mtime;
      let birthtime = "";
      try {
        const st = statSync(fp);
        mtime = st.mtime.toISOString();
        birthtime = st.birthtime.toISOString();
      } catch {
        /* keep ledger updated_at */
      }
      const reopenReason = String(fm.reopen_reason ?? row.reopen_reason ?? "").trim();
      const reviewNote = String(fm.review_note ?? row.review_note ?? "").trim();
      const reviewStatus = String(fm.review_status ?? row.review_status ?? "").trim();
      const reopenedCount = Number(fm.reopened_count ?? row.reopened_count ?? 0);
      const yamlDisplayStatus = String(fm.display_status ?? row.display_status ?? "").trim();
      const reworkCompletedBy = String(
        fm.rework_completed_by_report ??
          (row as { rework_completed_by_report?: string }).rework_completed_by_report ??
          "",
      ).trim();
      const diskBucket =
        stageFromPath(fp, v3.lifecycleRoot) ??
        (_wpIsHistoryTaskPath(fp) ? "archive" : null);
      const ledgerScope = String(
        row.bucket ?? row._state ?? row.state ?? "",
      ).toLowerCase();
      const effectiveScope = diskBucket ?? ledgerScope;
      const relPath = path.relative(projectRoot, fp).replace(/\\/g, "/");
      const transitions = _wpCollectTaskTransitions(row);
      const transitionCount = transitions.length;
      const latestTransition =
        transitionCount > 0
          ? (transitions[transitionCount - 1] as Record<string, unknown>)
          : undefined;
      const settledApprovedOnDisk =
        reviewStatus.toLowerCase() === "approved" &&
        (diskBucket === "done" ||
          diskBucket === "archive" ||
          effectiveScope === "done" ||
          effectiveScope === "archive");
      const reworkFields = {
        display_status: yamlDisplayStatus,
        reopen_reason: reopenReason,
        review_note: reviewNote,
        review_status: reviewStatus,
        reopened_count: reopenedCount,
        rework_completed_by_report: reworkCompletedBy,
        bucket: diskBucket ?? String(t.bucket ?? effectiveScope),
        scope: effectiveScope,
        state: String(row.state ?? fm.state ?? ""),
      };
      const isReopenedForRework = isTaskReopenedForReworkFromLedger(reworkFields);
      const merged: Record<string, unknown> = {
        ...row,
        subject: subj,
        preview: prev,
        summary: prev,
        path: relPath,
        ...(mtime ? { mtime } : {}),
        ...(birthtime ? { flow_created_at: birthtime } : {}),
        ...(reopenReason ? { reopen_reason: reopenReason } : {}),
        ...(reviewNote ? { review_note: reviewNote } : {}),
        ...(reviewStatus ? { review_status: reviewStatus } : {}),
        ...(reopenedCount > 0 ? { reopened_count: reopenedCount } : {}),
        ...(yamlDisplayStatus && !settledApprovedOnDisk
          ? { display_status: yamlDisplayStatus }
          : {}),
        ...(reworkCompletedBy ? { rework_completed_by_report: reworkCompletedBy } : {}),
        transition_count: transitionCount,
        ...(latestTransition ? { latest_transition: latestTransition } : {}),
        ...(flowStartedAt ? { flow_started_at: flowStartedAt } : {}),
        ledger_scope: ledgerScope,
        ...(diskBucket ? { scope: diskBucket, physical_scope: diskBucket } : {}),
      };
      if (settledApprovedOnDisk) {
        merged.display_status = "done";
      } else if (yamlDisplayStatus) {
        merged.display_status = yamlDisplayStatus;
        if (
          isReopenedForRework &&
          !isReworkResubmitUnblocked(reworkFields) &&
          (effectiveScope === "done" || effectiveScope === "archive")
        ) {
          merged.scope = "active";
        }
      } else if (isReopenedForRework) {
        merged.display_status = "admin_rejected";
        const scope = String(merged.scope ?? effectiveScope).toLowerCase();
        if (scope === "done" || scope === "archive") {
          merged.scope = "active";
        }
      } else if (
        reviewStatus.toLowerCase() === "approved" &&
        diskBucket === "done"
      ) {
        merged.display_status = "done";
      }
      if (_wpDetectForceArchiveFromRaw(raw, fm, fp)) {
        merged.archive_mode = "force";
      }
      if (String(fm.frozen ?? "").toLowerCase() === "true") {
        merged.frozen = "true";
      }
      const parentRaw = String(
        row.parent_task_id ?? row.parent ?? fm.parent ?? "",
      ).trim();
      if (parentRaw) {
        merged.parent = parentRaw;
        merged.parent_task_id = parentRaw;
      }
      out.push(merged);
    } catch {
      out.push(row);
    }
  }
  return out;
}

function _wpNormQueueTaskId(taskId: string): string {
  return String(taskId ?? "")
    .replace(/\.md$/i, "")
    .trim()
    .toUpperCase();
}

async function _wpMergeAgentDispatchStatus(
  tasks: Record<string, unknown>[],
  projectRoot: string,
): Promise<Record<string, unknown>[]> {
  try {
    const snap = await getAgentQueueApiSnapshot(projectRoot);
    const rows = snap.agents?.tasks ?? [];
    const map = new Map<
      string,
      {
        dispatch_status: string;
        queue_position?: number;
        agent_id: string;
      }
    >();
    for (const row of rows) {
      const tid = _wpNormQueueTaskId(String(row.task_id ?? ""));
      if (!tid) continue;
      map.set(tid, row);
    }
    return tasks.map((t) => {
      const fn = String(t.filename ?? t.task_id ?? "");
      const tid =
        _wpNormQueueTaskId(taskIdFromFilename(fn)) ||
        _wpNormQueueTaskId(String(t.task_id ?? ""));
      const dq = map.get(tid);
      if (!dq) return t;
      return {
        ...t,
        dispatch_status: dq.dispatch_status,
        ...(dq.queue_position != null ? { queue_position: dq.queue_position } : {}),
        dispatch_agent_id: dq.agent_id,
      };
    });
  } catch {
    return tasks;
  }
}

/** Ledger rows lack body text — read REPORT file from disk when available. */
function _wpEnrichReportsFromDisk(
  reports: Record<string, unknown>[],
  reportsDir: string | undefined,
): Record<string, unknown>[] {
  if (!reportsDir || !existsSync(reportsDir)) return reports;
  return reports.map((r) => {
    const fn = String(r.filename ?? "");
    if (!fn || r.error) return r;
    try {
      const fp = join(reportsDir, fn);
      if (!existsSync(fp)) return r;
      const raw = readFileSync(fp, "utf-8");
      const fm = _wpParseFmYaml(raw);
      const { subject, preview } = _wpExtractDocDisplay(raw, fn);
      const subj = String(r.subject ?? "").trim() || subject;
      const prev = String(r.preview ?? r.summary ?? "").trim() || preview;
      const created_at =
        String(fm["created_at"] ?? "").trim() ||
        String(r.created_at ?? "").trim() ||
        undefined;
      const updated_at =
        String(fm["updated_at"] ?? "").trim() ||
        String(r.updated_at ?? "").trim() ||
        undefined;
      let mtime = r.mtime;
      try {
        mtime = statSync(fp).mtime.toISOString();
      } catch {
        /* keep ledger updated_at */
      }
      const structuredIds = structuredLinkedTaskIdsFromReport(
        r as Record<string, unknown>,
        fm,
      );
      const bodyMentions = inferredBodyTaskMentionsFromMarkdown(raw);
      return {
        ...r,
        subject: subj,
        preview: prev,
        summary: prev,
        ...(mtime ? { mtime } : {}),
        ...(created_at ? { created_at } : {}),
        ...(updated_at ? { updated_at } : {}),
        ..._wpMergeLinkedTaskIds(r, structuredIds),
        ...(bodyMentions.length ? { inferred_body_task_mentions: bodyMentions } : {}),
      };
    } catch {
      return r;
    }
  });
}

function _wpStripMdBody(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function _wpDeriveAdminQuestion(
  humanRequestType: string | undefined,
  requestedAction: string | undefined,
): string {
  if (humanRequestType === "risk_approval") return "是否允许本次 review_to_done？";
  if (humanRequestType === "fallback_to_human") return "是否人工确认后继续？";
  if (requestedAction?.trim()) return `是否批准执行：${requestedAction}？`;
  return "是否批准本次 REVIEW-GATE 审批？";
}

function _wpBuildApprovalEvidenceDiff(parts: {
  admin_question?: string;
  target_task?: string;
  requested_action?: string;
  trigger_reason?: string;
  summary?: string;
  red_flags?: string[];
  task_excerpt?: string;
  report_excerpt?: string;
  review_excerpt?: string;
}): string {
  const lines: string[] = ["@@ 审批依据 @@", ""];
  const push = (label: string, text?: string) => {
    if (!text?.trim()) return;
    lines.push(`+【${label}】`);
    for (const ln of text.trim().split("\n").slice(0, 30)) {
      lines.push(`+${ln}`);
    }
    lines.push("+");
  };
  push("ADMIN 裁决", parts.admin_question);
  push("目标任务", parts.target_task);
  push("审批动作", parts.requested_action);
  push("触发原因", parts.trigger_reason);
  push("摘要", parts.summary);
  if (parts.red_flags?.length) {
    lines.push(`+【风险标记】 ${parts.red_flags.join(" · ")}`);
    lines.push("+");
  }
  push("TASK 摘录", parts.task_excerpt);
  push("REPORT 摘录", parts.report_excerpt);
  push("REVIEW 摘录", parts.review_excerpt);
  return lines.join("\n");
}

async function _wpEnrichPendingApproval(
  projectRoot: string,
  reviewsDir: string,
  fcopReportsDir: string | undefined,
  filename: string,
  raw: string,
  fm: Record<string, unknown>,
  preview: string,
  flat: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = _wpStripMdBody(raw);
  const taskId =
    strField(fm, "task_id") ||
    strField(fm, "subject_id") ||
    "";
  const taskPrefix = taskId.replace(/\.md$/i, "").trim();

  let taskFm: Record<string, unknown> | null = null;
  let taskFilename: string | null = null;
  let taskBody = "";
  if (taskPrefix.startsWith("TASK-") && projectRoot) {
    const hit = findTaskFileByIdPrefix(projectRoot, taskPrefix);
    if (hit) {
      taskFilename = hit.filename;
      try {
        const taskRaw = readFileSync(hit.path, "utf-8");
        taskFm = parseMarkdownFrontmatter(taskRaw) as Record<string, unknown>;
        taskBody = _wpStripMdBody(taskRaw);
      } catch {
        /* ignore */
      }
    }
  }

  let reportFm: Record<string, unknown> | null = null;
  let reportBody = "";
  const reporter = taskFm
    ? strField(taskFm, "recipient") || strField(taskFm, "reporter")
    : "PM";
  const reportRecipient = taskFm ? strField(taskFm, "sender") : undefined;
  const resolvedTaskId = taskPrefix || strField(fm, "subject_id");

  if (resolvedTaskId.startsWith("TASK-") && projectRoot) {
    const reportPath = await findReportPathForTaskOnDisk({
      projectRoot,
      fcopReportsDir,
      taskId: resolvedTaskId,
      reporter,
      reportRecipient: reportRecipient || undefined,
    });
    if (reportPath) {
      const abs =
        reportPath.includes("/") || reportPath.includes("\\")
          ? join(projectRoot, reportPath.replace(/\//g, path.sep))
          : join(
              fcopReportsDir ?? join(projectRoot, "fcop", "reports"),
              reportPath,
            );
      try {
        const reportRaw = readFileSync(abs, "utf-8");
        reportFm = parseMarkdownFrontmatter(reportRaw) as Record<string, unknown>;
        reportBody = _wpStripMdBody(reportRaw);
      } catch {
        /* ignore */
      }
    }
  }

  const card = buildReviewGateApprovalCard({
    reviewFrontmatter: fm,
    reviewFilename: filename,
    taskFrontmatter: taskFm,
    taskFilename,
    reportFrontmatter: reportFm,
    reportBody: reportBody || null,
    taskId: resolvedTaskId || undefined,
  });

  const target_task = card.related_task_id || resolvedTaskId || "";
  const summary =
    strField(fm, "rationale") ||
    strField(fm, "summary") ||
    preview ||
    card.trigger_reason ||
    "";
  const humanRequestType =
    flat["human_request_type"] || card.human_request_type;
  const admin_question = _wpDeriveAdminQuestion(
    humanRequestType,
    card.requested_action,
  );

  const redFlagLabels = card.red_flags.map(
    (f) => REVIEW_GATE_RED_FLAG_LABELS[f] ?? f,
  );

  const excerpt = (text: string, max = 800) => {
    const t = text.trim();
    return t.slice(0, max) + (t.length > max ? "\n…" : "");
  };

  const diff = _wpBuildApprovalEvidenceDiff({
    admin_question,
    target_task,
    requested_action: card.requested_action,
    trigger_reason: card.trigger_reason,
    summary,
    red_flags: redFlagLabels,
    task_excerpt: taskBody ? excerpt(taskBody) : undefined,
    report_excerpt: reportBody ? excerpt(reportBody) : undefined,
    review_excerpt: body ? excerpt(body) : undefined,
  });

  const matchedRules =
    flat["matched_rules"] ||
    (card.matched_rules?.length ? card.matched_rules.join(",") : "");

  return {
    id: filename,
    filename,
    preview,
    ...flat,
    target_task,
    summary,
    requested_action: card.requested_action,
    trigger_reason: card.trigger_reason,
    admin_question,
    gate_status: card.gate_status,
    can_approve: card.can_approve,
    red_flags: card.red_flags,
    red_flag_labels: redFlagLabels,
    related_task_id: card.related_task_id,
    related_report_id: card.related_report_id,
    on_approve: card.on_approve,
    on_reject: card.on_reject,
    diff,
    ...(humanRequestType ? { human_request_type: humanRequestType } : {}),
    ...(matchedRules ? { matched_rules: matchedRules } : {}),
    ...(card.team_type ? { team_type: card.team_type } : {}),
    ...(card.approval_mode ? { approval_mode: card.approval_mode } : {}),
  };
}

async function _wpListPendingApprovalsForProject(options: {
  projectRoot: string;
  reviewsDir: string | undefined;
  fcopReportsDir: string | undefined;
  taskId?: string;
  threadKey?: string;
}): Promise<Record<string, unknown>[]> {
  const reviewsDir = options.reviewsDir;
  if (!reviewsDir || !existsSync(reviewsDir)) return [];
  const scopeTaskId = String(options.taskId ?? "").trim();
  const scopeThreadKey = String(options.threadKey ?? "").trim();
  const files = readdirSync(reviewsDir).filter((f) => f.endsWith(".md") && f.startsWith("REVIEW-")).sort();
  return (
    await Promise.all(
      files.map(async (f) => {
        try {
          const raw = readFileSync(join(reviewsDir, f), "utf-8");
          const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
          if (!isReviewPendingHuman(fm)) return null;
          const linkedTaskId = String(fm["task_id"] ?? "").trim();
          if (linkedTaskId) {
            const taskHit = findTaskFileByIdPrefix(options.projectRoot, linkedTaskId);
            const normalizedPath = taskHit?.path?.replace(/\\/g, "/").toLowerCase() ?? "";
            if (
              normalizedPath.includes("/fcop/_lifecycle/done/") ||
              normalizedPath.includes("/fcop/_lifecycle/archive/")
            ) {
              const resolved = _wpPatchFmFields(raw, {
                resolution_status: "obsolete",
                resolved_at: new Date().toISOString(),
                resolution_reason: "task_already_completed",
              });
              writeFileSync(join(reviewsDir, f), resolved, "utf-8");
              return null;
            }
          }
          if (
            !reviewMatchesScope(fm, {
              taskId: scopeTaskId || undefined,
              threadKey: scopeThreadKey || undefined,
            })
          ) {
            return null;
          }
          const body = _wpStripMdBody(raw);
          const preview =
            body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(fm)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              flat[k] = String(v);
            }
          }
          const ha = fm["human_approval"];
          if (ha && typeof ha === "object") {
            const haObj = ha as Record<string, unknown>;
            if (typeof haObj["human_request_type"] === "string") {
              flat["human_request_type"] = haObj["human_request_type"];
            }
            if (typeof haObj["team_type"] === "string") {
              flat["team_type"] = haObj["team_type"];
            }
            if (Array.isArray(haObj["matched_rules"])) {
              flat["matched_rules"] = haObj["matched_rules"].map(String).filter(Boolean).join(",");
            }
          }
          return await _wpEnrichPendingApproval(
            options.projectRoot,
            reviewsDir,
            options.fcopReportsDir,
            f,
            raw,
            fm,
            preview,
            flat,
          );
        } catch {
          return null;
        }
      }),
    )
  ).filter((row): row is Record<string, unknown> => row !== null);
}

const _WP_TASK_ID_LONG_RE =
  /TASK-\d{8}-\d{3,}-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+/gi;
const _WP_TASK_ID_SHORT_RE = /TASK-\d{8}-\d{3,}/g;
const _WP_TASK_SEQ_RE = /TASK-(\d{8})-(\d{3,})/g;

/** Structured TASK ids from frontmatter only (no body scan — body → inferred_body_task_mentions). */
function _wpLinkedTaskIds(raw: string): string[] {
  const fm = _wpParseFmYaml(raw);
  return structuredLinkedTaskIdsFromReport({}, fm);
}

function _wpMergeLinkedTaskIds(
  row: Record<string, unknown>,
  diskIds: string[],
): { linked_task_ids?: string[]; task_id?: string } {
  if (!diskIds.length) return {};
  const existing = Array.isArray(row.linked_task_ids)
    ? row.linked_task_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const merged = [...new Set([...existing, ...diskIds])];
  const patch: { linked_task_ids: string[]; task_id?: string } = {
    linked_task_ids: merged,
  };
  if (!String(row.task_id ?? "").trim() && diskIds[0]) {
    patch.task_id = diskIds[0];
  }
  return patch;
}

function _wpScanTaskSeqText(text: string, date: string): number {
  let max = 0;
  for (const m of text.matchAll(_WP_TASK_SEQ_RE)) {
    if (m[1] === date) max = Math.max(max, Number(m[2]));
  }
  return max;
}

function _wpScanTaskSeqFile(file: string, date: string): number {
  let max = _wpScanTaskSeqText(pathBasename(file), date);
  try {
    const stat = statSync(file);
    if (stat.isFile() && stat.size <= 10 * 1024 * 1024) {
      max = Math.max(max, _wpScanTaskSeqText(readFileSync(file, "utf-8"), date));
    }
  } catch {
    /* ignore unreadable runtime files */
  }
  return max;
}

function _wpScanTaskSeqDir(dir: string, date: string): number {
  if (!existsSync(dir)) return 0;
  let max = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        max = Math.max(max, _wpScanTaskSeqDir(full, date));
      } else if (stat.isFile()) {
        max = Math.max(max, _wpScanTaskSeqFile(full, date));
      }
    } catch {
      /* ignore files that disappear while scanning */
    }
  }
  return max;
}

function _wpTaskSeqStatePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "runtime", "task-sequence.json");
}

function _wpReadTaskSeqState(projectRoot: string): Record<string, number> {
  try {
    const raw = readFileSync(_wpTaskSeqStatePath(projectRoot), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (/^\d{8}$/.test(k) && Number.isFinite(Number(v))) {
        state[k] = Math.max(0, Math.floor(Number(v)));
      }
    }
    return state;
  } catch {
    return {};
  }
}

function _wpWriteTaskSeqState(projectRoot: string, state: Record<string, number>): void {
  const file = _wpTaskSeqStatePath(projectRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function _wpNextTaskSeq(projectRoot: string, date: string): string {
  const paths = fcopV3Paths(projectRoot);
  const scanRoots = [
    ...fcopV3TaskSearchDirs(paths),
    paths.reports,
    paths.reviews,
    join(projectRoot, "fcop", "history"),
    join(projectRoot, "fcop", "internal"),
    join(projectRoot, "fcop", "alerts"),
    join(projectRoot, "fcop", "logs"),
    join(projectRoot, "fcop", "chat"),
  ];
  let max = 0;
  for (const root of scanRoots) max = Math.max(max, _wpScanTaskSeqDir(root, date));
  const state = _wpReadTaskSeqState(projectRoot);
  max = Math.max(max, state[date] ?? 0);
  const next = max + 1;
  state[date] = next;
  _wpWriteTaskSeqState(projectRoot, state);
  return String(next).padStart(3, "0");
}

/** Short window: duplicate Panel/API submits with identical payload → one TASK file. */
const WP_TASK_CREATE_DEDUP_MS = 10 * 60 * 1000;
const WP_TASK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const wpTaskIdempotency = new Map<
  string,
  { filename: string; filepath: string; createdAt: number }
>();

/** In-process dedup: same payload within window before/without disk visibility. */
const wpRecentAdminPmCreates = new Map<
  string,
  { filename: string; filepath: string; createdAt: number }
>();

function _wpDedupMemKey(projectRoot: string, fingerprint: string): string {
  return `${pathResolve(projectRoot)}\0${fingerprint}`;
}

function _wpNormalizeDedupText(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function _wpAttachmentPathsFromAttachments(
  attachments: ChatImageAttachment[],
): string {
  return attachments
    .map((a) => String(a.absolute_path || a.local_path || a.url || "").trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function _wpAttachmentPathsFromTaskMarkdown(raw: string): string {
  const paths: string[] = [];
  const re = /local_path:\s*"?([^"\n]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    paths.push(m[1]!.trim());
  }
  return paths.sort().join("|");
}

function _wpParseTaskMarkdownForDedup(raw: string): { subject: string; body: string } {
  const parts = raw.split(/\r?\n---\r?\n/);
  let md = parts.length >= 3 ? parts.slice(2).join("\n---\n") : raw;
  md = md.trim();
  const titleMatch = md.match(/^#\s+(.+?)\s*$/m);
  const subject = titleMatch ? titleMatch[1]! : "";
  const body = _wpNormalizeDedupText(md.replace(/^#\s+.+?\s*$/m, ""));
  return { subject: _wpNormalizeDedupText(subject), body };
}

/** Stable fingerprint for ADMIN→PM task create (panel form + chat as_task). */
export function wpTaskCreateFingerprint(
  subject: string,
  body: string,
  attachments: ChatImageAttachment[],
): string {
  return [
    _wpNormalizeDedupText(subject),
    _wpNormalizeDedupText(body),
    _wpAttachmentPathsFromAttachments(attachments),
  ].join("\0");
}

function _wpTaskFingerprintFromMarkdown(raw: string): string {
  const { subject, body } = _wpParseTaskMarkdownForDedup(raw);
  return [subject, body, _wpAttachmentPathsFromTaskMarkdown(raw)].join("\0");
}

export function wpGetIdempotencyReplay(
  key: string,
): { filename: string; filepath: string } | null {
  const ent = wpTaskIdempotency.get(key);
  if (!ent) return null;
  if (Date.now() - ent.createdAt > WP_TASK_IDEMPOTENCY_TTL_MS) {
    wpTaskIdempotency.delete(key);
    return null;
  }
  return { filename: ent.filename, filepath: ent.filepath };
}

export function wpRememberIdempotency(
  key: string,
  filename: string,
  filepath: string,
): void {
  wpTaskIdempotency.set(key, { filename, filepath, createdAt: Date.now() });
}

export function wpRememberRecentAdminPmCreate(
  projectRoot: string,
  fingerprint: string,
  filename: string,
  filepath: string,
): void {
  wpRecentAdminPmCreates.set(_wpDedupMemKey(projectRoot, fingerprint), {
    filename,
    filepath,
    createdAt: Date.now(),
  });
}

function _wpGetRecentAdminPmCreate(
  projectRoot: string,
  fingerprint: string,
  windowMs: number,
): { filename: string; filepath: string } | null {
  const key = _wpDedupMemKey(projectRoot, fingerprint);
  const ent = wpRecentAdminPmCreates.get(key);
  if (!ent) return null;
  if (Date.now() - ent.createdAt > windowMs) {
    wpRecentAdminPmCreates.delete(key);
    return null;
  }
  if (!existsSync(ent.filepath)) {
    wpRecentAdminPmCreates.delete(key);
    return null;
  }
  return { filename: ent.filename, filepath: ent.filepath };
}

export function wpClearIdempotencyCacheForTests(): void {
  wpTaskIdempotency.clear();
  wpRecentAdminPmCreates.clear();
}

/**
 * Reset in-process project registry for tests.
 * Pass `bootstrapRoot` to pin the active project (skips loading ~/.codeflowmu registry).
 */
export function wpResetProjectStoreForTests(bootstrapRoot?: string): void {
  wpClearIdempotencyCacheForTests();
  projectStore.clear();
  activeProjectId = "default";
  if (bootstrapRoot) {
    const root = pathResolve(bootstrapRoot);
    projectStoreHydrated = true;
    projectStore.set("default", {
      id: "default",
      name: defaultProjectDisplayName(root),
      root,
      active: true,
    });
    const seqPath = join(root, ".codeflowmu", "runtime", "task-sequence.json");
    try {
      unlinkSync(seqPath);
    } catch {
      /* absent is fine */
    }
    return;
  }
  projectStoreHydrated = false;
}

export async function wpFindRecentDuplicateAdminPmTask(
  projectRoot: string,
  fingerprint: string,
  adminTasksDir?: string,
  windowMs: number = WP_TASK_CREATE_DEDUP_MS,
): Promise<{ filename: string; filepath: string } | null> {
  const mem = _wpGetRecentAdminPmCreate(projectRoot, fingerprint, windowMs);
  if (mem) return mem;

  const v3 = fcopV3Paths(pathResolve(projectRoot));
  const dirs: string[] = [];
  const addDir = (d?: string) => {
    if (!d) return;
    const n = pathResolve(d);
    if (!dirs.includes(n)) dirs.push(n);
  };
  addDir(adminTasksDir);
  addDir(v3.inbox);
  addDir(v3.active);
  const cutoff = Date.now() - windowMs;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^TASK-\d{8}-\d{3,}-ADMIN-to-PM\.md$/i.test(name)) continue;
      const filepath = join(dir, name);
      try {
        const st = statSync(filepath);
        if (st.mtimeMs < cutoff) continue;
        const raw = readFileSync(filepath, "utf-8");
        if (_wpTaskFingerprintFromMarkdown(raw) === fingerprint) {
          return { filename: name, filepath };
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return null;
}

type DispatchRetryResolveResult =
  | {
      ok: true;
      filepath: string;
      filename: string;
      recipient: string;
      retryKey: string;
      taskId: string;
    }
  | { ok: false; status: number; code: string; message: string };

async function resolveDispatchRetryTarget(
  runtime: Runtime,
  root: string,
  taskIdInput: string,
  opts?: { agent_id?: string; role?: string },
): Promise<DispatchRetryResolveResult> {
  const prefix = String(taskIdInput ?? "").trim();
  if (!prefix) {
    return {
      ok: false,
      status: 400,
      code: "TASK_ID_REQUIRED",
      message: "task_id is required",
    };
  }

  const hit = findTaskFileByIdPrefix(root, prefix);
  if (!hit) {
    return {
      ok: false,
      status: 404,
      code: "TASK_NOT_FOUND",
      message: `task not found: ${prefix}`,
    };
  }

  let fm: Record<string, unknown> = {};
  try {
    const raw = readFileSync(hit.path, "utf-8");
    fm = parseMarkdownFrontmatter(raw);
  } catch {
    /* frontmatter optional for routing fallback */
  }

  const route = wpTaskRouteFromFilename(hit.filename);
  const recipient =
    strField(fm, "recipient") || route?.recipient || "";
  const taskId =
    strField(fm, "task_id") || hit.filename.replace(/\.md$/i, "");

  let agentId = String(opts?.agent_id ?? "").trim();
  if (!agentId) {
    const role = String(opts?.role ?? recipient).trim();
    if (!role) {
      return {
        ok: false,
        status: 400,
        code: "AGENT_UNRESOLVED",
        message: "cannot resolve agent: missing recipient/role",
      };
    }
    const agents = await runtime.registry.list({ role });
    const agent = agents[0];
    if (!agent) {
      return {
        ok: false,
        status: 404,
        code: "AGENT_NOT_FOUND",
        message: `no agent registered for role="${role}"`,
      };
    }
    agentId = agent.protocol.agent_id;
  }

  return {
    ok: true,
    filepath: hit.path,
    filename: hit.filename,
    recipient,
    retryKey: `${agentId}:${taskId}`,
    taskId,
  };
}

type DispatchRetryRecordLike = {
  filepath?: string;
  task_id?: string;
  provider?: string;
  adapter?: string;
  failureCount?: number;
  retryRound?: number;
  lastError?: string;
  lastCategory?: string;
  retryable?: boolean;
  nextRetryAt?: number | null;
  decisionRequired?: boolean;
  adminDecision?: string;
  forceArchived?: boolean;
  firstFailedAt?: number;
  lastFailedAt?: number;
  rawCode?: string;
  rawMessage?: string;
};

function serializeDispatchRetryRecord(
  rec: DispatchRetryRecordLike,
  meta?: { task_id?: string; retry_key?: string },
): Record<string, unknown> {
  const failureCount = rec.failureCount ?? 0;
  return {
    task_id: meta?.task_id ?? rec.task_id ?? null,
    retry_key: meta?.retry_key ?? null,
    provider: rec.provider ?? null,
    adapter: rec.adapter ?? null,
    category: rec.lastCategory ?? null,
    lastCategory: rec.lastCategory ?? null,
    failureCount,
    attempt: failureCount,
    retryRound: rec.retryRound ?? 0,
    nextRetryAt: rec.nextRetryAt ?? null,
    decisionRequired: rec.decisionRequired === true,
    forceArchived: rec.forceArchived === true,
    adminDecision: rec.adminDecision ?? null,
    lastError: rec.lastError ?? null,
    rawCode: rec.rawCode ?? null,
    rawMessage: rec.rawMessage ?? null,
    retryable: rec.retryable !== false,
    firstFailedAt: rec.firstFailedAt ?? null,
    lastFailedAt: rec.lastFailedAt ?? null,
    filepath: rec.filepath ?? null,
  };
}

function pmHeartbeatField(
  row: Record<string, unknown>,
  key: string,
): string {
  return String(row[key] ?? "").trim();
}

/**
 * 构造 PM 主动巡检的“业务状态摘要”。
 *
 * PM→ADMIN 的接单/处理中记录本身就是巡检副产物，不能反过来被当作
 * “业务有变化”，否则会形成：巡检写记录 → reportCount 变化 → 再巡检
 * → 再写记录的自激循环。真正会改变推进决策的 worker 回执、终态汇总、
 * task lifecycle 变化仍保留在摘要中。
 */
export function wpBuildPmHeartbeatDigestForTests(input: {
  activeRoots: Record<string, unknown>[];
  downstream: Record<string, unknown>[];
  reports: Record<string, unknown>[];
}): string {
  const stableRows = (rows: string[][]): string[][] =>
    rows.sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
  const meaningfulReports = input.reports.filter((row) => {
    const sender = pmHeartbeatField(row, "sender").toUpperCase();
    const recipient = pmHeartbeatField(row, "recipient").toUpperCase();
    const kind = pmHeartbeatField(row, "report_kind").toLowerCase();
    const status = pmHeartbeatField(row, "status").toLowerCase();
    if (sender !== "PM" || recipient !== "ADMIN") return true;
    return !(
      kind === "pm_to_admin_ack" ||
      kind === "pm_to_admin_in_progress" ||
      status === "in_progress" ||
      status === "dispatching"
    );
  });
  return JSON.stringify({
    roots: stableRows(
      input.activeRoots.map((row) => [
        pmHeartbeatField(row, "task_id"),
        pmHeartbeatField(row, "bucket"),
        pmHeartbeatField(row, "review_status"),
      ]),
    ),
    downstream: stableRows(
      input.downstream.map((row) => [
        pmHeartbeatField(row, "task_id"),
        pmHeartbeatField(row, "recipient"),
        pmHeartbeatField(row, "bucket"),
      ]),
    ),
    reports: stableRows(
      meaningfulReports.map((row) => [
        pmHeartbeatField(row, "report_id") || pmHeartbeatField(row, "filename"),
        pmHeartbeatField(row, "task_id"),
        pmHeartbeatField(row, "status"),
        pmHeartbeatField(row, "valid"),
        pmHeartbeatField(row, "superseded_by"),
      ]),
    ),
  });
}

/**
 * Build the Express app.  Separated from `startWebPanel` so tests can
 * import the app directly without binding to a port.
 */
export function buildWebPanelApp(
  runtime: Runtime,
  opts: {
    panelDir?: string;
    /** Directory where ADMIN task files are written (v3: fcop/_lifecycle/inbox/). */
    adminTasksDir?: string;
    /** Project root directory (parent of docs/, fcop/, etc.). Auto-derived if omitted. */
    projectRoot?: string;
    /** Root dir for fcop reports (fcop/reports/). */
    fcopReportsDir?: string;
    /** Root dir for fcop reviews (fcop/reviews/). */
    fcopReviewsDir?: string;
    /** Directory for system failure records (fcop/internal/failures/). */
    failuresDir?: string;
    /**
     * SDK adapter — required for the Agent Rotation endpoint
     * (`POST /api/v2/agents/:id/recycle`). When absent the endpoint
     * responds 503.
     */
    sdkAdapter?: AgentSdkAdapter;
    /** Actual HTTP listen port (for health/env responses). Falls back to WEB_PANEL_PORT. */
    panelPort?: number;
    /** Startup fcop bridge probe (from main.ts) — fallback when subprocess probe fails. */
    fcopRuntime?: FcopRuntimeSeed;
    /** Resolved data dir for agent-recycle-state.json (auto-recycle baseline). */
    dataDir?: string;
    /** Agent auto-recycle when idle after N sessions (default: disabled). */
    agentRecycle?: AgentRecycleConfig;
    /** Stop the old Runtime and automatically reload Shell after project switch. */
    reloadOnProjectSwitch?: boolean;
    /** Test/host override for scheduling the replacement process. */
    projectRuntimeReloadScheduler?: () => void;
    /**
     * Host-owned foreground confirmation. Production defaults to the native
     * confirmation dialog; tests may inject a deterministic decision.
     */
    trustedForegroundConfirmation?: (input: { title: string; message: string }) => Promise<boolean>;
  } = {},
): ReturnType<typeof express> {
  const app = express();
  // Mobile attachment upload: up to 10MB decoded image; JSON+base64 needs ~14MB headroom.
  app.use(express.json({ limit: "16mb" }));
  const panelPort = opts.panelPort ?? WEB_PANEL_PORT;
  const panelUrl = `http://127.0.0.1:${panelPort}`;
  const trustedForegroundConfirmation =
    opts.trustedForegroundConfirmation ?? confirmOperationImpactNative;
  // Per-agent MCP/Google adapters inherit this address and expose PM Runtime
  // control tools without asking the model to curl localhost itself.
  process.env["CODEFLOWMU_PANEL_URL"] = panelUrl;

  /** PM auto-wake executor — assigned after sseEmit is defined. */
  let pmWakeExecutorRef: WakeDownstreamExecutor | null = null;
  /** Downstream active-timeout auto-nudge poller. */
  let downstreamAutoNudgeRef: DownstreamAutoNudge | null = null;
  let pmHeartbeatIntervalRef: ReturnType<typeof setInterval> | null = null;
  let pmHeartbeatLastRunAt = 0;
  let pmHeartbeatLastDigest = "";
  let autoArchiveStartupTimer: ReturnType<typeof setTimeout> | null = null;
  let autoArchiveDailyTimer: ReturnType<typeof setInterval> | null = null;
  let zombieStartupTimer: ReturnType<typeof setTimeout> | null = null;
  let zombieIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let agentRecycleInterval: ReturnType<typeof setInterval> | null = null;
  /** Disk-backed wake/session event log — assigned at doorbell init. */
  let runtimeEventLogger: RuntimeEventFileLogger | null = null;
  /** Unified analytics ledger — `fcop/logs/analytics/events-*.jsonl`. */
  let analyticsLedger: AnalyticsLedger | null = null;

  let frozenBootstrapRoot: string | null = null;

  /** Shell 启动时识别的根（切换「象棋 / 围棋」等产品后仍不变，仅作回退）。 */
  function resolveBootstrapProjectRoot(): string {
    if (frozenBootstrapRoot) return frozenBootstrapRoot;
    let root: string;
    if (opts.projectRoot) root = pathResolve(opts.projectRoot);
    else if (opts.adminTasksDir) {
      const fromInbox = findFcopProjectRoot(pathResolve(opts.adminTasksDir));
      root = fromInbox ?? process.cwd();
    } else {
      const fromCwd = findFcopProjectRoot(process.cwd());
      root =
        fromCwd ??
        resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT) ??
        process.cwd();
    }
    frozenBootstrapRoot = pathResolve(root);
    return frozenBootstrapRoot;
  }

  /** 将 Panel 当前选中的产品开发根（如象棋 / 围棋各自仓库）同步到 opts 路径。 */
  function applyProjectScopedOpts(root: string): void {
    const r = pathResolve(root);
    const v3 = fcopV3Paths(r);
    opts.projectRoot = r;
    opts.adminTasksDir = v3.inbox;
    opts.fcopReportsDir = v3.reports;
    opts.fcopReviewsDir = v3.reviews;
    opts.failuresDir = v3.failures;
  }

  let lastAppliedProjectRoot: string | null = null;

  function ensureProjectStore(): void {
    const boot = resolveBootstrapProjectRoot();
    hydrateProjectStore(boot);
    const active = projectStore.get(activeProjectId);
    if (active?.id === "open-default-newproject" && openEditionProtectedHostRoot() && isOpenEditionInstallLocalProjectPath(active.root)) {
      ensureOpenEditionProjectDirectory(pathResolve(active.root));
    }
    if (!active && openEditionProtectedHostRoot()) {
      return;
    }
    const root = active?.root ? pathResolve(active.root) : boot;
    if (lastAppliedProjectRoot !== root) {
      applyProjectScopedOpts(root);
      lastAppliedProjectRoot = root;
    }
  }

  /**
   * 当前协作根目录：优先 Panel 注册的 active 项目（多产品：象棋 / 围棋…），
   * 否则回退到 Shell 启动根。
   */
  function resolveProjectRoot(): string {
    ensureProjectStore();
    const active = projectStore.get(activeProjectId);
    if (active?.root) {
      const r = pathResolve(active.root);
      if (active.id === "open-default-newproject" && openEditionProtectedHostRoot() && isOpenEditionInstallLocalProjectPath(r)) {
        ensureOpenEditionProjectDirectory(r);
      }
      if (existsSync(r)) return r;
    }
    if (openEditionProtectedHostRoot() && opts.dataDir) {
      return pathResolve(opts.dataDir);
    }
    return resolveBootstrapProjectRoot();
  }

  /**
   * Git 页在母版中始终管理 CodeFlowMu 母仓库，不能跟随当前开发项目切换。
   * Open 版仍管理外部开发项目。main.ts 会把 CODEFLOWMU_HOST_ROOT 固定为
   * 安装根；测试或嵌入场景没有该变量时，回退到启动根以保持可测试性。
   */
  function resolveGitRoot(): string {
    if (isOpenEditionMode()) return resolveProjectRoot();
    const hostRoot = process.env["CODEFLOWMU_HOST_ROOT"]?.trim();
    if (hostRoot) return pathResolve(hostRoot);
    return resolveBootstrapProjectRoot();
  }

  function resolveAppConfigRoot(): string {
    return openEditionProtectedHostRoot() ?? resolveProjectRoot();
  }

  /** Task write + dedup must share the same project root and inbox after project store sync. */
  function resolveAdminTaskWriteScope(): {
    projectRoot: string;
    adminDir: string;
  } {
    const projectRoot = resolveProjectRoot();
    const adminDir = opts.adminTasksDir;
    return { projectRoot, adminDir: adminDir ?? fcopV3Paths(projectRoot).inbox };
  }

  /** FCoP init / deploy / 清理验收 — 必须与 Panel「当前项目」一致，禁止回退 monorepo 根。 */
  function resolveFcopActionRoot(): string {
    return resolveProjectRoot();
  }

  // CORS: loopback + private LAN IPs (mobile PWA on same port)
  app.use((_req, res, next) => {
    applyPanelCorsHeaders(res, _req.headers.origin);
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Health check ─────────────────────────────────────────────────────

  /**
   * GET /health — lightweight readiness probe.
   * Returns 200 + JSON immediately (no runtime calls). Useful for CI, QA,
   * and startup detection (wait until this returns 200 before hitting /api/v2/).
   */
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "codeflowmu-web-panel", uptime_s: Math.floor(process.uptime()) });
  });

  /**
   * GET /api/v2/health — rich health status with disk / mem / node / uptime.
   */
  app.get("/api/v2/health", async (_req: Request, res: Response) => {
    const uptimeSec = Math.floor(process.uptime());
    const totalMem  = os.totalmem();
    const freeMem   = os.freemem();
    const usedMem   = totalMem - freeMem;
    const root      = resolveProjectRoot();
    const artifactLayout = resolveArtifactRoot(root);

    // Disk space via PowerShell (Windows) — drive letter from projectRoot
    let disk: { freeGb: number; totalGb: number; usedPct: number } = {
      freeGb: -1, totalGb: -1, usedPct: -1,
    };
    try {
      const drive  = root.match(/^([A-Za-z]):/)?.[1] ?? "C";
      const cmd    =
        `$d=Get-PSDrive ${drive};` +
        `[PSCustomObject]@{Free=$d.Free;Used=$d.Used} | ConvertTo-Json`;
      const { stdout } = await execFile(
        "powershell", ["-NoProfile", "-Command", cmd],
        { timeout: 8000 }
      );
      const parsed = JSON.parse((stdout as string).trim());
      const freeBytes  = Number(parsed.Free ?? parsed.free ?? 0);
      const usedBytes  = Number(parsed.Used ?? parsed.used ?? 0);
      const totalBytes = freeBytes + usedBytes;
      disk = {
        freeGb  : Math.round(freeBytes  / 1073741824 * 10) / 10,
        totalGb : Math.round(totalBytes / 1073741824 * 10) / 10,
        usedPct : totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : -1,
      };
    } catch { /* disk info unavailable on non-Windows or permission issue */ }

    const shellVersion = readShellVersion(SHELL_PKG_ROOT);
    const versionManifest = readCodeflowmuVersionManifest();
    const codeflowmuVersion = versionManifest?.codeflowmu ?? null;
    const fcopMeta = readFcopJsonMeta(root);
    const protocolVersion =
      fcopMeta.protocolVersion ?? opts.fcopRuntime?.protocolVersion ?? null;
    const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
    const rulesVersion = readFcopRulesVersion(root);
    const pkgReport = buildFcopPackageVersionReport(pyProbe, opts.fcopRuntime);
    const protocolUpgrade = buildProtocolUpgradeReport(root, pyProbe);
    const adoptedPending = loadAdoptedPendingReport(root);

    // Best-effort Python detection for health dashboard
    let pythonVersion = "未检测";
    try {
      const pyExe = pyProbe.pythonExecutable || "python";
      const { stdout: pyv } = await execFile(pyExe, ["--version"], { timeout: 3000 })
        .catch(() => execFile("python3", ["--version"], { timeout: 3000 }));
      pythonVersion = (pyv as string).trim();
    } catch { /* optional */ }

    const mcpMounted = runtime.mcpInjector.listMounted();
    const mcpInjectorMode =
      (runtime.mcpInjector as { mode?: string }).mode ?? "unknown";

    res.json({
      ok         : true,
      /** @deprecated use shellVersion — kept for panel backward compat */
      version    : shellVersion,
      shellVersion,
      /** Product release line from .codeflowmu-version.json (authoritative for Panel header) */
      codeflowmuVersion,
      versionManifest: versionManifest ?? undefined,
      fcop       : pyProbe.fcop,
      fcopMcp    : pyProbe.fcopMcp,
      rulesVersion,
      requiredMinPackage: FCOP_MIN_PACKAGE_VERSION,
      packageVersionOk: pkgReport.packageVersionOk,
      protocolUpgrade,
      adoptedPending,
      pythonBin  : pyProbe.pythonExecutable,
      protocolVersion,
      productRole: "FCoP downstream application (示范体)",
      uptime     : uptimeSec,
      process_started_at_ts: WEB_PANEL_PROCESS_STARTED_AT_TS,
      process_started_at: new Date(WEB_PANEL_PROCESS_STARTED_AT_TS).toISOString(),
      log_center_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      node       : process.version,
      python     : pythonVersion,
      mcpRunning : mcpMounted.length > 0,
      mcpMountedCount: mcpMounted.length,
      mcpInjectorMode,
      root,
      projectRoot: root,
      codeRoot: artifactLayout.artifactRoot,
      workspaceMode: artifactLayout.mode,
      artifactLayout: artifactLayout.relativeArtifactRoot,
      fcopDataRoot: join(root, "fcop"),
      panelPort,
      panelUrl,
      mem        : {
        usedMb  : Math.round(usedMem  / 1048576),
        totalMb : Math.round(totalMem / 1048576),
      },
      disk,
    });
  });

  registerRuntimeAlertRoutes(app);

  /**
   * GET /api/v2/env/check — environment pre-check.
   * Groups: runtime, apikeys, connectivity, governance (Rule 4.5).
   */
  app.get("/api/v2/env/check", async (_req: Request, res: Response) => {
    const checks: Array<{ group: string; name: string; status: string; value: string }> = [];
    const root = resolveProjectRoot();
    const artifactLayout = resolveArtifactRoot(root);
    if (existsSync(join(root, "fcop", "fcop.json"))) {
      try {
        await ensureLedgerLayout(root);
      } catch {
        /* 预检时尽力补齐 v3 inbox / ledger，不阻断检测 */
      }
    }
    const shellVersion = readShellVersion(SHELL_PKG_ROOT);
    const fcopMeta = readFcopJsonMeta(root);
    const protocolVersion =
      fcopMeta.protocolVersion ?? opts.fcopRuntime?.protocolVersion ?? null;
    const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
    const mcpMounted = runtime.mcpInjector.listMounted();
    const openEditionMode = !!openEditionProtectedHostRoot();
    const visibleMcpMounted = openEditionMode
      ? mcpMounted.filter((id) => !/^REVIEW/i.test(id))
      : mcpMounted;
    const mcpInjectorMode =
      (runtime.mcpInjector as { mode?: string }).mode ?? "unknown";
    ensureProjectStore();
    const openNoProjectSelected =
      !!openEditionProtectedHostRoot() && !projectStore.get(activeProjectId);
    if (openNoProjectSelected) {
      checks.push(
        { group: "runtime", name: "Node.js", status: "ok", value: process.version },
        {
          group: "runtime",
          name: "codeflowmu-shell",
          status: shellVersion !== "unknown" ? "ok" : "warn",
          value: shellVersion !== "unknown" ? `v${shellVersion}` : "版本未知",
        },
        {
          group: "runtime",
          name: "fcop (Python)",
          status: pyProbe.fcop ? "ok" : "fail",
          value: pyProbe.fcop ? `v${pyProbe.fcop} (${pyProbe.pythonExecutable})` : pyProbe.error ?? "未安装或无法导入",
        },
        {
          group: "runtime",
          name: "fcop-mcp (Python)",
          status: pyProbe.fcopMcp || pyProbe.fcopMcpImportOk ? "ok" : "fail",
          value: pyProbe.fcopMcp ? `v${pyProbe.fcopMcp}` : pyProbe.fcopMcpImportOk ? "可导入" : "未安装或无法导入",
        },
        {
          group: "governance",
          name: "Open Dev Team 项目根",
          status: "warn",
          value: "公开版工具已就绪；请在设置 → 项目添加外部产品/代码目录，然后初始化该项目。",
        },
      );
      res.json({
        ok: true,
        openNoProjectSelected: true,
        fcopUninitialized: false,
        fcopReady: false,
        fcopGateMessage: "公开版工具已就绪；请先添加外部项目根。",
        failCount: checks.filter((c) => c.status === "fail").length,
        checks,
        timestamp: new Date().toISOString(),
        node: process.version,
        shellVersion,
        fcopVersion: pyProbe.fcop,
        fcopMcpVersion: pyProbe.fcopMcp,
        protocolVersion: null,
        mcpMounted: mcpMounted.length > 0,
        mcpMountedCount: mcpMounted.length,
        mcpInjectorMode,
        cursorApiKey: !!(process.env["CURSOR_API_KEY"]),
        relayUrl: !!process.env["RELAY_URL"],
        pythonBin: pyProbe.pythonExecutable || process.env["PYTHON_BIN"] || null,
        panelPort,
        panelUrl,
        projectRoot: null,
      });
      return;
    }

    // ── Group 1: Runtime dependencies ────────────────────
    checks.push({
      group: "runtime", name: "Node.js",
      status: "ok", value: process.version,
    });

    try {
      const pyExe = pyProbe.pythonExecutable || "python";
      const { stdout: pyOut } = await execFile(
        pyExe, ["--version"], { timeout: 5000 }
      ).catch(() => execFile("python3", ["--version"], { timeout: 5000 }));
      checks.push({ group: "runtime", name: "Python", status: "ok", value: (pyOut as string).trim() });
    } catch {
      checks.push({ group: "runtime", name: "Python", status: "warn", value: "未找到（可选）" });
    }

    checks.push({
      group: "runtime",
      name: "codeflowmu-shell",
      status: shellVersion !== "unknown" ? "ok" : "warn",
      value: shellVersion !== "unknown" ? `v${shellVersion}` : "版本未知",
    });

    checks.push({
      group: "runtime",
      name: "fcop (Python)",
      status: pyProbe.fcop ? "ok" : "fail",
      value: pyProbe.fcop
        ? `v${pyProbe.fcop} (${pyProbe.pythonExecutable})`
        : pyProbe.error ?? "未安装或无法导入",
    });

    checks.push({
      group: "runtime",
      name: "fcop-mcp (Python)",
      status: pyProbe.fcopMcp || pyProbe.fcopMcpImportOk ? "ok" : "fail",
      value: pyProbe.fcopMcp
        ? `v${pyProbe.fcopMcp}`
        : pyProbe.fcopMcpImportOk
          ? "可导入（无 distribution 元数据）"
          : "未安装或无法导入",
    });

    checks.push({
      group: "runtime",
      name: "FCoP protocol_version",
      status: protocolVersion != null ? "ok" : "fail",
      value:
        protocolVersion != null
          ? String(protocolVersion)
          : "fcop/fcop.json 缺失或未声明 protocol_version",
    });

    // ── Group 2: API keys ─────────────────────────────────
    const cursorKey = process.env["CURSOR_API_KEY"];
    checks.push({
      group: "apikeys", name: "CURSOR_API_KEY",
      status: cursorKey ? "ok" : openEditionMode ? "fail" : "warn",
      value: cursorKey ? "已设置" : openEditionMode ? "未设置（公开版必填）" : "未设置（可选）",
    });
    if (!openEditionMode) {
      const relayUrl = process.env["RELAY_URL"];
      checks.push({
        group: "apikeys", name: "RELAY_URL",
        status: relayUrl ? "ok" : "warn",
        value: relayUrl ? relayUrl.replace(/\/\/[^@]+@/, "//*@") : "未设置（可选）",
      });
    }

    // ── Group 3: Connectivity ─────────────────────────────
    checks.push({
      group: "connectivity", name: "Web Panel HTTP",
      status: "ok", value: panelUrl,
    });

    checks.push({
      group: "connectivity",
      name: "MCP 注入器",
      status: mcpInjectorMode === "live" ? "ok" : "warn",
      value: `mode=${mcpInjectorMode}, ${visibleMcpMounted.length} agent(s) mounted`,
    });

    checks.push({
      group: "connectivity",
      name: "fcop-mcp 挂载",
      status: visibleMcpMounted.length > 0 ? "ok" : "warn",
      value:
        visibleMcpMounted.length > 0
          ? `已挂载: ${visibleMcpMounted.join(", ")}`
          : "暂无 Agent 挂载 MCP（启动 Agent 会话后才会出现）",
    });

    // FCoP v3 only — inbox is fcop/_lifecycle/inbox (no fcop/tasks/ fallback)
    const v3 = fcopV3Paths(root);
    let taskInboxOk = false;
    try {
      await import("node:fs").then((m) => m.promises.access(v3.inbox));
      taskInboxOk = true;
    } catch {
      /* inbox missing */
    }
    checks.push({
      group: "connectivity",
      name: "FCoP 任务目录 (v3 inbox)",
      status: taskInboxOk ? "ok" : "fail",
      value: taskInboxOk
        ? "可访问（fcop/_lifecycle/inbox）"
        : "不可访问 — v3 项目必须有 fcop/_lifecycle/inbox/",
    });

    for (const folder of checkFcop0002WorkFolders(root)) {
      checks.push({
        group: "connectivity",
        name: `FCoP 0002 固定工作目录 (${folder.dir})`,
        status: folder.exists ? "ok" : "fail",
        value: folder.exists
          ? `fcop/${folder.dir} 可访问`
          : `fcop/${folder.dir} 不存在 — init 后应存在（adopted 0002）`,
      });
    }

    const adoptedCheck = buildAdoptedBootstrapHealthCheck(root);
    checks.push({
      group: "connectivity",
      name: "adopted 初始化源 (adoptedSource/)",
      status: adoptedCheck.status,
      value: adoptedCheck.value,
    });

    const layoutRisks = detectFcopLayoutRisks(root);
    checks.push({
      group: "connectivity",
      name: "FCoP 布局风险",
      status: layoutRisks.length === 0 ? "ok" : "warn",
      value:
        layoutRisks.length === 0
          ? "未发现 v2-only 拓扑 / 孤儿任务 / 未入 ledger / 无 protocol 残片"
          : layoutRisks.map((r) => r.message).join("；"),
    });

    // ── Group 4: FCoP governance (Rule 4.5) ─────────────────
    const roleTemplateHealth = checkRoleTemplateHealth(root, {
      team: fcopMeta.team,
      leader: fcopMeta.leader,
      roles: fcopMeta.roles,
      mode: fcopMeta.mode,
    });
    checks.push({
      group: "governance",
      name: "Rule 4.5 团队角色文档",
      status: !roleTemplateHealth.applicable
        ? "warn"
        : roleTemplateHealth.ok
          ? "ok"
          : "fail",
      value: roleTemplateHealth.summary,
    });
    if (roleTemplateHealth.applicable && roleTemplateHealth.ghostInit) {
      checks.push({
        group: "governance",
        name: "半初始化 (ghost init)",
        status: "fail",
        value:
          "存在 fcop/shared/.deployed_version 但缺 TEAM-ROLES / TEAM-OPERATING-RULES / roles/*.md — Agent 易退化成传声筒",
      });
    }

    const skillsHealth = checkSkillsManifestHealth(root);
    checks.push({
      group: "governance",
      name: "Skills manifest（PM 与 Agent Playbook）",
      status: !skillsHealth.applicable
        ? "warn"
        : !skillsHealth.ok
          ? "fail"
          : skillsHealth.missingSkillPackages.length > 0 ||
              !skillsHealth.pmManifestExists ||
              !skillsHealth.agentProjectionExists
            ? "warn"
            : "ok",
      value: skillsHealth.summary,
    });

    // Flat fields for lightweight consumers (TASK-20260514-397 compat)
    const cursorKeyFlat = !!(process.env["CURSOR_API_KEY"]);
    const relayUrlFlat = !!(process.env["RELAY_URL"]);
    const pythonBin = pyProbe.pythonExecutable || process.env["PYTHON_BIN"] || null;

    const failChecks = checks.filter((c) => c.status === "fail");
    const envGate = evaluateFcopEnvGate(root);
    const fcopUninitialized = envGate.fcopUninitialized;
    const fullInitializationRepairRequired = failChecks.some((check) =>
      check.name.startsWith("FCoP 0002 固定工作目录") ||
      check.name === "adopted 初始化源 (adoptedSource/)" ||
      check.name === "Skills manifest（PM 与 Agent Playbook）",
    );
    const fcopRepairRequired =
      envGate.fcopRepairRequired || fullInitializationRepairRequired;
    const fcopReady = envGate.fcopReady && !fullInitializationRepairRequired;

    res.json({
      ok: failChecks.length === 0,
      fcopUninitialized,
      fcopFirstRunRequired: fullInitializationRepairRequired,
      fcopRepairRequired,
      fcopReady,
      fcopGateMessage: envGate.userMessage,
      failCount: failChecks.length,
      checks,
      timestamp: new Date().toISOString(),
      // flat fields
      node: process.version,
      shellVersion,
      fcopVersion: pyProbe.fcop,
      fcopMcpVersion: pyProbe.fcopMcp,
      protocolVersion,
      mcpMounted: mcpMounted.length > 0,
      mcpMountedCount: mcpMounted.length,
      mcpInjectorMode,
      cursorApiKey: cursorKeyFlat,
      relayUrl: relayUrlFlat,
      pythonBin,
      panelPort,
      panelUrl,
      projectRoot: root,
      codeRoot: artifactLayout.artifactRoot,
      workspaceMode: artifactLayout.mode,
      artifactLayout: artifactLayout.relativeArtifactRoot,
      fcopDataRoot: join(root, "fcop"),
      roleTemplateHealth,
    });
  });

  /**
   * GET /api/v2/fcop/info — FCoP protocol + fcop-mcp catalog for Settings → About.
   */
  app.get("/api/v2/fcop/info", async (_req: Request, res: Response) => {
    const root = resolveProjectRoot();
    const fcopMeta = readFcopJsonMeta(root);
    const rulesVersion = readFcopRulesVersion(root);
    const protocolVersion =
      fcopMeta.protocolVersion ?? opts.fcopRuntime?.protocolVersion ?? null;
    const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
    const pkgReport = buildFcopPackageVersionReport(pyProbe, opts.fcopRuntime);
    const protocolUpgrade = buildProtocolUpgradeReport(root, pyProbe);
    const adoptedPending = loadAdoptedPendingReport(root);
    const mcpMounted = runtime.mcpInjector.listMounted();
    const mcpInjectorMode =
      (runtime.mcpInjector as { mode?: string }).mode ?? "unknown";
    const v3 = fcopV3Paths(root);
    const lifecycleKeys = ["inbox", "active", "review", "done", "archive"] as const;
    const lifecycle: Record<string, boolean> = {};
    for (const key of lifecycleKeys) {
      lifecycle[key] = existsSync(v3[key]);
    }
    const legacyV2Only = detectLegacyV2OnlyDirs(root);
    const workFolders0002 = checkFcop0002WorkFolders(root);
    const layoutRisks = detectFcopLayoutRisks(root);
    const fcopJsonExists = existsSync(join(root, "fcop", "fcop.json"));
    const roleTemplateHealth = checkRoleTemplateHealth(root, {
      team: fcopMeta.team,
      leader: fcopMeta.leader,
      roles: fcopMeta.roles,
      mode: fcopMeta.mode,
    });

    res.json({
      ok: true,
      productRole: "FCoP downstream application (示范体)",
      shellVersion: readShellVersion(SHELL_PKG_ROOT),
      fcopVersion: pyProbe.fcop,
      fcopMcpVersion: pyProbe.fcopMcp,
      packages: pkgReport,
      requiredMinPackage: FCOP_MIN_PACKAGE_VERSION,
      packageVersionOk: pkgReport.packageVersionOk,
      versionSemantics: {
        fcopPackage: "Python pip 包 fcop（运行时 __version__ 优先）",
        fcopMcpPackage: "Python pip 包 fcop-mcp",
        protocolVersion: "fcop/fcop.json protocol_version（协议纪元，如 v3）",
        rulesVersion: ".cursor/rules/fcop-rules.mdc fcop_rules_version（规则文件，≠ pip 包）",
        shellVersion: "codeflowmu-shell package.json semver",
      },
      protocolVersion,
      rulesVersion,
      protocolUpgrade,
      adoptedPending,
      fcopJsonExists,
      projectRoot: root,
      pythonBin: pyProbe.pythonExecutable,
      team: {
        mode: fcopMeta.mode ?? null,
        team: fcopMeta.team ?? null,
        leader: fcopMeta.leader ?? null,
        roles: fcopMeta.roles ?? [],
        displayName: fcopMeta.displayName ?? null,
      },
      roleTemplateHealth,
      v3: {
        paths: {
          inbox: v3.inbox,
          active: v3.active,
          archive: v3.archive,
          reports: v3.reports,
        },
        lifecycle,
        workFolders0002: Object.fromEntries(
          workFolders0002.map((f) => [f.dir, f.exists]),
        ),
        layoutRisks: layoutRisks.map((r) => ({
          kind: r.kind,
          message: r.message,
        })),
        /** v2-only dirs (e.g. log/) — NOT 0002 tasks/reports/issues/ledger */
        legacyV2OnlyDirs: legacyV2Only,
        legacyV2Dirs: legacyV2Only,
      },
      mcp: {
        injectorMode: mcpInjectorMode,
        mountedAgents: mcpMounted,
        toolGroups: FCOP_MCP_TOOL_GROUPS,
        toolDescriptions: FCOP_MCP_TOOL_DESC,
        toolCount: fcopMcpToolCount(),
      },
    });
  });

  /**
   * POST /api/v2/fcop/upgrade — Trigger pip install -U fcop fcop-mcp
   */
  app.post("/api/v2/fcop/upgrade", async (_req: Request, res: Response) => {
    try {
      const root = resolveAppConfigRoot();
      if (!(await trustedForegroundConfirmation({
        title: "CodeFlowMu Runtime 依赖升级确认",
        message: [
          "确认升级 FCoP 与 fcop-mcp 运行时依赖？",
          "",
          `配置根目录：${root}`,
          "动作：执行 pip install -U fcop fcop-mcp",
          "影响：可能改变 Runtime 协议行为、规则部署结果与兼容性",
          "",
          "取消后不会安装或升级任何包。",
        ].join("\n"),
      }))) {
        return sendError(res, 409, "RUNTIME_CHANGE_CONFIRMATION_CANCELLED", "用户取消了 Runtime 依赖升级");
      }
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const pythonBin = pyProbe.pythonExecutable || "python";

      // 执行 pip 升级
      const cmd = `"${pythonBin}" -m pip install -U fcop fcop-mcp`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 90000 });

      // 升级成功后，重置 fcop-env-probe 缓存，确保下次探测拿到最新版本！
      __resetFcopProbeCacheForTests();

      res.json({
        ok: true,
        message: "FCoP & fcop-mcp packages upgraded successfully.",
        stdout,
        stderr,
      });
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: e.message || String(e),
      });
    }
  });

  /**
   * POST /api/v2/fcop/deploy-role-templates — 仅补部署 Rule 4.5 团队三层文档（不全量 init）。
   * 默认 team=dev-team；SSE 进度流。
   */
  app.post("/api/v2/fcop/deploy-role-templates", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (msg: string, done = false, extra?: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ msg, done, ...extra })}\n\n`);
    };

    try {
      const root = resolveFcopActionRoot();
      if (isProtectedOpenEditionAppRoot(root)) {
        send("❌ 公开版工具目录受保护：请先在「设置 → 项目」添加外部项目根，再部署团队文档。", true, {
          success: false,
          code: "OPEN_EDITION_APP_ROOT_PROTECTED",
          projectRoot: root,
        });
        res.end();
        return;
      }
      const fcopMeta = readFcopJsonMeta(root);
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const pythonBin = pyProbe.pythonExecutable || "python";
      const team =
        (req.body as { team?: string } | undefined)?.team ??
        fcopMeta.team ??
        "dev-team";
      if (!(await trustedForegroundConfirmation({
        title: "CodeFlowMu 角色治理模板部署确认",
        message: [
          "确认覆盖部署团队角色治理模板？",
          "",
          `项目根目录：${root}`,
          `团队模板：${team}`,
          "影响：将以 force=True 更新 Rule 4.5 团队角色文档",
          "",
          "取消后不会写入模板文件。",
        ].join("\n"),
      }))) {
        send("已取消角色治理模板部署", true, { success: false, code: "GOVERNANCE_CHANGE_CONFIRMATION_CANCELLED" });
        res.end();
        return;
      }
      const escapedRoot = root.replace(/\\/g, "\\\\");

      send(`📍 项目根: ${root}`);
      send(`📚 正在 deploy_role_templates(team='${team}', force=True)...`);

      const deployCmd =
        `"${pythonBin}" -c "from fcop.project import Project; r=Project('${escapedRoot}').deploy_role_templates(team='${team}', lang='zh', force=True); print('deployed', len(r.deployed), 'skipped', len(r.skipped), 'archived', len(r.archived))"`;
      const { stdout: depOut, stderr: depErr } = await execAsync(deployCmd, {
        timeout: 120000,
      });
      const depLine = (depOut || depErr || "").trim().split(/\r?\n/).pop() ?? "";
      send(depLine ? `✅ ${depLine}` : "✅ deploy_role_templates 已执行");

      const health = checkRoleTemplateHealth(root, {
        team: fcopMeta.team ?? team,
        leader: fcopMeta.leader,
        roles: fcopMeta.roles,
        mode: fcopMeta.mode,
      });
      for (const c of health.checks.filter((x) => x.required)) {
        send(c.exists ? `  ↳ ✅ ${c.label}` : `  ↳ ❌ 缺失 ${c.rel}`);
      }
      if (health.ok) {
        const verification = verifyFcopProjectInit(root);
        send("🎉 Rule 4.5 团队角色文档已齐全", true, {
          success: verification.ok,
          verification,
          projectRoot: root,
        });
      } else {
        const verification = verifyFcopProjectInit(root);
        send(`⚠️ 仍缺 ${health.missing.length} 个文件 — ${health.summary}`, true, {
          success: false,
          verification,
          projectRoot: root,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      send(`❌ 补部署失败: ${msg}`, true, { success: false });
    }
    res.end();
  });

  /**
   * POST /api/v2/fcop/init — One-click initialize / takeover FCoP project supporting multi-modes (project/solo)
   * Streams SSE progress events so the UI can show real-time "正在建立..." status.
   */
  app.post("/api/v2/fcop/init", async (req: Request, res: Response) => {
    // SSE headers — let the browser read the stream line by line
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (msg: string, done = false, extra?: Record<string, unknown>) => {
      const payload = JSON.stringify({ msg, done, ...extra });
      res.write(`data: ${payload}\n\n`);
    };

    try {
      send("🔍 正在检测 Python 环境与 FCoP 工具链...");

      const root = resolveFcopActionRoot();
      if (isProtectedOpenEditionAppRoot(root)) {
        send("❌ 公开版不能把 CodeFlowMu-open 自身初始化为开发项目。请先添加外部项目根。", true, {
          success: false,
          code: "OPEN_EDITION_APP_ROOT_PROTECTED",
          projectRoot: root,
        });
        res.end();
        return;
      }
      send(`📍 产品开发根: ${root}`);

      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const pythonBin = pyProbe.pythonExecutable || "python";

      // 提取入参
      const { mode, team, role_code } = req.body || {};
      const selectMode = mode === "solo" ? "solo" : "project";
      const selectTeam = team || "dev-team";
      const selectRole = role_code || "ME";
      // Decide the artifact layout before Project.init() creates its legacy
      // workspace/ scaffold. Reading the mode afterwards would mistake that
      // generated layout for an explicit user choice.
      const requestedWorkspaceMode: WorkspaceMode =
        req.body?.workspaceMode === "multi"
          ? "multi"
          : req.body?.workspaceMode === "root"
            ? "root"
            : resolveArtifactRoot(root).mode;

      if (!(await trustedForegroundConfirmation({
        title: "CodeFlowMu 项目治理初始化确认",
        message: [
          "确认初始化或接管当前项目的 FCoP 治理骨架？",
          "",
          `项目根目录：${root}`,
          `模式：${selectMode}`,
          `团队/角色：${selectMode === "solo" ? selectRole : selectTeam}`,
          `工作区模式：${requestedWorkspaceMode}`,
          "影响：将创建或更新协议、角色、账本与运行时配置文件",
          "",
          "取消后不会部署初始化文件。",
        ].join("\n"),
      }))) {
        send("已取消项目治理初始化", true, { success: false, code: "GOVERNANCE_CHANGE_CONFIRMATION_CANCELLED" });
        res.end();
        return;
      }

      await deployRequiredProjectBootstrapProjection(root);

      send(`📦 正在部署 FCoP 协议骨架 (${selectMode === "solo" ? "Solo " + selectRole : "dev-team"})...`);

      // 1. 根据模式构建官方 Python SDK 初始化命令
      const escapedRoot = root.replace(/\\/g, "\\\\");
      let initPyCmd = "";
      if (selectMode === "solo") {
        initPyCmd =
          `Project('${escapedRoot}').init_solo(role_code='${selectRole}', lang='zh', force=True, deploy_rules=True)`;
      } else {
        initPyCmd =
          `Project('${escapedRoot}').init(team='${selectTeam}', lang='zh', force=True, deploy_rules=True)`;
      }

      const cmd = `"${pythonBin}" -c "from fcop.project import Project; ${initPyCmd}"`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
      writeWorkspaceMode(root, requestedWorkspaceMode);

      if (stderr?.trim()) {
        for (const line of stderr.trim().split(/\r?\n/).slice(0, 8)) {
          send(`  ↳ [python stderr] ${line}`);
        }
      }
      if (stdout?.trim()) {
        for (const line of stdout.trim().split(/\r?\n/).slice(0, 4)) {
          send(`  ↳ [python] ${line}`);
        }
      }

      send("✅ FCoP 协议目录骨架部署完成！(fcop.json / _lifecycle / reports / shared)");

      await deployPmPlanningProjectProjection(root);
      const openProjection = await deployOpenEditionProjectProjection(root);
      if (openProjection.applied) {
        for (const rel of openProjection.copied) {
          send(`  ↳ Open projection: ${rel}`);
        }
        for (const rel of openProjection.skipped) {
          send(`  ↳ Open projection missing source: ${rel}`);
        }
      }

      // 1b. 显式再跑 deploy_role_templates（init 内用 suppress 吞异常，这里要可观测）
      const teamForTemplates = selectMode === "solo" ? "solo" : selectTeam;
      const deployCmd =
        `"${pythonBin}" -c "from fcop.project import Project; r=Project('${escapedRoot}').deploy_role_templates(team='${teamForTemplates}', lang='zh', force=True); print('deployed', len(r.deployed), 'skipped', len(r.skipped), 'archived', len(r.archived))"`;
      try {
        const { stdout: depOut, stderr: depErr } = await execAsync(deployCmd, {
          timeout: 120000,
        });
        const depLine = (depOut || depErr || "").trim().split(/\r?\n/).pop() ?? "";
        send(
          depLine
            ? `📚 团队角色模板已部署：${depLine}`
            : "📚 团队角色模板 deploy_role_templates 已执行",
        );
      } catch (depErr: unknown) {
        const msg = depErr instanceof Error ? depErr.message : String(depErr);
        send(`  ↳ ❌ deploy_role_templates 失败：${msg}`);
      }

      const postInitMeta = readFcopJsonMeta(root);
      const roleHealth = checkRoleTemplateHealth(root, {
        team: postInitMeta.team ?? selectTeam,
        leader: postInitMeta.leader,
        roles: postInitMeta.roles,
        mode: postInitMeta.mode,
      });
      for (const c of roleHealth.checks.filter((x) => x.required)) {
        send(c.exists ? `  ↳ ✅ ${c.label}` : `  ↳ ❌ 缺失 ${c.rel}`);
      }
      if (!roleHealth.ok) {
        send(`  ↳ ⚠️ Rule 4.5：${roleHealth.summary}`);
      }

      // ★ 修复：Python SDK 生成的 fcop.json 只有 "version" 字段，没有 "protocol_version"
      // 环境检测读的是 "protocol_version"，需要我们补写进去
      const fcopJsonPath = join(root, "fcop", "fcop.json");
      if (existsSync(fcopJsonPath)) {
        try {
          const { readFileSync, writeFileSync: wfs } = await import("node:fs");
          const fcopMeta = JSON.parse(readFileSync(fcopJsonPath, "utf-8")) as Record<string, unknown>;
          if (!fcopMeta["protocol_version"] && !fcopMeta["protocolVersion"]) {
            fcopMeta["protocol_version"] = 3;
            wfs(fcopJsonPath, JSON.stringify(fcopMeta, null, 2), "utf-8");
            send("  ↳ 🔧 已注入 protocol_version: 3 到 fcop.json");
          }
        } catch (_) { /* 不阻断流程 */ }
      }

      send("📁 正在初始化 0002 工作目录与 ledger 布局...");
      try {
        await ensureLedgerLayout(root);
        send("  ↳ ✅ fcop/tasks、reports、issues、attachments、ledger、_lifecycle/ 已就绪");
      } catch (ledgerErr: unknown) {
        const msg = ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr);
        send(`  ↳ ⚠️ ensureLedgerLayout: ${msg}`);
      }

      send("📦 正在从 adoptedSource/ 初始化 fcop/adopted/（copy-if-missing）...");
      try {
        const adopted = await ensureAdoptedFromSource(root);
        if (adopted.bootstrapped) {
          send(
            `  ↳ ✅ 已复制 ${adopted.copied} 个文件到 fcop/adopted/` +
              (adopted.skipped > 0 ? `（${adopted.skipped} 个已存在，未覆盖）` : ""),
          );
        } else if (adopted.adoptedSourceMissing && adopted.adoptedWasEmpty) {
          send(
            "  ↳ ❌ fcop/adopted/ 为空且 adoptedSource/ 不存在 — 请恢复项目根 adoptedSource/ 后重试",
          );
        } else if (!adopted.adoptedWasEmpty) {
          send("  ↳ ℹ️ fcop/adopted/ 已有内容，跳过 bootstrap");
        }
      } catch (adoptedErr: unknown) {
        const msg = adoptedErr instanceof Error ? adoptedErr.message : String(adoptedErr);
        send(`  ↳ ⚠️ ensureAdoptedFromSource: ${msg}`);
      }

      send("📁 正在为 CodeFlowMu 补齐专属运行态目录...");

      // 2. ★ 核心加固：自动为 CodeFlowMu 补齐专属的应用运行态物理目录
      const fcopDir = join(root, "fcop");
      const codeflowDirs = [
        { path: join(fcopDir, "logs"), label: "fcop/logs/ (运行日志)" },
        { path: join(fcopDir, "logs", "thinking"), label: "fcop/logs/thinking/ (脑电波思考痕迹)" },
        { path: join(fcopDir, "logs", "thinking", "chat"), label: "fcop/logs/thinking/chat/ (聊天思考流归档)" },
        { path: join(fcopDir, "logs", "thinking", "task"), label: "fcop/logs/thinking/task/ (任务思考流归档)" },
        { path: join(fcopDir, "logs", "usage"), label: "fcop/logs/usage/ (用量 JSONL 资产)" },
        { path: join(fcopDir, "logs", "analytics"), label: "fcop/logs/analytics/ (统一分析账本)" },
        { path: join(fcopDir, "logs", "runtime"), label: "fcop/logs/runtime/ (运维链路 runtime-events)" },
        { path: join(fcopDir, "logs", "panel-api"), label: "fcop/logs/panel-api/ (面板 API 耗时 JSONL)" },
        { path: join(fcopDir, "chat"), label: "fcop/chat/ (聊天控制台 Session)" },
        { path: join(fcopDir, "attachments"), label: "fcop/attachments/ (图片附件目录)" },
        { path: join(fcopDir, "internal"), label: "fcop/internal/ (后台调控缓存)" },
        { path: join(fcopDir, "scripts"), label: "fcop/scripts/ (自动化脚本)" },
      ];
      const { mkdirSync, writeFileSync } = await import("node:fs");
      for (const dir of codeflowDirs) {
        if (!existsSync(dir.path)) {
          mkdirSync(dir.path, { recursive: true });
        }
        send(`  ↳ 📂 已建立 ${dir.label}`);
      }

      // 写入专属 README.md 说明文档
      const logsReadme = join(fcopDir, "logs", "README.md");
      if (!existsSync(logsReadme)) {
        writeFileSync(
          logsReadme,
          `# CodeFlowMu 日志目录 / Logs\n\n本目录用于存放 CodeFlowMu 专属运行态思考流与运行跟踪。\n\n- \`thinking/chat/\` — ADMIN 聊天会话的 sdk.thinking / tool_call 自动归档\n- \`thinking/task/\` — 派单 / 唤醒 / 巡查等任务会话的思考流归档\n`,
          "utf-8",
        );
      }
      const chatReadme = join(fcopDir, "chat", "README.md");
      if (!existsSync(chatReadme)) {
        writeFileSync(chatReadme, `# CodeFlowMu 聊天室 / Chat Sessions\n\n本目录用于持久化 Agent 与 ADMIN 的聊天对话 Session 历史。\n`, "utf-8");
      }

      // 重置探测缓存，使得下次探测瞬间返回最新合规状态
      __resetFcopProbeCacheForTests();

      send("📋 正在补种 Skills manifest（PM 内置 + Agent Playbook 投影）...");
      try {
        const pmPlanted = await plantPmSkillManifestIfMissing(root);
        send(
          pmPlanted
            ? "  ↳ ✅ 已写入 .codeflowmu/pm-skills.manifest.json"
            : "  ↳ ℹ️ PM skills manifest 已存在，跳过",
        );
        const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
        const agentPlanted = await plantAgentSkillsManifestIfMissing(root, {
          sourceRoot: hostRoot ?? root,
        });
        send(
          agentPlanted
            ? "  ↳ ✅ 已从 docs/skills 恢复 .codeflowmu/agent-skills.manifest.json"
            : "  ↳ ℹ️ Agent Playbook manifest 已存在，跳过",
        );
      } catch (plantErr: unknown) {
        const plantMsg = plantErr instanceof Error ? plantErr.message : String(plantErr);
        send(`  ↳ ⚠️ Skills manifest 补种异常（验收仍会继续）：${plantMsg}`);
      }

      send("🔎 正在验收初始化结果（磁盘只读检查）...");
      const verification = verifyFcopProjectInit(root);
      for (const item of verification.items) {
        const icon = item.status === "ok" ? "✅" : item.status === "warn" ? "⚠️" : "❌";
        send(`  ↳ ${icon} ${item.name}: ${item.detail}`);
      }
      for (const w of verification.warnings) {
        send(`  ↳ ⚠️ ${w}`);
      }

      // ── 补齐运行态 opts 路径，避免一键初始化后因没有重启而无法建立任务 ──
      if (!opts.adminTasksDir) {
        opts.adminTasksDir = join(root, "fcop", "_lifecycle", "inbox");
      }
      if (!opts.fcopReportsDir) {
        opts.fcopReportsDir = join(root, "fcop", "reports");
      }
      if (!opts.fcopReviewsDir) {
        opts.fcopReviewsDir = join(root, "fcop", "reviews");
      }
      if (!opts.failuresDir) {
        opts.failuresDir = join(root, "fcop", "internal", "failures");
      }

      // One-click initialization can happen after Runtime bootstrap. Rebind
      // persisted agent workspaces immediately so PM/DEV/QA/OPS inspect the
      // selected development project, never codeflowmu-shell or the user-level
      // .codeflowmu runtime-data directory.
      const registeredAgents = await runtime.registry.list();
      for (const agent of registeredAgents) {
        await runtime.registry.updateWorkspace(agent.protocol.agent_id, root);
      }

      if (verification.ok) {
        send(
          verification.warnings.length > 0
            ? `🎉 初始化验收通过（${verification.warnings.length} 项警告，见上方）`
            : "🎉 初始化验收通过！CodeFlowMu 工作区已就绪",
          true,
          { success: true, verification, projectRoot: root },
        );
      } else {
        send(`❌ 初始化验收未通过 — ${verification.summary}`, true, {
          success: false,
          verification,
          projectRoot: root,
        });
      }

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      send(`❌ 初始化失败：${msg}`, true, { success: false });
    } finally {
      res.end();
    }
  });

  /**
   * GET /api/v2/debug/build — 临时调试接口，用于在用户真实的 Node 环境变量下执行 npm run shell:build 并返回详细日志。
   */
  app.get("/api/v2/debug/build", (req: Request, res: Response) => {
    try {
      const { execSync } = require("node:child_process");
      const out = execSync("npm run shell:build", { cwd: resolveProjectRoot() }).toString();
      res.json({ ok: true, output: out });
    } catch (e: any) {
      res.json({
        ok: false,
        output: (e.stdout?.toString() || "") + "\n" + (e.stderr?.toString() || "") + "\n" + e.message,
      });
    }
  });

  /**
   * POST /api/v2/restart — gracefully restart the codeflowmu-shell service.
   * Responds immediately with { ok:true, message }, then spawns a replacement
   * `npm` process and exits after a short delay so the HTTP response is delivered.
   *
   * Spawn strategy: if this shell sits under a CodeFlowMu repo (parent has
   * `codeflowmu-shell/package.json`), runs `npm --prefix codeflowmu-shell start`
   * from the repo root — same as running root `npm start`. Otherwise runs
   * `npm start` with cwd `codeflowmu-shell`. On Windows uses `shell: true`
   * so `npm` resolves like an interactive terminal (avoids silent `npm.cmd` failures).
   */
  app.post("/api/v2/restart", (_req: Request, res: Response) => {
    res.json({ ok: true, message: "重启中，约 5 秒后自动重连...", pid: process.pid });
    // Spawn replacement before exit; delay exit so detached child can attach on Windows.
    setTimeout(() => {
      spawnDetachedShellRestart();
      setTimeout(() => process.exit(0), 600);
    }, 800);
  });

  // ── /api/v2/ routes ──────────────────────────────────────────────────

  /** Helper to mask sensitive API keys for safe UI display. */
  function maskApiKey(key?: string): string {
    if (!key) return "";
    if (key.length <= 16) {
      return "*".repeat(key.length);
    }
    return key.slice(0, 12) + "*".repeat(20) + key.slice(-8);
  }

  function isOpenCursorOnlyEdition(root: string): boolean {
    const editionPath = join(root, ".codeflowmu", "edition-ui.json");
    const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
    const hostEditionPath = hostRoot ? join(hostRoot, ".codeflowmu", "edition-ui.json") : "";
    const candidate = existsSync(editionPath) ? editionPath : hostEditionPath;
    if (!candidate || !existsSync(candidate)) return false;
    try {
      const edition = JSON.parse(readFileSync(candidate, "utf-8")) as {
        edition?: unknown;
        features?: { provider?: unknown };
      };
      return (
        edition.edition === "open-dev-team" &&
        edition.features?.provider === "cursor"
      );
    } catch {
      return false;
    }
  }

  function isProtectedOpenEditionAppRoot(root: string): boolean {
    return isOpenEditionProtectedPath(root);
  }

  function isOpenEditionMode(): boolean {
    return process.env["CODEFLOW_OPEN_EDITION"] === "1";
  }

  function rejectOpenEditionProjectGitNotConfigured(res: Response, cwd: string): boolean {
    if (!isOpenEditionMode()) return false;
    if (isProtectedOpenEditionAppRoot(cwd)) return false;
    if (wpHasOwnGitRepository(cwd)) return false;
    res.status(409).json({
      ok: false,
      code: "PROJECT_GIT_NOT_CONFIGURED",
      cwd,
      error:
        "当前开发项目还没有配置自己的 GitHub 仓库。请在「项目 Git」里填写 Remote URL 和分支并保存配置。",
    });
    return true;
  }

  function rejectProtectedOpenEditionAppRoot(res: Response): boolean {
    const root = resolveProjectRoot();
    if (!isProtectedOpenEditionAppRoot(root)) return false;
    sendError(
      res,
      403,
      "OPEN_EDITION_APP_ROOT_PROTECTED",
      "Open edition cannot modify its own CodeFlowMu-open source directory. Add or switch to an external project root first.",
    );
    return true;
  }

  /**
   * GET /api/v2/config/api-settings — load active API configuration with key masking.
   */
  async function deployOpenEditionProjectProjection(root: string): Promise<{
    applied: boolean;
    copied: string[];
    skipped: string[];
  }> {
    const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
    if (process.env["CODEFLOW_OPEN_EDITION"] !== "1" || !hostRoot) {
      return { applied: false, copied: [], skipped: [] };
    }
    if (isOpenEditionProtectedPath(root)) {
      return { applied: false, copied: [], skipped: [] };
    }
    const fsPromises = await import("node:fs/promises");
    const mappings = [
      [join(hostRoot, ".codeflowmu", "edition-ui.json"), join(root, ".codeflowmu", "edition-ui.json")],
      [join(hostRoot, "docs", "open"), join(root, "docs", "open")],
      [join(hostRoot, "docs", "skills"), join(root, "docs", "skills")],
      [join(hostRoot, "skills", "windows-use"), join(root, "skills", "windows-use")],
      [join(hostRoot, "skills", "browser-use"), join(root, "skills", "browser-use")],
      [join(hostRoot, "adoptedSource"), join(root, "adoptedSource")],
    ] as const;
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const [src, dest] of mappings) {
      if (!existsSync(src)) {
        skipped.push(path.relative(hostRoot, src));
        continue;
      }
      await fsPromises.mkdir(dirname(dest), { recursive: true });
      await fsPromises.cp(src, dest, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      copied.push(path.relative(root, dest));
    }
    if (await plantPmSkillManifestIfMissing(root)) {
      copied.push(".codeflowmu/pm-skills.manifest.json");
    }
    if (await plantAgentSkillsManifestIfMissing(root, { sourceRoot: hostRoot })) {
      copied.push(".codeflowmu/agent-skills.manifest.json");
    }
    return { applied: true, copied, skipped };
  }

  /**
   * Project-local adoptedSource is mandatory: FCoP protocol files are frozen,
   * while adoptedSource carries the mother application's continuing runtime
   * governance updates into every registered product project.
   */
  async function deployRequiredProjectBootstrapProjection(root: string): Promise<void> {
    const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
    if (!hostRoot) {
      throw new Error("CODEFLOW_MOTHER_ROOT_NOT_FOUND");
    }
    const source = join(hostRoot, "adoptedSource");
    const destination = join(root, "adoptedSource");
    if (!existsSync(source)) {
      throw new Error(`ADOPTED_SOURCE_MISSING: ${source}`);
    }
    if (!samePath(source, destination)) {
      const fsPromises = await import("node:fs/promises");
      await fsPromises.mkdir(dirname(destination), { recursive: true });
      await fsPromises.cp(source, destination, {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }
    const adopted = await ensureAdoptedFromSource(root);
    if (adopted.adoptedSourceMissing) {
      throw new Error(`ADOPTED_SOURCE_PROJECTION_FAILED: ${destination}`);
    }
  }

  async function deployPmPlanningProjectProjection(root: string): Promise<void> {
    const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
    if (!hostRoot || isProtectedOpenEditionAppRoot(root)) return;
    const fsPromises = await import("node:fs/promises");
    const source = join(hostRoot, "docs", "skills", "pm-planning-governance.md");
    const destination = join(root, "docs", "skills", "pm-planning-governance.md");
    if (existsSync(source)) {
      await fsPromises.mkdir(dirname(destination), { recursive: true });
      await fsPromises.copyFile(source, destination);
    }
    const marker = "## CodeFlowMu Dev-Team PM Planning Governance";
    const notice = [
      "",
      marker,
      "",
      "This is a CodeFlowMu development-team workflow above FCoP, not an FCoP core-protocol rule.",
      "PM must follow `docs/skills/pm-planning-governance.md` and complete the matching Level 0-3 plan before creating the first DEV/QA/OPS implementation task.",
      "",
    ].join("\n");
    for (const target of [
      join(root, "AGENTS.md"),
      join(root, "fcop", "shared", "roles", "PM.md"),
    ]) {
      if (!existsSync(target)) continue;
      const raw = await fsPromises.readFile(target, "utf8");
      if (!raw.includes(marker)) await fsPromises.appendFile(target, notice, "utf8");
    }
  }

  let apiSettingsRestartRequired = false;

  app.get("/api/v2/config/api-settings", (_req: Request, res: Response) => {
    try {
      const envPath = join(resolveProjectRoot(), ".env");
      let cursorApiKey = process.env["CURSOR_API_KEY"] || "";
      let cursorDefaultModel = process.env["CURSOR_DEFAULT_MODEL"] || "default";
      if (existsSync(envPath)) {
        for (const rawLine of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const eq = line.indexOf("=");
          if (eq < 1) continue;
          const key = line.slice(0, eq).trim();
          let value = line.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (key === "CURSOR_API_KEY") cursorApiKey = value;
          if (key === "CURSOR_DEFAULT_MODEL") cursorDefaultModel = value;
        }
      }
      res.json({
        ok: true,
        provider: "cursor",
        cursorApiKey: maskApiKey(cursorApiKey),
        cursorDefaultModel,
        restartRequired: apiSettingsRestartRequired,
      });
    } catch (err) {
      sendError(res, 500, "GET_API_SETTINGS_FAILED", String(err));
    }
  });

  app.get("/api/v2/config/pm-heartbeat", (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, config: readPmHeartbeatConfig(resolveProjectRoot()) });
    } catch (err) {
      sendError(res, 500, "GET_PM_HEARTBEAT_CONFIG_FAILED", String(err));
    }
  });

  app.put("/api/v2/config/pm-heartbeat", (_req: Request, res: Response) => {
    try {
      const config = writePmHeartbeatConfig(resolveProjectRoot(), _req.body ?? {});
      restartDownstreamAutoNudge();
      restartPmHeartbeatScheduler();
      res.json({ ok: true, config });
    } catch (err) {
      sendError(res, 500, "SAVE_PM_HEARTBEAT_CONFIG_FAILED", String(err));
    }
  });

  app.get("/api/v2/windows-use/manual", (_req: Request, res: Response) => {
    const candidates = [
      join(resolveProjectRoot(), "docs", "WINDOWS-USE-OPERATIONS.md"),
      join(resolveBootstrapProjectRoot(), "docs", "WINDOWS-USE-OPERATIONS.md"),
    ];
    const manualPath = candidates.find((candidate) => existsSync(candidate));
    if (!manualPath) {
      sendError(res, 404, "WINDOWS_USE_MANUAL_NOT_FOUND", "Windows Use manual was not found");
      return;
    }
    res.type("text/markdown; charset=utf-8").send(readFileSync(manualPath, "utf8"));
  });

  app.get("/api/v2/browser-use/settings", (_req: Request, res: Response) => {
    try { res.json({ ok: true, config: readBrowserUseSettings(resolveProjectRoot()) }); }
    catch (err) { sendError(res, 500, "GET_BROWSER_USE_SETTINGS_FAILED", String(err)); }
  });

  async function confirmSecurityMutation(operation: string, target: string, effect: string): Promise<boolean> {
    return trustedForegroundConfirmation({
      title: "CodeFlowMu 安全与权限变更确认",
      message: [
        "确认执行以下安全/权限配置变更？",
        "",
        `动作：${operation}`,
        `目标：${target}`,
        `影响：${effect}`,
        "",
        "敏感凭据不会显示或写入审批记录。取消后不会改变当前配置。",
      ].join("\n"),
    });
  }

  app.get("/api/v2/browser-use/manual", (_req: Request, res: Response) => {
    const candidates = [
      join(resolveProjectRoot(), "docs", "BROWSER-USE-OPERATIONS.md"),
      join(resolveBootstrapProjectRoot(), "docs", "BROWSER-USE-OPERATIONS.md"),
    ];
    const manualPath = candidates.find((candidate) => existsSync(candidate));
    if (!manualPath) { sendError(res, 404, "BROWSER_USE_MANUAL_NOT_FOUND", "Browser Use manual was not found"); return; }
    res.type("text/markdown; charset=utf-8").send(readFileSync(manualPath, "utf8"));
  });

  app.get("/api/v2/browser-use/login-recording", (_req: Request, res: Response) => {
    res.json({ ok: true, ...browserUseLoginRecordingStatus(resolveProjectRoot()) });
  });

  app.post("/api/v2/browser-use/targets/:id/login-recording/start", async (_req: Request, res: Response) => {
    try {
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      res.json({ ok: true, ...(await startBrowserUseLoginRecording(resolveProjectRoot(), id)) });
    } catch (err) { sendError(res, 400, "START_BROWSER_LOGIN_RECORDING_FAILED", String(err)); }
  });

  app.post("/api/v2/browser-use/targets/:id/login-recording/finish", async (_req: Request, res: Response) => {
    try {
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      const body = (_req.body ?? {}) as Record<string, unknown>;
      if (!(await confirmSecurityMutation(
        "保存 Browser Use 登录特征",
        id,
        "保存登录后页面特征与受管浏览器状态，供后续 Agent 访问该目标",
      ))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了登录特征保存");
        return;
      }
      const result = await finishBrowserUseLoginRecording(resolveProjectRoot(), id, String(body["successText"] ?? ""));
      res.json({ ok: true, ...result, targets: listBrowserUseTargets(resolveProjectRoot()) });
    } catch (err) { sendError(res, 400, "FINISH_BROWSER_LOGIN_RECORDING_FAILED", String(err)); }
  });

  app.delete("/api/v2/browser-use/targets/:id/login-recording", async (_req: Request, res: Response) => {
    try {
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      await cancelBrowserUseLoginRecording(resolveProjectRoot(), id);
      res.json({ ok: true, recording: false });
    } catch (err) { sendError(res, 400, "CANCEL_BROWSER_LOGIN_RECORDING_FAILED", String(err)); }
  });

  app.put("/api/v2/browser-use/settings", async (_req: Request, res: Response) => {
    try {
      const body = (_req.body ?? {}) as Record<string, unknown>;
      if (!(await confirmSecurityMutation("保存 Browser Use 允许策略", "browser-use/settings", "改变 Agent 可访问的浏览器目标范围"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了安全策略变更"); return;
      }
      res.json({ ok: true, config: writeBrowserUseSettings(resolveProjectRoot(), { enabled: body["enabled"], allowedTargetIds: body["allowedTargetIds"] }) });
    } catch (err) { sendError(res, 400, "SAVE_BROWSER_USE_SETTINGS_FAILED", String(err)); }
  });

  app.get("/api/v2/browser-use/targets", (_req: Request, res: Response) => {
    try { res.json({ ok: true, targets: listBrowserUseTargets(resolveProjectRoot()) }); }
    catch (err) { sendError(res, 500, "GET_BROWSER_USE_TARGETS_FAILED", String(err)); }
  });

  app.put("/api/v2/browser-use/targets/:id", async (_req: Request, res: Response) => {
    try {
      const body = (_req.body ?? {}) as Record<string, unknown>;
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      if (!(await confirmSecurityMutation("新增或修改 Browser Use 登录目标", id, "改变登录目标、认证方式或本地凭据配置"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了登录目标变更"); return;
      }
      const target = upsertBrowserUseTarget(resolveProjectRoot(), {
        id,
        name: body["name"],
        description: body["description"],
        url: body["url"],
        browser: body["browser"],
        loginMethod: body["loginMethod"],
        verificationChannel: body["verificationChannel"],
        loginInstruction: body["loginInstruction"],
        loginProfile: body["loginProfile"],
      }, {
        username: typeof body["username"] === "string" ? body["username"] : undefined,
        password: typeof body["password"] === "string" ? body["password"] : undefined,
      });
      res.json({ ok: true, target, targets: listBrowserUseTargets(resolveProjectRoot()) });
    } catch (err) { sendError(res, 400, "SAVE_BROWSER_USE_TARGET_FAILED", String(err)); }
  });

  app.delete("/api/v2/browser-use/targets/:id", async (_req: Request, res: Response) => {
    try {
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      if (!(await confirmSecurityMutation("删除 Browser Use 登录目标", id, "移除目标及其本地登录配置"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了登录目标删除"); return;
      }
      res.json({ ok: true, deleted: deleteBrowserUseTarget(resolveProjectRoot(), id), targets: listBrowserUseTargets(resolveProjectRoot()) });
    } catch (err) { sendError(res, 400, "DELETE_BROWSER_USE_TARGET_FAILED", String(err)); }
  });

  app.post("/api/v2/windows-use/pick-executable", async (_req: Request, res: Response) => {
    const body = (_req.body ?? {}) as Record<string, unknown>;
    const initialPath = sanitizeExecutablePickerInitialPath(
      typeof body["initialPath"] === "string" ? body["initialPath"] : "",
    );
    const result = await pickExecutableNative(initialPath);
    if (!result.ok && !result.cancelled) {
      sendError(res, 500, "WINDOWS_USE_PICK_EXECUTABLE_FAILED", result.error);
      return;
    }
    res.json(result);
  });

  app.get("/api/v2/windows-use/settings", (_req: Request, res: Response) => {
    try {
      const root = resolveProjectRoot();
      res.json({
        ok: true,
        platformSupported: process.platform === "win32",
        entry: "cursor",
        config: readWindowsUseSettings(root),
        effective: resolveEffectiveWindowsUseSettings(root),
      });
    } catch (err) {
      sendError(res, 500, "GET_WINDOWS_USE_SETTINGS_FAILED", String(err));
    }
  });

  app.put("/api/v2/windows-use/settings", async (_req: Request, res: Response) => {
    try {
      const body = (_req.body ?? {}) as Record<string, unknown>;
      if (!(await confirmSecurityMutation("保存 Windows Use 允许策略", "windows-use/settings", "改变 Agent 可启动或操作的本机应用范围"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了安全策略变更"); return;
      }
      const config = writeWindowsUseSettings(resolveProjectRoot(), {
        enabled: body["enabled"] === true,
        alwaysAllowedAppIds: Array.isArray(body["alwaysAllowedAppIds"])
          ? body["alwaysAllowedAppIds"] as string[]
          : [],
      });
      if (Array.isArray(body["allowedTargetIds"])) {
        writeWindowsUseAllowedTargetIds(resolveProjectRoot(), body["allowedTargetIds"]);
      }
      const saved = readWindowsUseSettings(resolveProjectRoot());
      res.json({ ok: true, config: saved, effective: resolveEffectiveWindowsUseSettings(resolveProjectRoot()) });
    } catch (err) {
      sendError(res, 400, "SAVE_WINDOWS_USE_SETTINGS_FAILED", String(err));
    }
  });

  app.get("/api/v2/windows-use/targets", (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, targets: listWindowsUseTargets(resolveProjectRoot()) });
    } catch (err) {
      sendError(res, 500, "GET_WINDOWS_USE_TARGETS_FAILED", String(err));
    }
  });

  app.put("/api/v2/windows-use/targets/:id", async (_req: Request, res: Response) => {
    try {
      const body = (_req.body ?? {}) as Record<string, unknown>;
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      if (!(await confirmSecurityMutation("新增或修改 Windows Use 目标", id, "改变本机应用、网页入口或本地凭据配置"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了目标变更"); return;
      }
      const target = upsertWindowsUseTarget(resolveProjectRoot(), {
        id,
        name: body["name"],
        description: body["description"],
        type: body["type"],
        target: body["target"],
        browser: body["browser"],
        loginMethod: body["loginMethod"],
        verificationChannel: body["verificationChannel"],
        loginInstruction: body["loginInstruction"],
      }, {
        username: typeof body["username"] === "string" ? body["username"] : undefined,
        password: typeof body["password"] === "string" ? body["password"] : undefined,
      });
      res.json({ ok: true, target, targets: listWindowsUseTargets(resolveProjectRoot()) });
    } catch (err) {
      sendError(res, 400, "SAVE_WINDOWS_USE_TARGET_FAILED", String(err));
    }
  });

  app.delete("/api/v2/windows-use/targets/:id", async (_req: Request, res: Response) => {
    try {
      const id = String(_req.params["id"] ?? "").trim().toLowerCase();
      if (!(await confirmSecurityMutation("删除 Windows Use 目标", id, "移除 Agent 对该本机应用或网页入口的配置"))) {
        sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了目标删除"); return;
      }
      const deleted = deleteWindowsUseTarget(resolveProjectRoot(), id);
      res.json({ ok: true, deleted, targets: listWindowsUseTargets(resolveProjectRoot()) });
    } catch (err) {
      sendError(res, 400, "DELETE_WINDOWS_USE_TARGET_FAILED", String(err));
    }
  });

  app.post("/api/v2/windows-use/targets/:id/launch", async (_req: Request, res: Response) => {
    try {
      const root = resolveProjectRoot();
      const targetId = String(_req.params["id"] ?? "").trim().toLowerCase();
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const result = await callWindowsUseHost(
        pyProbe.pythonExecutable || process.env["PYTHON_BIN"] || "python",
        root,
        "launch_target",
        { target_id: targetId },
      );
      const payload = result as { ok?: boolean; error?: { code?: string; message?: string } };
      if (!payload.ok) {
        sendError(res, 400, payload.error?.code || "WINDOWS_USE_LAUNCH_FAILED", payload.error?.message || "Failed to open Windows Use target");
        return;
      }
      res.json(result);
    } catch (err) {
      sendError(res, 500, "WINDOWS_USE_LAUNCH_FAILED", String(err));
    }
  });

  app.get("/api/v2/windows-use/health", async (_req: Request, res: Response) => {
    try {
      const root = resolveProjectRoot();
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const result = await callWindowsUseHost(
        pyProbe.pythonExecutable || process.env["PYTHON_BIN"] || "python",
        root,
        "capabilities",
      );
      res.json(result);
    } catch (err) {
      sendError(res, 503, "WINDOWS_USE_HOST_UNAVAILABLE", String(err));
    }
  });

  app.get("/api/v2/windows-use/apps", async (_req: Request, res: Response) => {
    try {
      const root = resolveProjectRoot();
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const result = await callWindowsUseHost(
        pyProbe.pythonExecutable || process.env["PYTHON_BIN"] || "python",
        root,
        "list_apps",
      );
      const payload = result["result"] && typeof result["result"] === "object"
        ? result["result"] as Record<string, unknown>
        : {};
      res.json({
        ...result,
        result: {
          ...payload,
          candidates: listCommonWindowsUseAppCandidates(),
        },
      });
    } catch (err) {
      sendError(res, 503, "WINDOWS_USE_APP_DISCOVERY_FAILED", String(err));
    }
  });

  app.get("/api/v2/models", async (_req: Request, res: Response) => {
    const fallback = ["default"];
    try {
      const root = resolveAppConfigRoot();
      const envPath = join(root, ".env");
      let apiKey = process.env["CURSOR_API_KEY"] || "";
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, "utf-8");
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const eq = line.indexOf("=");
          if (eq < 1) continue;
          const key = line.slice(0, eq).trim();
          if (key !== "CURSOR_API_KEY") continue;
          let value = line.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          apiKey = value;
        }
      }

      if (!apiKey) {
        res.json({ ok: true, source: "fallback-no-key", models: fallback });
        return;
      }

      const { Cursor } = await import("@cursor/sdk");
      const listed = await Cursor.models.list({ apiKey });
      const models = new Set<string>(["default"]);
      for (const model of listed as Array<{ id?: unknown; aliases?: unknown }>) {
        const id = String(model?.id ?? "").trim();
        if (id) models.add(id);
        if (Array.isArray(model?.aliases)) {
          for (const alias of model.aliases) {
            const value = String(alias ?? "").trim();
            if (value) models.add(value);
          }
        }
      }
      res.json({ ok: true, source: "cursor", models: Array.from(models) });
    } catch (err: any) {
      console.warn(`[web-panel] Failed to list Cursor models:`, err.message || err);
      res.json({
        ok: false,
        source: "fallback-error",
        error: err.message || String(err),
        models: fallback,
      });
    }
  });

  /**
   * POST /api/v2/config/api-settings — update the public Cursor SDK settings.
   */
  app.post("/api/v2/config/api-settings", async (_req: Request, res: Response) => {
    try {
      const cursorApiKey = String(_req.body?.cursorApiKey ?? "");
      const cursorDefaultModel = String(_req.body?.cursorDefaultModel ?? "default") || "default";
      const root = resolveAppConfigRoot();
      const envPath = join(root, ".env");
      if (!(await confirmSecurityMutation(
        "保存 Cursor SDK 接入与凭据配置",
        envPath,
        "更新 Cursor API Key 与默认模型",
      ))) {
        return sendError(res, 409, "SECURITY_CHANGE_CONFIRMATION_CANCELLED", "用户取消了 Cursor SDK 配置变更");
      }
      let currentCursorKey = process.env["CURSOR_API_KEY"] || "";
      let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1 || line.slice(0, eq).trim() !== "CURSOR_API_KEY") continue;
        currentCursorKey = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      }
      const targetCursorKey =
        cursorApiKey.includes("*") && currentCursorKey ? currentCursorKey : cursorApiKey;
      const runtimeCursorKey = process.env["CURSOR_API_KEY"] || "";
      const runtimeCursorModel = process.env["CURSOR_DEFAULT_MODEL"] || "default";
      const restartRequired =
        targetCursorKey !== runtimeCursorKey || cursorDefaultModel !== runtimeCursorModel;
      const updateMap = new Map<string, string>([
        ["CODEFLOW_PROVIDER", "cursor"],
        ["CURSOR_API_KEY", targetCursorKey],
        ["CURSOR_DEFAULT_MODEL", cursorDefaultModel],
      ]);
      const lines = content.split(/\r?\n/);
      const processed = new Set<string>();
      for (let index = 0; index < lines.length; index += 1) {
        const eq = lines[index]!.indexOf("=");
        if (eq < 1) continue;
        const key = lines[index]!.slice(0, eq).trim();
        if (!updateMap.has(key)) continue;
        lines[index] = `${key}=${updateMap.get(key)}`;
        processed.add(key);
      }
      for (const [key, value] of updateMap) {
        if (!processed.has(key)) lines.push(`${key}=${value}`);
      }
      writeFileSync(envPath, lines.join("\n"), "utf-8");
      process.env["CODEFLOW_PROVIDER"] = "cursor";
      process.env["CURSOR_API_KEY"] = targetCursorKey;
      process.env["CURSOR_DEFAULT_MODEL"] = cursorDefaultModel;
      apiSettingsRestartRequired = apiSettingsRestartRequired || restartRequired;
      res.json({
        ok: true,
        restartRequired: apiSettingsRestartRequired,
        message: apiSettingsRestartRequired
          ? "Cursor SDK 设置已保存；必须重启服务后生效"
          : "Cursor SDK 设置已保存，当前运行配置未变化",
      });
    } catch (err) {
      sendError(res, 500, "POST_API_SETTINGS_FAILED", String(err));
    }
  });

  // ── /api/v2/ routes ──────────────────────────────────────────────────

  /**
   * GET /api/v2/thinking/logs — list local thinking log files.
   * chat/ + task/ under fcop/logs/thinking/ (legacy flat files included in files[]).
   */
  app.get("/api/v2/thinking/logs", (_req: Request, res: Response) => {
    try {
      const files = thinkingLogger?.listFiles() ?? [];
      const byChannel = thinkingLogger?.listByChannel() ?? { chat: [], task: [] };
      res.json({
        log_dir: thinkingLogger?.rootDir ?? null,
        channels: {
          chat: {
            dir: thinkingLogger?.channelDir("chat") ?? null,
            files: byChannel.chat,
          },
          task: {
            dir: thinkingLogger?.channelDir("task") ?? null,
            files: byChannel.task,
          },
        },
        files,
        total: files.length,
      });
    } catch (err) {
      sendError(res, 500, "THINKING_LOGS_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/usage/today — today's aggregated token consumption.
   * Cursor SDK local runs only provide estimates reliably. When configured,
   * Cursor Admin API contributes a team-level billing snapshot; local JSONL
   * remains the source for per-run estimates.
   * If cache is stale, triggers a background sync and serves local data in the meantime.
   */
  const usageSyncMeta = () => ({
    cursor_sync_enabled: !isCursorAdminUsageSyncDisabled() && !!cursorSyncer,
    has_team_id: Boolean((process.env["CURSOR_TEAM_ID"] ?? "").trim()),
    has_api_key: Boolean((process.env["CURSOR_API_KEY"] ?? "").trim()),
  });

  app.get("/api/v2/usage/today", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const syncParam = String(req.query["sync"] ?? "1").toLowerCase();
      const allowBackgroundSync =
        syncParam !== "0" && syncParam !== "false" && syncParam !== "off";
      const sync_meta = usageSyncMeta();
      const agg = usageLogger?.aggregateToday() ?? {
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_estimated_input_tokens: 0,
        total_estimated_tool_schema_tokens: 0,
        total_runs: 0,
        by_agent: {},
        by_thread: {},
        by_task: {},
        by_model: {},
      };
      // Try Cursor API cache first
      if (cursorSyncer) {
        const fresh = await cursorSyncer.isCacheFresh();
        if (fresh) {
          const cache = await cursorSyncer.readCache();
          if (cache) {
            const localByModel = agg.by_model as Record<
              string,
              {
                estimated_input_tokens?: number;
                estimated_tool_schema_tokens?: number;
              }
            >;
            res.json({
              total_cost_usd: cache.summary.totalCost,
              total_input_tokens: cache.summary.totalTokens,
              total_output_tokens: 0,
              total_estimated_input_tokens: agg.total_estimated_input_tokens,
              total_estimated_tool_schema_tokens:
                agg.total_estimated_tool_schema_tokens,
              total_runs: cache.summary.totalRuns,
              by_agent: Object.fromEntries(
                cache.agents.map((a) => [
                  a.agentId,
                  { cost: a.totalCost, runs: a.runCount, tokens: a.totalTokens },
                ]),
              ),
              by_thread: agg.by_thread,
              by_task: agg.by_task,
              by_model: Object.fromEntries(
                cache.models.map((m) => [
                  m.model,
                  {
                    cost: m.totalCost,
                    runs: m.runCount,
                    tokens: m.totalTokens,
                    estimated_input_tokens:
                      localByModel[m.model]?.estimated_input_tokens ?? 0,
                    estimated_tool_schema_tokens:
                      localByModel[m.model]?.estimated_tool_schema_tokens ?? 0,
                  },
                ]),
              ),
              source: "cursor-admin-api+local-jsonl-estimates",
              sources: {
                billing_snapshot: "cursor-admin-api",
                estimates: "local-jsonl",
              },
              syncedAt: cache.syncedAt,
              sync_meta,
            });
            return;
          }
        } else if (allowBackgroundSync) {
          // Stale/missing — trigger async sync, serve local data now
          void cursorSyncer.sync();
        }
      }
      // Fallback to local usage JSONL
      res.json({ ...agg, source: "local-jsonl", sync_meta });
    } catch (err) {
      sendError(res, 500, "USAGE_AGG_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * POST /api/v2/usage/sync — manually trigger an immediate Cursor API sync.
   * Returns the fresh cache summary.
   */
  app.post("/api/v2/usage/sync", async (_req: Request, res: Response) => {
    if (isCursorAdminUsageSyncDisabled()) {
      sendError(
        res,
        503,
        "SYNC_DISABLED",
        "Cursor Admin usage sync is disabled (CODEFLOW_CURSOR_USAGE_SYNC=0|false|off|no).",
      );
      return;
    }
    if (!cursorSyncer) {
      sendError(res, 503, "NO_SYNCER", "CursorUsageSyncer not configured (projectRoot missing)");
      return;
    }
    try {
      const cache = await cursorSyncer.sync();
      if (!cache) {
        // sync() returned null — no API key or network error, try stale cache
        const stale = await cursorSyncer.readCache();
        res.json({
          ok: true,
          syncedAt: stale?.syncedAt ?? null,
          summary: stale?.summary ?? { totalCost: 0, totalTokens: 0, totalRuns: 0 },
          source: stale ? "stale-cache" : "no-cache",
        });
        return;
      }
      res.json({ ok: true, syncedAt: cache.syncedAt, summary: cache.summary, source: "cursor-api" });
    } catch (err) {
      sendError(res, 500, "SYNC_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/queue — pending report queue snapshot.
   * Returns items waiting for PM to become idle, plus task inbox status.
   */
  app.get("/api/v2/queue", async (_req: Request, res: Response) => {
    try {
      const reportQueue = runtime.reportDispatcher?.queueSnapshot() ?? [];
      const agents = await runtime.registry.list();
      const pmAgents = agents.filter((a) => /^PM/i.test(a.protocol.agent_id));
      runtime.pmQueueGuard.checkAndReleaseStale();
      const refreshed = runtime.pmQueueGuard.snapshot();
      const root = resolveAppConfigRoot();

      let pmWaitingDownstream = refreshed.waiting_downstream;
      let receiptPhase: WorkerReceiptWaitingPhase = "none";
      let receiptRole = refreshed.downstream_role;
      let receiptWorkerTaskId: string | null = null;
      let receiptReportId: string | null = null;
      let receiptThreadKey: string | null = null;
      let receiptQueueState = "none";
      let receiptReasonCode: string | null = null;
      let receiptSessionId: string | null = null;
      let receiptSuggestedAction: string | null = null;
      let receiptLastFailureCategory: string | null = null;
      let receiptIsFirstTurnAbort = false;

      const rolesToCheck = ["QA", "DEV", "OPS"];

      try {
        const v3 = fcopV3Paths(root);
        const extraDirs = [
          runtime.watcher.dir,
          ...(opts.adminTasksDir ? [opts.adminTasksDir] : []),
        ];
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const enrichedTasks = _wpEnrichTasksFromDisk(
          taskRows,
          root,
          v3,
          extraDirs,
        ) as unknown as LedgerTaskRecord[];
        const { reports: reportRows } = await listReportsFromLedgerAuto(root);
        const tasks = enrichedTasks;
        const reports = reportRows as unknown as LedgerReportRecord[];

        await pruneStaleDownstreamReceiptFailures(root, tasks, reports);

        pmWaitingDownstream = false;

        const { ev, meta } = await (async () => {
          const agents = await runtime.registry.list();
          const extrasCache = new Map<
            string,
            Omit<
              Parameters<typeof evaluateWorkerReceiptWaiting>[0],
              "tasks" | "reports" | "targetRole" | "focusTaskId"
            >
          >();
          const evalExtras = async (role: string, tid: string) => {
            const durable = await resolveWorkerReceiptDurableHints(root, tid);
            const agentRunning = agents.some(
              (a) =>
                (a.protocol.role ?? "").toUpperCase() === role &&
                a.protocol.status === "running",
            );
            const merged = mergeWorkerReceiptSignals(
              {
                nudgeCount: runtime.pmQueueGuard.nudgeCountForTask(tid),
                workerFailed: runtime.pmQueueGuard.isDownstreamWorkerFailed(tid),
              },
              durable,
              { agentRunning },
            );
            return {
              nudgeCount: merged.nudgeCount,
              workerFailed: merged.workerFailed,
              sessionFailed: merged.sessionFailed,
              sessionUnsettled: merged.sessionUnsettled,
              recoverable: merged.recoverable,
              lastSessionId: merged.lastSessionId,
              lastFailureCode: merged.lastFailureCode,
              lastFailureCategory: merged.lastFailureCategory,
              isFirstTurnAbort: merged.isFirstTurnAbort,
              lastSessionStatus: durable.lastSessionStatus,
              agentRunning,
            };
          };

          for (const role of rolesToCheck) {
            const workers = tasks.filter(
              (t) =>
                isPmToWorkerDispatch(t.sender, t.recipient, t.filename) &&
                (t.recipient ?? "").toUpperCase() === role &&
                isWorkerReceiptWaitingBucket(resolveTaskCurrentBucket(t)),
            );
            for (const w of workers) {
              const key = `${role}:${w.task_id}`;
              if (!extrasCache.has(key)) {
                extrasCache.set(key, await evalExtras(role, w.task_id));
              }
            }
          }

          const picked = pickQueueWorkerReceiptState(tasks, reports, rolesToCheck, (role, taskId) => {
            const key = `${role}:${taskId}`;
            return (
              extrasCache.get(key) ?? {
                nudgeCount: 0,
                workerFailed: false,
                sessionFailed: false,
              }
            );
          });
          const metaKey =
            picked.role && picked.workerTaskId
              ? `${String(picked.role).toUpperCase()}:${picked.workerTaskId}`
              : null;
          const meta = metaKey ? extrasCache.get(metaKey) : undefined;
          return { ev: picked, meta };
        })();

        receiptQueueState = ev.queueState ?? "none";
        receiptReasonCode = ev.reasonCode ?? null;
        receiptSessionId = ev.lastSessionId ?? null;
        receiptSuggestedAction = ev.suggestedAction ?? null;
        receiptLastFailureCategory = meta?.lastFailureCategory ?? null;
        receiptIsFirstTurnAbort = Boolean(meta?.isFirstTurnAbort);

        if (ev.phase === "worker_receipt_failed" && ev.workerTaskId) {
          receiptPhase = ev.phase;
          receiptRole = ev.role;
          receiptWorkerTaskId = ev.workerTaskId;
          receiptReportId = ev.receiptReportId;
          receiptThreadKey = ev.threadKey;
          pmWaitingDownstream = false;
          runtime.pmQueueGuard.clearWaitingDownstream();
          runtime.pmQueueGuard.clearAutoNudge();
          if (
            !isRecoverableSessionFailure(
              ev.reasonCode ?? ev.reason,
              meta?.lastSessionStatus,
              {
                failureCategory: meta?.lastFailureCategory,
                isFirstTurnAbort: meta?.isFirstTurnAbort,
              },
            )
          ) {
            runtime.pmQueueGuard.markDownstreamWorkerFailed(ev.workerTaskId);
            void persistWorkerReceiptFailed(root, ev.workerTaskId, ev.reason);
          }
        } else if (ev.shouldShowWaiting) {
          pmWaitingDownstream = true;
          receiptPhase = ev.phase;
          receiptRole = ev.role;
          receiptWorkerTaskId = ev.workerTaskId;
          receiptReportId = ev.receiptReportId;
          receiptThreadKey = ev.threadKey;
        } else {
          receiptPhase = ev.phase;
          receiptRole = ev.role;
          receiptWorkerTaskId = ev.workerTaskId;
          receiptReportId = ev.receiptReportId;
          receiptThreadKey = ev.threadKey;
          if (ev.shouldClearGuard) {
            runtime.pmQueueGuard.clearWaitingDownstream();
            runtime.pmQueueGuard.clearAutoNudge();
          }
          if (ev.workerTaskId) {
            void clearWorkerReceiptFailed(root, ev.workerTaskId);
            runtime.pmQueueGuard.clearDownstreamWorkerFailed(ev.workerTaskId);
          }
        }
      } catch {
        /* keep guard snapshot fallback */
      }

      if (receiptPhase === "worker_receipt_failed" && !receiptWorkerTaskId) {
        receiptPhase = "none";
      }

      const registryPmRunning = pmAgents.some(
        (a) => a.protocol.status === "running",
      );
      const downstreamRole = receiptRole ?? refreshed.downstream_role;
      const downstreamRunning = downstreamRole
        ? agents.some(
            (a) =>
              (a.protocol.role ?? "").toUpperCase() === downstreamRole &&
              a.protocol.status === "running",
          )
        : false;
      const pmBusy =
        !pmWaitingDownstream &&
        receiptPhase !== "worker_receipt_failed" &&
        receiptPhase !== "session_recoverable" &&
        receiptPhase !== "session_running" &&
        (refreshed.pm_busy || registryPmRunning);
      res.json({
        pm_busy: pmBusy,
        pm_queue_state: refreshed.phase,
        pm_waiting_downstream: pmWaitingDownstream,
        pm_downstream_receipt_phase: receiptPhase,
        pm_downstream_queue_state: receiptQueueState,
        pm_downstream_receipt_reason_code: receiptReasonCode,
        pm_downstream_receipt_session_id: receiptSessionId,
        pm_downstream_suggested_action: receiptSuggestedAction,
        pm_downstream_last_failure_category: receiptLastFailureCategory,
        pm_downstream_is_first_turn_abort: receiptIsFirstTurnAbort,
        pm_downstream_receipt_task_id: receiptWorkerTaskId,
        pm_downstream_receipt_report_id: receiptReportId,
        pm_downstream_receipt_thread_key: receiptThreadKey,
        pm_stale_released: refreshed.stale_released,
        pm_downstream_role: downstreamRole,
        pm_downstream_running: downstreamRunning,
        pm_downstream_auto_nudged_at: refreshed.downstream_auto_nudged_at,
        pm_downstream_next_nudge_at: refreshed.downstream_next_nudge_at,
        pm_downstream_nudge_task_id: refreshed.downstream_nudge_task_id,
        pm_downstream_last_wake_session_id: refreshed.downstream_last_wake_session_id,
        pm_queue: {
          processing: refreshed.processing,
          in_flight: refreshed.in_flight,
          busy_since: refreshed.busy_since,
          last_pm_event_at: refreshed.last_pm_event_at,
        },
        report_queue: reportQueue,
        report_queue_depth: reportQueue.length,
        pm_agents: pmAgents.map((a) => ({
          id: a.protocol.agent_id,
          status: a.protocol.status,
        })),
        autoRecovery: getPanelAutoRecoverySnapshot(),
      });
    } catch (err) {
      sendError(res, 500, "QUEUE_READ_FAILED", String(err));
    }
  });

  /** GET /api/v2/agents — list all registered agents */
  app.get("/api/v2/agents", async (_req: Request, res: Response) => {
    try {
      const agents = await runtime.registry.list();
      res.json(agents);
    } catch (err) {
      sendError(res, 500, "AGENTS_LIST_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/tasks — list tasks from ledger current-index (default).
   * Default source is `tasks.jsonl` rebuilt from `fcop/_lifecycle/*`.
   * Query: ?limit=N (default 100), ?sender=ADMIN, ?recipient=PM,
   * ?source=ledger|legacy (legacy = explicit migration scan only).
   */
  // ── Sprint-5: Global full-text search ──────────────────────────────────────
  /**
   * GET /api/v2/search?q=<keyword>&scope=tasks,reports,files&limit=20
   * Scans fcop/_lifecycle/inbox/ + fcop/reports/ for files matching the query (case-insensitive).
   * Returns {results:[{type,filename,path,excerpt,score}]}.
   */
  app.get("/api/v2/search", async (req: Request, res: Response) => {
    try {
      const q = String(req.query["q"] ?? "").trim().toLowerCase();
      if (!q || q.length < 2) { res.json({ results: [] }); return; }
      const scope = String(req.query["scope"] ?? "tasks,reports").split(",").map(s => s.trim());
      const limitN = Math.min(Number(req.query["limit"] ?? 20), 100);
      // 搜索属于当前开发项目上下文；母体安装根与开发项目切换是两套概念。
      const root = resolveProjectRoot();
      const v3 = fcopV3Paths(root);
      const { readdirSync, readFileSync: rfs } = await import("node:fs");

      const dirMap: Record<string, string> = {
        tasks:   v3.inbox,
        reports: v3.reports,
        reviews: v3.reviews,
        files:   join(root, "fcop", "internal"),
      };

      const results: { type: string; filename: string; path: string; excerpt: string; score: number }[] = [];

      for (const s of scope) {
        const dir = dirMap[s];
        if (!dir || !existsSync(dir)) continue;
        let files: string[];
        try { files = readdirSync(dir).filter(f => /\.(md|txt|json)$/.test(f)); }
        catch { continue; }
        for (const filename of files) {
          if (s === "reports" && !isTeamVisibleReportFilename(filename)) continue;
          const filePath = join(dir, filename);
          let content = "";
          try { content = rfs(filePath, "utf-8"); } catch { continue; }
          const lower = content.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx === -1 && !filename.toLowerCase().includes(q)) continue;
          // Build excerpt around first match
          const start = Math.max(0, idx - 50);
          const end = Math.min(content.length, idx + q.length + 50);
          const excerpt = idx >= 0
            ? (start > 0 ? "…" : "") + content.slice(start, end).replace(/\n/g, " ") + (end < content.length ? "…" : "")
            : filename;
          // Score: filename match > content match near top
          const score = filename.toLowerCase().includes(q) ? 100 :
            idx < 500 ? 80 : idx < 2000 ? 60 : 40;
          const dirKey: Record<string, string> = {
            tasks: "fcop/_lifecycle/inbox",
            reports: "fcop/reports",
            reviews: "fcop/reviews",
            files: "fcop/internal",
          };
          const pageKey: Record<string, string> = { tasks:"tasks", reports:"reports", reviews:"approvals", files:"files" };
          const relPath = `${dirKey[s] ?? s}/${filename}`;
          results.push({ type: s === "reviews" ? "review" : s.replace(/s$/,""), filename, path: relPath, excerpt: excerpt.slice(0, 150), score, page: pageKey[s] ?? "files" } as any);
          if (results.length >= limitN * 3) break; // over-fetch then sort
        }
      }

      results.sort((a, b) => b.score - a.score);
      res.json({ results: results.slice(0, limitN) });
    } catch (err) {
      sendError(res, 500, "SEARCH_FAILED", String(err));
    }
  });

  app.get("/api/v2/ledger/threads", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      const threads = await readLedgerThreadsAuto(root);
      res.json({ threads, count: threads.length });
    } catch (err) {
      sendError(res, 500, "LEDGER_THREADS_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * GET /api/v2/team/dynamics — lifecycle SoT snapshot for ADMIN dashboard.
   * Rebuilds from enriched tasks (physical_scope); ledger threads are supplementary.
   */
  app.get("/api/v2/team/dynamics", async (_req: Request, res: Response) => {
    try {
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
      const enriched = _wpEnrichTasksFromDisk(
        taskRows,
        root,
        v3,
        opts.adminTasksDir ? [opts.adminTasksDir] : [],
      ) as unknown as LedgerTaskRecord[];
      const { reports: reportRows } = await listReportsFromLedgerAuto(root);
      const reports = reportRows as unknown as LedgerReportRecord[];
      const tasks = enriched.filter((t) =>
        String(t.filename ?? "").startsWith("TASK-"),
      );
      const lifecycle_counts = aggregateLifecycleCountsFromPhysical(tasks);
      const pm_open = collectPmOpenMainlineTasks(tasks, reports);
      const heal_notes: string[] = [];
      for (const t of taskRows as unknown as LedgerTaskRecord[]) {
        const fn = String(t.filename ?? "");
        if (!fn) continue;
        const ledgerBucket = String(t.bucket ?? "").toLowerCase();
        const physical = resolveTaskCurrentBucket({
          bucket: t.bucket,
          path: t.path,
          physical_scope: t.physical_scope,
        });
        const enrichedOne = tasks.find((e) => e.filename === fn);
        const diskBucket = enrichedOne
          ? resolveTaskCurrentBucket({
              bucket: enrichedOne.bucket,
              path: enrichedOne.path,
              physical_scope: enrichedOne.physical_scope,
            })
          : physical;
        if (
          ledgerBucket &&
          diskBucket &&
          ledgerBucket !== diskBucket &&
          ["inbox", "active", "review", "done", "archive"].includes(diskBucket)
        ) {
          heal_notes.push(
            `${fn}: ledger=${ledgerBucket} → currentBucket=${diskBucket}`,
          );
        }
      }
      res.json({
        lifecycle_counts,
        pm_open_task_ids: pm_open.map((t) => t.task_id ?? t.filename),
        heal_notes: heal_notes.slice(0, 50),
        source: "physical_scope",
      });
    } catch (err) {
      sendError(res, 500, "TEAM_DYNAMICS_FAILED", String(err));
    }
  });

  app.get("/api/v2/ledger/views/:role", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const role = String(req.params["role"] ?? "");
      const variant = String(req.query["variant"] ?? "todo");
      const view = await readLedgerViewMarkdownAuto(projectRoot(), role, variant);
      if (!view) {
        sendError(res, 404, "LEDGER_VIEW_NOT_FOUND", `no ledger view for ${role}.${variant}`);
        return;
      }
      res.json(view);
    } catch (err) {
      sendError(res, 500, "LEDGER_VIEW_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /** Diagnostics — ledger reconcile anomalies (separate from normal tasks). */
  app.get("/api/v2/diagnostics", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      res.json(await getDiagnosticsListResponseConfirmed(root));
    } catch (err) {
      sendError(res, 500, "DIAGNOSTICS_LIST_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.post("/api/v2/diagnostics/rescan", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      const summary = await rescanDiagnostics(root);
      res.json({ ok: true, summary });
    } catch (err) {
      sendError(res, 500, "DIAGNOSTICS_RESCAN_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.get("/api/v2/diagnostics/:id", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const id = decodeURIComponent(String(req.params["id"] ?? "")).trim();
      if (!id) {
        sendError(res, 400, "MISSING_DIAGNOSTIC_ID", "id is required");
        return;
      }
      const root = projectRoot();
      const item = getDiagnosticById(root, id);
      if (!item) {
        sendError(res, 404, "DIAGNOSTIC_NOT_FOUND", id);
        return;
      }
      res.json(item);
    } catch (err) {
      sendError(res, 500, "DIAGNOSTICS_GET_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.post(
    "/api/v2/diagnostics/:id/clear-orphan",
    async (req: Request, res: Response) => {
      const label = panelApiPathLabel(req);
      const t0 = performance.now();
      try {
        const id = decodeURIComponent(String(req.params["id"] ?? "")).trim();
        if (!id) {
          sendError(res, 400, "MISSING_DIAGNOSTIC_ID", "id is required");
          return;
        }
        const root = projectRoot();
        try {
          const result = clearOrphanDiagnostic(root, id);
          res.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "DIAGNOSTIC_NOT_FOUND") {
            sendError(res, 404, "DIAGNOSTIC_NOT_FOUND", id);
            return;
          }
          if (msg === "NOT_LEDGER_ORPHAN") {
            sendError(res, 400, "NOT_LEDGER_ORPHAN", "clear-orphan only applies to ledger_orphan");
            return;
          }
          if (msg === "ALREADY_CLEARED") {
            sendError(res, 409, "ALREADY_CLEARED", id);
            return;
          }
          throw err;
        }
      } catch (err) {
        sendError(res, 500, "DIAGNOSTICS_CLEAR_ORPHAN_FAILED", String(err));
      } finally {
        logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
      }
    },
  );

  /** PM 内置治理（只读摘要 / 关单草稿；非 ADMIN 按钮墙） */
  app.get("/api/v2/pm/governance/thread/:threadKey/summary", async (req: Request, res: Response) => {
    try {
      const threadKey = decodeURIComponent(String(req.params["threadKey"] ?? "")).trim();
      if (!threadKey) {
        sendError(res, 400, "MISSING_THREAD_KEY", "threadKey is required");
        return;
      }
      const root = projectRoot();
      if (!statusCheckThrottle.shouldRun(threadKey)) {
        void recordSkillInvocation(root, {
          skill_id: "pm.summarize_thread",
          channel: "api",
          caller_role: "PM",
          thread_key: threadKey,
          outcome: "skipped",
          summary: "状态检查节流过频",
          triggered_by: "api",
        }).catch(() => {});
        res.json({
          throttled: true,
          retry_after_ms: statusCheckThrottle.msUntilReady(threadKey),
          message: "状态检查节流过频（同 thread 30–60s 内最多一次）",
        });
        return;
      }
      const summary = await invokePmSkillWithJournal(
        root,
        {
          skill_id: "pm.summarize_thread",
          channel: "api",
          thread_key: threadKey,
          caller_role: "PM",
          triggered_by: "api",
        },
        () => summarizeThread(root, threadKey),
        (s) => ({
          outcome: s ? "ok" : "failed",
          summary: s
            ? `thread ${threadKey} · ${s.tasks?.length ?? 0} tasks`
            : "thread not found",
        }),
      );
      if (!summary) {
        sendError(res, 404, "THREAD_NOT_FOUND", threadKey);
        return;
      }
      res.json(summary);
    } catch (err) {
      sendError(res, 500, "PM_SUMMARY_FAILED", String(err));
    }
  });

  const validateRuntimePlanningIdentity = async (
    sessionId: string,
    callerRole: string,
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
    if (!sessionId || !callerRole) {
      return { ok: false, code: "INVALID_PLANNING_ARTIFACT_CALL", message: "Runtime session identity is required" };
    }
    const session = await runtime.sessionStore.load(sessionId);
    if (!session) {
      return { ok: false, code: "RUNTIME_SESSION_NOT_FOUND", message: `Unknown Runtime session_id: ${sessionId}` };
    }
    if (session.protocol.status !== "running") {
      return { ok: false, code: "RUNTIME_SESSION_NOT_ACTIVE", message: `Runtime session is ${session.protocol.status}` };
    }
    if (session.protocol.agent_id !== callerRole) {
      return {
        ok: false,
        code: "RUNTIME_CONTEXT_MISMATCH",
        message: `caller_role does not match SessionStore agent_id for ${sessionId}`,
      };
    }
    if (session.protocol.task_id !== taskId) {
      return {
        ok: false,
        code: "RUNTIME_TASK_MISMATCH",
        message: `task_id does not match SessionStore task_id for ${sessionId}`,
      };
    }
    return { ok: true };
  };

  app.post("/api/v2/pm/governance/planning-skill-evidence", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = String(body["session_id"] ?? "").trim();
      if (!sessionId) {
        sendError(res, 400, "SESSION_REQUIRED", "真实规划技能证据必须关联 Runtime session_id");
        return;
      }
      const callerRole = String(body["caller_role"] ?? "").trim();
      const taskId = String(body["task_id"] ?? "").trim();
      const identity = await validateRuntimePlanningIdentity(sessionId, callerRole, taskId);
      if (!identity.ok) {
        sendError(res, 409, identity.code, identity.message);
        return;
      }
      const decisions = Array.isArray(body["product_decisions"])
        ? body["product_decisions"].map(String)
        : [];
      const record = await recordPlanningSkillEvidence(projectRoot(), {
        skill_id: String(body["skill_id"] ?? ""),
        task_id: taskId,
        session_id: sessionId,
        caller_role: callerRole,
        input_context: String(body["input_context"] ?? ""),
        output_summary: String(body["output_summary"] ?? ""),
        brief_section: String(body["brief_section"] ?? ""),
        product_decisions: decisions,
        ...(String(body["thread_key"] ?? "").trim()
          ? { thread_key: String(body["thread_key"]).trim() }
          : {}),
      });
      res.json({ ok: true, invocation: record });
    } catch (err) {
      sendError(res, 400, "INVALID_PLANNING_SKILL_EVIDENCE", String(err));
    }
  });

  app.post("/api/v2/pm/governance/planning-artifact", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = String(body["task_id"] ?? "").trim();
      const threadKey = String(body["thread_key"] ?? "").trim();
      const sessionId = String(body["session_id"] ?? "").trim();
      const callerRole = String(body["caller_role"] ?? "").trim();
      const bodyMarkdown = String(body["body_markdown"] ?? "");
      const status = String(body["status"] ?? "ready").trim().toLowerCase();
      if (
        !taskId ||
        !/^[A-Za-z0-9._:-]+$/.test(sessionId) ||
        !/^PM(?:[-.][A-Za-z0-9_-]+)?$/i.test(callerRole)
      ) {
        sendError(res, 400, "INVALID_PLANNING_ARTIFACT_CALL", "PM task_id, Runtime session_id and caller_role are required");
        return;
      }
      const identity = await validateRuntimePlanningIdentity(sessionId, callerRole, taskId);
      if (!identity.ok) {
        sendError(res, 409, identity.code, identity.message);
        return;
      }
      if (!bodyMarkdown.trim() || !["draft", "ready"].includes(status)) {
        sendError(res, 400, "INVALID_PLANNING_ARTIFACT", "body_markdown and status=draft|ready are required");
        return;
      }

      const root = projectRoot();
      const ctx = await resolveThreadContext(root, {
        task_id: taskId,
        thread_key: threadKey || undefined,
      });
      if (!ctx?.root_task_id) {
        sendError(res, 404, "PLANNING_ROOT_TASK_NOT_FOUND", taskId);
        return;
      }
      const rootTask = ctx.tasks.find((task) => task.task_id === ctx.root_task_id);
      const before = await evaluateProductDeliveryGate({
        projectRoot: root,
        taskId: ctx.root_task_id,
        taskBody: ctx.root_body ?? "",
        taskFrontmatter: rootTask?.yaml,
      });
      if (before.planning_level === 0) {
        sendError(res, 409, "PLANNING_ARTIFACT_NOT_REQUIRED", "Level 0 task does not accept a planning artifact");
        return;
      }
      const artifact = await writePlanningArtifact({
        projectRoot: root,
        taskId: ctx.root_task_id,
        planningLevel: before.planning_level,
        bodyMarkdown,
        status: status as "draft" | "ready",
        callerRole,
        sessionId,
      });
      const gate = await evaluateProductDeliveryGate({
        projectRoot: root,
        taskId: ctx.root_task_id,
        taskBody: ctx.root_body ?? "",
        taskFrontmatter: rootTask?.yaml,
      });
      res.json({ ok: true, artifact, gate });
    } catch (err) {
      sendError(res, 400, "PLANNING_ARTIFACT_WRITE_FAILED", String(err));
    }
  });

  app.post("/api/v2/pm/governance/planning-level", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = String(body["task_id"] ?? "").trim();
      const level = Number(body["planning_level"]);
      const reason = String(body["reason"] ?? "").trim();
      if (!taskId || ![0, 1, 2, 3].includes(level) || !reason) {
        sendError(res, 400, "INVALID_PLANNING_LEVEL_OVERRIDE", "task_id, planning_level 0..3 and reason are required");
        return;
      }
      const saved = await recordPlanningLevelOverride({
        projectRoot: projectRoot(),
        taskId,
        planningLevel: level as 0 | 1 | 2 | 3,
        reason,
      });
      res.json({ ok: true, ...saved, override_by: "ADMIN", override_reason: reason });
    } catch (err) {
      sendError(res, 400, "PLANNING_LEVEL_OVERRIDE_FAILED", String(err));
    }
  });

  app.get("/api/v2/pm/governance/product-gate", async (req: Request, res: Response) => {
    try {
      const taskId = String(req.query["task_id"] ?? "").trim();
      const threadKey = String(req.query["thread_key"] ?? "").trim();
      if (!taskId && !threadKey) {
        sendError(res, 400, "MISSING_INPUT", "task_id or thread_key required");
        return;
      }
      const root = projectRoot();
      const ctx = await resolveThreadContext(root, {
        task_id: taskId || undefined,
        thread_key: threadKey || undefined,
      });
      if (!ctx || !ctx.root_task_id) {
        sendError(res, 404, "THREAD_NOT_FOUND", taskId || threadKey);
        return;
      }
      const rootTask = ctx.tasks.find((task) => task.task_id === ctx.root_task_id);
      const product = await evaluateProductDeliveryGate({
        projectRoot: root,
        taskId: ctx.root_task_id,
        taskBody: ctx.root_body ?? "",
        taskFrontmatter: rootTask?.yaml,
      });
      const close = evaluatePmSummaryGate({
        thread: ctx.thread,
        tasks: ctx.tasks,
        reports: ctx.reports,
        root_task_id: ctx.root_task_id,
        root_body: ctx.root_body,
      });
      const roleState = (role: "DEV" | "QA") => {
        const tasks = ctx.tasks.filter(
          (task) => task.sender === "PM" && task.recipient.toUpperCase() === role,
        );
        if (!tasks.length) return "missing";
        const reports = ctx.reports.filter(
          (report) => report.sender.toUpperCase() === role && report.recipient.toUpperCase() === "PM",
        );
        if (!reports.length) return tasks.some((task) => task.bucket === "active") ? "running" : "waiting";
        const latest = reports.sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc))[0];
        if (role === "QA") {
          if (latest?.qa_verdict === "fail" || latest?.qa_verdict === "blocked") return "fail";
          if (latest?.qa_verdict === "pass" && latest.qa_browser_verified) return "pass";
        }
        return ["done", "completed", "pass"].includes(String(latest?.status ?? "").toLowerCase())
          ? "done"
          : "running";
      };
      res.json({
        task_id: ctx.root_task_id,
        thread_key: ctx.thread_key,
        product_task: product.classification.task_class === "product_delivery",
        planning_level: product.planning_level,
        planning_label: product.classification.planning_label,
        classification_reason: product.classification.classification_reason,
        classification_override: product.classification.override_by === "ADMIN",
        planning_status: product.planning_status,
        planning_artifact_path: product.planning_artifact_path,
        planning_artifact_revision: product.planning_artifact_revision,
        product_brief: product.product_brief_ready ? "completed" : product.planning_status,
        pm_product_skills: `${product.invoked_skills.length}/${product.required_skills.length}`,
        required_skills: product.required_skills,
        invoked_skills: product.invoked_skills,
        missing_skills: product.missing_skills,
        missing_sections: product.missing_sections,
        invalid_skill_evidence: product.invalid_skill_evidence,
        downstream_dispatch: product.dispatch_open ? "open" : "closed",
        dispatch_open: product.dispatch_open,
        next_action: product.next_action,
        dev: roleState("DEV"),
        qa: roleState("QA"),
        open_issues: product.open_issues.length,
        close_allowed: product.allowed && close.ok,
        findings: [...product.findings, ...(!close.ok ? [close.skipped_reason] : [])],
        required_action: !product.allowed ? product.next_action : close.ok ? null : "resolve_close_gate_findings",
      });
    } catch (err) {
      sendError(res, 500, "PRODUCT_GATE_FAILED", String(err));
    }
  });

  app.get("/api/v2/pm/governance/thread/:threadKey/stall", async (req: Request, res: Response) => {
    try {
      const threadKey = decodeURIComponent(String(req.params["threadKey"] ?? "")).trim();
      if (!threadKey) {
        sendError(res, 400, "MISSING_THREAD_KEY", "threadKey is required");
        return;
      }
      const root = projectRoot();
      if (!statusCheckThrottle.shouldRun(threadKey)) {
        void recordSkillInvocation(root, {
          skill_id: "pm.detect_thread_stall",
          channel: "api",
          caller_role: "PM",
          thread_key: threadKey,
          outcome: "skipped",
          summary: "状态检查节流过频",
          triggered_by: "api",
        }).catch(() => {});
        res.json({
          throttled: true,
          retry_after_ms: statusCheckThrottle.msUntilReady(threadKey),
          message: "状态检查节流过频（同 thread 30–60s 内最多一次）",
        });
        return;
      }
      const stall = await invokePmSkillWithJournal(
        root,
        {
          skill_id: "pm.detect_thread_stall",
          channel: "api",
          thread_key: threadKey,
          caller_role: "PM",
          triggered_by: "api",
        },
        () => detectThreadStall(root, threadKey),
        (s) => ({
          outcome: s ? "ok" : "failed",
          summary: s
            ? `stall=${s.is_stalled} · ${(s.findings ?? []).length} findings`
            : "thread not found",
        }),
      );
      if (!stall) {
        sendError(res, 404, "THREAD_NOT_FOUND", threadKey);
        return;
      }
      res.json(stall);
    } catch (err) {
      sendError(res, 500, "PM_STALL_FAILED", String(err));
    }
  });

  app.get("/api/v2/pm/governance/close-draft", async (req: Request, res: Response) => {
    try {
      const threadKey = String(req.query["thread_key"] ?? "").trim();
      const taskId = String(req.query["task_id"] ?? "").trim();
      const currentTaskId = String(req.query["current_task_id"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!threadKey && !taskId) {
        sendError(res, 400, "MISSING_INPUT", "thread_key or task_id required");
        return;
      }
      const root = projectRoot();
      if (currentTaskId) {
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const current = (taskRows as Array<Record<string, unknown>>).find(
          (task) =>
            String(task["task_id"] ?? "").replace(/\.md$/i, "").trim() === currentTaskId,
        );
        const currentBucket = String(
          current?.["bucket"] ?? current?.["scope"] ?? current?.["state"] ?? "",
        ).toLowerCase();
        const requestedTaskId = taskId.replace(/\.md$/i, "");
        if (
          current &&
          !["done", "archive"].includes(currentBucket) &&
          requestedTaskId &&
          requestedTaskId !== currentTaskId
        ) {
          sendError(
            res,
            409,
            "CURRENT_PM_TASK_NOT_SETTLED",
            `当前 PM 任务 ${currentTaskId} 尚未收口，不能跳过它关闭 ${requestedTaskId}；请先完成当前任务的派单、回报与汇总`,
          );
          return;
        }
      }
      const throttleKey = threadKey || taskId;
      if (!statusCheckThrottle.shouldRun(throttleKey)) {
        void recordSkillInvocation(root, {
          skill_id: "pm.close_admin_task",
          channel: "api",
          caller_role: "PM",
          ...(threadKey ? { thread_key: threadKey } : {}),
          ...(taskId ? { task_id: taskId } : {}),
          outcome: "skipped",
          summary: "状态检查节流过频",
          triggered_by: "api",
        }).catch(() => {});
        res.json({
          throttled: true,
          retry_after_ms: statusCheckThrottle.msUntilReady(throttleKey),
          message: "状态检查节流过频（同 thread/task 30–60s 内最多一次）",
        });
        return;
      }
      const draft = await invokePmSkillWithJournal(
        root,
        {
          skill_id: "pm.close_admin_task",
          channel: "api",
          caller_role: "PM",
          ...(threadKey ? { thread_key: threadKey } : {}),
          ...(taskId ? { task_id: taskId } : {}),
          triggered_by: "api",
        },
        () =>
          closeAdminTaskDraft(root, {
            thread_key: threadKey || undefined,
            task_id: taskId || undefined,
          }),
        (d) => ({
          outcome: d ? "ok" : "failed",
          summary: d
            ? `close draft · ${d.suggested_status ?? "—"}`
            : "close draft not found",
        }),
      );
      if (!draft) {
        sendError(res, 404, "CLOSE_DRAFT_NOT_FOUND", threadKey || taskId);
        return;
      }
      res.json(draft);
    } catch (err) {
      sendError(res, 500, "PM_CLOSE_DRAFT_FAILED", String(err));
    }
  });

  app.get("/api/v2/pm/governance/cycle/recent", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const limitRaw = parseInt(String(req.query["limit"] ?? "20"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
      const root = projectRoot();
      const cycles = await readRecentPmGovernanceCycles(root, Math.max(5, Math.ceil(limit / 4)));
      const decisions = flattenRecentPmGovernanceDecisions(cycles, limit);
      res.json({
        project_root: root,
        journal_path: join(root, ".codeflowmu", "pm-governance", "cycle.jsonl"),
        limit,
        count: decisions.length,
        decisions,
      });
    } catch (err) {
      sendError(res, 500, "PM_GOVERNANCE_CYCLE_RECENT_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.get("/api/v2/pm/governance/review-check", async (req: Request, res: Response) => {
    try {
      const taskId = String(req.query["task_id"] ?? "").trim();
      const reportId = String(req.query["report_id"] ?? "").trim();
      if (!taskId && !reportId) {
        sendError(res, 400, "MISSING_INPUT", "task_id or report_id required");
        return;
      }
      const root = projectRoot();
      const throttleKey = taskId || reportId;
      if (!statusCheckThrottle.shouldRun(throttleKey)) {
        void recordSkillInvocation(root, {
          skill_id: "pm.review_check",
          channel: "api",
          caller_role: "PM",
          ...(taskId ? { task_id: taskId } : {}),
          outcome: "skipped",
          summary: "状态检查节流过频",
          triggered_by: "api",
        }).catch(() => {});
        res.json({
          throttled: true,
          retry_after_ms: statusCheckThrottle.msUntilReady(throttleKey),
          message: "状态检查节流过频（同 task/report 30–60s 内最多一次）",
        });
        return;
      }
      const result = await invokePmSkillWithJournal(
        root,
        {
          skill_id: "pm.review_check",
          channel: "api",
          caller_role: "PM",
          ...(taskId ? { task_id: taskId } : {}),
          triggered_by: "api",
        },
        () =>
          reviewCheck(root, {
            task_id: taskId || undefined,
            report_id: reportId || undefined,
          }),
        (rc) => ({
          outcome: rc ? "ok" : "failed",
          summary: rc
            ? `review · ${rc.findings?.length ?? 0} findings`
            : "review check invalid",
        }),
      );
      if (!result) {
        sendError(res, 400, "REVIEW_CHECK_INVALID", "task_id or report_id required");
        return;
      }
      res.json(result);
    } catch (err) {
      sendError(res, 500, "PM_REVIEW_CHECK_FAILED", String(err));
    }
  });

  app.post("/api/v2/tasks/:taskId/fact-check-decisions", async (req: Request, res: Response) => {
    const allowed = new Set([
      "return_for_evidence",
      "confirm_fact_false",
      "accept_evidence_exception",
      "retry_fact_check",
    ]);
    try {
      const root = projectRoot();
      const taskId = String(req.params["taskId"] ?? "").replace(/\.md$/i, "").trim();
      const action = String(req.body?.action ?? "").trim();
      const reason = String(req.body?.reason ?? "").trim();
      const idempotencyKey = String(req.body?.idempotency_key ?? "").trim();
      if (!taskId || !allowed.has(action)) {
        sendError(res, 400, "FACT_CHECK_DECISION_INVALID", "task_id and a supported action are required");
        return;
      }
      if (!idempotencyKey) {
        sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required");
        return;
      }
      if (action === "accept_evidence_exception" && !reason) {
        sendError(res, 400, "FACT_CHECK_REASON_REQUIRED", "accepting an evidence exception requires a reason");
        return;
      }
      const decisionDir = join(root, ".codeflowmu", "fact-check-decisions");
      const decisionPath = join(decisionDir, `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
      if (existsSync(decisionPath)) {
        const prior = readFileSync(decisionPath, "utf-8").split(/\r?\n/).filter(Boolean).map((line) => {
          try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; }
        }).find((row) => row["idempotency_key"] === idempotencyKey);
        if (prior) { res.json({ ok: true, idempotent_replay: true, decision: prior }); return; }
      }
      const taskHit = findTaskFileByIdPrefix(root, taskId);
      if (!taskHit?.path) {
        sendError(res, 404, "TASK_NOT_FOUND", taskId);
        return;
      }
      const taskPathNorm = taskHit.path.replace(/\\/g, "/").toLowerCase();
      const stage = taskPathNorm.match(/\/fcop\/_lifecycle\/(inbox|active|review|done|archive)\//)?.[1] ?? "";
      let result: Record<string, unknown> = {};
      if (action === "return_for_evidence" || action === "confirm_fact_false") {
        if (stage === "review") {
          const lifecycle = await executeLifecycleRuntimeAction(
            "reject_review",
            {
              task_id: taskId,
              actor: "ADMIN",
              reason: reason || (action === "return_for_evidence" ? "退回补充事实核查证据" : "人工确认事实不成立"),
            },
            root,
          );
          if (!lifecycle.ok) {
            sendError(res, 409, "FACT_CHECK_TASK_STATE_CHANGED", lifecycle.error);
            return;
          }
          result = { lifecycle_action: "reject_review", lifecycle };
        } else if (stage !== "active" && stage !== "inbox") {
          sendError(res, 409, "FACT_CHECK_TASK_STATE_CHANGED", `task ${taskId} is ${stage || "unknown"}`);
          return;
        }
      } else if (action === "accept_evidence_exception") {
        const raw = readFileSync(taskHit.path, "utf-8");
        writeFileSync(taskHit.path, _wpPatchFmFields(raw, {
          pm_attention_reason: "",
          fact_check_exception: "true",
          fact_check_exception_by: "ADMIN",
          fact_check_exception_at: new Date().toISOString(),
          fact_check_exception_reason: reason.replace(/\r?\n/g, " ").slice(0, 500),
        }), "utf-8");
        result = { attention_cleared: true, high_risk_authorized: false };
      } else {
        const review = await reviewCheck(root, { task_id: taskId });
        if (!review) {
          sendError(res, 500, "FACT_CHECK_RETRY_FAILED", "review_check returned no result");
          return;
        }
        result = { review };
        if (review.ok) {
          const currentHit = findTaskFileByIdPrefix(root, taskId);
          if (currentHit?.path) {
            const raw = readFileSync(currentHit.path, "utf-8");
            writeFileSync(currentHit.path, _wpPatchFmFields(raw, { pm_attention_reason: "" }), "utf-8");
          }
        }
      }
      const decision = {
        event: `fact_check.${action}`,
        at: new Date().toISOString(),
        task_id: taskId,
        action,
        actor: "ADMIN",
        reason,
        expected_review_id: String(req.body?.expected_review_id ?? "").trim(),
        idempotency_key: idempotencyKey,
        result,
      };
      mkdirSync(decisionDir, { recursive: true });
      appendFileSync(decisionPath, `${JSON.stringify(decision)}\n`, "utf-8");
      invalidateLedgerFreshCache(root);
      sseEmit("codeflowmu.fact_check_decision", decision);
      res.json({ ok: true, decision });
    } catch (err) {
      sendError(res, 500, "FACT_CHECK_DECISION_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/v2/pm/skills/enabled", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      const manifest = await readPmSkillManifest(root);
      const skills = listPmSkillsForRole("PM");
      res.json({
        role: "PM",
        manifest_path: join(root, ".codeflowmu", "pm-skills.manifest.json"),
        manifest_version: manifest.manifest_version,
        skills: skills.map((s) => ({
          skill_id: s.skill_id,
          display_name: s.display_name,
          description: s.description,
          api: s.api,
        })),
      });
    } catch (err) {
      sendError(res, 500, "PM_SKILLS_LIST_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /** GET /api/v2/agent-skills/catalog — Agent Playbook manifest 全库（只读浏览） */
  app.get("/api/v2/agent-skills/catalog", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      const catalog = await loadAgentSkillsCatalog(root, { checkPackages: true });
      res.json(catalog);
    } catch (err) {
      if (err instanceof AgentSkillsManifestMissingError) {
        sendError(res, 404, "AGENT_SKILLS_MANIFEST_MISSING", err.message);
        return;
      }
      if (err instanceof AgentSkillsManifestInvalidError) {
        sendError(res, 422, "AGENT_SKILLS_MANIFEST_INVALID", err.message);
        return;
      }
      if (err instanceof AgentSkillsManifestReadError) {
        sendError(res, 500, "AGENT_SKILLS_MANIFEST_READ_FAILED", err.message);
        return;
      }
      sendError(res, 500, "AGENT_SKILLS_CATALOG_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * POST /api/v2/pm/governance/wake-downstream
   * Body: { task_id, role, reason?, thread_key?, agent_id?, current_task_id? }
   * 复用 doorbell wake；不写 TASK/REPORT、不动 _lifecycle。
   */
  app.post("/api/v2/pm/governance/wake-downstream", async (req: Request, res: Response) => {
    const body = req.body as {
      task_id?: string;
      role?: string;
      reason?: string;
      thread_key?: string;
      agent_id?: string;
      caller?: string;
      source?: string;
      caller_session_id?: string;
      current_task_id?: string;
    };
    const taskId = String(body.task_id ?? "").trim();
    const role = String(body.role ?? "").trim();
    if (!taskId || !role) {
      sendError(res, 400, "MISSING_PARAMS", "task_id and role are required");
      return;
    }
    const currentTaskId = String(body.current_task_id ?? "")
      .replace(/\.md$/i, "")
      .trim();
    if (currentTaskId && currentTaskId !== taskId.replace(/\.md$/i, "")) {
      const { tasks: taskRows } = await listTasksFromLedgerAuto(projectRoot());
      const byId = new Map(
        (taskRows as Array<Record<string, unknown>>).map((task) => [
          String(task["task_id"] ?? "").replace(/\.md$/i, "").trim(),
          task,
        ]),
      );
      let cursor = byId.get(taskId.replace(/\.md$/i, ""));
      const seen = new Set<string>();
      let belongsToCurrentBranch = false;
      while (cursor) {
        const cursorId = String(cursor["task_id"] ?? "").replace(/\.md$/i, "").trim();
        if (!cursorId || seen.has(cursorId)) break;
        seen.add(cursorId);
        const parentId = String(
          cursor["parent_task_id"] ?? cursor["parent"] ??
            (cursor["yaml"] as Record<string, unknown> | undefined)?.["parent"] ?? "",
        ).replace(/\.md$/i, "").trim();
        if (parentId === currentTaskId) {
          belongsToCurrentBranch = true;
          break;
        }
        cursor = parentId ? byId.get(parentId) : undefined;
      }
      if (!belongsToCurrentBranch) {
        sendError(
          res,
          409,
          "DOWNSTREAM_TASK_OUTSIDE_CURRENT_BRANCH",
          `当前任务 ${currentTaskId} 不能唤醒旧分支任务 ${taskId}；请先创建 parent=${currentTaskId} 的新下游任务，再唤醒该新任务`,
        );
        return;
      }
    }
    const plan = buildWakeDownstreamRequest({
      task_id: taskId,
      role,
      reason: body.reason,
      thread_key: body.thread_key,
      agent_id: body.agent_id,
      caller: body.caller || "PM",
      source: body.source || "pm_governance_api",
      caller_session_id: body.caller_session_id,
    });
    if (!pmWakeExecutorRef) {
      sendError(res, 503, "WAKE_EXECUTOR_UNAVAILABLE", "PM wake executor not ready");
      return;
    }
    try {
      // All callers share the same direct AI wake primitive. Task review,
      // dependency handling and lifecycle decisions belong to the AI after
      // wake, not to this endpoint.
      const result = await pmWakeExecutorRef(plan);
      const status = result.outcome === "error"
          ? 500
          : 200;
      res.status(status).json({ ok: result.ok, plan, result, reconcile: null });
    } catch (err) {
      sendError(res, 500, "WAKE_DOWNSTREAM_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/runtime/dispatch-retry
   * 无 task_id：列出全部 dispatch-retry 记录；有 task_id：返回单条（无记录时 record=null）。
   */
  app.get("/api/v2/runtime/dispatch-retry", async (req: Request, res: Response) => {
    try {
      const taskIdQuery = String(req.query["task_id"] ?? "").trim();
      if (!taskIdQuery) {
        const records = runtime.dispatcher.listDispatchRetryRecords().map((rec) =>
          serializeDispatchRetryRecord(rec as DispatchRetryRecordLike, {
            task_id: (rec as DispatchRetryRecordLike).task_id,
          }),
        );
        res.json({ records });
        return;
      }

      const resolved = await resolveDispatchRetryTarget(
        runtime,
        projectRoot(),
        taskIdQuery,
      );
      if (!resolved.ok) {
        return sendError(
          res,
          resolved.status,
          resolved.code,
          resolved.message,
        );
      }

      const raw = runtime.dispatcher.getDispatchRetryRecord(resolved.retryKey);
      res.json({
        task_id: resolved.taskId,
        retry_key: resolved.retryKey,
        record: raw
          ? serializeDispatchRetryRecord(raw as DispatchRetryRecordLike, {
              task_id: resolved.taskId,
              retry_key: resolved.retryKey,
            })
          : null,
      });
    } catch (err) {
      sendError(res, 500, "DISPATCH_RETRY_QUERY_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/runtime/dispatch-retry/admin-retry
   * ADMIN 决策：清除 waiting_admin_decision 并立即重新 dispatch。
   */
  app.post(
    "/api/v2/runtime/dispatch-retry/admin-retry",
    async (req: Request, res: Response) => {
      try {
        const taskId = String(req.body?.task_id ?? "").trim();
        const reason = String(req.body?.reason ?? "").trim() || undefined;
        const agentIdBody = String(req.body?.agent_id ?? "").trim() || undefined;
        const roleBody = String(req.body?.role ?? "").trim() || undefined;

        const resolved = await resolveDispatchRetryTarget(
          runtime,
          projectRoot(),
          taskId,
          { agent_id: agentIdBody, role: roleBody },
        );
        if (!resolved.ok) {
          return sendError(
            res,
            resolved.status,
            resolved.code,
            resolved.message,
          );
        }

        const outcome = await runtime.dispatcher.adminRetryDispatch(
          resolved.filepath,
          resolved.filename,
          resolved.recipient,
          resolved.retryKey,
        );

        res.json({
          ok: outcome.kind === "dispatched",
          task_id: resolved.taskId,
          retry_key: resolved.retryKey,
          reason,
          outcome,
        });
        appendPanelRuntimeAction(projectRoot(), {
          operator: String(req.body?.operator_role ?? "ADMIN"),
          action: "dispatch_retry",
          target_task: resolved.taskId,
          target_agent: resolved.recipient,
          result: outcome.kind === "dispatched" ? "ok" : "skipped",
          reason:
            outcome.kind === "dispatched"
              ? undefined
              : String(outcome.kind ?? "dispatch_skipped"),
        });
      } catch (err) {
        sendError(res, 500, "DISPATCH_ADMIN_RETRY_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/runtime/dispatch-retry/force-archive
   * ADMIN 决策：强制归档，停止一切自动 dispatch 重试。
   */
  app.post(
    "/api/v2/runtime/dispatch-retry/force-archive",
    async (req: Request, res: Response) => {
      try {
        const taskId = String(req.body?.task_id ?? "").trim();
        const reason = String(req.body?.reason ?? "").trim() || undefined;
        const agentIdBody = String(req.body?.agent_id ?? "").trim() || undefined;
        const roleBody = String(req.body?.role ?? "").trim() || undefined;

        const resolved = await resolveDispatchRetryTarget(
          runtime,
          projectRoot(),
          taskId,
          { agent_id: agentIdBody, role: roleBody },
        );
        if (!resolved.ok) {
          return sendError(
            res,
            resolved.status,
            resolved.code,
            resolved.message,
          );
        }

        await runtime.dispatcher.adminForceArchiveDispatch(
          resolved.filepath,
          resolved.retryKey,
        );

        void ensureLedgerFresh(projectRoot(), { rebuild: true, force: true }).catch(
          (err: unknown) => {
            console.warn(
              `[web-panel] ledger refresh after force-archive: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );

        res.json({
          ok: true,
          task_id: resolved.taskId,
          retry_key: resolved.retryKey,
          reason,
        });
        appendPanelRuntimeAction(projectRoot(), {
          operator: String(req.body?.operator_role ?? "ADMIN"),
          action: "force_archive",
          target_task: resolved.taskId,
          target_agent: agentIdBody || roleBody || undefined,
          result: "ok",
          reason: reason ?? "dispatch force archive",
        });
      } catch (err) {
        sendError(res, 500, "DISPATCH_FORCE_ARCHIVE_FAILED", String(err));
      }
    },
  );

  app.get("/api/v2/skills/invocations/recent", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const limitRaw = parseInt(String(req.query["limit"] ?? "50"), 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 50;
      const root = projectRoot();
      const raw = await readRecentSkillInvocations(root, limit);
      const invocations = await enrichSkillInvocationsForDisplay(root, raw);
      res.json({
        project_root: root,
        journal_path: skillInvocationJournalPath(root),
        limit,
        count: invocations.length,
        invocations,
      });
    } catch (err) {
      sendError(res, 500, "SKILL_INVOCATIONS_RECENT_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.get("/api/v2/tasks/stats", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const root = projectRoot();
      res.json(buildTaskStats(root));
    } catch (err) {
      sendError(res, 500, "TASK_STATS_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * GET /api/v2/tasks/:taskId/report-scope
   * Dual-scope report aggregation: direct_reports vs thread_reports.
   */
  app.get("/api/v2/tasks/:taskId/report-scope", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        sendError(res, 400, "MISSING_TASK_ID", "taskId required");
        return;
      }
      const root = projectRoot();
      const scopes = await readTaskReportScopes(root, taskId);
      res.json({
        ok: true,
        task_id: scopes.task_id,
        direct_count: scopes.direct_count,
        thread_count: scopes.thread_count,
        direct_reports: scopes.direct_reports.map((r) => ({
          report_id: r.report_id,
          filename: r.filename,
          sender: r.sender,
          recipient: r.recipient,
          status: r.status,
        })),
        thread_reports: scopes.thread_reports.map((r) => ({
          report_id: r.report_id,
          filename: r.filename,
          sender: r.sender,
          recipient: r.recipient,
          status: r.status,
        })),
      });
    } catch (err) {
      sendError(res, 500, "TASK_REPORT_SCOPE_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  app.get("/api/v2/tasks", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
      const senderFilter = (req.query["sender"] as string) ?? "";
      const recipientFilter = (req.query["recipient"] as string) ?? "";
      const sourceRaw = String(req.query["source"] ?? "ledger").toLowerCase();
      // `auto` kept as alias for ledger-only (no filesystem fallback).
      const source = sourceRaw === "auto" ? "ledger" : sourceRaw;
      const includeHistory =
        req.query["includeHistory"] === "1" ||
        req.query["includeHistory"] === "true";

      const root = projectRoot();
      const maybeMergeHistory = (rows: Record<string, unknown>[]) =>
        includeHistory
          ? _wpMergeHistoryOnlyTasks(
              rows,
              root,
              senderFilter,
              recipientFilter,
            )
          : rows;
      const v3 = fcopV3Paths(root);
      const legacySearchDirs = [
        runtime.watcher.dir,
        ...(opts.adminTasksDir ? [opts.adminTasksDir] : []),
      ];

      const scanFilesystemTasks = (): Record<string, unknown>[] => {
      // Legacy scan: runtime watcher inbox only — never fcop/_lifecycle (ledger truth).
      const taskDirs: Array<{ dir: string; scope: string }> = [
        { dir: runtime.watcher.dir, scope: "legacy-inbox" },
        ...(opts.adminTasksDir && opts.adminTasksDir !== runtime.watcher.dir
          ? [{ dir: opts.adminTasksDir, scope: "admin" as const }]
          : []),
      ];

      const seen = new Set<string>();
      const allTasks: Record<string, unknown>[] = [];

      for (const { dir, scope } of taskDirs) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".md") && f.startsWith("TASK-"))
          .sort()
          .reverse();
        for (const f of files) {
          if (seen.has(f)) continue;
          seen.add(f);
          try {
            const fullPath = join(dir, f);
            const raw = readFileSync(fullPath, "utf-8");
            const fileStat = statSync(fullPath);
            const match = raw.match(/^---\n([\s\S]*?)\n---/);
            const fm: Record<string, string> = {};
            if (match?.[1]) {
              for (const line of match[1].split("\n")) {
                const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
                if (kv) fm[kv[1]!] = kv[2]!.trim();
              }
            }
            if (senderFilter && fm["sender"]?.toUpperCase() !== senderFilter.toUpperCase()) continue;
            if (recipientFilter && fm["recipient"]?.toUpperCase() !== recipientFilter.toUpperCase()) continue;
            const { subject, preview } = _wpExtractDocDisplay(raw, f);
            // Derive state_history from trailing YAML
            const stateMatch = raw.match(/\n---\s*state_history([\s\S]*)$/);
            const lastState = stateMatch ? "dispatched" : "inbox";
            allTasks.push({
              filename: f,
              scope,
              mtime: fileStat.mtime.toISOString(),
              _state: lastState,
              _source: "legacy",
              ledger_scope: "legacy-inbox",
              ...fm,
              subject,
              preview,
            });
          } catch {
            allTasks.push({
              filename: f,
              scope,
              error: "parse_failed",
              _source: "legacy",
            });
          }
        }
      }

        return allTasks;
      };

      if (source === "legacy") {
        const legacyTasks = await _wpMergeAgentDispatchStatus(
          _wpEnrichTasksFromDisk(
            maybeMergeHistory(scanFilesystemTasks()),
            root,
            v3,
            legacySearchDirs,
          ),
          root,
        ).then((rows) => rows.slice(0, limit));
        res.json({
          tasks: legacyTasks,
          _meta: {
            source: "legacy-only",
            note:
              "Explicit legacy filesystem scan; not the lifecycle truth source. Use migration tools to reconcile into fcop/_lifecycle + ledger.",
          },
        });
        return;
      }

      if (source !== "ledger") {
        sendError(
          res,
          400,
          "INVALID_SOURCE",
          `Unknown source=${sourceRaw}; use ledger (default) or legacy`,
        );
        return;
      }

      const { tasks: ledgerTasks, source: ledgerSource, diagnostics } =
        await listTasksFromLedgerAuto(root, {
          sender: senderFilter || undefined,
          recipient: recipientFilter || undefined,
          limit,
        });
      const enrichTasks = async (rows: Record<string, unknown>[]) =>
        _wpMergeAgentDispatchStatus(
          _wpEnrichTasksFromDisk(rows, root, v3, legacySearchDirs),
          root,
        );

      const enriched = (await enrichTasks(maybeMergeHistory(ledgerTasks))).slice(
        0,
        limit,
      );
      const listWarnings: string[] = [];
      const summarizedTasks = enriched.map((row) => {
        const { task, warnings } = wpSummarizeTaskTransitionsForList(row);
        listWarnings.push(...warnings);
        const fmWarn = String(task._frontmatter_warning ?? "").trim();
        if (fmWarn) {
          listWarnings.push(
            `task_frontmatter_warning:${String(task.task_id ?? task.filename ?? "unknown")}:${fmWarn}`,
          );
        }
        return task;
      });
      const tasksWithReviewAttention = enrichTasksWithReviewAttention(
        root,
        summarizedTasks,
      );
      res.json({
        tasks: tasksWithReviewAttention,
        _meta: {
          source: ledgerSource === "ledger" ? "ledger" : "empty",
          diagnostics,
          ...(listWarnings.length > 0
            ? { transition_warnings: listWarnings.slice(0, 50) }
            : {}),
        },
      });
    } catch (err) {
      sendError(res, 500, "TASKS_LIST_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * GET /api/v2/tasks/resolve-path?filename=TASK-*.md&path=<hint>
   * Locates TASK file on disk across lifecycle dirs (inbox → archive → fcop/tasks).
   */
  app.get("/api/v2/tasks/resolve-path", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const filename = String(req.query["filename"] ?? "").trim();
      if (!filename.endsWith(".md") || !filename.startsWith("TASK-")) {
        sendError(res, 400, "INVALID_FILENAME", "filename must be TASK-*.md");
        return;
      }
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const pathHint = String(req.query["path"] ?? "");
      const taskIdHint = String(req.query["task_id"] ?? "").trim();
      const extraDirs = [
        runtime.watcher.dir,
        ...(opts.adminTasksDir ? [opts.adminTasksDir] : []),
      ];
      const fp = _wpResolveTaskFilePath(
        root,
        v3,
        filename,
        pathHint,
        extraDirs,
        taskIdHint,
      );
      if (!fp) {
        sendError(res, 404, "TASK_NOT_FOUND", filename);
        return;
      }
      const relPath = path.relative(root, fp).replace(/\\/g, "/");
      const diskBucket = stageFromPath(fp, v3.lifecycleRoot);
      res.json({
        filename,
        path: relPath,
        absolute_path: fp.replace(/\\/g, "/"),
        physical_scope: diskBucket ?? "",
        client_hint: resolveTaskRelPath({
          filename,
          path: pathHint || relPath,
          physical_scope: diskBucket ?? undefined,
        }),
      });
    } catch (err) {
      sendError(res, 500, "RESOLVE_PATH_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * GET /api/v2/reviews — list reviews from reviewWriter.reviewsDir.
   * Query: ?limit=N (default 50).
   */
  app.get("/api/v2/reviews", async (req: Request, res: Response) => {
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const reviewsDir = runtime.reviewWriter.reviewsDir;
      if (!existsSync(reviewsDir)) {
        res.json([]);
        return;
      }
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const files = readdirSync(reviewsDir)
        .filter((f) => f.endsWith(".md") && f.startsWith("REVIEW-"))
        .slice(-limit);
      const reviews = files.map((f) => {
        try {
          const raw = readFileSync(join(reviewsDir, f), "utf-8");
          const match = raw.match(/^---\n([\s\S]*?)\n---/);
          const frontmatter: Record<string, string> = {};
          if (match?.[1]) {
            for (const line of match[1].split("\n")) {
              const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
              if (kv) frontmatter[kv[1]!] = kv[2]!.trim();
            }
          }
          return { filename: f, ...frontmatter };
        } catch {
          return { filename: f, error: "parse_failed" };
        }
      });
      res.json(reviews);
    } catch (err) {
      sendError(res, 500, "REVIEWS_LIST_FAILED", String(err));
    }
  });

  /** GET /api/v2/sessions/current — current runtime session metadata */
  app.get("/api/v2/sessions/current", async (_req: Request, res: Response) => {
    try {
      // SessionStore doesn't expose a list() — use SessionManager.listActive()
      const active = await runtime.sessionManager.listActive();
      res.json({
        active_count: active.length,
        sessions: active.slice(0, 10),
        pid: process.pid,
        uptime_s: Math.floor(process.uptime()),
      });
    } catch (err) {
      sendError(res, 500, "SESSIONS_FAILED", String(err));
    }
  });

  /** POST /api/v2/config/reload — hot-reload runtime config (stub for v1.0) */
  app.post("/api/v2/config/reload", (_req: Request, res: Response) => {
    res.json({ ok: true, message: "Config reload acknowledged (v1.0 stub — full hot-reload in v1.1)" });
  });

  /**
   * GET /api/v2/team — read codeflowmu.team.json from project root.
   */
  app.get("/api/v2/team", async (_req: Request, res: Response) => {
    try {
      const { readFileSync } = await import("node:fs");
      const projectRoot = resolveProjectRoot();
      const teamPath = join(projectRoot, "codeflowmu.team.json");
      if (!existsSync(teamPath)) { res.json({}); return; }
      res.json(JSON.parse(readFileSync(teamPath, "utf-8")));
    } catch (err) {
      sendError(res, 500, "TEAM_READ_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/team/review-decision-policy — load team review decision policy.
   */
  app.get("/api/v2/team/review-decision-policy", async (_req: Request, res: Response) => {
    try {
      const projectRoot = resolveProjectRoot();
      const policy = await loadReviewDecisionPolicy({
        projectRoot,
        initializeIfMissing: true,
      });
      res.json(policy);
    } catch (err) {
      sendError(res, 500, "POLICY_LOAD_FAILED", String(err));
    }
  });

  type ReviewPolicyUpdates = Parameters<typeof saveReviewDecisionPolicy>[0]["updates"];
  async function buildReviewPolicyApprovalInput(
    root: string,
    updates: ReviewPolicyUpdates,
  ): Promise<Parameters<OperationApprovalService["prepare"]>[0]> {
    const current = await loadReviewDecisionPolicy({ projectRoot: root, initializeIfMissing: false });
    return {
      request: {
        subject: { actor: "PANEL-REQUEST", role: "AGENT", project_id: activeProjectId || "active-project" },
        action: { capability: "runtime.governance.policy.write", operation: "save_review_decision_policy", executor: "review.policy.save" },
        resource: { type: "governance_policy", targets: ["fcop/shared/policies/review-decision-policy.yaml"], scope: { updates } },
        context: { workspace: root, environment: "runtime_governance", initiated_by: "agent", authorization_source: "none", human_confirmation_id: null },
        effect: { governance_change: true },
        snapshot: { current_policy: current, proposed_updates: updates },
      },
      reason: "修改 REVIEW 决策策略及未来任务治理边界",
      effects: ["新的 REVIEW 规则将影响后续任务验收与人工处置条件"],
      non_effects: ["不会改写既有 REVIEW 历史", "不会自动批准任何操作审批"],
      recovery: "可通过后续受审批的策略变更恢复；本次不会修改历史记录",
    };
  }

  /**
   * POST /api/v2/team/review-decision-policy — update team review decision policy.
   * Body: { team_name?, team_type?, approval_mode?, team_rules?: { id, enabled }[] }
   */
  app.post("/api/v2/team/review-decision-policy", async (req: Request, res: Response) => {
    try {
      const projectRoot = resolveProjectRoot();
      const body = req.body || {};
      const updates: ReviewPolicyUpdates = {
        team_name: body.team_name,
        team_type: body.team_type,
        approval_mode: body.approval_mode,
        team_rules: body.team_rules,
      };
      const prepared = operationApprovalService().prepare(await buildReviewPolicyApprovalInput(projectRoot, updates));
      res.status(202).json({ ok: true, ...prepared });
    } catch (err) {
      sendOperationApprovalError(res, err);
    }
  });

  /**
   * PATCH /api/v2/team/:agentId/model — update a single agent's model in codeflowmu.team.json.
   * Body: { model_id: string }
   */
  app.patch("/api/v2/team/:agentId/model", async (req: Request, res: Response) => {
    try {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const projectRoot = resolveProjectRoot();
      const teamPath = join(projectRoot, "codeflowmu.team.json");
      if (!existsSync(teamPath)) { sendError(res, 404, "TEAM_NOT_FOUND", "codeflowmu.team.json not found"); return; }
      const agentId = req.params["agentId"];
      if (typeof agentId !== "string") { sendError(res, 400, "MISSING_AGENT_ID", "agentId is required"); return; }
      const { model_id } = req.body as { model_id?: string };
      if (!model_id) { sendError(res, 400, "MISSING_MODEL_ID", "model_id is required"); return; }
      const team = JSON.parse(readFileSync(teamPath, "utf-8"));
      const member = (team.members as { agent_id: string; model?: { id: string } }[])
        .find((m) => m.agent_id === agentId);
      if (!member) { sendError(res, 404, "AGENT_NOT_FOUND", `Agent ${agentId} not in team config`); return; }
      member.model = { id: model_id };
      writeFileSync(teamPath, JSON.stringify(team, null, 2), "utf-8");
      await runtime.registry.updateModel(agentId, model_id);
      try {
        const rec = await runtime.registry.get(agentId);
        analyticsLedger?.noteAgentRecord(
          agentId,
          rec?.protocol.role ?? "unknown",
          model_id,
        );
      } catch {
        analyticsLedger?.noteAgentRecord(agentId, "unknown", model_id);
      }
      sseEmit("codeflowmu.team_updated", { agent_id: agentId, model_id });
      res.json({ ok: true, agent_id: agentId, model_id });
    } catch (err) {
      sendError(res, 500, "TEAM_UPDATE_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/reports — list REPORT-*.md files from fcopReportsDir.
   * Query: ?limit=N (default 50).
   */
  app.get("/api/v2/reports", async (req: Request, res: Response) => {
    const label = panelApiPathLabel(req);
    const t0 = performance.now();
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const limit = Math.min(Number(req.query["limit"] ?? 50), 500);
      const sourceRaw = String(req.query["source"] ?? "ledger").toLowerCase();
      const source = sourceRaw === "auto" ? "ledger" : sourceRaw;
      const root = projectRoot();

      const scanFilesystemReports = (): Record<string, unknown>[] => {
        const reportsDir = opts.fcopReportsDir;
        if (!reportsDir || !existsSync(reportsDir)) {
          return [];
        }
        const files = readdirSync(reportsDir)
          .filter(
            (f) =>
              (f.startsWith("REPORT-") && isCanonicalReportMarkdownFilename(f)) ||
              (f.startsWith("MANUAL-") && f.endsWith(".md")),
          )
          .filter((f) => isTeamVisibleReportFilename(f))
          .sort()
          .slice(-limit);
        const reports = files.map((f) => {
          try {
            const raw = readFileSync(join(reportsDir, f), "utf-8");
            const frontmatter = _wpParseFmYaml(raw);
            const { subject, preview } = _wpExtractDocDisplay(raw, f);
            const linked_task_ids = _wpLinkedTaskIds(raw);
            return { filename: f, ...frontmatter, subject, preview, linked_task_ids, _source: "filesystem" };
          } catch {
            return { filename: f, error: "parse_failed" };
          }
        });
        return reports.reverse();
      };

      if (source === "legacy") {
        res.json({
          reports: _wpEnrichReportsFromDisk(scanFilesystemReports(), opts.fcopReportsDir),
          _meta: {
            source: "legacy-only",
            note:
              "Explicit legacy filesystem scan; not the ledger truth source.",
          },
        });
        return;
      }

      if (source !== "ledger") {
        sendError(
          res,
          400,
          "INVALID_SOURCE",
          `Unknown source=${sourceRaw}; use ledger (default) or legacy`,
        );
        return;
      }

      const { reports: ledgerReports, source: ledgerSource } =
        await listReportsFromLedgerAuto(root, { limit });
      res.json({
        reports: _wpEnrichReportsFromDisk(ledgerReports, opts.fcopReportsDir),
        _meta: { source: ledgerSource === "ledger" ? "ledger" : "empty" },
      });
    } catch (err) {
      sendError(res, 500, "REPORTS_LIST_FAILED", String(err));
    } finally {
      logPanelApiTiming(label, t0, { projectRoot: projectRoot() });
    }
  });

  /**
   * GET /api/v2/reports/done-seqs — lightweight list of ALL report sequence IDs.
   * Returns { seqs: ["20260514-960", "20260514-884", ...] } — no file content,
   * just the YYYYMMDD-NNN sequences extracted from REPORT-* filenames.
   * Used by the frontend to accurately determine task done/todo status without
   * being limited by the report page size.
   */
  app.get("/api/v2/reports/done-seqs", (_req: Request, res: Response) => {
    try {
      const reportsDir = opts.fcopReportsDir;
      if (!reportsDir || !existsSync(reportsDir)) { res.json({ seqs: [] }); return; }
      const seqs = readdirSync(reportsDir)
        .filter((f) => isCanonicalReportMarkdownFilename(f))
        .filter((f) => isTeamVisibleReportFilename(f))
        .map((f) => { const m = f.match(/REPORT-(\d{8}-\d{3})/); return m?.[1] ?? null; })
        .filter((s): s is string => s !== null);
      res.json({ seqs });
    } catch (err) {
      sendError(res, 500, "DONE_SEQS_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/issues — list ISSUE-*.md from fcop/issues/ (default open-only).
   * Query: ?status=open|closed|all&limit=N (default 100, max 500).
   */
  app.get("/api/v2/issues", (req: Request, res: Response) => {
    try {
      const root = projectRoot();
      const issuesDir = join(root, "fcop", "issues");
      const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
      const status = String(req.query["status"] ?? "open").toLowerCase();
      const issues = _wpScanIssueFiles(issuesDir, { status, limit, projectRoot: root });
      res.json({ issues, _meta: { status, count: issues.length } });
    } catch (err) {
      sendError(res, 500, "ISSUES_LIST_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/issues/:filename — read one issue (body included).
   */
  app.get("/api/v2/issues/:filename", (req: Request, res: Response) => {
    try {
      const filename = String(req.params["filename"] ?? "").trim();
      if (!/^ISSUE-\d{8}-\d{3}-.+\.md$/i.test(filename)) {
        sendError(res, 400, "INVALID_ISSUE_FILENAME", "Expected ISSUE-YYYYMMDD-NNN-*.md");
        return;
      }
      const root = projectRoot();
      const abs = join(root, "fcop", "issues", filename);
      if (!existsSync(abs)) {
        sendError(res, 404, "ISSUE_NOT_FOUND", filename);
        return;
      }
      const raw = readFileSync(abs, "utf-8");
      const fm = _wpParseFmYaml(raw);
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      const enrichment = enrichIssueMetadata(root, fm, body);
      res.json({ filename, ...fm, ...enrichment, body, open: _wpIssueStatusOpen(fm) });
    } catch (err) {
      sendError(res, 500, "ISSUE_READ_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/issues/:filename/close — mark issue closed (frontmatter only, ADR-0004).
   * Body: { closed_by?: string, resolution?: string }
   */
  app.post("/api/v2/issues/:filename/close", (req: Request, res: Response) => {
    try {
      const filename = String(req.params["filename"] ?? "").trim();
      if (!/^ISSUE-\d{8}-\d{3}-.+\.md$/i.test(filename)) {
        sendError(res, 400, "INVALID_ISSUE_FILENAME", "Expected ISSUE-YYYYMMDD-NNN-*.md");
        return;
      }
      const root = projectRoot();
      const abs = join(root, "fcop", "issues", filename);
      if (!existsSync(abs)) {
        sendError(res, 404, "ISSUE_NOT_FOUND", filename);
        return;
      }
      const raw = readFileSync(abs, "utf-8");
      const fm = _wpParseFmYaml(raw);
      if (!_wpIssueStatusOpen(fm)) {
        res.json({ ok: true, filename, already_closed: true });
        return;
      }
      const body = (req.body as Record<string, unknown>) ?? {};
      const closedBy = String(body.closed_by ?? body.operator ?? "ADMIN").trim() || "ADMIN";
      const resolution = String(body.resolution ?? "").trim();
      const closedAt = new Date().toISOString();
      const fields: Record<string, string> = {
        status: "closed",
        closed_at: `'${closedAt}'`,
        closed_by: closedBy,
      };
      if (resolution) fields.resolution = resolution.replace(/\n/g, " ").slice(0, 200);
      const updated = _wpPatchFmFields(raw, fields);
      writeFileSync(abs, updated, "utf-8");
      res.json({ ok: true, filename, status: "closed", closed_at: closedAt, closed_by: closedBy });
    } catch (err) {
      sendError(res, 500, "ISSUE_CLOSE_FAILED", String(err));
    }
  });

  function operationApprovalService(): OperationApprovalService {
    return new OperationApprovalService({ projectRoot: projectRoot() });
  }

  function operationApprovalPanelRow(row: ReturnType<OperationApprovalService["get"]>): Record<string, unknown> {
    return {
      ...row,
      id: row.approval_id,
      filename: row.approval_id,
      created_at: row.requested_at,
      sender: row.requested_by,
      risk: row.primary_kind === "external_write" ? "high" : "irreversible",
      requested_action: row.request.action.operation,
      target_task: row.task_id ?? `project:${row.project_id}`,
      summary: row.effects.join("；"),
      trigger_reason: row.reason,
      admin_question: `是否${row.reason}？`,
      can_approve: row.status === "pending_approval",
      gate_status: row.status === "pending_approval" ? "valid" : row.status,
    };
  }

  function sendOperationApprovalError(res: Response, error: unknown): void {
    if (error instanceof OperationApprovalError) {
      sendError(res, error.httpStatus, error.code, error.message);
      return;
    }
    sendError(res, 500, "OPERATION_APPROVAL_FAILED", error instanceof Error ? error.message : String(error));
  }

  /** GET /api/v2/approvals — compatibility projection of real pre-action approvals only. */
  app.get("/api/v2/approvals", async (req: Request, res: Response) => {
    try {
      const taskId = String(req.query["task_id"] ?? "").trim();
      const pending = operationApprovalService().list({ status: "pending_approval", limit: 1000 })
        .filter((row) => !taskId || row.task_id === taskId)
        .map(operationApprovalPanelRow);
      res.json(pending);
    } catch (err) {
      sendOperationApprovalError(res, err);
    }
  });

  /**
   * GET /api/v2/approvals/history — settled approval outcomes from ledger (one row per task_id).
   * Query: ?limit=N (default 50), ?decision=approved|rejected (filters history only; stats stay full)
   */
  app.get("/api/v2/approvals/history", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number((req.query["limit"] as string) ?? 50), 200);
      const rows = operationApprovalService().list({ limit: 1000 }).filter((row) => row.status !== "pending_approval");
      const approved = rows.filter((row) => ["approved", "executing", "succeeded", "partial_failed", "failed"].includes(row.status)).length;
      const rejected = rows.filter((row) => row.status === "rejected").length;
      const history = rows.slice(0, limit).map((row) => ({
        id: row.approval_id,
        filename: row.approval_id,
        time: row.decision?.at ?? row.updated_at,
        summary: row.effects.join("；"),
        sender: row.requested_by,
        risk: row.primary_kind === "external_write" ? "high" : "irreversible",
        decision: row.status === "rejected" ? "reject" : row.status === "cancelled" || row.status === "expired" || row.status === "stale" ? "pending" : "approve",
        status: row.status,
        primary_kind: row.primary_kind,
      }));
      res.json({ stats: { total: rows.length, approved, rejected }, total: rows.length, history, _meta: { source: "operation_approval" } });
    } catch (err) {
      sendOperationApprovalError(res, err);
    }
  });

  /**
   * POST /api/v2/approvals/:filename/ack — approve or reject a review.
   * Body: { decision: "approve" | "reject", comment?: string }
   * Writes human_approval block into the REVIEW file front-matter.
   */
  app.post("/api/v2/approvals/:filename/ack", async (req: Request, res: Response) => {
    sendError(res, 410, "REVIEW_ACK_RETIRED", "REVIEW acknowledgement is not an operation approval; use task REVIEW actions instead");
  });

  app.get("/api/v2/operation-approvals", (req: Request, res: Response) => {
    try {
      const status = String(req.query["status"] ?? "").trim() as OperationApprovalStatus;
      res.json(operationApprovalService().list({ ...(status ? { status } : {}), limit: Number(req.query["limit"] ?? 200) }));
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.post("/api/v2/operation-approvals/prepare", async (req: Request, res: Response) => {
    try {
      const executor = String(req.body?.executor ?? "").trim();
      if (executor !== "git.push") {
        sendError(res, 400, "EXECUTOR_NOT_REGISTERED", "prepare currently accepts only the controlled git.push executor");
        return;
      }
      const cwd = resolveGitRoot();
      const branch = String(req.body?.input?.branch ?? await wpReadGitBranch(cwd)).trim();
      const subject: CapabilityRequest["subject"] = {
        actor: String(req.body?.subject?.actor ?? "PANEL-REQUEST").trim() || "PANEL-REQUEST",
        role: String(req.body?.subject?.role ?? "AGENT").trim() || "AGENT",
        project_id: activeProjectId || "active-project",
        ...(req.body?.subject?.agent_id ? { agent_id: String(req.body.subject.agent_id) } : {}),
        ...(req.body?.subject?.session_id ? { session_id: String(req.body.subject.session_id) } : {}),
        ...(req.body?.subject?.task_id ? { task_id: String(req.body.subject.task_id) } : {}),
      };
      const prepared = operationApprovalService().prepare(await buildGitPushApprovalInput({ cwd, branch, subject }));
      res.status(prepared.decision === "REQUIRE_APPROVAL" ? 202 : 200).json({ ok: true, ...prepared });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.get("/api/v2/operation-approvals/:approvalId", (req: Request, res: Response) => {
    try { res.json(operationApprovalService().get(String(req.params["approvalId"] ?? ""))); }
    catch (err) { sendOperationApprovalError(res, err); }
  });

  app.get("/api/v2/operation-approvals/:approvalId/evidence", (req: Request, res: Response) => {
    try {
      const row = operationApprovalService().get(String(req.params["approvalId"] ?? ""));
      res.json({ approval_id: row.approval_id, operation_digest: row.operation_digest, execution: row.execution });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.post("/api/v2/operation-approvals/:approvalId/approve", async (req: Request, res: Response) => {
    try {
      const service = operationApprovalService();
      const id = String(req.params["approvalId"] ?? "");
      const reason = String(req.body?.reason ?? "").trim();
      const row = service.get(id);
      if (!(await confirmOperationDecisionNative(row, "approve", reason))) {
        sendError(res, 409, "HUMAN_CONFIRMATION_CANCELLED", "ADMIN cancelled the native confirmation");
        return;
      }
      res.json({ ok: true, ...service.approve(id, "ADMIN", reason) });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.post("/api/v2/operation-approvals/:approvalId/reject", async (req: Request, res: Response) => {
    try {
      const service = operationApprovalService();
      const id = String(req.params["approvalId"] ?? "");
      const reason = String(req.body?.reason ?? "").trim();
      const row = service.get(id);
      if (!(await confirmOperationDecisionNative(row, "reject", reason))) {
        sendError(res, 409, "HUMAN_CONFIRMATION_CANCELLED", "ADMIN cancelled the native confirmation");
        return;
      }
      res.json({ ok: true, approval: service.reject(id, "ADMIN", reason) });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.post("/api/v2/operation-approvals/:approvalId/cancel", (req: Request, res: Response) => {
    try {
      const service = operationApprovalService();
      const id = String(req.params["approvalId"] ?? "");
      const row = service.get(id);
      res.json({ ok: true, approval: service.cancel(id, row.requested_by, String(req.body?.reason ?? "")) });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  app.post("/api/v2/operation-approvals/:approvalId/execute", async (req: Request, res: Response) => {
    try {
      const service = operationApprovalService();
      const id = String(req.params["approvalId"] ?? "");
      const token = String(req.body?.execution_token ?? "");
      const row = service.get(id);
      if (row.request.action.executor !== "git.push" && row.request.action.executor !== "review.policy.save") {
        sendError(res, 501, "EXECUTOR_NOT_REGISTERED", `executor ${row.request.action.executor} is not registered`);
        return;
      }
      const scope = row.request.resource.scope ?? {};
      let completed;
      if (row.request.action.executor === "git.push") {
        const current = await buildGitPushApprovalInput({
          cwd: String(scope["cwd"] ?? ""),
          branch: String(scope["branch"] ?? ""),
          subject: row.request.subject,
        });
        completed = await service.execute(id, token, current.request, executeGitPushApproval);
      } else {
        const updates = (scope["updates"] ?? {}) as ReviewPolicyUpdates;
        const current = await buildReviewPolicyApprovalInput(projectRoot(), updates);
        completed = await service.execute(id, token, current.request, async () => {
          const policy = await saveReviewDecisionPolicy({ projectRoot: projectRoot(), updates });
          return { evidence: [{ executor: "review.policy.save", policy }] };
        });
      }
      res.status(completed.status === "failed" ? 500 : 200).json({ ok: completed.status === "succeeded", approval: completed });
    } catch (err) { sendOperationApprovalError(res, err); }
  });

  /**
   * POST /api/v2/reviews/:filename/approve
   * POST /api/v2/reviews/:filename/reject
   * Sprint-C: append Markdown audit block and move file to approved/rejected subdir.
   */
  async function handleReviewDecision(
    req: Request,
    res: Response,
    action: "approved" | "rejected"
  ): Promise<void> {
    try {
      const reviewsDir = opts.fcopReviewsDir;
      if (!reviewsDir) {
        sendError(res, 503, "REVIEWS_DIR_NOT_CONFIGURED", "fcopReviewsDir not configured");
        return;
      }
      const filename = String(req.params["filename"] ?? "");
      if (!filename || filename.includes("..") || filename.includes("/")) {
        sendError(res, 400, "INVALID_FILENAME", "invalid filename");
        return;
      }
      const srcPath = join(reviewsDir, filename);
      if (!existsSync(srcPath)) {
        sendError(res, 404, "FILE_NOT_FOUND", "file not found");
        return;
      }
      const now = new Date().toISOString();
      const resultLabel = action === "approved" ? "**批准**" : "**拒绝**";
      const auditBlock = `\n\n## 人工审批记录\n- 结果：${resultLabel}\n- 时间：${now}\n- 操作人：ADMIN\n`;
      const { readFileSync, writeFileSync, mkdirSync, renameSync } = await import("node:fs");
      const raw = readFileSync(srcPath, "utf-8");
      const reviewFm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
      const taskId = String(reviewFm["task_id"] ?? "").trim();
      if (!taskId) {
        sendError(res, 409, "REVIEW_TASK_MISSING", "review has no linked task_id");
        return;
      }
      const taskHit = findTaskFileByIdPrefix(projectRoot(), taskId);
      if (!taskHit?.path) {
        sendError(res, 409, "REVIEW_TASK_NOT_FOUND", taskId);
        return;
      }
      const taskPathNorm = taskHit.path.replace(/\\/g, "/").toLowerCase();
      const taskStage = taskPathNorm.match(/\/fcop\/_lifecycle\/(inbox|active|review|done|archive)\//)?.[1] ?? "";
      if (taskStage === "archive" || (taskStage === "done" && action === "approved")) {
        const obsolete = _wpPatchFmFields(raw, {
          resolution_status: "obsolete",
          resolved_at: now,
          resolution_reason: "task_already_completed",
        });
        writeFileSync(srcPath, obsolete + auditBlock, "utf-8");
        const obsoleteDir = join(reviewsDir, "obsolete");
        mkdirSync(obsoleteDir, { recursive: true });
        renameSync(srcPath, join(obsoleteDir, filename));
        res.json({ ok: true, action: "obsolete", filename, task_id: taskId });
        return;
      }

      const taskRaw = readFileSync(taskHit.path, "utf-8");
      const taskFm = parseMarkdownFrontmatter(taskRaw) as Record<string, unknown>;
      if (action === "approved") {
        if (taskStage !== "review") {
          sendError(res, 409, "REVIEW_TASK_STATE_CHANGED", `task ${taskId} is ${taskStage || "unknown"}`);
          return;
        }
        const lifecycleResult = await executeLifecycleRuntimeAction(
          "approve_review",
          { task_id: taskId, actor: "ADMIN", note: "ADMIN accepted review risk" },
          projectRoot(),
        );
        if (!lifecycleResult.ok) {
          sendError(res, 409, "REVIEW_TASK_STATE_CHANGED", lifecycleResult.error);
          return;
        }
      } else {
        const reason = String((req.body as Record<string, unknown>)?.reason ?? "ADMIN rejected review").trim();
        if (taskStage === "review") {
          const lifecycleResult = await executeLifecycleRuntimeAction(
            "reject_review",
            { task_id: taskId, actor: "ADMIN", reason },
            projectRoot(),
          );
          if (!lifecycleResult.ok) {
            sendError(res, 409, "REVIEW_TASK_STATE_CHANGED", lifecycleResult.error);
            return;
          }
        } else if (taskStage === "done") {
          const lifecycleResult = await executeLifecycleRuntimeAction(
            "reopen_task",
            { task_id: taskId, actor: "ADMIN", reason },
            projectRoot(),
          );
          if (!lifecycleResult.ok) {
            sendError(res, 409, "REVIEW_TASK_STATE_CHANGED", lifecycleResult.error);
            return;
          }
        } else if (taskStage !== "active" && taskStage !== "inbox") {
          sendError(res, 409, "REVIEW_TASK_STATE_CHANGED", `task ${taskId} is ${taskStage || "unknown"}`);
          return;
        }

        const reportId = String(reviewFm["report_id"] ?? reviewFm["subject_id"] ?? "")
          .replace(/\.md$/i, "")
          .trim();
        if (reportId && opts.fcopReportsDir) {
          const reportPath = join(opts.fcopReportsDir, `${reportId}.md`);
          if (existsSync(reportPath)) {
            const reportRaw = readFileSync(reportPath, "utf-8");
            writeFileSync(
              reportPath,
              _wpPatchFmFields(reportRaw, {
                status: "rejected",
                valid: "false",
                invalidated_by: "ADMIN",
                invalidated_at: now,
                invalid_reason: reason,
              }),
              "utf-8",
            );
          }
        }

        const role = String(taskFm["recipient"] ?? taskFm["to"] ?? "").toUpperCase();
        if (pmWakeExecutorRef && role) {
          await pmWakeExecutorRef(
            buildWakeDownstreamRequest({
              task_id: taskId,
              role,
              reason: "admin_review_rejected_rework",
              thread_key: String(taskFm["thread_key"] ?? "") || undefined,
              source: "admin_review_reject",
              caller: "ADMIN",
            }),
          );
        }
      }
      const finalDecisionValue = action === "approved" ? "approved" : "rejected";
      let updated = _wpPatchFmFields(raw, {
        decision: finalDecisionValue,
        resolution_status: "resolved",
        resolved_at: now,
      });
      updated = updated + auditBlock;
      writeFileSync(srcPath, updated, "utf-8");
      // Move file to subdirectory
      const destDir = join(reviewsDir, action);
      mkdirSync(destDir, { recursive: true });
      const destPath = join(destDir, filename);
      renameSync(srcPath, destPath);
      sseEmit(`codeflowmu.review_${action}`, { filename, action, task_id: taskId, reviewed_at: now });
      res.json({ ok: true, action, filename, task_id: taskId });
    } catch (err) {
      sendError(res, 500, "REVIEW_DECISION_FAILED", String(err));
    }
  }

  app.post("/api/v2/reviews/:filename/approve", (req: Request, res: Response) => {
    handleReviewDecision(req, res, "approved");
  });

  app.post("/api/v2/reviews/:filename/reject", (req: Request, res: Response) => {
    handleReviewDecision(req, res, "rejected");
  });

  // ── File browser APIs (v1.3) ─────────────────────────────────────────

  /** Resolve project root (legacy alias — same as resolveProjectRoot). */
  function getProjectRoot(): string {
    return resolveProjectRoot();
  }

  /** File browser may list/read under fcop/ or docs/ (prefix allow, not exact dir list). */
  function normalizeBrowseRel(raw: string): string | null {
    const clean = raw.replace(/^[/\\]+/, "").replace(/\\/g, "/").replace(/\/$/, "");
    if (!clean || clean.includes("..") || clean.includes("\x00")) return null;
    if (clean === "fcop" || clean === "docs") return clean;
    if (clean.startsWith("fcop/") || clean.startsWith("docs/")) return clean;
    return null;
  }

  function resolveBrowseAbs(rel: string): string | null {
    const clean = normalizeBrowseRel(rel);
    if (!clean) return null;
    const root = pathResolve(projectRoot());
    const abs = pathResolve(join(root, clean));
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    return abs;
  }

  /** Count direct .md/.json/.txt files in a directory (matches /api/v2/files/tree fileCount). */
  function countBrowsableFilesInDir(absDir: string): number {
    try {
      return readdirSync(absDir).filter((n) => /\.(md|json|txt)$/i.test(n)).length;
    } catch {
      return 0;
    }
  }

  /**
   * GET /api/v2/files/list?dir=<relative_path>
   * Lists entries in fcop/ or docs/ (non-recursive). Supports nested paths e.g. fcop/history/2026-05-15.
   */
  app.get("/api/v2/files/list", async (req: Request, res: Response) => {
    try {
      const { readdirSync, statSync } = await import("node:fs");
      const dir = String(req.query["dir"] ?? "").replace(/\\/g, "/").replace(/\/$/, "");
      const fullPath = resolveBrowseAbs(dir);
      if (!fullPath) {
        sendError(res, 400, "INVALID_DIR", "dir must be under fcop/ or docs/");
        return;
      }
      if (!existsSync(fullPath)) { res.json([]); return; }
      const entries = readdirSync(fullPath).map((name) => {
        try {
          const entryPath = join(fullPath, name);
          const stat = statSync(entryPath);
          const isDir = stat.isDirectory();
          return {
            name,
            path: `${dir}/${name}`,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isDir,
            type: isDir ? "dir" : "file",
            ...(isDir ? { fileCount: countBrowsableFilesInDir(entryPath) } : {}),
          };
        } catch {
          return { name, path: `${dir}/${name}`, size: 0, mtime: "", isDir: false, type: "file" };
        }
      }).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json(entries);
    } catch (err) {
      sendError(res, 500, "FILES_LIST_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/files?path=<relative_path> — alias for list (panel v3 compat).
   */
  app.get("/api/v2/files", async (req: Request, res: Response) => {
    try {
      const { readdirSync, statSync } = await import("node:fs");
      const dir = String(req.query["path"] ?? req.query["dir"] ?? "fcop")
        .replace(/\\/g, "/")
        .replace(/\/$/, "");
      const fullPath = resolveBrowseAbs(dir);
      if (!fullPath) {
        sendError(res, 400, "INVALID_DIR", "path must be under fcop/ or docs/");
        return;
      }
      if (!existsSync(fullPath)) { res.json([]); return; }
      const entries = readdirSync(fullPath).map((name) => {
        try {
          const entryPath = join(fullPath, name);
          const stat = statSync(entryPath);
          const isDir = stat.isDirectory();
          return {
            name,
            path: `${dir}/${name}`,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isDir,
            type: isDir ? "dir" : "file",
            ...(isDir ? { fileCount: countBrowsableFilesInDir(entryPath) } : {}),
          };
        } catch {
          return { name, path: `${dir}/${name}`, size: 0, mtime: "", isDir: false, type: "file" };
        }
      }).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json(entries);
    } catch (err) {
      sendError(res, 500, "FILES_LIST_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/files/read?path=<relative_path>
   * Reads a .md file under fcop/ or docs/ (max 512 KB).
   */
  app.get("/api/v2/files/read", async (req: Request, res: Response) => {
    try {
      const { readFileSync, statSync } = await import("node:fs");
      const relPath = String(req.query["path"] ?? "").replace(/\\/g, "/");
      if (!relPath || !relPath.endsWith(".md")) {
        sendError(res, 400, "INVALID_PATH", "path must be a .md file under fcop/ or docs/");
        return;
      }
      const fullPath = resolveBrowseAbs(relPath);
      if (!fullPath) {
        sendError(res, 403, "PATH_NOT_ALLOWED", "path is outside fcop/ or docs/");
        return;
      }
      if (!fullPath || !existsSync(fullPath)) {
        sendError(res, 404, "FILE_NOT_FOUND", `${relPath} not found`);
        return;
      }
      const stat = statSync(fullPath);
      if (stat.size > 512 * 1024) { sendError(res, 413, "FILE_TOO_LARGE", "File exceeds 512 KB"); return; }
      const content = readFileSync(fullPath, "utf-8");
      res.json({ content, path: relPath, size: stat.size, mtime: stat.mtime.toISOString() });
    } catch (err) {
      sendError(res, 500, "FILE_READ_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/chat/attachments/upload
   * Raw upload. Saves bytes to fcop/attachments/YYYYMMDD/<name>
   * Supports images + pdf/txt/md/log/json. Returns metadata for TASK frontmatter.
   */
  app.post(
    "/api/v2/chat/attachments/upload",
    express.raw({ type: "*/*", limit: "20mb" }),
    async (req: Request, res: Response) => {
      try {
        const body = req.body;
        if (!body || !(body instanceof Buffer) || body.length === 0) {
          sendError(res, 400, "INVALID_UPLOAD_BODY", "raw body is required");
          return;
        }

        const mime =
          (String(req.query["mime"] ?? req.headers["content-type"] ?? "")
            .split(";")[0]
            ?.trim()
            .toLowerCase() ?? "") || "application/octet-stream";

        const extMap: Record<string, string> = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "application/pdf": ".pdf",
          "text/plain": ".txt",
          "text/markdown": ".md",
          "application/json": ".json",
        };
        const rawName = String(req.query["filename"] ?? "").trim();
        const cleanedBase = rawName
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^\.+/, "")
          .slice(0, 80);
        const safeNameBase = cleanedBase || `file-${Date.now()}`;
        const hasExt = /\.[A-Za-z0-9]+$/.test(safeNameBase);
        const fallbackExt = extMap[mime] ?? "";
        const fileName = hasExt
          ? safeNameBase
          : `${safeNameBase}${fallbackExt || ".bin"}`;

        const allowed =
          mime.startsWith("image/") ||
          ALLOWED_ATTACHMENT_MIMES.has(mime) ||
          /\.(png|jpe?g|webp|pdf|txt|md|log|json)$/i.test(fileName);
        if (!allowed) {
          sendError(
            res,
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "allowed: png/jpg/webp/pdf/txt/md/log/json",
          );
          return;
        }

        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const root = getProjectRoot();
        if (isProtectedOpenEditionAppRoot(root)) {
          sendError(
            res,
            403,
            "OPEN_EDITION_APP_ROOT_PROTECTED",
            "Open edition cannot upload attachments into its own source directory. Add or switch to an external project root first.",
          );
          return;
        }
        const relDir = `fcop/attachments/${ymd}`;
        const absDir = join(root, "fcop", "attachments", ymd);
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { createHash } = await import("node:crypto");
        await mkdir(absDir, { recursive: true });

        let finalName = fileName;
        let absPath = join(absDir, finalName);
        let relPath = `${relDir}/${finalName}`.replace(/\\/g, "/");
        let n = 1;
        while (existsSync(absPath)) {
          const dot = fileName.lastIndexOf(".");
          const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
          const ext = dot >= 0 ? fileName.slice(dot) : "";
          finalName = `${base}-${++n}${ext}`;
          absPath = join(absDir, finalName);
          relPath = `${relDir}/${finalName}`.replace(/\\/g, "/");
        }

        await writeFile(absPath, body);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const attType = inferAttachmentType(mime, finalName);

        res.json({
          ok: true,
          attachment: {
            type: attType,
            local_path: relPath,
            absolute_path: absPath.replace(/\\/g, "/"),
            mime,
            original_name: rawName || finalName,
            size: body.length,
            sha256,
          } satisfies TaskAttachment,
        });
      } catch (err) {
        sendError(res, 500, "ATTACHMENT_UPLOAD_FAILED", String(err));
      }
    },
  );

  /**
   * GET /api/v2/files/attachment?path=fcop/attachments/...
   * Serve attachment bytes for Panel preview (fcop/attachments only).
   */
  app.get("/api/v2/files/attachment", async (req: Request, res: Response) => {
    try {
      const relPath = String(req.query["path"] ?? "").replace(/\\/g, "/");
      if (!relPath.startsWith("fcop/attachments/")) {
        sendError(res, 403, "PATH_NOT_ALLOWED", "only fcop/attachments/");
        return;
      }
      const fullPath = resolveBrowseAbs(relPath);
      if (!fullPath || !existsSync(fullPath)) {
        sendError(res, 404, "FILE_NOT_FOUND", relPath);
        return;
      }
      const { readFileSync } = await import("node:fs");
      const buf = readFileSync(fullPath);
      const lower = fullPath.toLowerCase();
      let contentType = "application/octet-stream";
      if (lower.endsWith(".png")) contentType = "image/png";
      else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
        contentType = "image/jpeg";
      else if (lower.endsWith(".webp")) contentType = "image/webp";
      else if (lower.endsWith(".pdf")) contentType = "application/pdf";
      else if (lower.endsWith(".txt") || lower.endsWith(".log"))
        contentType = "text/plain";
      else if (lower.endsWith(".md")) contentType = "text/markdown";
      else if (lower.endsWith(".json")) contentType = "application/json";
      res.setHeader("Content-Type", contentType);
      res.send(buf);
    } catch (err) {
      sendError(res, 500, "ATTACHMENT_READ_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/admin/message — REMOVED (duplicate, see correct handler below).
   * The canonical handler with as_task support is registered further down.
   */
  // [Duplicate removed by fix TASK-20260514-319]

  /**
   * POST /api/v2/tasks — create a new ADMIN→PM task file (FCoP team routing).
   * Body also accepts relation_mode, references, parent_task_id, and current_task_id.
   * Ignores client `recipient`/`sender`: filename is always TASK-*-ADMIN-to-PM.md.
   * Panel may embed executor hints inside `body` (e.g. 【意向执行角色】DEV).
   */
  async function dispatchAdminPmTaskAfterCreate(optsDispatch: {
    projectRoot: string;
    filepath: string;
    filename: string;
    source: string;
  }): Promise<Record<string, unknown>> {
    const { projectRoot, filepath, filename, source } = optsDispatch;
    try {
      const parsed = await TaskParser.parse(filepath);
      const durabilityErrors = validateDurableTaskForDispatch(parsed, {
        expectedSender: "ADMIN",
        expectedRecipient: "PM",
        requiredFields: ["priority", "thread_key", "state"],
      });
      if (durabilityErrors.length > 0) {
        return {
          ok: false,
          dispatched: false,
          skipped: true,
          reason: "invalid_task_file",
          detail: durabilityErrors.join(", "),
        };
      }
      const outcome = await runtime.dispatcher.dispatchTaskFromControlPlane(
        filepath,
        filename,
        "PM",
        source,
      );
      if (outcome.kind === "dispatched") {
        sseEmit("codeflowmu.task_dispatched", {
          event: "task_dispatched",
          task_id: filename.replace(/\.md$/i, ""),
          task_path: filepath,
          role: "PM",
          session_id: outcome.session_id,
          source,
        });
        appendPanelRuntimeAction(projectRoot, {
          operator: "ADMIN",
          action: "dispatch",
          target_agent: "PM-01",
          target_task: filename.replace(/\.md$/i, ""),
          result: "ok",
          session_id: outcome.session_id,
        });
        return { ok: true, dispatched: true, session_id: outcome.session_id };
      }
      if (outcome.kind === "already_dispatched") {
        return {
          ok: true,
          dispatched: true,
          already_dispatched: true,
          reason: "inbox watcher claimed the task first",
        };
      }
      if (outcome.kind === "dispatch_skipped" || outcome.kind === "dependency_pending") {
        sseEmit("dispatch_skipped", {
          filename,
          task_path: filepath,
          role: "PM",
          source,
          reason: outcome.reason,
          detail: "detail" in outcome ? outcome.detail : undefined,
        });
        appendPanelRuntimeAction(projectRoot, {
          operator: "ADMIN",
          action: "dispatch",
          target_agent: "PM-01",
          target_task: filename.replace(/\.md$/i, ""),
          result: "skipped",
          reason: outcome.reason,
        });
        return {
          ok: false,
          dispatched: false,
          skipped: true,
          reason: outcome.reason,
          detail: "detail" in outcome ? outcome.detail : undefined,
        };
      }
      return { ok: false, dispatched: false, outcome: outcome.kind };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      appendPanelRuntimeAction(projectRoot, {
        operator: "ADMIN",
        action: "dispatch",
        target_agent: "PM-01",
        target_task: filename.replace(/\.md$/i, ""),
        result: "failed",
        reason: reason.slice(0, 200),
      });
      return { ok: false, dispatched: false, error: reason };
    }
  }

  async function persistDurableAdminPmTask(
    filepath: string,
    content: string,
  ): Promise<void> {
    const { readFile, unlink } = await import("node:fs/promises");
    try {
      await atomicWriteFcopMarkdown(filepath, content);
      const persisted = await readFile(filepath, "utf-8");
      if (persisted !== content) {
        throw new Error("persisted task content does not match the submitted content");
      }
      const parsed = await TaskParser.parse(filepath);
      const errors = validateDurableTaskForDispatch(parsed, {
        expectedSender: "ADMIN",
        expectedRecipient: "PM",
        requiredFields: ["priority", "thread_key", "state"],
      });
      if (errors.length > 0) {
        throw new Error(`task durability validation failed: ${errors.join(", ")}`);
      }
    } catch (err) {
      await unlink(filepath).catch(() => undefined);
      throw err;
    }
  }

  app.post("/api/v2/tasks", async (req: Request, res: Response) => {
    const { mkdir: mk } = await import("node:fs/promises");
    const { projectRoot, adminDir } = resolveAdminTaskWriteScope();
    if (isProtectedOpenEditionAppRoot(projectRoot)) {
      sendError(
        res,
        403,
        "OPEN_EDITION_APP_ROOT_PROTECTED",
        "Open edition cannot create tasks against the CodeFlowMu-open source directory. Add or switch to an external project root first.",
      );
      return;
    }
    if (!adminDir) {
      sendError(res, 503, "ADMIN_DIR_NOT_CONFIGURED", "adminTasksDir not configured");
      return;
    }
    const { subject, body, priority = "P2" } = req.body as {
      subject?: string;
      body?: string;
      priority?: string;
      attachments?: unknown;
      relation_mode?: "new" | "continue" | "child";
      references?: unknown;
      parent_task_id?: string;
      current_task_id?: string;
    };
    const attachments = normalizeAndEnrichAttachments(
      projectRoot,
      req.body?.attachments,
    );
    if (!subject || !body) {
      sendError(res, 400, "MISSING_FIELDS", "subject and body are required");
      return;
    }
    let relationMode = String(req.body?.relation_mode ?? "new").trim().toLowerCase();
    if (!new Set(["new", "continue", "child"]).has(relationMode)) {
      sendError(res, 400, "INVALID_RELATION_MODE", "relation_mode must be new, continue, or child");
      return;
    }
    const requestedRefs: string[] = Array.isArray(req.body?.references)
      ? [...new Set<string>(req.body.references.map((v: unknown) => String(v).replace(/\.md$/i, "").trim()).filter(Boolean))]
      : [];
    const parentTaskIdInput = String(req.body?.parent_task_id ?? "").replace(/\.md$/i, "").trim();
    const currentTaskIdInput = String(req.body?.current_task_id ?? "").replace(/\.md$/i, "").trim();
    const childParentInput = parentTaskIdInput || currentTaskIdInput;
    if (parentTaskIdInput && relationMode === "continue") {
      sendError(res, 400, "PARENT_TASK_ID_CONFLICT", "parent_task_id cannot be used with continue relation");
      return;
    }
    if (childParentInput && relationMode === "new") {
      relationMode = "child";
    }
    const { tasks: relationTaskRows } = await listTasksFromLedgerAuto(projectRoot, { limit: 500 });
    const relationTasks = relationTaskRows as unknown as Array<Record<string, unknown>>;
    const findRelationTask = (id: string) => relationTasks.find((row) => {
      const rowId = String(row.task_id ?? "").replace(/\.md$/i, "").trim();
      const rowFile = String(row.filename ?? "").replace(/\.md$/i, "").trim();
      return rowId === id || rowFile === id || taskIdFromFilename(rowFile) === taskIdFromFilename(id);
    });
    let relationReferences: string[] = [];
    let relationParent = "";
    let relationThreadKey = "";
    if (relationMode === "continue") {
      relationReferences = requestedRefs.filter((id) => Boolean(findRelationTask(id)));
      if (!relationReferences.length) {
        sendError(res, 400, "REFERENCES_REQUIRED", "continue relation requires at least one current-project task");
        return;
      }
      const first = findRelationTask(relationReferences[0]!);
      relationThreadKey = String(
        first?.thread_key ??
          (first?.yaml ? (first.yaml as Record<string, unknown>).thread_key : "") ??
          "",
      ).trim();
    } else if (relationMode === "child") {
      if (!childParentInput) {
        sendError(res, 400, "PARENT_TASK_ID_REQUIRED", "child relation requires parent_task_id");
        return;
      }
      const parentTask = findRelationTask(childParentInput);
      const parentBucket = String(parentTask?.bucket ?? parentTask?.physical_scope ?? "").toLowerCase();
      const parentState = String(
        parentTask?.lifecycle_projection ?? parentTask?.display_status ?? parentTask?.state ?? "",
      ).toLowerCase();
      if (!parentTask || ["done", "archive"].includes(parentBucket) || ["done", "archive", "archived"].includes(parentState)) {
        sendError(res, 400, "PARENT_TASK_UNAVAILABLE", "child relation requires a current open task");
        return;
      }
      relationParent = String(parentTask.task_id ?? childParentInput).replace(/\.md$/i, "").trim();
      relationReferences = [relationParent];
      relationThreadKey = String(
        parentTask.thread_key ??
          (parentTask.yaml ? (parentTask.yaml as Record<string, unknown>).thread_key : "") ??
          "",
      ).trim();
    }
    const relationFingerprint = JSON.stringify({
      relation_mode: relationMode,
      parent: relationParent,
      references: relationReferences,
    });
    const fingerprint = wpTaskCreateFingerprint(subject, `${body}\n${relationFingerprint}`, attachments);
    const dup = await wpFindRecentDuplicateAdminPmTask(
      projectRoot,
      fingerprint,
      adminDir,
    );
    if (dup) {
      const dispatch = await dispatchAdminPmTaskAfterCreate({
        projectRoot,
        filepath: dup.filepath,
        filename: dup.filename,
        source: "admin_task_create_duplicate",
      });
      res.json({
        ok: true,
        filename: dup.filename,
        filepath: dup.filepath,
        deduplicated: true,
        parent_task_id: relationParent || undefined,
        dispatch,
      });
      return;
    }
    const idemKey = String(
      req.get("Idempotency-Key") ?? req.get("idempotency-key") ?? "",
    ).trim();
    if (idemKey) {
      const replay = wpGetIdempotencyReplay(idemKey);
      if (replay) {
        const dispatch = await dispatchAdminPmTaskAfterCreate({
          projectRoot,
          filepath: replay.filepath,
          filename: replay.filename,
          source: "admin_task_create_replay",
        });
        res.json({
          ok: true,
          filename: replay.filename,
          filepath: replay.filepath,
          deduplicated: true,
          idempotency_replay: true,
          parent_task_id: relationParent || undefined,
          dispatch,
        });
        return;
      }
    }

    await mk(adminDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const seq = _wpNextTaskSeq(projectRoot, date);
    const filename = `TASK-${date}-${seq}-ADMIN-to-PM.md`;
    const filepath = join(adminDir, filename);
    const bodyWithAttachmentRefs = appendMarkdownAttachmentRefs({
      body,
      markdownFilePath: filepath,
      attachments,
      projectRoot,
    });

    const content = [
      "---",
      "protocol: fcop",
      'version: "1.0"',
      "sender: ADMIN",
      "recipient: PM",
      `priority: ${priority}`,
      `thread_key: ${relationThreadKey || `panel-task-${seq}`}`,
      `parent: ${relationParent}`,
      ...(relationReferences.length
        ? ["references:", ...relationReferences.map((id) => `  - ${id}`)]
        : ["references: []"]),
      "state: inbox",
      ...formatAttachmentsYaml(attachments),
      "---",
      "",
      `# ${subject}`,
      "",
      bodyWithAttachmentRefs,
    ].join("\n");

    try {
      await persistDurableAdminPmTask(filepath, content);
      const ledgerResult = await finalizeTaskCreateAfterDiskWrite(
        projectRoot,
        filepath,
      );
      if (!ledgerResult.ok) {
        sendError(res, 500, "LEDGER_REBUILD_FAILED", ledgerResult.error);
        return;
      }

      const evalCfg = readEvalObserverConfig(projectRoot);
      if (evalCfg.trigger_on_task_create) {
        try {
          await spawnEval01(projectRoot, filename);
        } catch (doorbellErr) {
          console.warn("EVAL trigger on task create failed:", doorbellErr);
        }
      }
      const dispatch = await dispatchAdminPmTaskAfterCreate({
        projectRoot,
        filepath,
        filename,
        source: "admin_task_create",
      });

      res.json({
        ok: true,
        filename,
        filepath,
        parent_task_id: relationParent || undefined,
        dispatch,
      });
      wpRememberRecentAdminPmCreate(projectRoot, fingerprint, filename, filepath);
      if (idemKey) wpRememberIdempotency(idemKey, filename, filepath);
    } catch (err) {
      sendError(res, 500, "WRITE_FAILED", String(err));
    }
  });

  // In-memory chat log for ADMIN-PM chat (non-task messages).
  const chatLog: {
    ts: string;
    role: "admin" | "pm";
    text: string;
    attachments?: ChatImageAttachment[];
  }[] = [];

  // ── Direct chat (non-task) store ────────────────────────────────────────
  interface DirectChatMsg {
    id: string; agentId: string; role: "admin" | "agent";
    text: string; ts: string; session_id?: string;
    attachments?: ChatImageAttachment[];
    source?: string;
    client?: string;
  }
  const directChat: DirectChatMsg[] = [];

  // Restore up to 500 most-recent messages from disk on startup so history
  // survives server restarts (按日 chat-YYYYMMDD.jsonl + 兼容 chat.jsonl).
  (() => {
    try {
      const root = getProjectRoot();
      const paths = listChatReadPaths(root);
      const merged: DirectChatMsg[] = [];
      for (const chatFile of paths) {
        if (!existsSync(chatFile)) continue;
        const lines = readFileSync(chatFile, "utf-8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            merged.push(JSON.parse(line) as DirectChatMsg);
          } catch {
            /* skip malformed */
          }
        }
      }
      merged.sort((a, b) => a.ts.localeCompare(b.ts));
      for (const msg of merged.slice(-500)) {
        directChat.push(msg);
      }
    } catch {
      /* best-effort — don't crash panel if file unreadable */
    }
  })();

  function persistDirectChatMsg(msg: DirectChatMsg): void {
    try {
      const root = getProjectRoot();
      const chatDir = fcopChatDir(root);
      mkdirSync(chatDir, { recursive: true });
      appendFileSync(
        fcopChatPathForDate(root),
        JSON.stringify(msg) + "\n",
        "utf-8",
      );
    } catch {
      /* best-effort */
    }
  }

  const chatPending = new Map<
    string,
    {
      agentId: string;
      text: string;
      thinking: string;
      userMessage: string;
      uiLang: UiLang;
    }
  >();

  async function agentIsPmSeat(agentId: string): Promise<boolean> {
    if (/^PM(?:[-_.]|$)/i.test(agentId)) return true;
    try {
      const rec = await runtime.registry.get(agentId);
      return (rec?.protocol.role ?? "").toUpperCase() === "PM";
    } catch {
      return false;
    }
  }

  async function handleDirectSession(
    res: Response,
    params: {
      agentId: string;
      message: string;
      intent: DirectSessionIntent;
      operatorRole: "ADMIN" | "PM";
      taskId?: string;
      threadKey?: string;
      attachments?: ChatImageAttachment[];
      uiLang?: UiLang;
      source?: string;
      client?: string;
    },
  ): Promise<void> {
    const { agentId, message, intent, operatorRole, taskId, threadKey } = params;
    const root = getProjectRoot();
    if (isProtectedOpenEditionAppRoot(root)) {
      sendError(
        res,
        403,
        "OPEN_EDITION_APP_ROOT_PROTECTED",
        "Open edition cannot run agent sessions against its own CodeFlowMu-open source directory. Add or switch to an external project root first.",
      );
      return;
    }
    const envGate = evaluateFcopEnvGate(root);
    if (!envGate.fcopReady) {
      sendError(
        res,
        403,
        "FCOP_ENV_NOT_READY",
        envGate.userMessage ??
          "环境预检未通过，请先在「环境预检」完成一键初始化/修复。",
      );
      return;
    }
    const attachments = enrichImageAttachments(root, params.attachments ?? []);
    const uiLang = normalizeUiLang(params.uiLang ?? readPanelUiLang(root));
    try {
      writePanelUiLang(root, uiLang);
    } catch {
      /* non-fatal */
    }

    if (intent === "chat") {
      if (!(await agentIsPmSeat(agentId))) {
        sendError(
          res,
          403,
          "CHAT_PM_ONLY",
          "聊天通道仅 ADMIN ↔ PM；催 DEV/OPS/QA 请用唤醒(intent=wake)或让 PM 巡查",
        );
        return;
      }
      if (operatorRole !== "ADMIN") {
        sendError(
          res,
          403,
          "CHAT_ADMIN_ONLY",
          "聊天通道仅 ADMIN 发起；PM 催下游请用唤醒/巡查",
        );
        return;
      }
    }

    const triggerChatId = `CHAT-${Date.now()}`;
    const taskMention = message.match(/TASK-\d{8}-\d{3,}/i)?.[0]?.toUpperCase() ?? "";
    const boundTaskId = String(taskId ?? "").trim() || taskMention;
    let boundThreadKey = String(threadKey ?? "").trim();
    if (boundTaskId && !boundThreadKey) {
      try {
        const taskHit = findTaskFileByIdPrefix(root, boundTaskId);
        if (taskHit?.path) {
          const taskFm = parseMarkdownFrontmatter(readFileSync(taskHit.path, "utf-8"));
          boundThreadKey = String(taskFm["thread_key"] ?? "").trim();
        }
      } catch {
        /* task id remains authoritative even if thread lookup is unavailable */
      }
    }
    const sessionTaskId = boundTaskId || `CHAT-${Date.now()}`;
    const isPmTarget =
      intent !== "chat" && (/^PM/i.test(agentId) || (await agentIsPmSeat(agentId)));
    let registryModelId: string | undefined;
    if (intent === "chat") {
      try {
        const rec = await runtime.registry.get(agentId);
        registryModelId = rec?.protocol?.model?.id?.trim() || undefined;
      } catch {
        /* fallback to agents.json in identity block */
      }
    }
    const { chatPrompt, sessionMaxRounds } = await buildDirectSessionPromptWithGovernance(
      message,
      {
        intent,
        operatorRole,
        targetAgentId: agentId,
        projectRoot: root,
        runGovernanceCycle: isPmTarget,
        taskId: boundTaskId || undefined,
        threadKey: boundThreadKey || undefined,
        attachments,
        registryModelId,
        wakeDownstream:
          isPmTarget && pmWakeExecutorRef ? pmWakeExecutorRef : undefined,
        allowAutoWake: isPmTarget && Boolean(pmWakeExecutorRef),
        pmQueueGuard: isPmTarget ? runtime.pmQueueGuard : undefined,
      },
    );

    let msgSource = params.source;
    let msgClient = params.client;
    if (!msgSource && intent === "chat" && operatorRole === "ADMIN") {
      msgSource = "pc";
      msgClient = msgClient ?? "web";
    }
    const userMsg: DirectChatMsg = {
      id: triggerChatId,
      agentId,
      role: operatorRole === "PM" ? "agent" : "admin",
      text: message,
      ts: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
      ...(msgSource ? { source: msgSource } : {}),
      ...(msgClient ? { client: msgClient } : {}),
    };
    directChat.push(userMsg);
    if (directChat.length > 500) directChat.shift();
    persistDirectChatMsg(userMsg);

    try {
      const sessionImages = await buildSessionImagesFromAttachments(root, attachments);
      const handle = await runtime.sessionManager.startSession(
        agentId,
        sessionTaskId,
        {
          text: chatPrompt,
          maxToolRounds: sessionMaxRounds ?? DEFAULT_SESSION_MAX_TOOL_ROUNDS,
          uiLang,
          context: {
            trigger_chat_id: triggerChatId,
            ...(boundTaskId ? { task_id: boundTaskId } : {}),
            ...(boundThreadKey ? { thread_key: boundThreadKey } : {}),
          },
          ...(sessionImages.length > 0 ? { images: sessionImages } : {}),
        },
      );
      if (usageLogger && handle.session_id) {
        if (boundTaskId) usageLogger.noteSessionTask(handle.session_id, boundTaskId);
        if (boundThreadKey) usageLogger.noteSessionThread(handle.session_id, boundThreadKey);
      }
      noteSessionThinkingChannel(
        handle.session_id,
        intent === "chat" ? "chat" : "task",
      );
      chatPending.set(handle.session_id, {
        agentId,
        text: "",
        thinking: "",
        userMessage: message,
        uiLang,
      });
      sseEmit("codeflowmu.chat_message", {
        agentId,
        role: userMsg.role,
        text: message,
        attachments,
        ts: userMsg.ts,
        session_id: handle.session_id,
        intent,
        ...(userMsg.source ? { source: userMsg.source } : {}),
        ...(userMsg.client ? { client: userMsg.client } : {}),
      });
      appendPanelRuntimeAction(root, {
        operator: operatorRole,
        action: intent === "patrol" ? "patrol" : "wake",
        target_agent: agentId,
        target_task: boundTaskId || undefined,
        result: "ok",
        session_id: handle.session_id,
      });
      res.json({
        ok: true,
        session_id: handle.session_id,
        ts: userMsg.ts,
        intent,
      });
    } catch (err: unknown) {
      const code =
        (err as Error)?.constructor?.name === "InvalidAgentStatusError"
          ? "AGENT_BUSY"
          : "SESSION_ERROR";
      const status = code === "AGENT_BUSY" ? 409 : 500;
      const hint =
        code === "AGENT_BUSY"
          ? `Agent ${agentId} 正在处理任务，请稍候再试`
          : String(err);
      appendPanelRuntimeAction(root, {
        operator: operatorRole,
        action: intent === "patrol" ? "patrol" : "wake",
        target_agent: agentId,
        target_task: boundTaskId || undefined,
        result: code === "AGENT_BUSY" ? "skipped" : "failed",
        reason: code === "AGENT_BUSY" ? "agent busy" : hint.slice(0, 200),
      });
      sendError(res, status, code, hint);
    }
  }

  /**
   * POST /api/v2/admin/message
   * Body: { text: string, as_task?: boolean, as_report?: boolean, priority?: string }
   * as_task=true  → writes TASK-*-ADMIN-to-PM.md to adminTasksDir (same as POST /api/v2/tasks)
   * as_report=true → writes REPORT-*.md to fcopReportsDir (manual report helper)
   * as_task=false → stores in in-memory chatLog
   */
  app.post("/api/v2/admin/message", async (req: Request, res: Response) => {
    const {
      text = "",
      as_task = false,
      as_report = false,
      priority = "P1",
      reporter = "PM",
      recipient = "ADMIN",
      status = "done",
      task_id = "",
      thread_key = "",
    } = req.body as {
      text?: string;
      as_task?: boolean;
      as_report?: boolean;
      priority?: string;
      reporter?: string;
      recipient?: string;
      status?: string;
      task_id?: string;
      thread_key?: string;
      attachments?: unknown;
    };
    const attachments = normalizeAndEnrichAttachments(
      resolveProjectRoot(),
      req.body?.attachments,
    );
    if (!text.trim()) { sendError(res, 400, "MISSING_TEXT", "text is required"); return; }
    if (as_task && as_report) {
      sendError(res, 400, "INVALID_MODE", "as_task and as_report cannot both be true");
      return;
    }

    if (as_task) {
      // Reuse task-write logic
      const { mkdir: mk } = await import("node:fs/promises");
      const { projectRoot, adminDir } = resolveAdminTaskWriteScope();
      if (!adminDir) { sendError(res, 503, "ADMIN_DIR_NOT_CONFIGURED", "adminTasksDir not configured"); return; }
      const chatSubject = text.slice(0, 80);
      const fingerprint = wpTaskCreateFingerprint(chatSubject, text, attachments);
      const dup = await wpFindRecentDuplicateAdminPmTask(
        projectRoot,
        fingerprint,
        adminDir,
      );
      if (dup) {
        const dispatch = await dispatchAdminPmTaskAfterCreate({
          projectRoot,
          filepath: dup.filepath,
          filename: dup.filename,
          source: "admin_chat_task_duplicate",
        });
        res.json({
          ok: true,
          as_task: true,
          filename: dup.filename,
          deduplicated: true,
          dispatch,
        });
        return;
      }
      const idemKey = String(
        req.get("Idempotency-Key") ?? req.get("idempotency-key") ?? "",
      ).trim();
      if (idemKey) {
        const replay = wpGetIdempotencyReplay(idemKey);
        if (replay) {
          const dispatch = await dispatchAdminPmTaskAfterCreate({
            projectRoot,
            filepath: replay.filepath,
            filename: replay.filename,
            source: "admin_chat_task_replay",
          });
          res.json({
            ok: true,
            as_task: true,
            filename: replay.filename,
            deduplicated: true,
            idempotency_replay: true,
            dispatch,
          });
          return;
        }
      }
      await mk(adminDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const seq = _wpNextTaskSeq(projectRoot, date);
      const filename = `TASK-${date}-${seq}-ADMIN-to-PM.md`;
      const filepath = join(adminDir, filename);
      const textWithAttachmentRefs = appendMarkdownAttachmentRefs({
        body: text,
        markdownFilePath: filepath,
        attachments,
        projectRoot,
      });
      const content = [
        "---", "protocol: fcop", 'version: "1.0"', "sender: ADMIN", "recipient: PM",
        `priority: ${priority}`, `thread_key: chat-task-${seq}`, "state: inbox",
        ...formatAttachmentsYaml(attachments),
        "---", "", `# ${text.slice(0, 80)}`, "", textWithAttachmentRefs,
      ].join("\n");
      try {
        await persistDurableAdminPmTask(filepath, content);
        const ledgerResult = await finalizeTaskCreateAfterDiskWrite(
          projectRoot,
          filepath,
        );
        if (!ledgerResult.ok) {
          sendError(res, 500, "LEDGER_REBUILD_FAILED", ledgerResult.error);
          return;
        }
        wpRememberRecentAdminPmCreate(projectRoot, fingerprint, filename, filepath);
        if (idemKey) wpRememberIdempotency(idemKey, filename, filepath);
        const dispatch = await dispatchAdminPmTaskAfterCreate({
          projectRoot,
          filepath,
          filename,
          source: "admin_chat_task",
        });
        res.json({ ok: true, as_task: true, filename, dispatch });
      } catch (err) {
        sendError(res, 500, "WRITE_FAILED", String(err));
      }
    } else if (as_report) {
      const { mkdir: mk } = await import("node:fs/promises");
      const reportsDir = opts.fcopReportsDir;
      if (!reportsDir) {
        sendError(res, 503, "REPORTS_DIR_NOT_CONFIGURED", "fcopReportsDir not configured");
        return;
      }
      await mk(reportsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const seq = _wpNextTaskSeq(resolveProjectRoot(), date);
      const senderRole = String(reporter || "PM").trim().toUpperCase();
      const recipientRole = String(recipient || "ADMIN").trim().toUpperCase();
      const filename = `REPORT-${date}-${seq}-${senderRole}-to-${recipientRole}.md`;
      const filepath = join(reportsDir, filename);
      const taskId = String(task_id || "").trim();
      const threadKey = String(thread_key || "").trim();
      const textWithAttachmentRefs = appendMarkdownAttachmentRefs({
        body: text,
        markdownFilePath: filepath,
        attachments,
        projectRoot: resolveProjectRoot(),
      });
      const content = [
        "---",
        "protocol: fcop",
        'version: "1.0"',
        `sender: ${senderRole}`,
        `recipient: ${recipientRole}`,
        `status: ${status}`,
        ...(taskId ? [`task_id: ${taskId}`] : []),
        ...(threadKey ? [`thread_key: ${threadKey}`] : []),
        ...formatAttachmentsYaml(attachments),
        "---",
        "",
        `# ${text.slice(0, 80)}`,
        "",
        textWithAttachmentRefs,
      ].join("\n");
      try {
        const outcome = await atomicWriteFcopMarkdown(filepath, content, {
          skipIfExists: true,
        });
        if (outcome === "written") {
          sseEmit("codeflowmu.report_created", { filename, source: "chat" });
        }
        res.json({
          ok: true,
          as_report: true,
          filename,
          written: outcome === "written",
        });
      } catch (err) {
        sendError(res, 500, "WRITE_FAILED", String(err));
      }
    } else {
      chatLog.push({
        ts: new Date().toISOString(),
        role: "admin",
        text,
        ...(attachments.length ? { attachments } : {}),
      });
      if (chatLog.length > 200) chatLog.shift();
      sseEmit("codeflowmu.chat_message", {
        role: "admin",
        text,
        attachments,
        ts: chatLog[chatLog.length - 1]!.ts,
      });
      res.json({ ok: true, as_task: false });
    }
  });

  /**
   * GET /api/v2/admin/messages — retrieve in-memory chat log.
   * Query: ?limit=N (default 50)
   */
  app.get("/api/v2/admin/messages", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
    res.json(chatLog.slice(-limit));
  });

  const PM_FINAL_TERMINAL_STATUSES = new Set([
    "done",
    "blocked",
    "failed",
    "completed",
  ]);

  function deriveAdminCloseoutHint(closeout: AdminTaskCloseout): {
    phase: "waiting_eval_observation" | "ready_for_admin_review" | "other";
    pm_final: boolean;
    eval: boolean;
  } {
    const pm = closeout.pm_final_report;
    const ev = closeout.eval_observation;
    if (pm && !ev) {
      const st = String(pm.status ?? "").toLowerCase();
      if (PM_FINAL_TERMINAL_STATUSES.has(st)) {
        return {
          phase: "waiting_eval_observation",
          pm_final: true,
          eval: false,
        };
      }
    }
    if (pm && ev) {
      return { phase: "ready_for_admin_review", pm_final: true, eval: true };
    }
    return { phase: "other", pm_final: !!pm, eval: !!ev };
  }

  async function readAdminCloseoutNoAutoEval(
    projectRoot: string,
    taskId: string,
  ): Promise<AdminTaskCloseout | null> {
    await ensureLedgerFresh(projectRoot);
    return getAdminTaskCloseout(projectRoot, taskId, { ensureEval: false });
  }

  async function adminApprovalBlockedByMissingEval(
    projectRoot: string,
    taskId: string,
    actor?: string,
  ): Promise<{ blocked: boolean; hint?: ReturnType<typeof deriveAdminCloseoutHint> }> {
    const actorNorm = String(actor ?? "").trim().toUpperCase();
    if (actorNorm && actorNorm !== "ADMIN") return { blocked: false };
    if (!isAdminMainlineTaskFn(taskId)) return { blocked: false };
    const closeout = await readAdminCloseoutNoAutoEval(projectRoot, taskId);
    if (!closeout) return { blocked: false };
    const hint = deriveAdminCloseoutHint(closeout);
    if (hint.phase === "waiting_eval_observation") {
      return { blocked: true, hint };
    }
    return { blocked: false, hint };
  }

  /**
   * GET /api/v2/admin/task-closeout — PM final summary + EVAL observation (read-only).
   * Query: ?task_id=TASK-YYYYMMDD-NNN&ensure_eval=0 (skip auto-generate EVAL)
   */
  app.get("/api/v2/admin/task-closeout", async (req: Request, res: Response) => {
    const taskId = String(req.query["task_id"] ?? "").trim();
    if (!taskId) {
      return sendError(res, 400, "TASK_ID_REQUIRED", "task_id query required");
    }
    const ensureEvalRaw = String(req.query["ensure_eval"] ?? "").trim().toLowerCase();
    const ensureEval =
      ensureEvalRaw !== "0" &&
      ensureEvalRaw !== "false" &&
      ensureEvalRaw !== "no";
    try {
      const root = getProjectRoot();
      const closeout = ensureEval
        ? await readAdminTaskCloseout(root, taskId)
        : await readAdminCloseoutNoAutoEval(root, taskId);
      if (!closeout) {
        return sendError(
          res,
          404,
          "CLOSEOUT_NOT_FOUND",
          "No ADMIN closeout for task_id",
        );
      }
      let adminCloseoutHint = deriveAdminCloseoutHint(closeout);
      if (!isAdminMainlineTaskFn(taskId)) {
        adminCloseoutHint = {
          phase: "other",
          pm_final: !!closeout.pm_final_report,
          eval: !!closeout.eval_observation,
        };
      }
      res.json({
        ok: true,
        closeout,
        admin_closeout_hint: adminCloseoutHint,
      });
    } catch (err: unknown) {
      sendError(res, 500, "CLOSEOUT_READ_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/admin/task-closeout/generate-eval — 为已有 PM final 补写 EVAL。
   * Body: { task_id: TASK-YYYYMMDD-NNN }
   */
  app.post(
    "/api/v2/admin/task-closeout/generate-eval",
    async (req: Request, res: Response) => {
      const taskId = String(req.body?.task_id ?? req.query["task_id"] ?? "").trim();
      if (!taskId) {
        return sendError(res, 400, "TASK_ID_REQUIRED", "task_id required");
      }
      const forceRegenerate =
        req.body?.force_regenerate === true ||
        req.query["force_regenerate"] === "true" ||
        req.query["force_regenerate"] === "1";
      try {
        const root = getProjectRoot();
        const { result, closeout } = await generateAdminTaskCloseoutEval(
          root,
          taskId,
          { forceRegenerate },
        );
        if (!closeout) {
          return sendError(
            res,
            404,
            "CLOSEOUT_NOT_FOUND",
            "No ADMIN closeout for task_id",
          );
        }
        const adminCloseoutHint = deriveAdminCloseoutHint(closeout);
        res.json({ ok: true, result, closeout, admin_closeout_hint: adminCloseoutHint });
      } catch (err: unknown) {
        sendError(res, 500, "EVAL_GENERATE_FAILED", String(err));
      }
    },
  );

  // ── Panel UI language (thinking stream locale) ───────────────────────

  /**
   * GET /api/v2/panel/ui-lang
   * Returns persisted panel UI language for agent thinking stream.
   */
  app.get("/api/v2/panel/ui-lang", (_req: Request, res: Response) => {
    const root = getProjectRoot();
    res.json({ ok: true, ui_lang: readPanelUiLang(root) });
  });

  /**
   * POST /api/v2/panel/ui-lang
   * Body: { ui_lang: 'zh' | 'en' }
   */
  app.post("/api/v2/panel/ui-lang", (req: Request, res: Response) => {
    const root = getProjectRoot();
    const body = req.body as { ui_lang?: unknown };
    const uiLang = normalizeUiLang(body.ui_lang);
    try {
      writePanelUiLang(root, uiLang);
      res.json({ ok: true, ui_lang: uiLang });
    } catch (err: unknown) {
      sendError(res, 500, "UI_LANG_WRITE_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/edition/config
   * Returns optional edition-specific UI metadata from `.codeflowmu/edition-ui.json`.
   */
  app.get("/api/v2/edition/config", (_req: Request, res: Response) => {
    const root = getProjectRoot();
    const configPath = join(root, ".codeflowmu", "edition-ui.json");
    const hostRoot = resolveMonorepoRootFromShellPkg(SHELL_PKG_ROOT);
    const hostConfigPath = hostRoot ? join(hostRoot, ".codeflowmu", "edition-ui.json") : "";
    const candidate = existsSync(configPath)
      ? configPath
      : hostConfigPath && existsSync(hostConfigPath)
        ? hostConfigPath
        : "";
    if (!candidate) {
      res.json({ ok: true, edition: "mother", config: null });
      return;
    }
    try {
      const raw = readFileSync(candidate, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      res.json({
        ok: true,
        edition: String(config.edition ?? "custom"),
        config,
      });
    } catch (err: unknown) {
      sendError(res, 500, "EDITION_CONFIG_READ_FAILED", String(err));
    }
  });

  // ── Direct chat with agent (no task file created) ────────────────────

  /**
   * POST /api/v2/chat/direct
   * Body: { agentId?, message, intent?: 'chat'|'wake'|'patrol', operator_role?: 'ADMIN'|'PM' }
   * - intent=chat：仅 ADMIN ↔ PM-01（不落 TASK）
   * - intent=wake|patrol：任意席位唤醒/巡查（运维能力，不是「聊天关系」）
   */
  app.post("/api/v2/chat/direct", async (req: Request, res: Response) => {
    const body = req.body as {
      agentId?: string;
      message?: string;
      intent?: string;
      operator_role?: string;
      task_id?: string;
      thread_key?: string;
      attachments?: unknown;
      ui_lang?: unknown;
    };
    const message = String(body.message ?? "").trim();
    if (!message) {
      sendError(res, 400, "MISSING_MESSAGE", "message is required");
      return;
    }
    const intent = normalizeDirectIntent(body.intent);
    const operatorRole = normalizeDirectOperatorRole(body.operator_role);
    const agentId = String(body.agentId ?? ADMIN_CHAT_AGENT_ID);
    await handleDirectSession(res, {
      agentId,
      message,
      intent,
      operatorRole,
      taskId: body.task_id,
      threadKey: body.thread_key,
      attachments: normalizeAndEnrichAttachments(getProjectRoot(), body.attachments),
      uiLang: normalizeUiLang(body.ui_lang),
    });
  });

  /**
   * POST /api/v2/agents/:agentId/wake
   * 通用唤醒（面板 ⚡、PM 催下游、定时巡检）。短句「开工」「巡查」即可，不写 TASK。
   */
  app.post("/api/v2/agents/:agentId/wake", async (req: Request, res: Response) => {
    const agentId = String(req.params["agentId"] ?? "").trim();
    if (!agentId) {
      sendError(res, 400, "MISSING_AGENT", "agentId is required");
      return;
    }
    const wb = req.body as {
      message?: string;
      operator_role?: string;
      intent?: string;
      task_id?: string;
      thread_key?: string;
      attachments?: unknown;
      ui_lang?: unknown;
    };
    const message = String(wb.message ?? "开工").trim() || "开工";
    const intentRaw = String(wb.intent ?? "wake").toLowerCase();
    const intent: DirectSessionIntent =
      intentRaw === "patrol" ? "patrol" : "wake";
    const operatorRole = normalizeDirectOperatorRole(wb.operator_role);
    await handleDirectSession(res, {
      agentId,
      message,
      intent,
      operatorRole,
      taskId: wb.task_id,
      threadKey: wb.thread_key,
      attachments: normalizeAndEnrichAttachments(getProjectRoot(), wb.attachments),
      uiLang: normalizeUiLang(wb.ui_lang),
    });
  });

  /**
   * GET /api/v2/chat/messages
   * Query: ?agentId=PM-01&limit=50
   * Returns recent direct-chat messages (user + agent replies).
   */
  app.get("/api/v2/chat/messages", (req: Request, res: Response) => {
    const { agentId, limit = "80" } = req.query as { agentId?: string; limit?: string };
    const msgs = agentId
      ? directChat.filter((m) => m.agentId === agentId)
      : directChat;
    res.setHeader("Cache-Control", "no-store");
    res.json(msgs.slice(-Number(limit)));
  });

  function projectRoot(): string {
    return resolveProjectRoot();
  }

  // ── Chat history API ─────────────────────────────────────────────────
  /**
   * GET /api/v2/chat/history
   * Returns merged ADMIN↔PM chat: ADMIN-to-PM task files + PM-to-ADMIN report files.
   * Each entry: { role, filename, seq, ts, text }
   */
  app.get("/api/v2/chat/history", async (_req: Request, res: Response) => {
    try {
      const root = opts.projectRoot ?? getProjectRoot();
      const entries = collectFormalChatHistory(root, 60);
      res.json(entries);
    } catch (err) {
      sendError(res, 500, "CHAT_HISTORY_FAILED", String(err));
    }
  });

  // ── Failure logger ───────────────────────────────────────────────────
  const failureLogger = opts.failuresDir ? new FailureLogger(opts.failuresDir) : null;

  // ── Doorbell ring buffer + query API (v1.2) ──────────────────────────
  /**
   * In-memory ring buffer: captures sdk.tool_call / sdk.thinking /
   * sdk.status / codeflowmu.failure events for the /api/v2/doorbell/* REST
   * endpoints.  Max 1000 entries; oldest evicted on overflow.
   */
  const doorbellBuffer = new DoorbellBuffer(1000);
  const projectRootForLogs = resolveProjectRoot();
  ensureFcopLogsAssetLayout(projectRootForLogs);
  runtimeEventLogger = new RuntimeEventFileLogger(projectRootForLogs);
  analyticsLedger = new AnalyticsLedger(projectRootForLogs);
  void analyticsLedger.bootstrapFromRegistry(runtime.registry);
  for (const rec of runtimeEventLogger.tailRecent(500)) {
    doorbellBuffer.hydrateFromDisk(
      rec.event_type,
      {
        ...(rec.payload ?? {}),
        ...(rec.agent_id ? { agent_id: rec.agent_id } : {}),
        ...(rec.session_id ? { session_id: rec.session_id } : {}),
        ...(rec.task_id ? { task_id: rec.task_id } : {}),
      },
      rec.ts,
    );
  }

  function parseLogCenterQuery(req: Request): LogCenterQueryParams {
    const sinceRaw = req.query["since"];
    const limitRaw = req.query["limit"];
    const tabRaw = req.query["tab"];
    const tab =
      tabRaw &&
      [
        "all",
        "alerts",
        "runtime",
        "tools",
        "actions",
        "sessions",
        "wake",
        "skills",
        "gateway",
        "raw",
      ].includes(String(tabRaw))
        ? (String(tabRaw) as LogCenterQueryParams["tab"])
        : undefined;
    return {
      tab,
      agent: req.query["agent"] ? String(req.query["agent"]) : undefined,
      role: req.query["role"] ? String(req.query["role"]) : undefined,
      skill_id: req.query["skill_id"]
        ? String(req.query["skill_id"])
        : undefined,
      task_id: req.query["task_id"] ? String(req.query["task_id"]) : undefined,
      session_id: req.query["session_id"]
        ? String(req.query["session_id"])
        : undefined,
      event_type: req.query["event_type"]
        ? String(req.query["event_type"])
        : undefined,
      status: req.query["status"] ? String(req.query["status"]) : undefined,
      reason: req.query["reason"] ? String(req.query["reason"]) : undefined,
      since: sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined,
      limit: limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined,
    };
  }

  /**
   * GET /api/v2/log-center/query — unified log center (doorbell + runtime-events.jsonl).
   */
  app.get("/api/v2/log-center/query", async (req: Request, res: Response) => {
    try {
      const params = parseLogCenterQuery(req);
      const tab = params.tab ?? "all";
      const root = projectRoot();
      let extraRows: LogCenterRow[] = [];
      if (tab === "skills" || tab === "all") {
        const recs = await enrichSkillInvocationsForDisplay(
          root,
          await readRecentSkillInvocations(root, 300),
        );
        extraRows = recs.map(skillInvocationToLogCenterRow);
      }
      if (tab === "actions" || tab === "all") {
        const actionRecs = readRecentActionEvidence(root, 300);
        extraRows = [
          ...extraRows,
          ...actionRecs.map(actionEvidenceToLogCenterRow),
        ];
      }
      if (tab === "gateway" || tab === "all") {
        const gwLimit =
          tab === "gateway"
            ? Math.min(Math.max(params.limit ?? 100, 1), 300)
            : 100;
        const gwEntries = readRecentGatewayLogs(
          root,
          gwLimit,
          params.since,
        );
        extraRows = [
          ...extraRows,
          ...gwEntries.map((e, i) => gatewayLogToLogCenterRow(e, i)),
        ];
      }
      const queryParams =
        tab === "gateway"
          ? {
              ...params,
              limit: Math.min(Math.max(params.limit ?? 100, 1), 300),
            }
          : params;
      const result = queryLogCenter(
        doorbellBuffer,
        runtimeEventLogger,
        queryParams,
        extraRows,
      );
      if (tab === "gateway" || tab === "all") {
        result.jsonl_path = fcopLogsGatewayPath(root);
      }
      if (tab === "actions" || tab === "all") {
        result.actions_path = actionEvidenceDisplayPath(root);
      }
      res.json(result);
    } catch (err) {
      sendError(res, 500, "LOG_CENTER_QUERY_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/logs?source=gateway&limit=100 — gateway JSONL tail (dedicated API).
   */
  app.get("/api/v2/logs", async (req: Request, res: Response) => {
    try {
      const source = req.query["source"] ? String(req.query["source"]) : "";
      if (source !== "gateway") {
        res.status(400).json({ ok: false, error: "UNSUPPORTED_SOURCE" });
        return;
      }
      const limitRaw = req.query["limit"];
      const limit = Math.min(
        Math.max(
          limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 100,
          1,
        ),
        300,
      );
      const sinceRaw = req.query["since"];
      const since =
        sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined;
      const root = projectRoot();
      const entries = readRecentGatewayLogs(root, limit, since);
      res.json({
        ok: true,
        source: "gateway",
        path: fcopLogsGatewayPath(root),
        total: entries.length,
        rows: entries.map((e, i) => gatewayLogToLogCenterRow(e, i)),
        entries,
      });
    } catch (err) {
      sendError(res, 500, "LOGS_QUERY_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/panel/runtime-actions — 仪表盘「最近运行时动作」
   */
  app.get("/api/v2/panel/runtime-actions", (req: Request, res: Response) => {
    try {
      const limitRaw = parseInt(String(req.query["limit"] ?? "15"), 10);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 15;
      const root = projectRoot();
      const actions = queryPanelRuntimeActions(root, limit);
      res.json({
        ok: true,
        limit,
        count: actions.length,
        actions,
        log_path: fcopLogsPanelActionsPath(root),
      });
    } catch (err) {
      sendError(res, 500, "PANEL_RUNTIME_ACTIONS_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/panel/runtime-actions — 面板客户端补充记录（催单等）
   */
  app.post("/api/v2/panel/runtime-actions", (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Partial<PanelRuntimeActionInput>;
      if (!body.action) {
        sendError(res, 400, "MISSING_ACTION", "action is required");
        return;
      }
      const rec = appendPanelRuntimeAction(projectRoot(), {
        operator: String(body.operator ?? "ADMIN"),
        action: String(body.action),
        ...(body.target_agent ? { target_agent: body.target_agent } : {}),
        ...(body.target_task ? { target_task: body.target_task } : {}),
        result: body.result ?? "ok",
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.detail ? { detail: body.detail } : {}),
        ...(body.session_id ? { session_id: body.session_id } : {}),
        ...(body.model_id ? { model_id: body.model_id } : {}),
      });
      res.json({ ok: true, action: rec });
    } catch (err) {
      sendError(res, 500, "PANEL_RUNTIME_ACTIONS_APPEND_FAILED", String(err));
    }
  });

  function parseAnalyticsQuery(req: Request): AnalyticsQueryParams {
    const sinceRaw = req.query["since"];
    const limitRaw = req.query["limit"];
    return {
      platform: req.query["platform"] ? String(req.query["platform"]) : undefined,
      role: req.query["role"] ? String(req.query["role"]) : undefined,
      model_id: req.query["model_id"] ? String(req.query["model_id"]) : undefined,
      agent_id: req.query["agent_id"] ? String(req.query["agent_id"]) : undefined,
      session_id: req.query["session_id"]
        ? String(req.query["session_id"])
        : undefined,
      task_id: req.query["task_id"] ? String(req.query["task_id"]) : undefined,
      event_type: req.query["event_type"]
        ? String(req.query["event_type"])
        : undefined,
      since: sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined,
      limit: limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined,
    };
  }

  /**
   * GET /api/v2/analytics/query — 统一分析账本（platform / role / model_id 等维度）。
   */
  app.get("/api/v2/analytics/query", (req: Request, res: Response) => {
    if (!analyticsLedger) {
      sendError(res, 503, "ANALYTICS_UNAVAILABLE", "analytics ledger not ready");
      return;
    }
    res.json({ rows: analyticsLedger.query(parseAnalyticsQuery(req)) });
  });

  /**
   * GET /api/v2/analytics/summary — 按 platform / role / model 聚合计数。
   */
  app.get("/api/v2/analytics/summary", (req: Request, res: Response) => {
    if (!analyticsLedger) {
      sendError(res, 503, "ANALYTICS_UNAVAILABLE", "analytics ledger not ready");
      return;
    }
    const sinceRaw = req.query["since"];
    const since =
      sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined;
    res.json(analyticsLedger.summarize(since));
  });

  function parseDoorQuery(req: Request): DoorbellQueryOpts {
    return {
      agent: req.query["agent"] ? String(req.query["agent"]) : undefined,
      type:  req.query["type"]  ? String(req.query["type"])  : undefined,
      limit: req.query["limit"] ? Number(req.query["limit"]) : 50,
      since: req.query["since"] ? Number(req.query["since"]) : undefined,
    };
  }

  /**
   * GET /api/v2/doorbell/events — tool-call events (sdk.tool_call).
   * Query: ?agent=DEV-01&limit=50&since=<ts_ms>
   */
  app.get("/api/v2/doorbell/events", (req: Request, res: Response) => {
    res.json(doorbellBuffer.query({ ...parseDoorQuery(req), types: DOORBELL_BUCKET_TOOLS }));
  });

  /**
   * GET /api/v2/doorbell/failures — failure events (codeflowmu.failure).
   * Query: ?agent=DEV-01&limit=20&since=<ts_ms>
   */
  app.get("/api/v2/doorbell/failures", (req: Request, res: Response) => {
    res.json(doorbellBuffer.query({ ...parseDoorQuery(req), types: DOORBELL_BUCKET_FAILURES }));
  });

  /**
   * GET /api/v2/doorbell/system — system events (sdk.thinking, sdk.status).
   * Query: ?agent=DEV-01&limit=20&since=<ts_ms>
   */
  function backfillDoorbellFromRuntimeLog(): void {
    if (!runtimeEventLogger) return;
    const seen = new Set(
      doorbellBuffer.query({ limit: 500 }).events.map(
        (e) => `${e.event_type}:${e.ts}:${e.task_id ?? ""}`,
      ),
    );
    for (const rec of runtimeEventLogger.tailRecent(500)) {
      if (!DOORBELL_BUCKET_SYSTEM.includes(rec.event_type)) continue;
      const key = `${rec.event_type}:${rec.ts}:${rec.task_id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      doorbellBuffer.hydrateFromDisk(
        rec.event_type,
        {
          ...(rec.payload ?? {}),
          ...(rec.task_id ? { task_id: rec.task_id } : {}),
          ...(rec.agent_id ? { agent_id: rec.agent_id } : {}),
          ...(rec.session_id ? { session_id: rec.session_id } : {}),
        },
        rec.ts,
      );
    }
  }

  app.get("/api/v2/doorbell/system", (req: Request, res: Response) => {
    backfillDoorbellFromRuntimeLog();
    res.json(doorbellBuffer.query({ ...parseDoorQuery(req), types: DOORBELL_BUCKET_SYSTEM }));
  });

  /**
   * GET /api/v2/doorbell — all events, with optional ?type= filter.
   */
  app.get("/api/v2/doorbell", (req: Request, res: Response) => {
    res.json(doorbellBuffer.query(parseDoorQuery(req)));
  });

  /**
   * GET /api/v2/doorbell/wake-chain?task_id=TASK-...
   * 聚合 wake → session → report 持久化链路（重启后仍可读 runtime-events.jsonl）。
   */
  app.get("/api/v2/doorbell/wake-chain", (req: Request, res: Response) => {
    const taskId = String(req.query["task_id"] ?? "").trim();
    if (!taskId) {
      sendError(res, 400, "MISSING_TASK_ID", "task_id query param is required");
      return;
    }
    if (!runtimeEventLogger) {
      sendError(res, 503, "EVENT_LOGGER_UNAVAILABLE", "runtime event logger not ready");
      return;
    }
    res.json(runtimeEventLogger.queryWakeChain(taskId));
  });

  // ── Git status & commit endpoints ────────────────────────────────────
  /**
   * GET /api/v2/git/status — returns branch, last commit, uncommitted count.
   */
  app.get("/api/v2/git/status", async (_req: Request, res: Response) => {
    try {
      const cwd = resolveGitRoot();
      if (isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd)) {
        res.status(403).json({
          ok: false,
          code: "OPEN_EDITION_TOOL_REPO_PROTECTED",
          error:
            "CodeFlowMu Open is an application tool. Git status is only available for an external development project root.",
        });
        return;
      }
      if (rejectOpenEditionProjectGitNotConfigured(res, cwd)) return;
      const payload = await wpReadGitStatusPayload(cwd);
      res.json({ ...payload, cwd, remoteUrl: await wpReadGitRemoteUrl(cwd), hasOwnGit: wpHasOwnGitRepository(cwd) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/v2/git/config", async (_req: Request, res: Response) => {
    try {
      const cwd = resolveGitRoot();
      const protectedRoot = isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd);
      const hasOwnGit = wpHasOwnGitRepository(cwd);
      res.json({
        ok: true,
        cwd,
        protectedRoot,
        hasOwnGit,
        remoteUrl: hasOwnGit ? await wpReadGitRemoteUrl(cwd) : "",
        branch: hasOwnGit ? await wpReadGitBranch(cwd) : "main",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post("/api/v2/git/config", async (req: Request, res: Response) => {
    try {
      const cwd = resolveGitRoot();
      if (isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd)) {
        return res.status(403).json({
          ok: false,
          code: "OPEN_EDITION_TOOL_REPO_PROTECTED",
          error:
            "CodeFlowMu Open cannot configure Git for its own tool repository. Switch to a development project first.",
        });
      }
      const remoteUrl = String(req.body?.remoteUrl ?? "").trim();
      const branch = String(req.body?.branch ?? "main").trim() || "main";
      if (!remoteUrl) {
        return res.status(400).json({
          ok: false,
          code: "REMOTE_URL_REQUIRED",
          error: "请填写当前开发项目的 GitHub Remote URL。",
        });
      }
      if (!(await trustedForegroundConfirmation({
        title: "CodeFlowMu Git 远端配置确认",
        message: [
          "确认修改当前项目的 Git 分支与远端地址？",
          "",
          `项目根目录：${cwd}`,
          `分支：${branch}`,
          `远端：${remoteUrl}`,
          "影响：后续推送将发送到以上远端；本次不会执行推送",
          "",
          "取消后不会初始化仓库、切换分支或修改 origin。",
        ].join("\n"),
      }))) {
        return sendError(res, 409, "GIT_CONFIG_CONFIRMATION_CANCELLED", "用户取消了 Git 远端配置变更");
      }
      mkdirSync(cwd, { recursive: true });
      if (!wpHasOwnGitRepository(cwd)) {
        await execFile("git", ["init"], { cwd, timeout: 30000 });
      }
      try {
        await execFile("git", ["checkout", "-B", branch], { cwd, timeout: 30000 });
      } catch {
        await execFile("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd, timeout: 30000 });
      }
      try {
        await execFile("git", ["remote", "set-url", "origin", remoteUrl], { cwd, timeout: 30000 });
      } catch {
        await execFile("git", ["remote", "add", "origin", remoteUrl], { cwd, timeout: 30000 });
      }
      res.json({
        ok: true,
        cwd,
        hasOwnGit: true,
        remoteUrl: await wpReadGitRemoteUrl(cwd),
        branch: await wpReadGitBranch(cwd),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  /**
   * POST /api/v2/git/commit — runs `git add -A && git commit -m <message>`.
   */
  app.post("/api/v2/git/commit", async (req: Request, res: Response) => {
    try {
      const message =
        typeof req.body?.message === "string" && req.body.message.trim()
          ? req.body.message.trim()
          : "chore: panel manual commit";
      const cwd = resolveGitRoot();
      if (isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd)) {
        return res.status(403).json({
          ok: false,
          code: "OPEN_EDITION_TOOL_REPO_PROTECTED",
          error:
            "CodeFlowMu Open cannot commit its own tool repository. Switch to an external development project root first.",
        });
      }
      if (rejectOpenEditionProjectGitNotConfigured(res, cwd)) return;
      const opts = { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 * 4 };

      const preDiag = await wpReadGitDiagnostics(cwd);
      wpLogGitCommitDiagnostics("pre-commit", preDiag);

      const { stdout: statusStdout } = await execFile(
        "git",
        ["status", "--porcelain=v1", "-z"],
        opts,
      );
      const rawStatus = String(statusStdout ?? "");
      const statusFiles = wpParseGitStatusPorcelainZ(rawStatus);
      const productFiles = statusFiles.filter((file) => !wpIsMotherRuntimeLedgerPath(file.path));
      if (rawStatus.trim().length === 0 || productFiles.length === 0) {
        const gitStatus = await wpReadGitStatusPayload(cwd);
        const postDiag = await wpReadGitDiagnostics(cwd);
        wpLogGitCommitDiagnostics("post-commit (skipped, clean)", postDiag);
        return res.json({
          ok: true,
          skipped: true,
          reason: rawStatus.trim().length === 0 ? "nothing to commit" : "runtime only",
          message: rawStatus.trim().length === 0 ? "working tree clean" : "only runtime records changed",
          gitStatus,
        });
      }

      await wpStageGitPaths(cwd, productFiles.map((file) => file.path));
      const { stdout } = await execFile("git", ["commit", "-m", message], opts);
      const out = (stdout as string).trim();

      if (out.includes("nothing to commit")) {
        const gitStatus = await wpReadGitStatusAfterCommit(cwd);
        const postDiag = await wpReadGitDiagnostics(cwd);
        wpLogGitCommitDiagnostics("post-commit (skipped after add)", postDiag);
        return res.json({
          ok: true,
          skipped: true,
          reason: "nothing to commit",
          message: "working tree clean",
          gitStatus,
        });
      }

      const hashMatch = out.match(/\[[\w./]+\s+([0-9a-f]+)\]/);
      const hash = hashMatch ? hashMatch[1] : "";
      const gitStatus = await wpReadGitStatusAfterCommit(cwd);
      const postDiag = await wpReadGitDiagnostics(cwd);
      wpLogGitCommitDiagnostics("post-commit", postDiag);

      return res.json({ ok: true, hash, gitStatus });
    } catch (err: unknown) {
      const msg = wpGitCommandErrorMessage(err);
      if (msg.includes("nothing to commit")) {
        try {
          const cwd = resolveGitRoot();
          const gitStatus = await wpReadGitStatusAfterCommit(cwd);
          const postDiag = await wpReadGitDiagnostics(cwd);
          wpLogGitCommitDiagnostics("post-commit (error path, clean)", postDiag);
          return res.json({
            ok: true,
            skipped: true,
            reason: "nothing to commit",
            message: "working tree clean",
            gitStatus,
          });
        } catch {
          /* fall through */
        }
      }
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post("/api/v2/git/push", async (req: Request, res: Response) => {
    try {
      const cwd = resolveGitRoot();
      if (isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd)) {
        return res.status(403).json({
          ok: false,
          code: "OPEN_EDITION_TOOL_REPO_PROTECTED",
          error:
            "CodeFlowMu Open cannot push its own tool repository. Switch to a development project first.",
        });
      }
      if (rejectOpenEditionProjectGitNotConfigured(res, cwd)) return;
      const branch = String((req.body?.branch ?? (await wpReadGitBranch(cwd))) || "main").trim() || "main";
      const remoteUrl = await wpReadGitRemoteUrl(cwd);
      if (!remoteUrl) {
        return res.status(400).json({
          ok: false,
          code: "REMOTE_URL_REQUIRED",
          error: "当前开发项目还没有配置 GitHub Remote URL。",
        });
      }
      const prepared = operationApprovalService().prepare(await buildGitPushApprovalInput({
        cwd,
        branch,
        subject: {
          actor: String(req.body?.requested_by ?? "PANEL-REQUEST").trim() || "PANEL-REQUEST",
          role: String(req.body?.role ?? "AGENT").trim() || "AGENT",
          project_id: activeProjectId || "active-project",
          ...(req.body?.agent_id ? { agent_id: String(req.body.agent_id) } : {}),
          ...(req.body?.session_id ? { session_id: String(req.body.session_id) } : {}),
          ...(req.body?.task_id ? { task_id: String(req.body.task_id) } : {}),
        },
      }));
      res.status(prepared.decision === "REQUIRE_APPROVAL" ? 202 : 200).json({
        ok: true,
        cwd,
        branch,
        remoteUrl,
        ...prepared,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  /**
   * GET /api/v2/git/log — returns last N commits (default 5).
   */
  app.get("/api/v2/git/log", async (req: Request, res: Response) => {
    try {
      const n = Math.min(parseInt(String(req.query.n ?? "5"), 10) || 5, 20);
      const cwd = resolveGitRoot();
      if (isOpenEditionMode() && isProtectedOpenEditionAppRoot(cwd)) {
        res.status(403).json({
          ok: false,
          code: "OPEN_EDITION_TOOL_REPO_PROTECTED",
          error:
            "CodeFlowMu Open is an application tool. Git log is only available for an external development project root.",
        });
        return;
      }
      if (rejectOpenEditionProjectGitNotConfigured(res, cwd)) return;
      const fmt = "%H\x1f%h\x1f%s\x1f%cr";
      const { stdout } = await execFile(
        "git",
        ["log", `-${n}`, `--pretty=format:${fmt}`],
        { cwd, timeout: 10000 }
      );
      const lines = (stdout as string).trim().split("\n").filter(Boolean);
      const commits = lines.map((line) => {
        const [hash, short, subject, date] = line.split("\x1f");
        return { hash, short, subject, date };
      });
      return res.json(commits);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  });

  // ── Sprint-A1: EVAL summary endpoint ───────────────────────────────────

  /**
   * GET /api/v2/eval/reports — ADMIN/EVAL 面板专用：internal/eval 观察记录列表（OBSERVATION + legacy AUDIT；不含团队 reports）。
   */
  app.get("/api/v2/eval/reports", async (_req: Request, res: Response) => {
    try {
      const items = listEvalAuditFiles(projectRoot(), 100);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/v2/eval/promotion-state?path= — 读取 EVAL 文件嵌套 promotion: 状态 */
  app.get("/api/v2/eval/promotion-state", (req: Request, res: Response) => {
    try {
      const relPath = String(req.query.path ?? req.query.rel_path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "path query required" });
        return;
      }
      const st = readEvalPromotionState(getProjectRoot(), relPath);
      res.json({ ok: true, ...st });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /**
   * GET /api/v2/eval/summary — EVAL 观察窗口摘要（只读 internal/eval + emergence-log）。
   */
  app.get("/api/v2/eval/summary", async (_req: Request, res: Response) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const root = projectRoot();
      const audits = listEvalAuditFiles(root, 20);

      let violations: { file: string; severity: string; role: string }[] = [];
      let lastRun: string | null = null;
      const filesChecked = audits.length;

      if (audits.length) {
        const latest = audits[0]!;
        lastRun = latest.created_at || null;
        if (!lastRun) {
          const m = latest.filename.match(/(?:AUDIT|OBSERVATION)-(\d{8})/);
          if (m) {
            const ds = m[1]!;
            lastRun = new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8)).toISOString();
          }
        }
        try {
          const raw = await readFile(join(root, ...latest.rel_path.split("/")), "utf-8");
          const matches = raw.match(/[-*]\s+\*?\*?([A-Z]+)\*?\*?:\s+(.+)/g) || [];
          violations = matches.slice(0, 20).map((m) => {
            const sev = /HIGH|CRITICAL/i.test(m) ? "HIGH" : /MEDIUM/i.test(m) ? "MEDIUM" : "LOW";
            return { file: m.replace(/[-*]\s+/, "").slice(0, 60), severity: sev, role: "EVAL" };
          });
        } catch {
          /* 摘要解析失败时仍返回 score */
        }
      }

      // Emergence count from emergence-log.md
      const emergePath = join(root, "fcop", "internal", "emergence-log.md");
      let emergenceCount = 0;
      let score = 85;
      if (existsSync(emergePath)) {
        const emergRaw = await readFile(emergePath, "utf-8");
        emergenceCount = (emergRaw.match(/^[-*]\s+/gm) || []).length;
        // Simple score: start at 100, deduct for violations, reward for emergence
        score = Math.max(0, Math.min(100,
          100 - violations.length * 3 + Math.min(emergenceCount, 5) * 2
        ));
      }

      res.json({
        ok: true,
        last_run: lastRun,
        files_checked: filesChecked,
        violations_count: violations.length,
        violations,
        emergence_count: emergenceCount,
        score: Math.round(score),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/v2/eval/history — 近 7 日 internal/eval 观察记录（按日聚合）。
   */
  app.get("/api/v2/eval/history", async (_req: Request, res: Response) => {
    try {
      const root = projectRoot();
      const audits = listEvalAuditFiles(root, 200);
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const byDate = new Map<string, typeof audits>();

      for (const a of audits) {
        let key: string | null = null;
        if (a.created_at) {
          const d = new Date(a.created_at);
          if (now - d.getTime() <= sevenDays) key = d.toISOString().slice(0, 10);
        }
        if (!key) {
          const m =
            a.filename.match(/(?:AUDIT|OBSERVATION)-(\d{4})(\d{2})(\d{2})/) ||
            a.filename.match(/(\d{8})/);
          if (m) {
            const ds = m[0].length === 8 ? m[0] : `${m[1]}${m[2]}${m[3]}`;
            const d = new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8));
            if (now - d.getTime() <= sevenDays) {
              key = `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
            }
          }
        }
        if (!key) continue;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key)!.push(a);
      }

      const history = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, dayAudits]) => {
          const latest = dayAudits[dayAudits.length - 1]!;
          return {
            date,
            score: latest.score ?? 75,
            violations: 0,
            files_checked: dayAudits.length,
            filename: latest.filename,
            rel_path: latest.rel_path,
          };
        });

      res.json(history);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** POST /api/v2/eval/promote/task — EVAL → 本地任务草稿（待 ADMIN 确认后落地 inbox） */
  app.post("/api/v2/eval/promote/task", (req: Request, res: Response) => {
    try {
      const body = req.body as { rel_path?: string; path?: string };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const root = getProjectRoot();
      const v3 = fcopV3Paths(root);
      const result = promoteEvalToLocalTask({
        projectRoot: root,
        adminInboxDir: opts.adminTasksDir ?? v3.inbox,
        evalRelPath: relPath,
        allocateTaskSeq: (date) => _wpNextTaskSeq(root, date),
        promotedBy: "ADMIN",
      });
      invalidateLedgerFreshCache(root);
      res.json(result);
    } catch (err) {
      const gate = formatEvalTaskPromoteGateError(err);
      res.status(gate.status).json(gate.body);
    }
  });

  /** POST /api/v2/eval/promote/codeflowmu-issue-draft */
  app.post("/api/v2/eval/promote/codeflowmu-issue-draft", (req: Request, res: Response) => {
    try {
      const body = req.body as { rel_path?: string; path?: string };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const root = getProjectRoot();
      const v3 = fcopV3Paths(root);
      const result = promoteEvalToCodeflowMuIssueDraft({
        projectRoot: root,
        adminInboxDir: opts.adminTasksDir ?? v3.inbox,
        evalRelPath: relPath,
        allocateTaskSeq: (date) => _wpNextTaskSeq(root, date),
        promotedBy: "ADMIN",
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /** POST /api/v2/eval/promote/fcop-issue-draft */
  app.post("/api/v2/eval/promote/fcop-issue-draft", (req: Request, res: Response) => {
    try {
      const body = req.body as { rel_path?: string; path?: string };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const root = getProjectRoot();
      const v3 = fcopV3Paths(root);
      const result = promoteEvalToFcopIssueDraft({
        projectRoot: root,
        adminInboxDir: opts.adminTasksDir ?? v3.inbox,
        evalRelPath: relPath,
        allocateTaskSeq: (date) => _wpNextTaskSeq(root, date),
        promotedBy: "ADMIN",
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /** POST /api/v2/eval/submit/issue-draft — Issue 草稿经 ADMIN 确认后正式 gh issue create */
  app.post("/api/v2/eval/submit/issue-draft", (req: Request, res: Response) => {
    try {
      const body = req.body as {
        rel_path?: string;
        path?: string;
        admin_approved?: boolean;
        draftRelPath?: string;
        draft_rel_path?: string;
      };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const adminApproved = body.admin_approved === true;
      const draftRelPath = String(body.draftRelPath ?? body.draft_rel_path ?? "").trim();
      const root = getProjectRoot();
      const result = submitEvalIssueDraft({
        projectRoot: root,
        evalRelPath: relPath,
        adminApproved,
        promotedBy: "ADMIN",
        ...(draftRelPath ? { draftRelPath } : {}),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /** POST /api/v2/eval/submit/task-draft — 本地任务草稿经 ADMIN 确认后落地 inbox */
  app.post("/api/v2/eval/submit/task-draft", (req: Request, res: Response) => {
    try {
      const body = req.body as { rel_path?: string; path?: string; admin_approved?: boolean };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const adminApproved = body.admin_approved === true;
      const root = getProjectRoot();
      const v3 = fcopV3Paths(root);
      const result = submitEvalLocalTaskDraft({
        projectRoot: root,
        adminInboxDir: opts.adminTasksDir ?? v3.inbox,
        evalRelPath: relPath,
        adminApproved,
        promotedBy: "ADMIN",
      });
      invalidateLedgerFreshCache(root);
      res.json(result);
    } catch (err) {
      const gate = formatEvalTaskPromoteGateError(err);
      res.status(gate.status).json(gate.body);
    }
  });

  /** POST /api/v2/eval/delete/draft — 删除当前 EVAL 的晋升草稿并重置为 pending */
  app.post("/api/v2/eval/delete/draft", (req: Request, res: Response) => {
    try {
      const body = req.body as {
        rel_path?: string;
        path?: string;
        draftRelPath?: string;
        draft_rel_path?: string;
      };
      const relPath = String(body.rel_path ?? body.path ?? "").trim();
      if (!relPath) {
        res.status(400).json({ ok: false, error: "rel_path required" });
        return;
      }
      const draftRelPath = String(body.draftRelPath ?? body.draft_rel_path ?? "").trim();
      const root = getProjectRoot();
      const result = deleteEvalPromotionDraft({
        projectRoot: root,
        evalRelPath: relPath,
        ...(draftRelPath ? { draftRelPath } : {}),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /**
   * POST /api/v2/eval/run — 生成观察报告（spawn eval-01.js，进度见 .observation-run.json）
   */
  app.post("/api/v2/eval/run", async (req: Request, res: Response) => {
    try {
      const pRoot = getProjectRoot();
      const body = req.body as { task_id?: string };
      const taskId =
        typeof body.task_id === "string" && body.task_id.trim()
          ? body.task_id.trim()
          : `MANUAL-EVAL-${Date.now()}`;
      const started = await spawnEval01(pRoot, taskId);
      res.json({
        ok: true,
        message: "观察报告生成已启动",
        task_id: started.task_id,
        run_id: started.run_id,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/v2/eval/run/status — 轮询观察报告生成进度 */
  app.get("/api/v2/eval/run/status", (_req: Request, res: Response) => {
    try {
      const pRoot = getProjectRoot();
      const progress = readEvalRunProgress(pRoot);
      if (!progress) {
        res.json({ ok: true, phase: "idle", message: "暂无进行中的生成任务" });
        return;
      }
      res.json({ ok: true, progress });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/v2/eval/settings — 观察员触发配置 + watcher 运行状态
   */
  app.get("/api/v2/eval/settings", (_req: Request, res: Response) => {
    try {
      const root = getProjectRoot();
      const config = readEvalObserverConfig(root);
      const watcher = getEvalWatcherStatus(root);
      res.json({ ok: true, config, watcher });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * PUT /api/v2/eval/settings — 更新配置（默认不自启 watcher）
   */
  app.put("/api/v2/eval/settings", (req: Request, res: Response) => {
    try {
      const root = getProjectRoot();
      const body = req.body as Partial<EvalObserverConfig>;
      const allowed: Partial<EvalObserverConfig> = {};
      if (typeof body.watcher_auto_start === "boolean") {
        allowed.watcher_auto_start = body.watcher_auto_start;
      }
      if (typeof body.trigger_on_task_create === "boolean") {
        allowed.trigger_on_task_create = body.trigger_on_task_create;
      }
      if (typeof body.schedule_enabled === "boolean") {
        allowed.schedule_enabled = body.schedule_enabled;
      }
      if (typeof body.schedule_time === "string" && /^\d{2}:\d{2}$/.test(body.schedule_time)) {
        allowed.schedule_time = body.schedule_time;
      }
      const config = writeEvalObserverConfig(root, allowed);
      res.json({ ok: true, config, watcher: getEvalWatcherStatus(root) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /api/v2/eval/watcher/stop — 停止常驻 watcher（止血）
   */
  app.post("/api/v2/eval/watcher/stop", (_req: Request, res: Response) => {
    try {
      const root = getProjectRoot();
      const result = stopEvalWatcher(root);
      res.json({ ok: true, ...result, watcher: getEvalWatcherStatus(root) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── System: in-panel directory browser (Shell host machine) ───────────────

  app.get("/api/v2/system/browse-directory", (req: Request, res: Response) => {
    try {
      const requested = typeof req.query.path === "string" ? req.query.path.trim() : "";
      const protectedRoot = openEditionProtectedHostRoot();
      const fallback =
        protectedRoot ? path.dirname(protectedRoot) : (process.platform === "win32" ? "D:\\" : os.homedir());
      const current = requested ? pathResolve(requested) : pathResolve(fallback);
      const roots: string[] =
        process.platform === "win32"
          ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
              .split("")
              .map((letter) => `${letter}:\\`)
              .filter((drive) => existsSync(drive))
          : ["/", os.homedir()].filter((p, idx, arr) => !!p && arr.indexOf(p) === idx);
      const safeCurrent =
        existsSync(current) && statSync(current).isDirectory()
          ? current
          : roots[0] ?? os.homedir();
      const parent = path.dirname(safeCurrent);
      const entries = readdirSync(safeCurrent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const fullPath = join(safeCurrent, entry.name);
          let readable = true;
          try {
            statSync(fullPath);
          } catch {
            readable = false;
          }
          return { name: entry.name, path: fullPath, readable };
        })
        .filter((entry) => !entry.name.startsWith("$"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .slice(0, 300);
      res.json({
        ok: true,
        path: safeCurrent,
        parent: parent && parent !== safeCurrent ? parent : "",
        roots,
        entries,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── System: native directory picker (Shell host machine) ─────────────────

  let directoryPickerBusy = false;

  /**
   * POST /api/v2/system/pick-directory — open OS folder dialog; body { initial? }.
   */
  app.post("/api/v2/system/pick-directory", (req: Request, res: Response) => {
    if (directoryPickerBusy) {
      return res.status(409).json({
        ok: false,
        error: "directory picker already open",
      });
    }
    directoryPickerBusy = true;
    try {
      const initial =
        typeof req.body?.initial === "string" ? req.body.initial : "";
      const result = pickDirectoryNative(initial);
      if (result.ok) {
        return res.json({ ok: true, path: result.path });
      }
      if (result.cancelled) {
        return res.json({ ok: false, cancelled: true });
      }
      return res.status(500).json({ ok: false, error: result.error });
    } finally {
      directoryPickerBusy = false;
    }
  });

  // ── Sprint-7: Project management endpoints ─────────────────────────────

  /**
   * GET /api/v2/projects — list all registered projects.
   */
  app.get("/api/v2/projects", (_req: Request, res: Response) => {
    ensureProjectStore();
    res.json(projectList());
  });

  app.get("/api/v2/projects/default-root", (_req: Request, res: Response) => {
    res.json({ projectsRoot: projectsCollectionRoot(resolveBootstrapProjectRoot()) });
  });

  /**
   * POST /api/v2/projects — register a new project { name, root }.
   */
  app.post("/api/v2/projects", (req: Request, res: Response) => {
    ensureProjectStore();
    const { name, root: rawRoot } = req.body ?? {};
    const workspaceMode: WorkspaceMode =
      req.body?.workspaceMode === "multi" ? "multi" : "root";
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    if (typeof rawRoot !== "string" || !rawRoot.trim()) {
      return res.status(400).json({ error: "root required" });
    }
    const root = pathResolve(rawRoot.trim());
    if (!existsSync(root)) {
      return res.status(400).json({ error: "root path does not exist" });
    }
    if (isProtectedOpenEditionAppRoot(root)) {
      return res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_APP_ROOT_PROTECTED",
        message:
          "Open edition cannot register its own CodeFlowMu-open source directory as a development project.",
      });
    }
    const id = `proj_${Date.now()}`;
    const project: Project = { id, name: name.trim(), root, active: false };
    // An adopted existing directory is the application root itself.  A
    // directory named workspace inside it may be legacy/supporting data and
    // must never silently turn the adopted project into a multi-product root.
    if (existsSync(join(root, "fcop", "fcop.json"))) {
      writeWorkspaceMode(root, workspaceMode);
    }
    projectStore.set(id, project);
    if (!activeProjectId || !projectStore.has(activeProjectId)) {
      activeProjectId = id;
      applyProjectScopedOpts(root);
      lastAppliedProjectRoot = pathResolve(root);
    }
    persistProjectStore();
    return res.json({ ok: true, project: { ...project, active: id === activeProjectId } });
  });

  /**
   * POST /api/v2/projects/create — create + FCoP-init + register an independent project.
   * Switching stays a separate explicit action so no running TASK can silently
   * move its Runtime/MCP/ledger context to another root mid-session.
   */
  app.post("/api/v2/projects/create", async (req: Request, res: Response) => {
    ensureProjectStore();
    const { name } = req.body ?? {};
    // A project created by CodeFlowMu is always a self-contained independent
    // root under the installation-level projects/ collection.  Its product
    // source remains separated in workspace/<slug>; arbitrary existing paths
    // belong to POST /api/v2/projects ("add/adopt existing project").
    const workspaceMode: WorkspaceMode = "multi";
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "name required" });
    }
    const normalizedName = name.trim();
    if (/[<>:"/\\|?*\x00-\x1f]/.test(normalizedName) || /[. ]$/.test(normalizedName)) {
      return res.status(400).json({ ok: false, error: "invalid project name" });
    }
    const root = pathResolve(
      projectsCollectionRoot(resolveBootstrapProjectRoot()),
      normalizedName,
    );
    if (isProtectedOpenEditionAppRoot(root)) {
      return res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_APP_ROOT_PROTECTED",
        message: "新项目根不能是 CodeFlowMu-open 工具代码目录。",
      });
    }
    if (Array.from(projectStore.values()).some((project) => samePath(project.root, root))) {
      return res.status(409).json({
        ok: false,
        error: "PROJECT_ALREADY_REGISTERED",
        message: "该目录已经登记为 CodeFlowMu 项目。",
      });
    }
    if (existsSync(root) && readdirSync(root).length > 0) {
      return res.status(409).json({
        ok: false,
        error: "PROJECT_CREATE_ROOT_NOT_EMPTY",
        message: "新建独立项目要求目录不存在或为空；已有代码请使用“添加已有项目”。",
      });
    }

    mkdirSync(root, { recursive: true });
    try {
      await deployRequiredProjectBootstrapProjection(root);
      const pyProbe = await probeFcopPythonPackages(undefined, opts.fcopRuntime);
      const pythonBin = pyProbe.pythonExecutable || "python";
      const initPyCmd = [
        "import sys",
        "from fcop.project import Project",
        "Project(sys.argv[1]).init(team='dev-team', lang='zh', force=True, deploy_rules=True)",
      ].join("; ");
      await execFile(pythonBin, ["-c", initPyCmd, root], { timeout: 120000 });
      writeWorkspaceMode(root, workspaceMode);
      await deployRequiredProjectBootstrapProjection(root);
      await deployPmPlanningProjectProjection(root);
      await deployOpenEditionProjectProjection(root);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "PROJECT_FCOP_INIT_FAILED",
        message: err instanceof Error ? err.message : String(err),
        root,
        recoverable: true,
      });
    }

    const id = `proj_${Date.now()}`;
    const project: Project = { id, name: normalizedName, root, active: false };
    projectStore.set(id, project);
    if (existsSync(join(root, "fcop", "fcop.json"))) {
      writeWorkspaceMode(root, workspaceMode);
    }
    persistProjectStore();
    return res.json({
      ok: true,
      project,
      initialized: true,
      workspaceMode,
      codeRoot: resolveArtifactRoot(root).artifactRoot,
      next_action: "switch_project_then_publish_task",
      message: "独立项目已创建并完成 FCoP 初始化；请切换为当前项目后再发布 TASK。",
    });
  });

  /**
   * POST /api/v2/projects/switch — switch active project { id }.
   */
  app.post("/api/v2/projects/switch", async (req: Request, res: Response) => {
    ensureProjectStore();
    const { id } = req.body ?? {};
    if (typeof id !== "string" || !projectStore.has(id)) {
      return res.status(404).json({ error: "project not found" });
    }
    const target = projectStore.get(id)!;
    if (target.id === "open-default-newproject" && isOpenEditionInstallLocalProjectPath(target.root)) {
      ensureOpenEditionProjectDirectory(pathResolve(target.root));
    }
    if (!existsSync(target.root)) {
      return res.status(400).json({ error: "project root no longer exists" });
    }
    if (isProtectedOpenEditionAppRoot(target.root)) {
      return res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_APP_ROOT_PROTECTED",
        message:
          "Open edition cannot switch to its own CodeFlowMu-open source directory as a development project.",
      });
    }
    await deployPmPlanningProjectProjection(target.root);
    await deployOpenEditionProjectProjection(target.root);

    // Runtime owns cwd, MCP subprocess configuration and filesystem watchers.
    // They are constructed as one project-scoped unit, so a safe hot switch is
    // an atomic stop -> persist new root -> automatic process reload.
    if (opts.reloadOnProjectSwitch) {
      try {
        const cancelled = await runtime.sessionManager.cancelAllForEmergencyStop();
        if (cancelled.failed_to_cancel.length > 0) {
          return res.status(409).json({
            ok: false,
            code: "PROJECT_SWITCH_ACTIVE_SESSIONS",
            error: "仍有 Agent 会话无法停止，项目未切换",
            failedToCancel: cancelled.failed_to_cancel,
          });
        }
        await runtime.stop();
      } catch (err) {
        return res.status(409).json({
          ok: false,
          code: "PROJECT_SWITCH_RUNTIME_STOP_FAILED",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    activeProjectId = id;
    applyProjectScopedOpts(target.root);
    lastAppliedProjectRoot = pathResolve(target.root);
    persistProjectStore();
    const root = pathResolve(target.root);
    invalidateLedgerFreshCache(root);
    void ensureLedgerFresh(root).catch((err: unknown) => {
      console.warn(
        "[web-panel] ledger refresh after project switch failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    res.json({
      ok: true,
      project: { ...target, active: true },
      root,
      runtimeReloadScheduled: Boolean(opts.reloadOnProjectSwitch),
      message: opts.reloadOnProjectSwitch
        ? "项目已切换，Runtime 正在热重载，约 5 秒后自动重连"
        : "项目已切换",
    });
    if (opts.reloadOnProjectSwitch) {
      if (opts.projectRuntimeReloadScheduler) {
        opts.projectRuntimeReloadScheduler();
      } else {
        setTimeout(() => {
          spawnDetachedShellRestart();
          setTimeout(() => process.exit(0), 600);
        }, 800);
      }
    }
    return;
  });

  /**
   * GET /api/v2/projects/clean-runtime/preview — list deletable paths for active root.
   * Query: includeOptional=1
   */
  app.get("/api/v2/projects/workspace-migration/preview", (_req: Request, res: Response) => {
    ensureProjectStore();
    const plan = planSingleWorkspaceMigration(resolveProjectRoot());
    return res.status(plan.ok ? 200 : 409).json({ dryRun: true, ...plan });
  });

  app.post("/api/v2/projects/workspace-migration/execute", async (req: Request, res: Response) => {
    ensureProjectStore();
    if (req.body?.confirm !== "MIGRATE_TO_PROJECT_ROOT") {
      return res.status(400).json({
        ok: false,
        error: "Explicit confirmation MIGRATE_TO_PROJECT_ROOT is required.",
      });
    }
    try {
      const root = resolveProjectRoot();
      const plan = planSingleWorkspaceMigration(root);
      if (!(await trustedForegroundConfirmation({
        title: "CodeFlowMu 工作区迁移确认",
        message: [
          "确认把单工作区内容迁移到项目根目录？",
          "",
          `项目根目录：${root}`,
          `预检结果：${plan.ok ? "可迁移" : "存在冲突"}`,
          "影响：将移动或覆盖预检计划中列出的本地文件",
          "",
          "取消后不会执行迁移。",
        ].join("\n"),
      }))) {
        return res.status(409).json({ ok: false, code: "WORKSPACE_MIGRATION_CONFIRMATION_CANCELLED", error: "用户取消了工作区迁移。" });
      }
      return res.json(executeSingleWorkspaceMigration(resolveProjectRoot()));
    } catch (error) {
      return res.status(409).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/v2/projects/clean-runtime/preview", (req: Request, res: Response) => {
    ensureProjectStore();
    const root = resolveProjectRoot();
    if (!existsSync(root)) {
      return res.status(400).json({ error: "active project root does not exist" });
    }
    if (isProtectedOpenEditionAppRoot(root)) {
      return res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_APP_ROOT_PROTECTED",
        message:
          "Open edition cannot clean or initialize its own CodeFlowMu-open source directory. Add or switch to an external project root first.",
      });
    }
    const includeOptional =
      req.query["includeOptional"] === "1" || req.query["includeOptional"] === "true";
    const active = projectStore.get(activeProjectId);
    return res.json({
      root,
      projectName: active?.name ?? "",
      includeOptional,
      targets: listCleanRuntimeTargets(root, includeOptional),
      note:
        "执行前会先停止 Agent 会话与运行时 watcher；清理完成后可勾选自动后台重启 Shell。",
    });
  });

  async function confirmCleanRuntimeMutation(root: string, includeOptional: boolean): Promise<boolean> {
    const targets = listCleanRuntimeTargets(root, includeOptional)
      .filter((target) => target.exists)
      .map((target) => `- ${target.rel}`);
    return trustedForegroundConfirmation({
      title: "CodeFlowMu 项目环境清理确认",
      message: [
        "确认永久清理当前项目的运行现场？",
        "",
        `项目根目录：${root}`,
        `包含可选目录：${includeOptional ? "是" : "否"}`,
        "将删除：",
        ...(targets.length > 0 ? targets : ["- 当前没有命中的清理目标"]),
        "",
        "确认仅授权本次、以上述根目录和清理范围为准的操作。",
      ].join("\n"),
    });
  }

  /**
   * POST /api/v2/projects/clean-runtime/stop-runtime
   * 停止所有 Agent 会话并释放 inbox/report watcher（Windows 删 fcop 前必做）。
   */
  app.post("/api/v2/projects/clean-runtime/stop-runtime", async (_req: Request, res: Response) => {
    ensureProjectStore();
    const root = resolveProjectRoot();
    if (!existsSync(root)) {
      return res.status(400).json({ error: "active project root does not exist" });
    }
    if (isProtectedOpenEditionAppRoot(root)) {
      return res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_APP_ROOT_PROTECTED",
        message:
          "Open edition cannot stop/clean runtime for its own CodeFlowMu-open source directory. Add or switch to an external project root first.",
      });
    }
    let emergency = { cancelled: [] as string[], failed_to_cancel: [] as { session_id: string; reason: string }[] };
    try {
      emergency = await runtime.sessionManager.cancelAllForEmergencyStop();
    } catch (err) {
      console.warn(
        "[web-panel] clean-runtime stop: emergency stop failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    let runtimeStopped = false;
    try {
      await runtime.stop();
      runtimeStopped = true;
    } catch (err) {
      console.warn(
        "[web-panel] clean-runtime stop: runtime.stop failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return res.json({
      ok: runtimeStopped,
      root,
      cancelledSessions: emergency.cancelled.length,
      cancelledSessionIds: emergency.cancelled,
      failedToCancel: emergency.failed_to_cancel,
      runtimeStopped,
      message: runtimeStopped
        ? `已停止 ${emergency.cancelled.length} 个会话并释放文件锁`
        : "会话已尝试停止，但 runtime.stop 未完全成功",
    });
  });

  /**
   * POST /api/v2/projects/clean-runtime/execute — delete whitelist paths (call after stop-runtime).
   * Body: { includeOptional?: boolean, autoRestart?: boolean }
   */
  app.post("/api/v2/projects/clean-runtime/execute", async (req: Request, res: Response) => {
    ensureProjectStore();
    const root = resolveProjectRoot();
    if (!existsSync(root)) {
      return res.status(400).json({ error: "active project root does not exist" });
    }
    const includeOptional = Boolean(req.body?.includeOptional);
    const autoRestart = req.body?.autoRestart !== false;
    if (!(await confirmCleanRuntimeMutation(root, includeOptional))) {
      return sendError(
        res,
        409,
        "CLEAN_RUNTIME_CONFIRMATION_CANCELLED",
        "用户取消了项目环境清理",
      );
    }
    const result = cleanProjectRuntime(root, includeOptional);
    const postCleanVerification = verifyPostCleanRuntime(root);
    if (result.deleted.length > 0) {
      invalidateLedgerFreshCache(root);
    }
    const active = projectStore.get(activeProjectId);
    const payload = {
      ok: result.ok && postCleanVerification.ok,
      root: result.root,
      projectName: active?.name ?? "",
      deleted: result.deleted,
      notFound: result.notFound,
      errors: result.errors,
      steps: result.steps,
      postCleanVerification,
      autoRestartScheduled: false,
      nextSteps: [
        "打开 Panel → 环境预检 → 对当前产品开发根执行「一键初始化/接管」",
        "初始化 SSE 末尾应显示「初始化验收通过」；若 ❌ 请查看验收项",
        "确认 fcop/fcop.json、Rule 4.5 角色文档与 fcop/_lifecycle/inbox 后再创建任务",
      ],
    };
    const shouldRestart = autoRestart && payload.ok;
    if (shouldRestart) {
      payload.autoRestartScheduled = true;
      res.json({
        ...payload,
        restartMessage: "清理完成，约 5 秒后在后台启动新 Shell，请稍后刷新本页",
      });
      setTimeout(() => {
        spawnDetachedShellRestart();
        setTimeout(() => process.exit(0), 600);
      }, 800);
      return;
    }
    return res.json(payload);
  });

  /**
   * POST /api/v2/projects/clean-runtime — legacy one-shot (stop + delete, optional restart).
   * Prefer stop-runtime → execute for progress UI.
   */
  app.post("/api/v2/projects/clean-runtime", async (req: Request, res: Response) => {
    ensureProjectStore();
    const root = resolveProjectRoot();
    if (!existsSync(root)) {
      return res.status(400).json({ error: "active project root does not exist" });
    }
    const includeOptional = Boolean(req.body?.includeOptional);
    const autoRestart = req.body?.autoRestart !== false;
    if (!(await confirmCleanRuntimeMutation(root, includeOptional))) {
      return sendError(
        res,
        409,
        "CLEAN_RUNTIME_CONFIRMATION_CANCELLED",
        "用户取消了项目环境清理",
      );
    }
    try {
      await runtime.sessionManager.cancelAllForEmergencyStop();
    } catch {
      /* best effort */
    }
    try {
      await runtime.stop();
    } catch {
      /* best effort */
    }
    const result = cleanProjectRuntime(root, includeOptional);
    const postCleanVerification = verifyPostCleanRuntime(root);
    if (result.deleted.length > 0) {
      invalidateLedgerFreshCache(root);
    }
    const active = projectStore.get(activeProjectId);
    const ok = result.ok && postCleanVerification.ok;
    const shouldRestart = autoRestart && ok;
    const body = {
      ok,
      root: result.root,
      projectName: active?.name ?? "",
      deleted: result.deleted,
      notFound: result.notFound,
      errors: result.errors,
      steps: result.steps,
      postCleanVerification,
      autoRestartScheduled: shouldRestart,
      nextSteps: [
        shouldRestart
          ? "等待 Shell 自动重启后刷新 Panel"
          : "请手动重启 CodeFlowMu（START-CODEFLOWMU.bat 或 npm start）",
        "打开 Panel → 环境预检 → 一键初始化/接管项目",
        "确认 fcop/fcop.json 与 fcop/adopted/pending/ 后再创建任务",
      ],
    };
    if (shouldRestart) {
      res.json(body);
      setTimeout(() => {
        spawnDetachedShellRestart();
        setTimeout(() => process.exit(0), 600);
      }, 800);
      return;
    }
    return res.json(body);
  });

  /**
   * DELETE /api/v2/projects/:id — remove a project (cannot delete active).
   */
  app.delete("/api/v2/projects/:id", (req: Request, res: Response) => {
    ensureProjectStore();
    const id = String(req.params["id"] ?? "");
    if (id === activeProjectId) {
      return res.status(400).json({ error: "cannot delete the active project" });
    }
    if (!projectStore.has(id)) {
      return res.status(404).json({ error: "project not found" });
    }
    projectStore.delete(id);
    persistProjectStore();
    return res.json({ ok: true });
  });

  // ── Sprint-7: Network info endpoint ────────────────────────────────────

  /**
   * GET /api/v2/network/info — returns LAN IPv4 addresses (non-loopback).
   */
  app.get("/api/v2/network/info", (_req: Request, res: Response) => {
    const nets = os.networkInterfaces();
    const all: { name: string; address: string; family: string }[] = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs ?? []) {
        if (addr.family === "IPv4" && !addr.internal) {
          all.push({ name, address: addr.address, family: addr.family });
        }
      }
    }
    const interfaces = filterReachableLanInterfaces(all);
    res.json({ interfaces, all_interfaces: all });
  });

  // ── Sprint-A3 + P1 Runtime: lifecycle transitions ─────────────────────

  function lifecycleTaskIdParam(raw: string): string {
    const s = String(raw ?? "").trim();
    return s.replace(/\.md$/i, "");
  }

  function lifecycleCanonicalTaskId(raw: string): string {
    const normalized = lifecycleTaskIdParam(raw);
    return normalized.match(/^(TASK-\d{8}-\d{3,})/i)?.[1]?.toUpperCase() ?? normalized.toUpperCase();
  }

  function sendLifecycleHttp(
    res: Response,
    result: Awaited<ReturnType<typeof executeLifecycleRuntimeAction>>,
    opts?: {
      refreshLedger?: boolean;
      panelAction?: string;
      taskId?: string;
      actor?: string;
    },
  ): void {
    if (result.ok) {
      if (opts?.refreshLedger) {
        void ensureLedgerFresh(projectRoot(), { rebuild: true, force: true }).catch(
          (err: unknown) => {
            console.warn(
              `[web-panel] ledger refresh after lifecycle: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
      }
      res.json(result);
      return;
    }
    if (opts?.panelAction && opts.taskId) {
      appendPanelRuntimeAction(projectRoot(), {
        operator: opts.actor || "ADMIN",
        action: opts.panelAction,
        target_task: opts.taskId,
        result: "failed",
        reason: result.error?.slice(0, 200),
      });
    }
    const status = result.authority ? 403 : 400;
    if (result.code === "CHILD_TASKS_OPEN") {
      res.status(400).json({
        ...result,
        message:
          "不能归档：仍有未收口子任务。请先让 PM 收口子任务，或由 ADMIN 执行「强制归档并终止子任务」。",
        child_tasks: result.child_tasks ?? [],
      });
      return;
    }
    if (result.code === "CHILD_TASKS_NOT_ACCEPTED") {
      res.status(400).json({
        ...result,
        message:
          "不能归档：存在 done 但未验收子任务。请等待 worker REPORT 与 pm.review_check 通过后再归档主线。",
        child_tasks: result.child_tasks ?? [],
      });
      return;
    }
    res.status(status).json(result);
  }

  app.post("/api/v2/tasks/:taskId/submit-review", async (req: Request, res: Response) => {
    try {
      const taskId = lifecycleTaskIdParam(String(req.params["taskId"] ?? ""));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const root = projectRoot();
      const actor = String(body["actor"] ?? "PM");
      if (actor.toUpperCase() === "PM") {
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const { reports: reportRows } = await listReportsFromLedgerAuto(root);
        const requestedReportId = String(
          body["report_id"] ?? body["reportId"] ?? "",
        )
          .replace(/\.md$/i, "")
          .trim();
        // The panel addresses lifecycle files by their full stem
        // (TASK-...-ADMIN-to-PM), while REPORT frontmatter links the
        // canonical protocol id (TASK-...).  Compare canonical ids here;
        // otherwise a valid terminal PM report is mistaken for unrelated
        // and is incorrectly sent through the success-only close gate.
        const normalizedTaskId = lifecycleCanonicalTaskId(taskId);
        const requestedReport = (reportRows as unknown as LedgerReportRecord[]).find(
          (report) =>
            String(report.report_id ?? report.filename)
              .replace(/\.md$/i, "")
              .trim() === requestedReportId,
        );
        const reportRefs = requestedReport?.references ?? [];
        const reportLinkedToTask = Boolean(
          requestedReport &&
            String(requestedReport.sender ?? "").toUpperCase() === "PM" &&
            String(requestedReport.recipient ?? "").toUpperCase() === "ADMIN" &&
            (lifecycleCanonicalTaskId(String(requestedReport.task_id ?? "")) ===
              normalizedTaskId ||
              lifecycleCanonicalTaskId(String(requestedReport.source_task_id ?? "")) ===
                normalizedTaskId ||
              reportRefs.some(
                (ref) =>
                  lifecycleCanonicalTaskId(String(ref)) === normalizedTaskId,
              )),
        );
        const reportStatus = String(requestedReport?.status ?? "")
          .trim()
          .toLowerCase();
        const isTerminalEscalation =
          reportLinkedToTask &&
          ["blocked", "failed", "aborted"].includes(reportStatus);

        // A terminal failure/block report is itself the escalation to ADMIN.
        // active -> review does not approve it, so success-only close gates
        // must not prevent the human reviewer from receiving it.
        if (!isTerminalEscalation) {
          const gate = await checkPmSummaryAllowed({
            projectRoot: root,
            runtime,
            taskId,
            threadKey: String(body["thread_key"] ?? "").trim() || undefined,
            tasks: taskRows as unknown as LedgerTaskRecord[],
            reports: reportRows as unknown as LedgerReportRecord[],
          });
          if (!gate.allowed) {
            const hint = gate.blockers
              .map((b) => b.admin_hint)
              .join("\n\n");
            return res.status(409).json({
              ok: false,
              blocked: true,
              reason: "pm_summary_blocked",
              message: `PM 总结被阻止：存在可恢复未结算任务\n${hint}`,
              blockers: gate.blockers,
            });
          }
        }
      }
      const result = await executeLifecycleRuntimeAction(
        "submit_review",
        {
          task_id: taskId,
          actor: body["actor"],
          report_id: body["report_id"] ?? body["reportId"],
          reason: body["reason"] ?? body["note"],
        },
        projectRoot(),
      );
      sendLifecycleHttp(res, result, {
        panelAction: "submit_review",
        taskId,
        actor: String(body["actor"] ?? "PM"),
      });
    } catch (err) {
      sendError(res, 500, "SUBMIT_REVIEW_FAILED", String(err));
    }
  });

  app.post("/api/v2/tasks/:taskId/approve", async (req: Request, res: Response) => {
    try {
      const taskId = lifecycleTaskIdParam(String(req.params["taskId"] ?? ""));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const gate = await adminApprovalBlockedByMissingEval(
        projectRoot(),
        taskId,
        String(body["actor"] ?? ""),
      );
      if (gate.blocked) {
        return sendError(
          res,
          403,
          "EVAL_REQUIRED_BEFORE_APPROVAL",
          "PM final report exists but EVAL observation is missing; generate EVAL before ADMIN approval",
        );
      }
      const result = await executeLifecycleRuntimeAction(
        "approve_review",
        {
          task_id: taskId,
          actor: body["actor"],
          note: body["note"] ?? body["reason"],
        },
        projectRoot(),
      );
      sendLifecycleHttp(res, result, {
        panelAction: "approve",
        taskId,
        actor: String(body["actor"] ?? "ADMIN"),
        refreshLedger: true,
      });
    } catch (err) {
      sendError(res, 500, "APPROVE_FAILED", String(err));
    }
  });

  app.post("/api/v2/tasks/:taskId/reject", async (req: Request, res: Response) => {
    try {
      const taskId = lifecycleTaskIdParam(String(req.params["taskId"] ?? ""));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const gate = await adminApprovalBlockedByMissingEval(
        projectRoot(),
        taskId,
        String(body["actor"] ?? ""),
      );
      if (gate.blocked) {
        return sendError(
          res,
          403,
          "EVAL_REQUIRED_BEFORE_REJECT",
          "PM final report exists but EVAL observation is missing; generate EVAL before ADMIN review actions",
        );
      }
      const result = await executeLifecycleRuntimeAction(
        "reject_review",
        {
          task_id: taskId,
          actor: body["actor"],
          reason: body["reason"] ?? body["note"],
        },
        projectRoot(),
      );
      sendLifecycleHttp(res, result, {
        panelAction: "reject",
        taskId,
        actor: String(body["actor"] ?? "ADMIN"),
        refreshLedger: true,
      });
    } catch (err) {
      sendError(res, 500, "REJECT_FAILED", String(err));
    }
  });

  app.post("/api/v2/tasks/:taskId/reopen", async (req: Request, res: Response) => {
    try {
      const taskId = lifecycleTaskIdParam(String(req.params["taskId"] ?? ""));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await executeLifecycleRuntimeAction(
        "reopen_task",
        {
          task_id: taskId,
          actor: body["actor"],
          reason: body["reason"] ?? body["note"],
        },
        projectRoot(),
      );
      sendLifecycleHttp(res, result, {
        panelAction: "reopen",
        taskId,
        actor: String(body["actor"] ?? "ADMIN"),
      });
    } catch (err) {
      sendError(res, 500, "REOPEN_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:filename/archive — Runtime StateMachine archive_task
   */
  async function cancelRunningTaskTreeBeforeForceArchive(
    rootTaskId: string,
    reason: string,
  ): Promise<{ ok: boolean; cancelled: string[]; error?: string }> {
    const normalizeId = (value: unknown): string => {
      const raw = String(value ?? "").replace(/\.md$/i, "").trim();
      return raw.match(/^(TASK-\d{8}-\d{3,})/i)?.[1]?.toUpperCase() ?? raw;
    };
    const taskIds = new Set<string>([normalizeId(rootTaskId)]);
    const { tasks } = await listTasksFromLedgerAuto(projectRoot(), { limit: 1000 });
    const rows = tasks as unknown as Array<Record<string, unknown>>;

    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const id = normalizeId(row.task_id ?? row.filename);
        if (!id || taskIds.has(id)) continue;
        const yaml =
          row.yaml && typeof row.yaml === "object"
            ? (row.yaml as Record<string, unknown>)
            : {};
        const parent = normalizeId(row.parent ?? yaml.parent);
        const referencesRaw = row.references ?? yaml.references;
        const references = Array.isArray(referencesRaw)
          ? referencesRaw.map(normalizeId)
          : [normalizeId(referencesRaw)].filter(Boolean);
        if ((parent && taskIds.has(parent)) || references.some((ref) => taskIds.has(ref))) {
          taskIds.add(id);
          changed = true;
        }
      }
    }

    const cancelled: string[] = [];
    const active = await runtime.sessionManager.listActive();
    for (const session of active) {
      if (!taskIds.has(normalizeId(session.protocol.task_id))) continue;
      try {
        await runtime.sessionManager.cancelSession(
          session.protocol.session_id,
          reason,
        );
        cancelled.push(session.protocol.session_id);
      } catch (err) {
        return {
          ok: false,
          cancelled,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const remaining = (await runtime.sessionManager.listActive()).filter((session) =>
      taskIds.has(normalizeId(session.protocol.task_id)),
    );
    if (remaining.length > 0) {
      return {
        ok: false,
        cancelled,
        error: `sessions still running: ${remaining.map((s) => s.protocol.session_id).join(", ")}`,
      };
    }
    return { ok: true, cancelled };
  }

  app.post("/api/v2/tasks/:filename/archive", async (req: Request, res: Response) => {
    try {
      const taskId = lifecycleTaskIdParam(String(req.params["filename"] ?? ""));
      if (!/^TASK-[\w-]+$/i.test(taskId)) {
        return sendError(res, 400, "INVALID_FILENAME", "invalid task id");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const force = body["force"] === true;
      if (force) {
        const stopResult = await cancelRunningTaskTreeBeforeForceArchive(
          taskId,
          String(body["reason"] ?? body["note"] ?? "ADMIN force archive"),
        );
        if (!stopResult.ok) {
          return res.status(409).json({
            ok: false,
            code: "SESSION_CANCEL_FAILED",
            error: stopResult.error,
            cancelled_sessions: stopResult.cancelled,
          });
        }
      }
      const result = await executeLifecycleRuntimeAction(
        "archive_task",
        {
          task_id: taskId,
          actor: body["actor"],
          reason: body["reason"] ?? body["note"],
          force,
        },
        projectRoot(),
      );
      sendLifecycleHttp(res, result, {
        refreshLedger: true,
        panelAction: "archive",
        taskId,
        actor: String(body["actor"] ?? "ADMIN"),
      });
    } catch (err) {
      sendError(res, 500, "ARCHIVE_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/admin/closed-parent-residue — ADMIN 闭线残留检测列表
   */
  app.get("/api/v2/admin/closed-parent-residue", async (_req: Request, res: Response) => {
    try {
      const root = projectRoot();
      const { tasks: taskRows } = await listTasksFromLedgerAuto(root, {
        limit: 500,
      });
      const tasks = taskRows as unknown as Array<Record<string, unknown>>;
      const residue = detectClosedParentResidueTasks(tasks).map((t) => ({
        task_id: taskIdFromFilename(String(t.filename ?? "")),
        filename: t.filename,
        parent: t.parent ?? t.references,
        path: t.path,
        physical_scope: t.physical_scope,
        display_status: t.display_status,
        state: t.state,
        flags: [
          "closed_parent_residue",
          ...(hasStateBucketMismatch(t) ? ["state_bucket_mismatch"] : []),
        ],
      }));
      res.json({ ok: true, residue, count: residue.length });
    } catch (err) {
      sendError(res, 500, "RESIDUE_LIST_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/admin/closed-parent-residue/:taskId/action
   * body: { action: noted_only | terminate | to_issue, actor?, reason? }
   */
  app.post(
    "/api/v2/admin/closed-parent-residue/:taskId/action",
    async (req: Request, res: Response) => {
      try {
        const taskId = lifecycleTaskIdParam(String(req.params["taskId"] ?? ""));
        const body = (req.body ?? {}) as Record<string, unknown>;
        const action = String(body["action"] ?? "").trim().toLowerCase();
        const actor = String(body["actor"] ?? "ADMIN").trim();
        const reason = String(body["reason"] ?? "ADMIN 闭线残留处理").trim();
        const root = projectRoot();
        const lifecycleRoot = join(root, "fcop", "_lifecycle");

        if (action === "to_issue") {
          res.json({
            ok: true,
            action,
            issue_prefill: {
              subject: `[闭线残留] ${taskId}`,
              body: `## 现象\n子任务 ${taskId} 在父主线归档后仍为闭线残留。\n\n## 建议\n请 ADMIN/PM 评估是否需人工跟进。`,
              references: taskId,
            },
          });
          return;
        }

        const located = findTaskPathByIdSync(lifecycleRoot, taskId);
        if (!located) {
          return sendError(res, 404, "TASK_NOT_FOUND", `Task ${taskId} not found`);
        }

        if (action === "noted_only") {
          const store = new TaskFrontmatterStore();
          const now = new Date().toISOString();
          await store.patch(located.path, {
            residue_admin_action: "noted_only",
            residue_noted_at: now,
            residue_noted_by: actor,
          });
          void ensureLedgerFresh(root, { rebuild: true, force: true }).catch(() => {});
          res.json({ ok: true, action, task_id: taskId });
          return;
        }

        if (action === "terminate") {
          const result = await terminateSingleChildAsParentResidue({
            lifecycleRoot,
            taskId,
            actor,
            reason,
          });
          if (!result) {
            return sendError(res, 404, "TERMINATE_FAILED", `Cannot terminate ${taskId}`);
          }
          void ensureLedgerFresh(root, { rebuild: true, force: true }).catch(() => {});
          res.json({ ok: true, action, task_id: taskId, child: result });
          return;
        }

        return sendError(res, 400, "INVALID_ACTION", `Unknown action: ${action}`);
      } catch (err) {
        sendError(res, 500, "RESIDUE_ACTION_FAILED", String(err));
      }
    },
  );

  // ── Session unsettled recover (TASK-20260610-017) ───────────────────────
  /**
   * GET /api/v2/tasks/:taskId/receipt-status
   * 任务页摘要：session / REPORT reconcile 四态。
   */
  app.get("/api/v2/tasks/:taskId/receipt-status", async (req: Request, res: Response) => {
    try {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        return sendError(res, 400, "MISSING_TASK_ID", "taskId required");
      }
      const root = projectRoot();
      const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
      const { reports: reportRows } = await listReportsFromLedgerAuto(root);
      const tasks = taskRows as unknown as LedgerTaskRecord[];
      const reports = reportRows as unknown as LedgerReportRecord[];
      const worker = tasks.find(
        (t) =>
          t.task_id === taskId ||
          String(t.filename ?? "").replace(/\.md$/i, "") === taskId,
      );
      const role = String(worker?.recipient ?? req.query["role"] ?? "").trim();
      if (!role) {
        return sendError(res, 400, "MISSING_ROLE", "role required");
      }
      const durable = await resolveWorkerReceiptDurableHints(root, taskId);
      const agents = await runtime.registry.list();
      const agentRunning = agents.some(
        (a) =>
          (a.protocol.role ?? "").toUpperCase() === role.toUpperCase() &&
          a.protocol.status === "running",
      );
      const merged = mergeWorkerReceiptSignals(
        {
          nudgeCount: runtime.pmQueueGuard.nudgeCountForTask(taskId),
          workerFailed: runtime.pmQueueGuard.isDownstreamWorkerFailed(taskId),
        },
        durable,
        { agentRunning },
      );
      const ev = evaluateWorkerReceiptWaiting({
        tasks,
        reports,
        targetRole: role,
        focusTaskId: taskId,
        nudgeCount: merged.nudgeCount,
        workerFailed: merged.workerFailed,
        sessionFailed: merged.sessionFailed,
        sessionUnsettled: merged.sessionUnsettled,
        recoverable: merged.recoverable,
        lastSessionId: merged.lastSessionId,
        lastFailureCode: merged.lastFailureCode,
        lastFailureCategory: merged.lastFailureCategory,
        isFirstTurnAbort: merged.isFirstTurnAbort,
        lastSessionStatus: durable.lastSessionStatus,
        agentRunning,
      });
      const agentForRole = agents.find(
        (a) => (a.protocol.role ?? "").toUpperCase() === role.toUpperCase(),
      );
      let reconcileState: Awaited<ReturnType<typeof reconcileAgentTaskState>> | null =
        null;
      if (agentForRole) {
        reconcileState = await reconcileAgentTaskState({
          projectRoot: root,
          agentId: agentForRole.protocol.agent_id,
          taskId,
          registry: runtime.registry,
          sessionManager: runtime.sessionManager,
          tasks,
          reports,
          nudgeCount: runtime.pmQueueGuard.nudgeCountForTask(taskId),
          workerFailed: runtime.pmQueueGuard.isDownstreamWorkerFailed(taskId),
        });
        const evType =
          reconcileState.state === "unknown" ||
          reconcileState.state === "idle"
            ? "agent_reconcile.checked"
            : (`agent_reconcile.${reconcileState.state}` as const);
        appendAgentReconcileEvent(root, evType, {
          task_id: taskId,
          role: role.toUpperCase(),
          agent_id: agentForRole.protocol.agent_id,
          reason_code: reconcileState.reason_code,
          admin_hint: reconcileState.admin_hint,
          trigger: "task_detail",
        });
      }
      res.json({
        task_id: taskId,
        role: role.toUpperCase(),
        phase: ev.phase,
        queue_state: reconcileState?.state ?? ev.queueState,
        agent_state: reconcileState?.state ?? null,
        reason_code: reconcileState?.reason_code ?? ev.reasonCode,
        last_session_id: ev.lastSessionId,
        suggested_action: reconcileState?.suggested_action ?? ev.suggestedAction,
        last_failure_category: merged.lastFailureCategory ?? null,
        is_first_turn_abort: Boolean(merged.isFirstTurnAbort),
        admin_hint: reconcileState?.admin_hint ?? null,
        summary: merged.summary,
        has_final_report:
          ev.phase === "cleared" &&
          (ev.reason === "worker_report_done" ||
            ev.reason === "worker_report_on_disk" ||
            ev.reason === "pm_summary_done"),
      });
    } catch (err) {
      sendError(res, 500, "RECEIPT_STATUS_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:taskId/release-receipt-failure
   * Clears durable + in-memory downstream worker failed marks (ADMIN SOP release).
   */
  app.post(
    "/api/v2/tasks/:taskId/release-receipt-failure",
    async (req: Request, res: Response) => {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        sendError(res, 400, "MISSING_PARAMS", "task_id is required");
        return;
      }
      const root = projectRoot();
      const operator = String((req.body as { operator?: string })?.operator ?? "ADMIN").trim() || "ADMIN";
      try {
        const clearedDurable = await clearWorkerReceiptFailed(root, taskId);
        runtime.pmQueueGuard.clearDownstreamWorkerFailed(taskId);
        appendPanelRuntimeAction(root, {
          operator,
          action: "release_receipt_failure",
          target_task: taskId,
          result: "ok",
          detail: clearedDurable ? "durable_and_guard_cleared" : "guard_cleared",
        });
        res.json({
          ok: true,
          task_id: taskId,
          cleared_durable: clearedDurable,
          cleared_guard: true,
        });
      } catch (err) {
        sendError(res, 500, "RELEASE_RECEIPT_FAILURE_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/tasks/:taskId/resolve-blocked-report
   * Acknowledge a formal worker blocked/failed REPORT and settle the original
   * branch task. The REPORT is preserved; any rework must be a new TASK.
   */
  app.post(
    "/api/v2/tasks/:taskId/resolve-blocked-report",
    async (req: Request, res: Response) => {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        sendError(res, 400, "MISSING_TASK_ID", "task_id is required");
        return;
      }
      const root = projectRoot();
      try {
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const { reports: reportRows } = await listReportsFromLedgerAuto(root);
        const task = (taskRows as Array<Record<string, unknown>>).find(
          (row) =>
            String(row["task_id"] ?? "").replace(/\.md$/i, "").trim() === taskId,
        );
        if (!task) {
          sendError(res, 404, "TASK_NOT_FOUND", taskId);
          return;
        }
        const role = String(task["recipient"] ?? "").trim().toUpperCase();
        const terminal = new Set(["blocked", "aborted", "failed"]);
        const reports = (reportRows as Array<Record<string, unknown>>).filter((row) => {
          const status = String(row["status"] ?? "").trim().toLowerCase();
          const sender = String(row["sender"] ?? "").trim().toUpperCase();
          const recipient = String(row["recipient"] ?? "").trim().toUpperCase();
          const reportTaskId = String(row["task_id"] ?? "").replace(/\.md$/i, "").trim();
          const refs = Array.isArray(row["references"])
            ? (row["references"] as unknown[]).map((ref) =>
                String(ref).replace(/\.md$/i, "").trim(),
              )
            : [];
          return (
            terminal.has(status) &&
            sender === role &&
            recipient === "PM" &&
            (reportTaskId === taskId || refs.includes(taskId))
          );
        });
        const report = reports.at(-1);
        if (!report) {
          sendError(
            res,
            409,
            "FORMAL_BLOCKED_REPORT_REQUIRED",
            "没有找到与该任务精确关联的正式 blocked/aborted/failed REPORT",
          );
          return;
        }
        const reportId = String(report["report_id"] ?? report["filename"] ?? "")
          .replace(/\.md$/i, "")
          .trim();
        const submit = await executeLifecycleRuntimeAction(
          "submit_review",
          {
            task_id: taskId,
            actor: role,
            report_id: reportId,
            reason: "正式阻塞回报已提交，等待 PM 确认原任务结果",
          },
          root,
        );
        if (!submit.ok) {
          res.status(400).json({ ...submit, stage: "submit_review" });
          return;
        }
        const approve = await executeLifecycleRuntimeAction(
          "approve_review",
          {
            task_id: taskId,
            actor: "PM",
            note: `PM 确认 ${reportId} 的阻塞结果；原任务收口，后续返工须新建 TASK`,
          },
          root,
        );
        if (!approve.ok) {
          res.status(400).json({ ...approve, stage: "approve_review" });
          return;
        }
        await clearWorkerReceiptFailed(root, taskId);
        runtime.pmQueueGuard.clearDownstreamWorkerFailed(taskId);
        await ensureLedgerFresh(root, { rebuild: true, force: true });
        appendPanelRuntimeAction(root, {
          operator: String((req.body as { operator?: string })?.operator ?? "PM"),
          action: "resolve_blocked_report",
          target_task: taskId,
          result: "ok",
          detail: `accepted ${reportId}; original task settled`,
        });
        res.json({
          ok: true,
          task_id: taskId,
          report_id: reportId,
          status: "done",
          message: "阻塞结果已确认，原任务已收口；如需返工请新建子任务",
        });
      } catch (err) {
        sendError(res, 500, "RESOLVE_BLOCKED_REPORT_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/tasks/:taskId/trim-transitions
   * Body: { keep?: number } — retain last N transitions (default 30).
   */
  app.post(
    "/api/v2/tasks/:taskId/trim-transitions",
    async (req: Request, res: Response) => {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        sendError(res, 400, "MISSING_TASK_ID", "task_id is required");
        return;
      }
      const keep = Math.max(1, Number((req.body as { keep?: number })?.keep ?? 30));
      const root = projectRoot();
      const lifecycleRoot = join(root, "fcop", "_lifecycle");
      try {
        const result = await trimTaskTransitions({
          lifecycleRoot,
          taskId,
          keep,
        });
        await invalidateLedgerFreshCache(root);
        res.json(result);
      } catch (err) {
        sendError(res, 500, "TRIM_TRANSITIONS_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/tasks/:taskId/admin-force-recovery
   * Body: { role, agent_id?, thread_key?, operator? }
   * ADMIN SOP: attention clear → failed clear → cooldown clear → force release → force idle → recycle → ledger → recover.
   */
  app.post(
    "/api/v2/tasks/:taskId/admin-force-recovery",
    async (req: Request, res: Response) => {
      const body = req.body as {
        role?: string;
        agent_id?: string;
        thread_key?: string;
        operator?: string;
      };
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      const role = String(body.role ?? "").trim();
      if (!taskId || !role) {
        sendError(res, 400, "MISSING_PARAMS", "task_id and role are required");
        return;
      }
      if (!pmWakeExecutorRef) {
        sendError(res, 503, "WAKE_EXECUTOR_UNAVAILABLE", "PM wake executor not ready");
        return;
      }
      const root = projectRoot();
      const operator = String(body.operator ?? "ADMIN").trim() || "ADMIN";
      try {
        const agentId =
          String(body.agent_id ?? "").trim() ||
          (await runtime.registry.list({ role: role.toUpperCase() }))[0]?.protocol
            .agent_id;
        if (!agentId) {
          sendError(res, 400, "MISSING_AGENT", "agent_id required (no registry match for role)");
          return;
        }
        const beforeAgent = await runtime.registry.get(agentId);
        const beforeSessions = (await runtime.sessionManager.listActive())
          .filter((session) => session.protocol.agent_id === agentId)
          .map((session) => session.protocol.session_id);
        const beforeState = {
          agent_id: agentId,
          agent_status: beforeAgent?.protocol.status ?? null,
          active_session_ids: beforeSessions,
          task_id: taskId,
        };
        const result = await adminForceRecovery({
          projectRoot: root,
          taskId,
          role,
          registry: runtime.registry,
          sessionManager: runtime.sessionManager,
          wakeExecutor: pmWakeExecutorRef,
          statusReconciler: runtime.statusReconciler,
          threadKey: body.thread_key,
          agentId,
          operator,
          forceReleaseAgent: (agentId, reason) =>
            runtime.forceReleaseAgent(agentId, reason),
          recycleAgent: (agentId, params) => performAgentRecycle(agentId, params),
          clearInMemoryWorkerFailed: (tid) => {
            runtime.pmQueueGuard.clearDownstreamWorkerFailed(tid);
          },
          scheduleDelayedWake: (plan, remainingMs, reason) =>
            schedulePanelDelayedWakeRetry(plan, remainingMs, reason),
        });
        appendPanelRuntimeAction(root, {
          operator,
          action: "admin_force_recovery",
          target_task: taskId,
          target_agent: result.recover?.agent_id,
          result: result.ok ? "ok" : "failed",
          reason: result.error ?? result.recover?.reason,
          detail: result.error,
          session_id: result.recover?.new_session_id ?? result.recover?.session_id,
          before_state: beforeState,
          after_state: {
            ok: result.ok,
            agent_status: (await runtime.registry.get(agentId))?.protocol.status ?? null,
            new_session_id: result.recover?.new_session_id ?? null,
          },
        });
        if (result.ok) {
          appendPanelRuntimeAction(root, {
            operator,
            action: "resume_original_chain",
            target_task: taskId,
            target_agent: role.toUpperCase(),
            result: "ok",
            current_leg: role.toUpperCase(),
            detail: "沿原任务链继续，不创建重复任务",
          });
        }
        if (!result.ok && result.error === "new_session_id_null") {
          res.status(409).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        sendError(res, 500, "ADMIN_FORCE_RECOVERY_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/tasks/:taskId/recover-execution
   * Body: { role, agent_id?, thread_key?, operator? }
   */
  app.post(
    "/api/v2/tasks/:taskId/recover-execution",
    async (req: Request, res: Response) => {
      const body = req.body as {
        role?: string;
        agent_id?: string;
        thread_key?: string;
        operator?: string;
      };
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      const role = String(body.role ?? "").trim();
      if (!taskId || !role) {
        sendError(res, 400, "MISSING_PARAMS", "task_id and role are required");
        return;
      }
      if (!pmWakeExecutorRef) {
        sendError(res, 503, "WAKE_EXECUTOR_UNAVAILABLE", "PM wake executor not ready");
        return;
      }
      const root = projectRoot();
      const operator = String(body.operator ?? "ADMIN").trim() || "ADMIN";
      try {
        const agentId =
          String(body.agent_id ?? "").trim() ||
          (await runtime.registry.list({ role: role.toUpperCase() }))[0]?.protocol
            .agent_id;
        let reconcileResult = null;
        let taskRowsForRecover: LedgerTaskRecord[] = [];
        if (agentId) {
          const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
          const { reports: reportRows } = await listReportsFromLedgerAuto(root);
          taskRowsForRecover = taskRows as unknown as LedgerTaskRecord[];
          reconcileResult = await runAgentReconcile({
            projectRoot: root,
            runtime,
            agentId,
            taskId,
            trigger: "recover",
            tasks: taskRows as unknown as LedgerTaskRecord[],
            reports: reportRows as unknown as LedgerReportRecord[],
            operator,
          });
          if (
            operator.toUpperCase() === "PM" &&
            shouldEscalateAdminForceRecovery({
              reason: reconcileResult.reason_code,
              taskBucket: resolveTaskCurrentBucket(
                taskRowsForRecover.find((task) =>
                  String(task.task_id ?? "").startsWith(taskId),
                ) ?? {},
              ),
            })
          ) {
            appendPanelRuntimeAction(root, {
              operator: "PM",
              action: "recovery_required",
              target_task: taskId,
              target_agent: agentId,
              result: "failed",
              reason: reconcileResult.reason_code,
              policy: ADMIN_FORCE_RECOVERY_POLICY,
              next_owner: "ADMIN",
              message: "建议 ADMIN 一键解除卡死",
            });
            res.status(409).json({
              ok: false,
              action: "recovery_required",
              reason: reconcileResult.reason_code,
              agent: agentId,
              task_id: taskId,
              policy: ADMIN_FORCE_RECOVERY_POLICY,
              message: "建议 ADMIN 一键解除卡死",
            });
            return;
          }
        }
        const result = await recoverTaskExecution({
          projectRoot: root,
          taskId,
          role,
          registry: runtime.registry,
          sessionManager: runtime.sessionManager,
          wakeExecutor: pmWakeExecutorRef,
          statusReconciler: runtime.statusReconciler,
          threadKey: body.thread_key,
          agentId,
          scheduleDelayedWake: (plan, remainingMs, reason) =>
            schedulePanelDelayedWakeRetry(plan, remainingMs, reason),
          clearInMemoryWorkerFailed: (tid) => {
            runtime.pmQueueGuard.clearDownstreamWorkerFailed(tid);
          },
          onRecovered: (info) => {
            sseEmit("codeflowmu.execution_recovered", {
              task_id: info.task_id,
              role: info.role,
              agent_id: info.agent_id,
              session_id: info.session_id,
              operator,
            });
            appendPanelRuntimeAction(root, {
              operator,
              action: "recover",
              target_agent: info.agent_id,
              target_task: info.task_id,
              result: "ok",
              session_id: info.session_id,
              detail: "recover_session_unsettled",
            });
          },
        });
        if (!result.ok) {
          appendPanelRuntimeAction(root, {
            operator,
            action: "recover",
            target_task: taskId,
            target_agent: result.agent_id,
            result: result.delayed ? "delayed" : result.skipped ? "skipped" : "failed",
            reason: result.reason,
            detail: result.detail,
            cooldownReason: result.cooldownReason,
            remainingMs: result.remainingMs,
            untilMs: result.untilMs,
            policy: result.policy,
            next_owner: result.next_owner,
            message:
              result.policy === PM_STOP_POLICY
                ? "PM 已停手，不再重复 wake/recover"
                : undefined,
          });
        }
        if (!result.ok && result.reason_code === "new_session_id_null") {
          res.status(409).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        sendError(res, 500, "RECOVER_EXECUTION_FAILED", String(err));
      }
    },
  );

  /**
   * GET /api/v2/agent-queue — per-agent FIFO queue + paused tasks.
   */
  app.get("/api/v2/agent-queue", async (_req: Request, res: Response) => {
    try {
      const snap = await runtime.getAgentQueueSnapshot();
      if (!snap) {
        sendError(res, 503, "QUEUE_UNAVAILABLE", "project root not configured");
        return;
      }
      res.json({ ok: true, ...snap });
    } catch (err) {
      sendError(res, 500, "AGENT_QUEUE_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:taskId/pause
   * Body: { agent_id, operator?, pause_reason? }
   */
  app.post("/api/v2/tasks/:taskId/pause", async (req: Request, res: Response) => {
    const body = req.body as {
      agent_id?: string;
      role?: string;
      operator?: string;
      pause_reason?: string;
    };
    const taskId = String(req.params["taskId"] ?? "")
      .replace(/\.md$/i, "")
      .trim();
    let agentId = String(body.agent_id ?? "").trim();
    if (!agentId && body.role) {
      agentId =
        (await runtime.registry.list({ role: String(body.role).toUpperCase() }))[0]
          ?.protocol.agent_id ?? "";
    }
    if (!taskId || !agentId) {
      sendError(res, 400, "MISSING_PARAMS", "task_id and agent_id (or role) required");
      return;
    }
    try {
      const result = await runtime.pauseTask(taskId, agentId, {
        pausedBy: String(body.operator ?? "ADMIN").trim() || "ADMIN",
        pauseReason: body.pause_reason,
      });
      if (!result.ok) {
        res.status(result.error === "not_running" ? 409 : 500).json(result);
        return;
      }
      res.json({
        ok: true,
        task_id: result.task_id,
        agent_id: result.agent_id,
        dispatch_status: result.dispatch_status ?? "paused",
      });
    } catch (err) {
      sendError(res, 500, "PAUSE_TASK_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:taskId/resume
   * Body: { operator? }
   */
  app.post("/api/v2/tasks/:taskId/resume", async (req: Request, res: Response) => {
    const taskId = String(req.params["taskId"] ?? "")
      .replace(/\.md$/i, "")
      .trim();
    if (!taskId) {
      sendError(res, 400, "MISSING_PARAMS", "task_id required");
      return;
    }
    try {
      const result = await runtime.resumeTask(taskId, { priority: false });
      if (!result.ok) {
        res.status(result.error === "not_paused" ? 409 : 500).json(result);
        return;
      }
      res.json({
        ok: true,
        task_id: result.task_id,
        agent_id: result.agent_id,
        dispatch_status: result.dispatch_status ?? "queued",
      });
    } catch (err) {
      sendError(res, 500, "RESUME_TASK_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:taskId/resume-priority — ADMIN: head-of-queue resume.
   */
  app.post(
    "/api/v2/tasks/:taskId/resume-priority",
    async (req: Request, res: Response) => {
      const taskId = String(req.params["taskId"] ?? "")
        .replace(/\.md$/i, "")
        .trim();
      if (!taskId) {
        sendError(res, 400, "MISSING_PARAMS", "task_id required");
        return;
      }
      try {
        const result = await runtime.resumeTask(taskId, { priority: true });
        if (!result.ok) {
          res.status(result.error === "not_paused" ? 409 : 500).json(result);
          return;
        }
        res.json({
          ok: true,
          task_id: result.task_id,
          agent_id: result.agent_id,
          dispatch_status: result.dispatch_status ?? "queued",
        });
      } catch (err) {
        sendError(res, 500, "RESUME_PRIORITY_FAILED", String(err));
      }
    },
  );

  /**
   * POST /api/v2/tasks/:taskId/unstick
   * Body: { role?, agent_id?, thread_key?, operator? }
   * Orchestrates cancel → release → switch → rewake (existing handlers only).
   */
  app.post("/api/v2/tasks/:taskId/unstick", async (req: Request, res: Response) => {
    const body = req.body as {
      role?: string;
      agent_id?: string;
      thread_key?: string;
      operator?: string;
    };
    const taskId = String(req.params["taskId"] ?? "")
      .replace(/\.md$/i, "")
      .trim();
    const role = String(body.role ?? "").trim();
    if (!taskId || !role) {
      sendError(res, 400, "MISSING_PARAMS", "task_id and role are required");
      return;
    }
    if (!pmWakeExecutorRef) {
      sendError(res, 503, "WAKE_EXECUTOR_UNAVAILABLE", "PM wake executor not ready");
      return;
    }
    const root = projectRoot();
    const operator = String(body.operator ?? "ADMIN").trim() || "ADMIN";
    const steps: UnstickStepResult[] = [];
    let recoverMeta: {
      new_session_id?: string | null;
      delayed?: boolean;
      remainingMs?: number;
      retryAt?: string;
      reason_code?: string;
      error?: string;
      detail?: string;
    } = {};

    try {
      const agentId =
        String(body.agent_id ?? "").trim() ||
        (await runtime.registry.list({ role: role.toUpperCase() }))[0]?.protocol
          .agent_id;
      if (!agentId) {
        sendError(res, 400, "MISSING_AGENT", "agent_id required (no registry match for role)");
        return;
      }

      // 1 cancel — release zombie/stuck sessions
      try {
        const active = await runtime.sessionManager.listActive();
        const targets = active.filter((r) => r.protocol.agent_id === agentId);
        let cancelled = 0;
        for (const rec of targets) {
          await runtime.sessionManager.cancelSession(
            rec.protocol.session_id,
            "panel_unstick",
          );
          cancelled++;
        }
        steps.push({
          name: "cancel",
          ok: true,
          message: `cancelled ${cancelled} session(s)`,
        });
      } catch (err) {
        steps.push({ name: "cancel", ok: false, message: String(err) });
      }

      // 2 release — clear receipt failure marks (404/non-fatal continues)
      try {
        const clearedDurable = await clearWorkerReceiptFailed(root, taskId);
        runtime.pmQueueGuard.clearDownstreamWorkerFailed(taskId);
        steps.push({
          name: "release",
          ok: true,
          message: clearedDurable ? "durable_and_guard_cleared" : "guard_cleared",
        });
      } catch (err) {
        steps.push({
          name: "release",
          ok: false,
          status: 500,
          message: String(err),
        });
      }

      // 3 switch — recycle agent sdk id
      try {
        if (await agentHasRunningSession(agentId)) {
          await runtime.forceReleaseAgent(agentId, "panel_unstick");
        }
        const recycled = await performAgentRecycle(agentId, {
          reason: "panel_unstick",
          operator_role: operator,
        });
        steps.push({
          name: "switch",
          ok: true,
          message: recycled.new_sdk_agent_id,
        });
      } catch (err) {
        steps.push({ name: "switch", ok: false, message: String(err) });
      }

      // 4 rewake — reconcile + recover
      try {
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const { reports: reportRows } = await listReportsFromLedgerAuto(root);
        await runAgentReconcile({
          projectRoot: root,
          runtime,
          agentId,
          taskId,
          trigger: "recover",
          tasks: taskRows as unknown as LedgerTaskRecord[],
          reports: reportRows as unknown as LedgerReportRecord[],
          operator,
        });
        const result = await recoverTaskExecution({
          projectRoot: root,
          taskId,
          role,
          registry: runtime.registry,
          sessionManager: runtime.sessionManager,
          wakeExecutor: pmWakeExecutorRef,
          statusReconciler: runtime.statusReconciler,
          threadKey: body.thread_key,
          agentId,
          reasonCode: "panel_unstick",
          clearInMemoryWorkerFailed: (tid) => {
            runtime.pmQueueGuard.clearDownstreamWorkerFailed(tid);
          },
          scheduleDelayedWake: (plan, remainingMs, reason) =>
            schedulePanelDelayedWakeRetry(plan, remainingMs, reason),
        });
        const sessionOk = Boolean(result.new_session_id ?? result.session_id);
        const remainingMs = result.remainingMs ?? 0;
        recoverMeta = {
          new_session_id: result.new_session_id ?? result.session_id ?? null,
          delayed: result.delayed,
          remainingMs: remainingMs > 0 ? remainingMs : undefined,
          retryAt:
            remainingMs > 0
              ? new Date(Date.now() + remainingMs).toISOString()
              : undefined,
          reason_code: result.reason_code,
          error: result.reason,
          detail: result.detail,
        };
        steps.push({
          name: "rewake",
          ok: result.ok && sessionOk,
          message: result.reason ?? result.detail ?? (sessionOk ? "ok" : "new_session_id_null"),
        });
      } catch (err) {
        steps.push({ name: "rewake", ok: false, message: String(err) });
      }

      const outcome = evaluateUnstickOutcome(steps);
      appendPanelRuntimeAction(root, {
        operator,
        action: "unstick",
        target_task: taskId,
        target_agent: agentId,
        result: outcome.criticalFailed ? "failed" : outcome.partial ? "partial" : "ok",
        detail: JSON.stringify(steps).slice(0, 400),
      });
      const payload = {
        ok: outcome.ok,
        partial: outcome.partial,
        steps: outcome.steps,
        agent_id: agentId,
        ...recoverMeta,
      };
      if (!outcome.ok && recoverMeta.reason_code === "new_session_id_null") {
        res.status(409).json({
          ...payload,
          error: recoverMeta.error ?? "new_session_id_null",
          detail: recoverMeta.detail,
        });
        return;
      }
      res.json(payload);
    } catch (err) {
      sendError(res, 500, "UNSTICK_FAILED", String(err));
    }
  });

  // ── Two-phase explicit dispatch (TASK-20260610-016) ─────────────────────
  /**
   * POST /api/v2/tasks/:filename/dispatch
   *
   * Dependency gate → inbox→active → TaskDispatcher.startSession.
   */
  app.post("/api/v2/tasks/:filename/dispatch", async (req: Request, res: Response) => {
    try {
      const filename = String(req.params["filename"] ?? "");
      if (!/^(TASK|PLAN)-[\w-]+\.md$/.test(filename)) {
        return sendError(res, 400, "INVALID_FILENAME", "invalid filename");
      }
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const found = findTaskFile(v3, filename);
      if (!found) {
        return sendError(res, 404, "TASK_NOT_FOUND", "task file not found");
      }
      const recipMatch = filename.match(/-to-([A-Z0-9]+)/i);
      const recipient = recipMatch?.[1]?.toUpperCase() ?? "";
      const agents = await runtime.registry.list({
        role: recipient || undefined,
      });
      const agentId = agents[0]?.protocol.agent_id;
      let reconcile = null;
      if (agentId) {
        const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
        const { reports: reportRows } = await listReportsFromLedgerAuto(root);
        reconcile = await runAgentReconcile({
          projectRoot: root,
          runtime,
          agentId,
          taskId: filename.replace(/\.md$/i, ""),
          trigger: "dispatch",
          tasks: taskRows as unknown as LedgerTaskRecord[],
          reports: reportRows as unknown as LedgerReportRecord[],
          operator: "ADMIN",
        });
      }
      const outcome = await runtime.dispatcher.dispatchTaskFromControlPlane(
        found.path,
        filename,
        recipient || undefined,
        "admin_api",
      );
      if (outcome.kind === "dispatch_bypass_blocked") {
        return res.status(403).json({
          ok: false,
          skipped: true,
          reason: outcome.reason,
        });
      }
      if (outcome.kind === "dispatch_skipped") {
        sseEmit("dispatch_skipped", {
          filename,
          task_path: found.path,
          reason: outcome.reason,
          detail: outcome.detail,
          waiting_on: outcome.waiting_on,
        });
        return res.json({
          ok: false,
          skipped: true,
          reason: outcome.reason,
          detail: outcome.detail,
          waiting_on: outcome.waiting_on,
        });
      }
      if (outcome.kind === "dispatched") {
        sseEmit("codeflowmu.task_dispatched", {
          event: "task_dispatched",
          task_id: filename.replace(/\.md$/i, ""),
          task_path: found.path,
          role: recipient,
          session_id: outcome.session_id,
        });
        return res.json({
          ok: true,
          dispatched: true,
          session_id: outcome.session_id,
          reconcile,
        });
      }
      return res.json({ ok: false, outcome: outcome.kind, reconcile });
    } catch (err) {
      sendError(res, 500, "DISPATCH_FAILED", String(err));
    }
  });

  // ── Sprint-L2: Task lock (CAS) endpoint ──────────────────────────────────
  /**
   * POST /api/v2/tasks/:filename/lock
   *
   * Compare-And-Swap lock for a task file's `state` field.
   * - If state == inbox (or missing) → atomically writes state=dispatched, returns { ok:true, locked:true }
   * - If state == dispatched|done   → returns { ok:true, locked:false, state }
   *
   * Uses a `.lock` sidecar file (O_EXCL) for cross-process atomicity.
   */
  app.post("/api/v2/tasks/:filename/lock", async (req: Request, res: Response) => {
    const { open, readFile, writeFile, unlink } = await import("node:fs/promises");
    const { O_CREAT, O_EXCL, O_WRONLY } = await import("node:fs").then(m => m.constants);
    try {
      const filename = String(req.params["filename"] ?? "");
      if (!/^(TASK|PLAN)-[\w-]+\.md$/.test(filename)) {
        return sendError(res, 400, "INVALID_FILENAME", "invalid filename");
      }
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const found = findTaskFile(v3, filename);
      if (!found) {
        return sendError(res, 404, "TASK_NOT_FOUND", "task file not found");
      }
      const taskPath = found.path;
      const lockPath = `${taskPath}.lock`;

      // Acquire sidecar .lock file (O_EXCL — fails if already exists)
      let lockFd: import("node:fs/promises").FileHandle | null = null;
      try {
        lockFd = await open(lockPath, O_CREAT | O_EXCL | O_WRONLY);
      } catch {
        // Another process holds the lock — treat as already dispatched
        return res.json({ ok: true, locked: false, state: "dispatched", reason: "lock_contention" });
      }

      try {
        // Check current state inside the lock
        let raw: string;
        try {
          raw = await readFile(taskPath, "utf-8");
        } catch {
          return sendError(res, 404, "TASK_NOT_FOUND", "task file not found");
        }

        const currentState = _wpParseFmState(raw) ?? "inbox";
        if (currentState !== "inbox") {
          return res.json({ ok: true, locked: false, state: currentState });
        }

        // CAS: write dispatched
        await writeFile(taskPath, _wpPatchFmState(raw, "dispatched"), "utf-8");
        return res.json({ ok: true, locked: true, state: "dispatched" });
      } finally {
        // Always release lock file
        if (lockFd) await lockFd.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      sendError(res, 500, "LOCK_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/tasks/:filename/unlock
   *
   * Revert state back to inbox (e.g. on dispatch failure).
   */
  app.post("/api/v2/tasks/:filename/unlock", async (req: Request, res: Response) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    try {
      const filename = String(req.params["filename"] ?? "");
      if (!/^(TASK|PLAN)-[\w-]+\.md$/.test(filename)) {
        return sendError(res, 400, "INVALID_FILENAME", "invalid filename");
      }
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const found = findTaskFile(v3, filename);
      if (!found) {
        return sendError(res, 404, "TASK_NOT_FOUND", "task file not found");
      }
      const taskPath = found.path;
      let raw: string;
      try {
        raw = await readFile(taskPath, "utf-8");
      } catch {
        return sendError(res, 404, "TASK_NOT_FOUND", "task file not found");
      }
      const currentState = _wpParseFmState(raw) ?? "inbox";
      if (currentState === "done") {
        return sendError(res, 409, "ALREADY_DONE", "cannot unlock a done task");
      }
      await writeFile(taskPath, _wpPatchFmState(raw, "inbox"), "utf-8");
      res.json({ ok: true, state: "inbox" });
    } catch (err) {
      sendError(res, 500, "UNLOCK_FAILED", String(err));
    }
  });

  // ── Auto-archival engine ──────────────────────────────────────────────────
  /**
   * archiveCompleted — bulk-move done tasks+reports to fcop/_lifecycle/archive/YYYYMM/.
   *
   * "Done" = there exists a REPORT-* file whose name contains the same
   * YYYYMMDD-NNN sequence as the task.
   *
   * @param minAgeDays  Only archive files created >= minAgeDays ago (default 1).
   * @param dryRun      If true, return the list but don't move anything.
   */
  async function archiveCompleted(minAgeDays = 1, dryRun = false): Promise<{
    archivedTasks: string[];
    archivedReports: string[];
    skipped: number;
    error?: string;
  }> {
    const root = projectRoot();
    const v3 = fcopV3Paths(root);
    const tasksDir = v3.inbox;
    const reportsDir = opts.fcopReportsDir ?? v3.reports;
    const fsm = await import("node:fs");
    const now = Date.now();
    const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

    // Build full set of YYYYMMDD-NNN sequences that have a matching report.
    let reportFiles: string[] = [];
    try { reportFiles = fsm.readdirSync(reportsDir).filter((f) => isCanonicalReportMarkdownFilename(f)); }
    catch { return { archivedTasks: [], archivedReports: [], skipped: 0, error: "cannot read reports dir" }; }

    const doneSeqSet = new Set<string>();
    for (const rf of reportFiles) {
      const m = rf.match(/REPORT-(\d{8}-\d{3})/);
      if (m) doneSeqSet.add(m[1]!);
    }

    // Collect task files eligible for archival.
    let taskFiles: string[] = [];
    try { taskFiles = fsm.readdirSync(tasksDir).filter(f => f.startsWith("TASK-") && f.endsWith(".md")); }
    catch { return { archivedTasks: [], archivedReports: [], skipped: 0, error: "cannot read tasks dir" }; }

    const toArchiveTasks: string[] = [];
    const toArchiveReports: string[] = [];
    let skipped = 0;

    for (const tf of taskFiles) {
      const seqM = tf.match(/TASK-(\d{8}-\d{3})/);
      if (!seqM) { skipped++; continue; } // skip PLAN* etc.
      const seq = seqM[1]!;
      if (!doneSeqSet.has(seq)) { skipped++; continue; } // not done
      // Age check
      try {
        const st = fsm.statSync(join(tasksDir, tf));
        if (now - st.mtimeMs < minAgeMs) { skipped++; continue; }
      } catch { skipped++; continue; }
      toArchiveTasks.push(tf);
      // Find matching reports
      for (const rf of reportFiles) {
        if (rf.includes(seq)) toArchiveReports.push(rf);
      }
    }

    if (dryRun) return { archivedTasks: toArchiveTasks, archivedReports: toArchiveReports, skipped };

    // Move files to fcop/_lifecycle/archive/YYYYMM/tasks/ and /reports/
    const archivedTasks: string[] = [];
    const archivedReports: string[] = [];

    const ensureDir = async (d: string) => { try { await fsm.promises.mkdir(d, { recursive: true }); } catch {} };

    for (const tf of toArchiveTasks) {
      const ym = tf.match(/TASK-(\d{4})(\d{2})/);
      if (!ym) continue;
      const archDir = join(v3.archive, `${ym[1]}-${ym[2]}`, "tasks");
      await ensureDir(archDir);
      try {
        await fsm.promises.rename(join(tasksDir, tf), join(archDir, tf));
        archivedTasks.push(tf);
      } catch { /* leave in place if rename fails */ }
    }
    for (const rf of toArchiveReports) {
      const ym = rf.match(/REPORT-(\d{4})(\d{2})/);
      if (!ym) continue;
      const archDir = join(v3.archive, `${ym[1]}-${ym[2]}`, "reports");
      await ensureDir(archDir);
      try {
        await fsm.promises.rename(join(reportsDir, rf), join(archDir, rf));
        archivedReports.push(rf);
      } catch { /* leave in place */ }
    }

    return { archivedTasks, archivedReports, skipped };
  }

  /** Recursively collect *.md under dir whose basename starts with prefix. */
  function collectMdRecursive(fsm: typeof import("node:fs"), dir: string, prefix: string): string[] {
    const out: string[] = [];
    if (!fsm.existsSync(dir)) return out;
    for (const ent of fsm.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...collectMdRecursive(fsm, full, prefix));
      else if (ent.isFile() && ent.name.startsWith(prefix)) {
        if (prefix.startsWith("REPORT") && !isCanonicalReportMarkdownFilename(ent.name)) continue;
        if (!ent.name.endsWith(".md")) continue;
        out.push(full);
      }
    }
    return out;
  }

  const TASK_SEQ_RE = /TASK-(\d{8})-(\d{3})/;
  const REPORT_SEQ_RE = /REPORT-(\d{8}-\d{3})/;
  const REVIEW_DATE_RE = /REVIEW-(\d{8})-(\d{3})/;

  /** 本地日历「今天」YYYYMMDD — 仅归档文件名日期严格早于今天的条目（今天可归档昨天及更早）。 */
  function todayYmdLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }

  function ymdToBucket(ymd: string): string {
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  }

  function parseYamlFrontmatter(raw: string): Record<string, string> {
    const fm: Record<string, string> = {};
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match?.[1]) return fm;
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
      if (kv) fm[kv[1]!] = kv[2]!.trim();
    }
    return fm;
  }

  /** ADMIN/PM 打回后需重做 — 不得迁入 history/ 深归档 */
  function isTaskFileReopenedForRework(fsm: typeof import("node:fs"), filePath: string): boolean {
    try {
      const raw = fsm.readFileSync(filePath, "utf-8");
      const fm = parseYamlFrontmatter(raw);
      const reviewStatus = String(fm["review_status"] ?? "").toLowerCase();
      const reopenReason = String(fm["reopen_reason"] ?? "").trim();
      const reopenedCount = Number(fm["reopened_count"] ?? 0);
      return reviewStatus === "rejected" || !!reopenReason || reopenedCount > 0;
    } catch {
      return false;
    }
  }

  /** needs_human 且尚未人工批准 → 不可归档 */
  function isReviewStillPending(fsm: typeof import("node:fs"), filePath: string): boolean {
    try {
      const raw = fsm.readFileSync(filePath, "utf-8");
      const fm = parseYamlFrontmatter(raw);
      if (fm["decision"] !== "needs_human") return false;
      const approved = fm["approved_at"] && fm["approved_at"] !== "null" && fm["approved_at"] !== "''";
      return !approved;
    } catch {
      return true;
    }
  }

  function taskRouteFromFilename(fn: string): { sender: string; recipient: string } | null {
    return wpTaskRouteFromFilename(fn);
  }

  function isAdminMainlineTaskFn(fn: string): boolean {
    const route = taskRouteFromFilename(fn);
    if (route) {
      return route.sender === "ADMIN" && route.recipient === "PM";
    }
    const base = String(fn || "").replace(/\.md$/i, "");
    const parts = base.split("-");
    if (
      parts.length === 3 &&
      parts[0] === "TASK" &&
      /^\d{8}$/.test(parts[1] ?? "") &&
      /^\d{3}$/.test(parts[2] ?? "")
    ) {
      return true;
    }
    return false;
  }
  function isPmMainlineReplyFn(fn: string): boolean {
    return /-PM-to-ADMIN/i.test(fn);
  }
  function isPmBranchTaskFn(fn: string): boolean {
    return /-PM-to-(DEV|OPS|QA)/i.test(fn);
  }
  function isBranchReplyToPmFn(fn: string): boolean {
    return /-(DEV|OPS|QA)-to-PM/i.test(fn);
  }

  /** 与面板 findReportForTask 一致：按 task_id / references 关联，短 ID 用路由消歧。 */
  function reportPairsWithTask(taskFn: string, reportPath: string, reportRaw: string): boolean {
    const taskKey = taskFn.replace(/\.md$/i, "");
    const taskId = taskKey.match(/^(TASK-\d{8}-\d{3,})/)?.[1] ?? "";
    const linked = _wpLinkedTaskIds(reportRaw);
    if (taskKey && linked.includes(taskKey)) return true;
    if (!taskId || !linked.includes(taskId)) return false;

    const route = taskRouteFromFilename(taskFn);
    const rFn = pathBasename(reportPath);
    const rr = taskRouteFromFilename(rFn);

    if (isAdminMainlineTaskFn(taskFn)) return isPmMainlineReplyFn(rFn);
    if (isPmBranchTaskFn(taskFn)) {
      if (!isBranchReplyToPmFn(rFn)) return false;
      if (route && rr) return rr.sender === route.recipient;
      return true;
    }
    if (route && rr) return rr.sender === route.recipient;
    return true;
  }

  /** All REPORT paths under fcop/reports + _lifecycle/archive (recursive). */
  function collectAllReportPaths(
    fsm: typeof import("node:fs"),
    reportsDir: string,
    archiveDir: string,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (full: string) => {
      const base = pathBasename(full);
      if (seen.has(base)) return;
      seen.add(base);
      out.push(full);
    };
    if (fsm.existsSync(reportsDir)) {
      for (const f of fsm.readdirSync(reportsDir)) {
        if (isCanonicalReportMarkdownFilename(f)) add(join(reportsDir, f));
      }
    }
    for (const rp of collectMdRecursive(fsm, archiveDir, "REPORT-")) add(rp);
    return out;
  }

  /** Same-date-seq REPORT (legacy / when seq matches). */
  function indexReportsBySeq(
    fsm: typeof import("node:fs"),
    reportsDir: string,
    archiveDir: string,
  ): Map<string, string[]> {
    const bySeq = new Map<string, string[]>();
    for (const full of collectAllReportPaths(fsm, reportsDir, archiveDir)) {
      const m = pathBasename(full).match(REPORT_SEQ_RE);
      if (!m) continue;
      const seq = m[1]!;
      const list = bySeq.get(seq) ?? [];
      if (!list.includes(full)) list.push(full);
      bySeq.set(seq, list);
    }
    return bySeq;
  }

  function resolvePairedReports(
    fsm: typeof import("node:fs"),
    taskFn: string,
    seq: string,
    reportsBySeq: Map<string, string[]>,
    allReportPaths: string[],
    usedReports: Set<string>,
  ): string[] {
    const paired: string[] = [];
    const add = (rp: string) => {
      const base = pathBasename(rp);
      if (usedReports.has(base) || paired.includes(rp)) return;
      paired.push(rp);
    };
    for (const rp of reportsBySeq.get(seq) ?? []) add(rp);
    try {
      for (const rp of allReportPaths) {
        const raw = fsm.readFileSync(rp, "utf-8");
        if (reportPairsWithTask(taskFn, rp, raw)) add(rp);
      }
    } catch { /* skip unreadable */ }
    return paired;
  }

  /** TASK 已在 fcop/history/YYYY-MM-DD/<stem>/ 内 — 用于补归档遗留在 reports/ 的回执。 */
  function collectHistoryTaskShards(
    fsm: typeof import("node:fs"),
    historyRoot: string,
  ): Array<{ shardDir: string; taskFn: string; taskYmd: string }> {
    const out: Array<{ shardDir: string; taskFn: string; taskYmd: string }> = [];
    if (!fsm.existsSync(historyRoot)) return out;
    for (const dateBucket of fsm.readdirSync(historyRoot)) {
      if (dateBucket === "reviews") continue;
      const bucketPath = join(historyRoot, dateBucket);
      try {
        if (!fsm.statSync(bucketPath).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const shard of fsm.readdirSync(bucketPath)) {
        const shardDir = join(bucketPath, shard);
        try {
          if (!fsm.statSync(shardDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const f of fsm.readdirSync(shardDir)) {
          if (!f.startsWith("TASK-") || !f.endsWith(".md")) continue;
          const seqM = f.match(TASK_SEQ_RE);
          if (!seqM) continue;
          out.push({ shardDir, taskFn: f, taskYmd: seqM[1]! });
        }
      }
    }
    return out;
  }

  function listFlatReports(fsm: typeof import("node:fs"), reportsDir: string): string[] {
    if (!fsm.existsSync(reportsDir)) return [];
    return fsm
      .readdirSync(reportsDir)
      .filter((f) => isCanonicalReportMarkdownFilename(f))
      .map((f) => join(reportsDir, f));
  }

  /** True when `child` is inside `parentDir` (inclusive of subdirs). */
  function isPathUnderDir(child: string, parentDir: string): boolean {
    const c = pathResolve(child);
    const p = pathResolve(parentDir);
    const rel = path.relative(p, c);
    if (rel === "" || rel === ".") return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** TASK paths only under `_lifecycle/archive/` (recursive). History 深归档仅接受已常规归档项。 */
  function collectArchivableTasks(
    fsm: typeof import("node:fs"),
    v3: ReturnType<typeof fcopV3Paths>,
  ): string[] {
    if (!fsm.existsSync(v3.archive)) return [];
    return collectMdRecursive(fsm, v3.archive, "TASK-");
  }

  /** REVIEW-* under fcop/reviews/ (+ approved/ rejected/ subdirs). */
  function collectReviewFiles(fsm: typeof import("node:fs"), reviewsDir: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const sub of ["", "approved", "rejected"]) {
      const dir = sub ? join(reviewsDir, sub) : reviewsDir;
      if (!fsm.existsSync(dir)) continue;
      for (const f of fsm.readdirSync(dir)) {
        if (!f.startsWith("REVIEW-") || !f.endsWith(".md")) continue;
        if (seen.has(f)) continue;
        seen.add(f);
        out.push(join(dir, f));
      }
    }
    return out;
  }

  /**
   * 历史档案（fcop/history/YYYY-MM-DD/）：
   * 0) TASK 必须已在 `_lifecycle/archive/`（常规归档后）——inbox/active/review/done 一律不可进历史；
   * 1) 文件名日期早于今天（今天可归档昨天及更早已完成项）；
   * 2) TASK + 关联 REPORT（frontmatter task_id / references，与面板一致）成对原子迁入 history 分片；
   * 3) 已处理 REVIEW 审批文件单独归档至同日期桶 reviews/ 子目录。
   */
  async function archiveToHistory(dryRun = false): Promise<{
    movedTasks: string[];
    movedReports: string[];
    movedReviews: string[];
    skipped: number;
    error?: string;
  }> {
    const root = projectRoot();
    const v3 = fcopV3Paths(root);
    const reportsDir = opts.fcopReportsDir ?? v3.reports;
    const reviewsDir = opts.fcopReviewsDir ?? v3.reviews;
    const historyRoot = join(root, "fcop", "history");
    const fsm = await import("node:fs");
    const todayYmd = todayYmdLocal();

    const allReportPaths = collectAllReportPaths(fsm, reportsDir, v3.archive);
    const reportsBySeq = indexReportsBySeq(fsm, reportsDir, v3.archive);
    const taskPaths = collectArchivableTasks(fsm, v3);
    const usedReports = new Set<string>();

    const movedTasks: string[] = [];
    const movedReports: string[] = [];
    const movedReviews: string[] = [];
    let skipped = 0;

    for (const tp of taskPaths) {
      const name = pathBasename(tp);
      if (!isPathUnderDir(tp, v3.archive)) { skipped++; continue; }
      if (isTaskFileReopenedForRework(fsm, tp)) { skipped++; continue; }
      const seqM = name.match(TASK_SEQ_RE);
      if (!seqM) { skipped++; continue; }
      const taskYmd = seqM[1]!;
      if (taskYmd >= todayYmd) { skipped++; continue; }
      const seq = `${taskYmd}-${seqM[2]!}`;
      const paired = resolvePairedReports(fsm, name, seq, reportsBySeq, allReportPaths, usedReports);
      if (!paired.length) { skipped++; continue; }

      const dateBucket = ymdToBucket(taskYmd);
      const stem = name.replace(/\.md$/, "");
      const shardDir = join(historyRoot, dateBucket, stem);

      if (dryRun) {
        movedTasks.push(name);
        for (const rp of paired) {
          const rName = pathBasename(rp);
          movedReports.push(rName);
          usedReports.add(rName);
        }
        continue;
      }

      try {
        await fsm.promises.mkdir(shardDir, { recursive: true });
        await fsm.promises.rename(tp, join(shardDir, name));
        movedTasks.push(name);
        for (const rp of paired) {
          if (!fsm.existsSync(rp)) continue;
          const rName = pathBasename(rp);
          await fsm.promises.rename(rp, join(shardDir, rName));
          movedReports.push(rName);
          usedReports.add(rName);
        }
        reportsBySeq.delete(seq);
      } catch {
        skipped++;
      }
    }

    // TASK 已在 history 分片、REPORT 仍留在 fcop/reports/ → 补迁入同一分片（成对规则）
    const historyTasks = collectHistoryTaskShards(fsm, historyRoot);
    for (const rp of listFlatReports(fsm, reportsDir)) {
      const rName = pathBasename(rp);
      if (usedReports.has(rName)) continue;
      const rSeqM = rName.match(REPORT_SEQ_RE);
      if (!rSeqM) { skipped++; continue; }
      const reportYmd = rSeqM[1]!.slice(0, 8);
      if (reportYmd >= todayYmd) { skipped++; continue; }
      let raw = "";
      try {
        raw = fsm.readFileSync(rp, "utf-8");
      } catch {
        skipped++;
        continue;
      }
      const match = historyTasks.find(
        (ht) => ht.taskYmd < todayYmd && reportPairsWithTask(ht.taskFn, rp, raw),
      );
      if (!match) { skipped++; continue; }

      if (dryRun) {
        movedReports.push(rName);
        usedReports.add(rName);
        continue;
      }
      try {
        await fsm.promises.rename(rp, join(match.shardDir, rName));
        movedReports.push(rName);
        usedReports.add(rName);
      } catch {
        skipped++;
      }
    }

    for (const rp of collectReviewFiles(fsm, reviewsDir)) {
      const name = pathBasename(rp);
      const dateM = name.match(REVIEW_DATE_RE);
      if (!dateM) { skipped++; continue; }
      const reviewYmd = dateM[1]!;
      if (reviewYmd >= todayYmd) { skipped++; continue; }
      if (isReviewStillPending(fsm, rp)) { skipped++; continue; }

      const dateBucket = ymdToBucket(reviewYmd);
      const stem = name.replace(/\.md$/, "");
      const shardDir = join(historyRoot, dateBucket, "reviews", stem);

      if (dryRun) {
        movedReviews.push(name);
        continue;
      }

      try {
        await fsm.promises.mkdir(shardDir, { recursive: true });
        await fsm.promises.rename(rp, join(shardDir, name));
        movedReviews.push(name);
      } catch {
        skipped++;
      }
    }

    return { movedTasks, movedReports, movedReviews, skipped };
  }

  /**
   * GET /api/v2/archive/stats — show current file counts + what would be archived.
   */
  app.get("/api/v2/archive/stats", async (req: Request, res: Response) => {
    try {
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const reportsDir = opts.fcopReportsDir ?? v3.reports;
      const fsm = await import("node:fs");
      const taskCount = countLifecycleTasks(v3);
      const reportCount = fsm.existsSync(reportsDir) ? fsm.readdirSync(reportsDir).filter((f) => isCanonicalReportMarkdownFilename(f)).length : 0;
      const preview = await archiveToHistory(true);
      res.json({
        tasks_active: taskCount,
        reports_active: reportCount,
        tasks_archivable: preview.movedTasks.length,
        reports_archivable: preview.movedReports.length,
        reviews_archivable: preview.movedReviews.length,
        tasks_pending: preview.skipped,
      });
    } catch (err) { sendError(res, 500, "ARCHIVE_STATS_FAILED", String(err)); }
  });

  /**
   * POST /api/v2/archive/run — alias: 转入历史档案（与 to-history 同逻辑）。
   * Body: { min_age_days?: number } 已忽略；保留字段仅为旧客户端兼容。
   */
  app.post("/api/v2/archive/run", async (req: Request, res: Response) => {
    try {
      const result = await archiveToHistory(false);
      res.json({
        ok: true,
        archivedTasks: result.movedTasks,
        archivedReports: result.movedReports,
        archivedReviews: result.movedReviews,
        skipped: result.skipped,
      });
    } catch (err) { sendError(res, 500, "ARCHIVE_RUN_FAILED", String(err)); }
  });

  /** GET /api/v2/archive/history-stats — preview archive/ → history/ move. */
  app.get("/api/v2/archive/history-stats", async (_req: Request, res: Response) => {
    try {
      const preview = await archiveToHistory(true);
      res.json({
        tasks_movable: preview.movedTasks.length,
        reports_movable: preview.movedReports.length,
        reviews_movable: preview.movedReviews.length,
        skipped: preview.skipped,
      });
    } catch (err) { sendError(res, 500, "HISTORY_STATS_FAILED", String(err)); }
  });

  /** POST /api/v2/archive/to-history — 昨日及更早：TASK+REPORT 成对、REVIEW 单独 → history/ 日期分片。 */
  app.post("/api/v2/archive/to-history", async (req: Request, res: Response) => {
    try {
      const dryRun = Boolean(req.body?.["dry_run"]);
      const result = await archiveToHistory(dryRun);
      res.json({ ok: true, ...result });
    } catch (err) { sendError(res, 500, "HISTORY_ARCHIVE_FAILED", String(err)); }
  });

  // Auto-archival: run once on startup (if tasks > ARCHIVE_THRESHOLD), then every 24h.
  const ARCHIVE_THRESHOLD = 150;
  const runAutoArchive = async () => {
    try {
      const root = projectRoot();
      const v3 = fcopV3Paths(root);
      const fsm = await import("node:fs");
      const cnt = countLifecycleTasks(v3);
      if (cnt >= ARCHIVE_THRESHOLD) {
        // High-velocity: archive completed tasks immediately (min_age_days=0)
        const r = await archiveToHistory(false);
        console.info(`[AutoArchive] tasks=${cnt} >= ${ARCHIVE_THRESHOLD} → history ${r.movedTasks.length} tasks, ${r.movedReports.length} reports, ${r.movedReviews.length} reviews`);
      }
    } catch (e) { console.warn("[AutoArchive] error:", e); }
  };
  // Startup check (deferred 10s to let service settle)
  autoArchiveStartupTimer = setTimeout(runAutoArchive, 10_000);
  autoArchiveStartupTimer.unref();
  // Daily check at 03:00 local time
  autoArchiveDailyTimer = setInterval(runAutoArchive, 24 * 60 * 60 * 1000);
  autoArchiveDailyTimer.unref();

  /**
   * GET /api/v2/files/tree — returns directory tree for fcop/ + docs/
   */
  app.get("/api/v2/files/tree", async (_req: Request, res: Response) => {
    const root = projectRoot();
    const roots = ["fcop", "docs"];
    type TreeNode = { name: string; type: "dir" | "file"; path: string; fileCount?: number; children?: TreeNode[] };
    const buildTree = async (dirPath: string, maxDepth = 5, depth = 0): Promise<TreeNode | null> => {
      if (depth >= maxDepth) return null;
      const fsm = await import("node:fs");
      let entries: import("node:fs").Dirent[];
      try { entries = await fsm.promises.readdir(dirPath, { withFileTypes: true }); }
      catch { return null; }
      const children: TreeNode[] = [];
      let fileCount = 0;
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(dirPath, entry.name);
        const relPath = fullPath.replace(/\\/g, "/").replace(root.replace(/\\/g, "/") + "/", "");
        if (entry.isDirectory()) {
          const sub = await buildTree(fullPath, maxDepth, depth + 1);
          if (sub) children.push(sub);
        } else if (/\.(md|json|txt)$/.test(entry.name)) {
          fileCount++;
          children.push({ name: entry.name, type: "file", path: relPath });
        }
      }
      return { name: path.basename(dirPath), type: "dir", fileCount, children, path: dirPath.replace(/\\/g, "/").replace(root.replace(/\\/g, "/") + "/", "") };
    };
    try {
      // Filter out roots that don't exist before building (defensive)
      const rootPaths = roots.map(r => join(root, r)).filter(p => existsSync(p));
      const trees = await Promise.all(rootPaths.map(p => buildTree(p)));
      res.json(trees.filter(Boolean));
    } catch (err) {
      sendError(res, 500, "TREE_FAILED", String(err));
    }
  });

  // ── Sprint-A4: Environment check ────────────────────────────────────────

  // ── SSE event stream (v1.1) ──────────────────────────────────────────
  /**
   * GET /api/v2/events — Server-Sent Events live feed.
   *
   * Each SSE event is JSON-encoded with `type` and `payload` fields:
   *   { type: "runtime.session_started", payload: { agent_id, task_id, ... } }
   *   { type: "codeflowmu.heartbeat", payload: { uptime_s } }
   *
   * The browser can reconnect automatically via EventSource retry logic.
   * We send a heartbeat every 15 s to prevent proxy timeouts.
   */
  // Track all connected SSE clients.
  const sseClients = new Set<Response>();
  const mobileSseClients = new Set<Response>();

  function fanOutMobileSse(type: string, payload: Record<string, unknown>): void {
    const formatted = formatMobileSseEvent(type, payload);
    if (!formatted) return;
    const chunk = `event: ${formatted.event}\ndata: ${JSON.stringify(formatted.data)}\n\n`;
    for (const client of mobileSseClients) {
      client.write(chunk);
    }
  }

  // Thinking file logger — auto-saves SDK events to fcop/logs/thinking/*.jsonl
  const _thinkLogRoot = opts.projectRoot ?? null;
  const thinkingLogger = _thinkLogRoot ? new ThinkingFileLogger(_thinkLogRoot) : null;
  /** session_id → chat（面板聊天）| task（派单/唤醒/巡查等） */
  const sessionThinkingChannel = new Map<string, ThinkingChannel>();
  function noteSessionThinkingChannel(
    sessionId: string,
    channel: ThinkingChannel,
  ): void {
    const sid = String(sessionId ?? "").trim();
    if (sid) sessionThinkingChannel.set(sid, channel);
  }
  function resolveThinkingChannel(sessionId: string | undefined): ThinkingChannel {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return "task";
    return sessionThinkingChannel.get(sid) ?? "task";
  }
  function clearSessionThinkingChannel(sessionId: string | undefined): void {
    const sid = String(sessionId ?? "").trim();
    if (sid) sessionThinkingChannel.delete(sid);
  }
  // Usage file logger — auto-saves sdk.result events to fcop/logs/usage/*.jsonl
  const usageLogger = _thinkLogRoot ? new UsageFileLogger(_thinkLogRoot) : null;
  // Cursor Admin API usage syncer — pulls real billing data every 30 min (optional).
  const cursorSyncer =
    _thinkLogRoot && !isCursorAdminUsageSyncDisabled()
      ? new CursorUsageSyncer({ projectRoot: _thinkLogRoot })
      : null;
  cursorSyncer?.startAutoSync();

  // Subscribe to runtime session events once and fan-out to all clients.
  // Also push qualifying event types into the doorbell ring buffer.
  const sessionLastSdkFailureDetail = new Map<string, Record<string, unknown>>();

  function pickSdkErrorText(
    pl: Record<string, unknown>,
    raw?: Record<string, unknown>,
  ): string {
    const r = raw ?? (pl["raw"] as Record<string, unknown> | undefined) ?? {};
    return String(
      pl["sdk_error_message"] ??
        pl["error"] ??
        pl["message"] ??
        r["error"] ??
        r["message"] ??
        r["stop_reason"] ??
        r["failure_reason"] ??
        "",
    ).trim();
  }

  function pickFailureFieldsFromPayload(
    pl: Record<string, unknown>,
  ): Record<string, unknown> {
    return pickSdkFailureFieldsFromPayload(pl);
  }

  function failureCategoryLabel(category: string): string {
    const c = category.trim();
    const map: Record<string, string> = {
      cursor_sdk_first_turn_abort: "首轮 abort（0 工具调用）",
      cursor_sdk_error_no_detail: "Cursor SDK 无详细错误",
      policy_blocked: "策略边界拦截",
      transient_network: "网络瞬断",
      rate_limited: "限流 / 配额",
      unknown_sdk_error: "未知 SDK 错误",
    };
    return map[c] ?? c;
  }

  function cacheSdkFailureDetail(
    sessionId: string,
    pl: Record<string, unknown>,
  ): void {
    if (!sessionId) return;
    const picked = pickFailureFieldsFromPayload(pl);
    if (Object.keys(picked).length > 0) {
      sessionLastSdkFailureDetail.set(sessionId, picked);
      return;
    }
    const raw = pl["raw"] ?? pl;
    const buildFields = buildSdkFailurePayloadFields;
    sessionLastSdkFailureDetail.set(
      sessionId,
      buildFields({
        status: String(pl["status"] ?? "error"),
        tool_call_count:
          pl["tool_call_count"] != null ? Number(pl["tool_call_count"]) : 0,
        duration_ms:
          pl["duration_ms"] != null ? Number(pl["duration_ms"]) : undefined,
        raw,
        error_message: pickSdkErrorText(pl, raw as Record<string, unknown>),
        agent_id:
          typeof pl["agent_id"] === "string" ? pl["agent_id"] : undefined,
        session_id: sessionId,
        task_id: String(pl["task_id"] ?? ""),
      }),
    );
  }

  function formatSessionFailureDescription(
    plEnd: Record<string, unknown>,
    sdkFields: Record<string, unknown>,
    upstreamErr: string,
  ): string {
    const category = String(
      sdkFields["failure_category"] ?? plEnd["failure_category"] ?? "",
    ).trim();
    const tc = plEnd["tool_call_count"] ?? sdkFields["tool_call_count"];
    const dur = plEnd["duration_ms"] ?? sdkFields["duration_ms"];
    const sdkMsg = String(
      sdkFields["sdk_error_message"] ?? plEnd["sdk_error_message"] ?? "",
    ).trim();
    const sdkCode = String(
      sdkFields["sdk_error_code"] ?? plEnd["sdk_error_code"] ?? "",
    ).trim();
    const noDetail =
      sdkFields["sdk_no_detail"] === true ||
      plEnd["sdk_no_detail"] === true ||
      category === "cursor_sdk_error_no_detail";
    const noDetailNote = String(
      sdkFields["sdk_no_detail_note"] ??
        plEnd["sdk_no_detail_note"] ??
        (noDetail ? "SDK 未暴露详细错误" : ""),
    ).trim();

    const parts: string[] = [];
    if (category) parts.push(`[${failureCategoryLabel(category)}]`);
    if (sdkCode) parts.push(sdkCode);
    if (tc != null) parts.push(`tools=${tc}`);
    if (dur != null) parts.push(`${Math.round(Number(dur))}ms`);
    if (sdkMsg) parts.push(sdkMsg.slice(0, 200));
    else if (noDetailNote) parts.push(noDetailNote);
    else if (upstreamErr) parts.push(upstreamErr.slice(0, 200));

    const actions = sdkFields["suggested_actions"] ?? plEnd["suggested_actions"];
    if (Array.isArray(actions) && actions.length > 0) {
      parts.push(`建议: ${actions.slice(0, 4).join(" / ")}`);
    }

    return parts.join(" · ") || upstreamErr || "session_failed";
  }

  const unsubscribeSse = runtime.sessionManager.onEvent((event) => {
    doorbellBuffer.push(event.event_type, event);

    if (analyticsLedger?.shouldRecord(event.event_type)) {
      if (event.event_type === "runtime.session_started" && event.agent_id) {
        void analyticsLedger.ensureAgentMeta(event.agent_id, runtime.registry);
      }
      analyticsLedger.appendFromRuntimeEvent(
        {
          event_type: event.event_type,
          agent_id: event.agent_id,
          session_id: event.session_id,
          payload: event.payload,
        },
        { channel: resolveThinkingChannel(event.session_id) },
      );
    }

    if (runtimeEventLogger) {
      const pl = (event.payload ?? {}) as Record<string, unknown>;
      if (event.event_type === "sdk.status") {
        const st = String(pl["status"] ?? "");
        const isTransient =
          pl["transient_sdk_error"] === true ||
          st === "retrying" ||
          st === "delayed";
        if (st === "retrying" && pl["transient_sdk_error"] === true) {
          runtimeEventLogger.append("transient_sdk_retry", {
            ...pl,
            agent_id: event.agent_id,
            session_id: event.session_id,
            task_id: String(pl["task_id"] ?? ""),
          });
        }
        if (isTransient) {
          runtimeEventLogger.append("transient_sdk_error", {
            ...pl,
            agent_id: event.agent_id,
            session_id: event.session_id,
            task_id: String(pl["task_id"] ?? ""),
          });
        }
      } else if (
        event.event_type === "runtime.session_started" ||
        event.event_type === "runtime.session_ended" ||
        event.event_type === "runtime.session_cancelled" ||
        event.event_type === "sdk.result" ||
        event.event_type === "sdk.tool_call"
      ) {
        runtimeEventLogger.append(event.event_type, {
          ...pl,
          agent_id: event.agent_id,
          session_id: event.session_id,
          task_id: String(pl["task_id"] ?? ""),
          thread_key: String(pl["thread_key"] ?? ""),
        });
      }
    }

    if (
      event.event_type === "runtime.session_ended" ||
      event.event_type === "runtime.session_cancelled"
    ) {
      const plEnd = (event.payload ?? {}) as Record<string, unknown>;
      const st = String(plEnd["status"] ?? "").toLowerCase();
      const reason = String(
        plEnd["reason"] ?? plEnd["failure_code"] ?? plEnd["settlement_reason"] ?? "",
      ).trim();
      const isCancel =
        st === "cancelled" || event.event_type === "runtime.session_cancelled";
      const isTurnLimit =
        reason === "TURN_LIMIT" || String(plEnd["failure_code"] ?? "") === "TURN_LIMIT";

      if (event.event_type === "runtime.session_ended") {
        const reportWritten = plEnd["report_written"] === true;
        const reportRel = String(plEnd["report_path"] ?? "").trim();
        const skipLedgerResolve =
          isCancel ||
          isTurnLimit ||
          ((st === "failed" || st === "timeout") && !reportWritten);
        if (reportWritten && reportRel && !skipLedgerResolve) {
          const root = projectRoot();
          const reportAbs = resolveReportPathForAfterWrite(root, reportRel);
          void resolveReportAfterWrite(root, reportAbs).then(
            () => {
              invalidateLedgerFreshCache(root);
            },
            (err: unknown) => {
              console.warn(
                "[web-panel] resolveReportAfterWrite:",
                err instanceof Error ? err.message : String(err),
              );
            },
          );
        }
      }

      if (isCancel || isTurnLimit || st === "failed" || st === "timeout") {
        const reportWrittenEnd = plEnd["report_written"] === true;
        const severity =
          isTurnLimit || isCancel || reportWrittenEnd ? "WARN" : "ERROR";
        const cachedSdk =
          sessionLastSdkFailureDetail.get(event.session_id) ?? {};
        const plSdk = pickFailureFieldsFromPayload(plEnd);
        const mergedSdk = { ...cachedSdk, ...plSdk };
        const upstreamErr = String(plEnd["error"] ?? "").trim();
        const sdkErr = String(mergedSdk["sdk_error_message"] ?? "").trim();
        const detail = sdkErr || upstreamErr;
        const reasonLabel = reason || "UNKNOWN";
        const description = formatSessionFailureDescription(
          plEnd,
          mergedSdk,
          upstreamErr,
        );
        sseEmit("codeflowmu.failure", {
          type: "codeflowmu.failure",
          agent_id: event.agent_id,
          session_id: event.session_id,
          task_id: String(plEnd["task_id"] ?? ""),
          failure_type: isTurnLimit
            ? "turn_limit"
            : isCancel
              ? "session_cancelled"
              : "session_failed",
          description,
          message: description,
          error: detail || undefined,
          severity,
          reason: reasonLabel,
          status: st,
          tool_call_count: plEnd["tool_call_count"],
          duration_ms: plEnd["duration_ms"],
          report_written: plEnd["report_written"],
          report_path: plEnd["report_path"],
          ...mergedSdk,
          ts: Date.now(),
        });
        sessionLastSdkFailureDetail.delete(event.session_id);
      }

      if (
        event.event_type === "runtime.session_ended" &&
        (st === "failed" || st === "timeout")
      ) {
        const failTaskId = String(plEnd["task_id"] ?? "").trim();
        const reportWritten = plEnd["report_written"] === true;
        const failureCode = String(
          plEnd["failure_code"] ?? plEnd["reason"] ?? "",
        ).trim();
        const recoverable =
          !reportWritten &&
          isRecoverableSessionFailure(failureCode, st);
        if (failTaskId && !recoverable) {
          void (async () => {
            try {
              const rec = await runtime.registry.get(event.agent_id);
              const workerRole = (rec?.protocol.role ?? "").toUpperCase();
              if (["QA", "DEV", "OPS"].includes(workerRole)) {
                runtime.pmQueueGuard.markDownstreamWorkerFailed(failTaskId);
                void persistWorkerReceiptFailed(
                  projectRoot(),
                  failTaskId,
                  failureCode || "session_failed",
                );
              }
            } catch {
              /* best-effort */
            }
          })();
        } else if (failTaskId && recoverable) {
          void (async () => {
            try {
              const root = projectRoot();
              const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
              const { reports: reportRows } = await listReportsFromLedgerAuto(root);
              const rec = await runtime.registry.get(event.agent_id);
              const reconcile = await runAgentReconcile({
                projectRoot: root,
                runtime,
                agentId: event.agent_id,
                taskId: failTaskId,
                trigger: "session_ended",
                tasks: taskRows as unknown as LedgerTaskRecord[],
                reports: reportRows as unknown as LedgerReportRecord[],
                operator: "PM",
              });
              await triggerPanelAutoRecovery({
                trigger: "session_ended",
                agentId: event.agent_id,
                taskId: failTaskId,
                role: rec?.protocol.role,
                reconcile,
                sessionPayload: plEnd,
              });
            } catch (err) {
              console.warn(
                "[auto-recovery] session_ended:",
                err instanceof Error ? err.message : String(err),
              );
            }
          })();
        }
      }
    }

    // Tool / session failures: mirror into codeflowmu.failure so 门铃「故障」与错误日志有数据。
    if (event.event_type === "sdk.status") {
      const pl = (event.payload ?? {}) as Record<string, unknown>;
      const raw = (pl["raw"] ?? pl) as Record<string, unknown>;
      const st = String(raw["status"] ?? pl["status"] ?? "");
      const errText = String(raw["error"] ?? pl["error"] ?? pl["message"] ?? "").trim();
      const isTransient =
        raw["transient_sdk_error"] === true ||
        pl["transient_sdk_error"] === true ||
        st === "retrying" ||
        st === "delayed" ||
        isTransientSdkError(errText);
      if (!isTransient && (st === "failed" || st === "error") && errText) {
        sseEmit("codeflowmu.failure", {
          agent_id: event.agent_id,
          failure_type: "tool_error",
          description: errText.slice(0, 500),
          message: errText.slice(0, 500),
          recovered: false,
          session_id: event.session_id,
          run_id: event.run_id,
          ts: Date.now(),
        });
      }
    }
    // Auto-save thinking + tool_call + assistant events to chat/ or task/ jsonl
    if (
      thinkingLogger &&
      (event.event_type === "sdk.thinking" ||
        event.event_type === "sdk.tool_call" ||
        event.event_type === "sdk.assistant")
    ) {
      const channel = resolveThinkingChannel(event.session_id);
      const dims = analyticsLedger?.resolveDimensions({
        agent_id: event.agent_id,
        session_id: event.session_id,
        payload: event.payload,
        channel,
      });
      thinkingLogger.append(
        channel,
        event as unknown as Record<string, unknown>,
        dims,
      );
    }
    if (event.event_type === "sdk.thinking") {
      try {
        const plThink = (event.payload ?? {}) as Record<string, unknown>;
        const thinkChannel = resolveThinkingChannel(event.session_id);
        if (thinkChannel !== "chat") {
          const thinkDims = analyticsLedger?.resolveDimensions({
            agent_id: event.agent_id,
            session_id: event.session_id,
            payload: plThink,
            channel: thinkChannel,
          });
          ingestMobileThinking(projectRoot(), {
            task_id: String(
              plThink["task_id"] ??
                thinkDims?.task_id ??
                usageLogger?.getSessionTask(event.session_id) ??
                "",
            ),
            agent_id: event.agent_id,
            session_id: event.session_id,
          });
        }
      } catch {
        /* non-fatal */
      }
    }
    if (event.event_type === "sdk.tool_call") {
      const plTc = (event.payload ?? {}) as Record<string, unknown>;
      const tcChannel = resolveThinkingChannel(event.session_id);
      const tcDims = analyticsLedger?.resolveDimensions({
        agent_id: event.agent_id,
        session_id: event.session_id,
        payload: plTc,
        channel: tcChannel,
      });
      void maybeRecordPlaybookSkillFromToolCall({
        projectRoot: projectRoot(),
        agent_id: event.agent_id,
        session_id: event.session_id,
        payload: plTc,
        thread_key: String(plTc["thread_key"] ?? tcDims?.thread_key ?? ""),
        task_id: String(
          plTc["task_id"] ??
            tcDims?.task_id ??
            usageLogger?.getSessionTask(event.session_id) ??
            "",
        ),
      }).catch((err) => {
        console.warn(
          "[web-panel] skill invocation journal:",
          err instanceof Error ? err.message : String(err),
        );
      });
      try {
        maybeRecordActionEvidenceFromToolCall({
          projectRoot: projectRoot(),
          agent_id: event.agent_id,
          session_id: event.session_id,
          payload: plTc,
          thread_key: String(plTc["thread_key"] ?? tcDims?.thread_key ?? ""),
          task_id: String(
            plTc["task_id"] ??
              tcDims?.task_id ??
              usageLogger?.getSessionTask(event.session_id) ??
              "",
          ),
        });
      } catch (err) {
        console.warn(
          "[web-panel] action evidence:",
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        if (tcChannel !== "chat") {
          ingestMobileToolCall(projectRoot(), {
            task_id: String(
              plTc["task_id"] ??
                tcDims?.task_id ??
                usageLogger?.getSessionTask(event.session_id) ??
                "",
            ),
            agent_id: event.agent_id,
            tool: String(plTc["tool"] ?? plTc["name"] ?? ""),
            status: String(
              (plTc["raw"] as Record<string, unknown> | undefined)?.["status"] ??
                plTc["status"] ??
                "",
            ),
            target: String(plTc["target"] ?? plTc["path"] ?? ""),
            path: String(plTc["path"] ?? ""),
            command: String(plTc["command"] ?? ""),
          });
        }
      } catch {
        /* non-fatal */
      }
    }
    if (
      usageLogger &&
      event.event_type === "runtime.session_started"
    ) {
      const pl = (event.payload ?? {}) as Record<string, unknown>;
      const sid = String(event.session_id ?? pl["session_id"] ?? "");
      const tid = String(pl["task_id"] ?? "");
      if (sid && tid) usageLogger.noteSessionTask(sid, tid);
      const tk = String(pl["thread_key"] ?? "");
      if (sid && tk) usageLogger.noteSessionThread(sid, tk);
      if (sid && !sessionThinkingChannel.has(sid)) {
        sessionThinkingChannel.set(sid, "task");
      }
      if (event.agent_id) {
        scheduleSessionStartedStallCheck({
          agentId: event.agent_id,
          taskId: tid || null,
          sessionId: sid || null,
        });
      }
    }
    if (
      event.event_type === "runtime.session_ended" ||
      event.event_type === "runtime.session_cancelled"
    ) {
      clearSessionThinkingChannel(event.session_id);
      sessionLastSdkFailureDetail.delete(event.session_id);
    }
    if (event.event_type === "sdk.result") {
      const plRes = (event.payload ?? {}) as Record<string, unknown>;
      const rawRes = (plRes["raw"] ?? {}) as Record<string, unknown>;
      const stRes = String(rawRes["status"] ?? plRes["status"] ?? "").toLowerCase();
      if (stRes === "error" || stRes === "failed") {
        cacheSdkFailureDetail(event.session_id, {
          ...plRes,
          agent_id: event.agent_id,
          session_id: event.session_id,
        });
      }
    }
    // Auto-save sdk.result events to usage log (token consumption tracking)
    if (usageLogger && event.event_type === "sdk.result") {
      const dims = analyticsLedger?.resolveDimensions({
        agent_id: event.agent_id,
        session_id: event.session_id,
        payload: event.payload,
        channel: resolveThinkingChannel(event.session_id),
      });
      usageLogger.append(event as unknown as Record<string, unknown>, dims);
    }
    // ── Direct-chat response tracking ──────────────────────────────
    // sdk.assistant payload shape (from thinking log):
    //   { sdk_type, raw: { type, agent_id, run_id, message: { role, content: [{type:"text", text:"..."}] } } }
    if (event.event_type === "sdk.thinking" && chatPending.has(event.session_id)) {
      const entry = chatPending.get(event.session_id)!;
      const thinkChunk = extractSdkThinkingText(
        event.payload as Record<string, unknown> | undefined,
      );
      if (thinkChunk) entry.thinking += thinkChunk;
    }
    if (event.event_type === "sdk.assistant" && chatPending.has(event.session_id)) {
      const entry = chatPending.get(event.session_id)!;
      type AssistantPayload = {
        raw?: {
          message?: { content?: Array<{ type?: string; text?: string }> };
          text?: string;
          content?: string;
        };
        text?: string;
        content?: string;
      };
      const pl = event.payload as AssistantPayload | undefined;
      const contentArr = pl?.raw?.message?.content ?? [];
      const chunk = contentArr.length > 0
        ? contentArr.map((c) => c.text ?? "").join("")
        : (pl?.raw?.text ?? pl?.raw?.content ?? pl?.text ?? pl?.content ?? "");
      entry.text += chunk;
      if (chunk) {
        sseEmit("codeflowmu.chat_delta", {
          agentId: entry.agentId,
          text: entry.text,
          delta: chunk,
          ts: new Date().toISOString(),
          session_id: event.session_id,
        });
      }
    }
    if (event.event_type === "runtime.session_ended" && chatPending.has(event.session_id)) {
      const entry = chatPending.get(event.session_id)!;
      chatPending.delete(event.session_id);
      const plChatEnd = (event.payload ?? {}) as Record<string, unknown>;
      const stChatEnd = String(plChatEnd["status"] ?? "").toLowerCase();
      let replyText = alignChatReplyWithThinking({
        uiLang: entry.uiLang,
        userMessage: entry.userMessage,
        thinking: entry.thinking,
        assistantReply: entry.text.trim(),
      });
      let chatFailed = false;
      if (!replyText && (stChatEnd === "failed" || stChatEnd === "timeout")) {
        const plSdkChat = pickFailureFieldsFromPayload(plChatEnd);
        const upstreamErrChat = String(plChatEnd["error"] ?? "").trim();
        const failDesc = formatSessionFailureDescription(
          plChatEnd,
          plSdkChat,
          upstreamErrChat,
        );
        replyText = `⚠ 会话失败 · ${failDesc}`;
        chatFailed = true;
      }
      replyText = replyText || "(无回复)";
      const msg: DirectChatMsg = {
        id: `dc-${Date.now()}`, agentId: entry.agentId,
        role: "agent", text: replyText,
        ts: new Date().toISOString(), session_id: event.session_id,
      };
      directChat.push(msg);
      if (directChat.length > 500) directChat.shift();
      persistDirectChatMsg(msg);
      sseEmit("codeflowmu.chat_reply", {
        agentId: entry.agentId,
        text: replyText,
        ts: msg.ts,
        session_id: event.session_id,
        ...(chatFailed
          ? {
              chat_failed: true,
              failure_type: "session_failed",
              tool_call_count: plChatEnd["tool_call_count"],
              duration_ms: plChatEnd["duration_ms"],
              status: stChatEnd,
            }
          : {}),
      });
    }
    const data = JSON.stringify({ type: event.event_type, payload: event });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
    const evPayload =
      typeof (event as { payload?: unknown }).payload === "object" &&
      (event as { payload?: unknown }).payload !== null
        ? ((event as { payload: Record<string, unknown> }).payload as Record<string, unknown>)
        : {};
    fanOutMobileSse(String((event as { event_type?: string }).event_type ?? ""), {
      ...evPayload,
      agent_id: (event as { agent_id?: string }).agent_id,
      session_id: (event as { session_id?: string }).session_id,
      task_id: (event as { task_id?: string }).task_id,
      thread_key: (event as { thread_key?: string }).thread_key,
    });
  });

  // Fan-out helper for synthetic codeflowmu.* events (task drop, report detect).
  // Also persists qualifying events into the doorbell ring buffer.
  function sseEmit(type: string, payload: Record<string, unknown>) {
    ingestRuntimeAlertFromSse(type, payload);
    doorbellBuffer.push(type, payload);
    if (runtimeEventLogger && RUNTIME_EVENT_TYPES.has(type)) {
      runtimeEventLogger.append(type, {
        ...payload,
        agent_id: String(payload.agent_id ?? payload.agentId ?? ""),
        session_id: String(payload.session_id ?? ""),
        task_id: String(payload.task_id ?? payload.taskId ?? ""),
        thread_key: String(payload.thread_key ?? payload.threadKey ?? ""),
      });
    }
    if (analyticsLedger?.shouldRecord(type)) {
      const sid = String(payload.session_id ?? "");
      analyticsLedger.appendFromRuntimeEvent(
        {
          event_type: type,
          agent_id: String(payload.agent_id ?? payload.agentId ?? ""),
          session_id: sid,
          payload,
        },
        {
          channel: sid ? resolveThinkingChannel(sid) : "task",
          task_id: String(payload.task_id ?? payload.taskId ?? ""),
          thread_key: String(payload.thread_key ?? payload.threadKey ?? ""),
        },
      );
    }
    try {
      maybeRecordPanelRuntimeActionFromSse(resolveProjectRoot(), type, payload);
    } catch {
      /* non-fatal */
    }
    try {
      ingestMobileSse(resolveProjectRoot(), type, payload);
    } catch {
      /* non-fatal */
    }
    const data = JSON.stringify({ type, payload });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
    fanOutMobileSse(type, payload);
  }
  // Expose so callers (main.ts) can push synthetic events without reaching
  // into the closed-over clients set.
  (app as unknown as { sseEmit: typeof sseEmit }).sseEmit = sseEmit;

  function schedulePanelDelayedWakeRetry(
    plan: WakeDownstreamRequest,
    remainingMs: number,
    reason: string,
  ): boolean {
    if (!pmWakeExecutorRef) return false;
    return scheduleDelayedPmWakeRetry({
      remainingMs,
      reason,
      request: plan,
      wake: (req) => pmWakeExecutorRef!(req),
      onScheduled: (info) => {
        sseEmit("wake_agent.delayed", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          role: plan.role,
          thread_key: plan.thread_key,
          remaining_ms: info.remainingMs,
          reason: info.reason,
          delayed: true,
        });
      },
    });
  }

  /** REPORT 落盘后 resolve ledger 并触发 PM 治理（不依赖 ADMIN 聊天唤醒）。 */
  async function handleReportArrivalGovernance(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const root = resolveProjectRoot();
    const reportAbs = resolveReportPathForAfterWrite(
      root,
      String(payload.filepath ?? "").trim(),
    );
    if (reportAbs) {
      try {
        await resolveReportAfterWrite(root, reportAbs);
        invalidateLedgerFreshCache(root);
      } catch (err) {
        console.warn(
          "[web-panel] resolveReportAfterWrite (report_detected):",
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        const raw = readFileSync(reportAbs, "utf-8");
        const fm = parseMarkdownFrontmatter(raw);
        const sender = String(fm["sender"] ?? fm["reporter"] ?? "").toUpperCase();
        const recipient = String(fm["recipient"] ?? "").toUpperCase();
        const status = String(fm["status"] ?? "").toLowerCase();
        const taskId = String(
          fm["task_id"] ?? fm["source_task_id"] ?? "",
        ).trim();
        if (sender === "PM" && recipient === "ADMIN" && status === "done" && taskId) {
          const generated = await generateAdminTaskCloseoutEval(root, taskId);
          sseEmit("codeflowmu.eval_observation_generated", {
            task_id: taskId,
            report: pathBasename(reportAbs),
            generated: generated.result,
          });
        }
      } catch (err) {
        console.warn(
          "[web-panel] auto EVAL after PM final failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const throttleKey = [
      String(payload.filename ?? pathBasename(reportAbs)),
      String(payload.sender_role ?? ""),
    ].join("|");
    if (!reportArrivalGovernanceThrottle.shouldRun(throttleKey)) {
      console.warn(
        `[pm-governance] report_arrival throttled (${throttleKey.slice(0, 80)})`,
      );
      return;
    }

    if (!pmWakeExecutorRef) {
      console.warn(
        "[pm-governance] report_arrival skipped: pmWakeExecutorRef not ready",
      );
      return;
    }

    try {
      await runtime.pmQueueGuard.runGuarded(
        "governance:report_arrival",
        () =>
          runPmGovernanceCycle(root, {
            triggered_by: "report_arrival",
            wake_downstream: pmWakeExecutorRef ?? undefined,
            allow_auto_wake: true,
            auto_review: true,
            max_threads: 3,
            max_judgments: 5,
          }),
        "completed",
      );
      try {
        const pmAgents = await runtime.registry.list({ role: "PM" });
        const pmId = pmAgents[0]?.protocol.agent_id;
        if (pmId) {
          void triggerPanelAutoRecovery({
            trigger: "report_arrival",
            agentId: pmId,
            role: "PM",
          });
        }
      } catch (err) {
        console.warn(
          "[auto-recovery] report_arrival:",
          err instanceof Error ? err.message : String(err),
        );
      }
    } catch (err) {
      console.warn("[pm-governance] report_arrival cycle failed:", err);
    }
  }

  const useDirectAiWake = (): boolean => true;
  const executePmWakeDownstreamRaw: WakeDownstreamExecutor = async (plan) =>
    agentWakeMutex.run(plan.agent_id, async () => {
      const root = resolveProjectRoot();
      // Wake is an AI runtime primitive, not a task-dispatch decision.  The
      // agent decides what work is actionable after it wakes.  In particular,
      // stale lifecycle projection, dependency checks, report presence and
      // sequential planning must never prevent an idle AI from being woken.
      // Formal task dispatch remains a separate TaskDispatcher operation.
      if (useDirectAiWake()) {
      const directGate = await evaluateAgentWakeGate({
        agentId: plan.agent_id,
        registry: runtime.registry,
        sessionManager: runtime.sessionManager,
      });
      if (!directGate.allow) {
        const running =
          directGate.reason === "agent_running" ||
          directGate.reason === "active_session";
        sseEmit("wake_agent.skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: running ? "agent_running" : directGate.reason,
          detail: directGate.detail,
          thread_key: plan.thread_key,
        });
        return {
          ok: running,
          skipped: true,
          reason: running ? "already_running" : directGate.reason,
          agent_id: plan.agent_id,
        };
      }

      sseEmit("wake_agent.requested", {
        task_id: plan.task_id,
        agent_id: plan.agent_id,
        role: plan.role,
        reason: plan.reason,
        thread_key: plan.thread_key,
      });
      await appendWakeJournal(root, plan.journal_entry).catch(() => undefined);
      try {
        const attachments = loadTaskAttachmentsFromDisk(root, plan.task_id);
        const attachmentBlock = formatImageAttachmentPromptBlock(attachments);
        const wakeText = attachmentBlock
          ? `${plan.message}\n\n${attachmentBlock}`
          : plan.message;
        const sessionImages = await buildSessionImagesFromAttachments(root, attachments);
        const handle = await runtime.sessionManager.startSession(
          plan.agent_id,
          plan.task_id || `WAKE-${Date.now()}`,
          {
            text: wakeText,
            maxToolRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
            context: {
              wake_reason: plan.reason,
              ...(plan.task_id ? { task_id: plan.task_id } : {}),
              ...(plan.thread_key ? { thread_key: plan.thread_key } : {}),
            },
            ...(sessionImages.length > 0 ? { images: sessionImages } : {}),
          },
        );
        if (usageLogger && handle.session_id) {
          if (plan.task_id) usageLogger.noteSessionTask(handle.session_id, plan.task_id);
          if (plan.thread_key) usageLogger.noteSessionThread(handle.session_id, plan.thread_key);
        }
        noteSessionThinkingChannel(handle.session_id, "task");
        sseEmit("wake_agent.accepted", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          session_id: handle.session_id,
          thread_key: plan.thread_key,
        });
        return {
          ok: true,
          session_id: handle.session_id,
          agent_id: plan.agent_id,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sseEmit("wake_agent.failed", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          error: msg,
        });
        return { ok: false, error: msg, agent_id: plan.agent_id };
      }
      }

      /* Legacy dispatch-aware wake path retained below temporarily for
       * source compatibility; direct wake above is the authoritative path. */
      /* istanbul ignore next */
      const isExplicitPmWake =
        plan.source === "pm_agent_tool" || plan.source === "admin_review_reject";
      const queueExplicitWake = async (reason: string) => {
        const hit = findTaskFileByIdPrefix(root, plan.task_id);
        await enqueueTaskWhenAgentBusy({
          projectRoot: root,
          taskId: plan.task_id,
          agentId: plan.agent_id,
          reason,
          filepath: hit?.path,
          filename: hit?.path?.split(/[/\\]/).pop(),
          recipient: plan.role,
        });
        sseEmit("wake_agent.queued", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason,
          thread_key: plan.thread_key,
        });
        return {
          ok: true,
          queued: true,
          reason: "queued",
          queue_reason: reason,
          agent_id: plan.agent_id,
        };
      };
      const sequential = await evaluateSequentialDispatchGuard({
        projectRoot: root,
        taskId: plan.task_id,
        targetRole: plan.role,
      });
      if (!sequential.allow && !isExplicitPmWake) {
        sseEmit("wake_agent.skipped", {
          action: "wake_blocked",
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: "sequential_dispatch_guarded",
          current_leg: sequential.current_leg,
          blocked_target: sequential.blocked_target,
          next_allowed_agent: sequential.next_allowed_agent,
        });
        return {
          ok: false,
          skipped: true,
          reason: "sequential_dispatch_guarded",
          current_leg: sequential.current_leg,
          blocked_target: sequential.blocked_target,
          next_allowed_agent: sequential.next_allowed_agent,
        };
      }
      const hasReport = await findReportForTaskOnDisk({
        projectRoot: root,
        taskId: plan.task_id,
        reporter: plan.role ?? "PM",
        reportRecipient: plan.role === "PM" ? "ADMIN" : "PM",
      });
      if (hasReport) {
        sseEmit("wake_agent.skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: "report_already_on_disk",
          thread_key: plan.thread_key,
        });
        return { ok: true, skipped: true, reason: "report_already_on_disk" };
      }

      const pausedStatus = await getTaskDispatchStatus(root, plan.task_id);
      if (pausedStatus === "paused") {
        sseEmit("wake_agent.skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: "task_paused",
          detail: "paused task must use resume, not wake",
          thread_key: plan.thread_key,
        });
        return { ok: true, skipped: true, reason: "task_paused" };
      }

      const throttleKey = wakeThrottleKey(
        plan.task_id,
        plan.thread_key ?? undefined,
        plan.agent_id,
      );
      if (!isExplicitPmWake && !wakeCheckThrottle.shouldRun(throttleKey)) {
        const remainingMs = wakeCheckThrottle.msUntilReady(throttleKey);
        const stopped = markPmStop({
          taskId: plan.task_id,
          agentId: plan.agent_id,
          reason: "wake_throttled",
          remainingMs,
          cooldownReason: "wake_throttled",
        });
        sseEmit("wake_agent.skipped", {
          action: "wake_throttled",
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: "wake_throttled",
          thread_key: plan.thread_key,
          retry_after_ms: remainingMs,
          remainingMs,
          untilMs: stopped.untilMs,
          cooldownReason: stopped.cooldownReason,
          policy: PM_STOP_POLICY,
        });
        return {
          ok: false,
          skipped: true,
          reason: "wake_throttled",
          remainingMs,
          untilMs: stopped.untilMs,
          cooldownReason: stopped.cooldownReason,
          policy: PM_STOP_POLICY,
          next_owner: "PM",
        };
      }

      const gate = await evaluateAgentWakeGate({
        agentId: plan.agent_id,
        registry: runtime.registry,
        sessionManager: runtime.sessionManager,
      });
      if (!gate.allow) {
        if (
          isExplicitPmWake &&
          gate.reason !== "agent_running" &&
          gate.reason !== "active_session"
        ) {
          return queueExplicitWake(gate.reason ?? "temporarily_unavailable");
        }
        const retryMs = gate.retryAfterMs ?? 0;
        if (retryMs > 0 && gate.reason === "sdk_cooldown") {
          const stopped = markPmStop({
            taskId: plan.task_id,
            agentId: plan.agent_id,
            reason: gate.reason,
            remainingMs: retryMs,
            cooldownReason: gate.reason,
          });
          return {
            ok: false,
            skipped: true,
            remainingMs: retryMs,
            untilMs: stopped.untilMs,
            cooldownReason: stopped.cooldownReason,
            reason: gate.reason,
            agent_id: plan.agent_id,
            policy: PM_STOP_POLICY,
            next_owner: "PM",
          };
        }
        if (
          gate.reason === "agent_running" ||
          gate.reason === "active_session"
        ) {
          const existingStatus = await getTaskDispatchStatus(root, plan.task_id);
          if (existingStatus === "queued" || existingStatus === "running") {
            sseEmit("wake_agent.skipped", {
              task_id: plan.task_id,
              agent_id: plan.agent_id,
              reason: gate.reason,
              detail: gate.detail,
              thread_key: plan.thread_key,
            });
            return {
              ok: true,
              skipped: true,
              reason: "already_running",
              agent_id: plan.agent_id,
            };
          }
          if (
            shouldEscalateAdminForceRecovery({
              reason: gate.reason,
              taskBucket: sequential.task_bucket,
            })
          ) {
            sseEmit("wake_agent.skipped", {
              action: "recovery_required",
              task_id: plan.task_id,
              agent_id: plan.agent_id,
              reason: gate.reason,
              policy: ADMIN_FORCE_RECOVERY_POLICY,
            });
            return {
              ok: false,
              skipped: true,
              reason: gate.reason,
              policy: ADMIN_FORCE_RECOVERY_POLICY,
              next_owner: "ADMIN",
            };
          }
          let taskPath: string | undefined;
          let taskFilename: string | undefined;
          try {
            const hit = findTaskFileByIdPrefix(root, plan.task_id);
            if (hit?.path) {
              taskPath = hit.path;
              taskFilename = hit.path.split(/[/\\]/).pop();
            }
          } catch {
            /* best-effort filepath for queue advance */
          }
          await enqueueTaskWhenAgentBusy({
            projectRoot: root,
            taskId: plan.task_id,
            agentId: plan.agent_id,
            reason: "wake_while_agent_busy",
            filepath: taskPath,
            filename: taskFilename,
            recipient: plan.role,
          });
          sseEmit("wake_agent.queued", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "agent_busy_queued",
            thread_key: plan.thread_key,
          });
          return {
            ok: true,
            queued: true,
            reason: "agent_busy_queued",
            agent_id: plan.agent_id,
          };
        }
        sseEmit("wake_agent.skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: gate.reason,
          detail: gate.detail,
          thread_key: plan.thread_key,
        });
        return { ok: true, skipped: true, reason: gate.reason };
      }

      const taskGate = isExplicitPmWake
        ? { allow: true as const }
        : await evaluateTaskDispatchWakeGate({
            projectRoot: root,
            taskId: plan.task_id,
          });
      if (!taskGate.allow) {
        sseEmit("dispatch_skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: taskGate.reason,
          detail: taskGate.detail,
          thread_key: plan.thread_key,
        });
        sseEmit("wake_agent.skipped", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          reason: taskGate.reason,
          detail: taskGate.detail,
          thread_key: plan.thread_key,
        });
        return { ok: true, skipped: true, reason: taskGate.reason };
      }

      sseEmit("wake_agent.requested", {
        task_id: plan.task_id,
        agent_id: plan.agent_id,
        role: plan.role,
        reason: plan.reason,
        thread_key: plan.thread_key,
      });

      try {
        await appendWakeJournal(root, plan.journal_entry);
      } catch (err) {
        const msg = String(err);
        sseEmit("wake_agent.failed", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          error: msg,
        });
        return { ok: false, error: msg, agent_id: plan.agent_id };
      }

      try {
        const attachments = loadTaskAttachmentsFromDisk(root, plan.task_id);
        const attachmentBlock = formatImageAttachmentPromptBlock(attachments);
        const wakeText = attachmentBlock
          ? `${plan.message}\n\n${attachmentBlock}`
          : plan.message;
        const sessionImages = await buildSessionImagesFromAttachments(
          root,
          attachments,
        );

        const hit = findTaskFileByIdPrefix(root, plan.task_id);
        if (!hit?.path) {
          const msg = `task file not found for ${plan.task_id}`;
          sseEmit("wake_agent.failed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            error: msg,
          });
          return { ok: false, error: msg, agent_id: plan.agent_id };
        }
        const taskPath = hit.path;
        const taskFilename =
          hit.path.split(/[/\\]/).pop() ?? `${plan.task_id}.md`;

        const outcome = await runtime.dispatcher.dispatchTaskFromControlPlane(
          taskPath,
          taskFilename,
          plan.role,
          "pm_wake",
          {
            preferredAgentId: plan.agent_id,
            sessionTextOverride: wakeText,
            sessionImagesOverride: sessionImages,
            maxToolRounds: DEFAULT_SESSION_MAX_TOOL_ROUNDS,
            bypassBusinessGates: isExplicitPmWake,
          },
        );

        if (outcome.kind === "dispatched") {
          noteSessionThinkingChannel(outcome.session_id, "task");
          sseEmit("wake_agent.accepted", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            session_id: outcome.session_id,
            thread_key: plan.thread_key,
          });
          return {
            ok: true,
            session_id: outcome.session_id,
            agent_id: plan.agent_id,
          };
        }

        if (outcome.kind === "already_dispatched") {
          sseEmit("wake_agent.skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "already_dispatched",
            thread_key: plan.thread_key,
          });
          return { ok: true, skipped: true, reason: "already_running" };
        }

        if (outcome.kind === "dependency_pending") {
          if (isExplicitPmWake) {
            return queueExplicitWake("dependency_pending_after_explicit_bypass");
          }
          sseEmit("dispatch_skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "dependency_pending",
            detail: outcome.reason,
            thread_key: plan.thread_key,
          });
          sseEmit("wake_agent.skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "dependency_pending",
            detail: outcome.reason,
            thread_key: plan.thread_key,
          });
          return { ok: true, skipped: true, reason: "dependency_pending" };
        }

        if (outcome.kind === "dispatch_skipped") {
          if (isExplicitPmWake) {
            return queueExplicitWake(outcome.reason || "dispatch_temporarily_unavailable");
          }
          sseEmit("dispatch_skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: outcome.reason,
            detail: outcome.detail,
            thread_key: plan.thread_key,
          });
          sseEmit("wake_agent.skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: outcome.reason,
            detail: outcome.detail,
            thread_key: plan.thread_key,
          });
          return { ok: true, skipped: true, reason: outcome.reason };
        }

        if (outcome.kind === "rejected_busy") {
          await enqueueTaskWhenAgentBusy({
            projectRoot: root,
            taskId: plan.task_id,
            agentId: plan.agent_id,
            reason: "wake_while_agent_busy",
            filepath: taskPath,
            filename: taskFilename,
            recipient: plan.role,
          });
          sseEmit("wake_agent.queued", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "agent_busy_queued",
            thread_key: plan.thread_key,
          });
          return {
            ok: true,
            queued: true,
            reason: "agent_busy_queued",
            agent_id: plan.agent_id,
          };
        }

        if (
          outcome.kind === "retry_waiting" ||
          outcome.kind === "waiting_admin_decision" ||
          outcome.kind === "blocked_network"
        ) {
          const remainingMs =
            outcome.kind === "retry_waiting"
              ? Math.max(0, outcome.next_retry_at - Date.now())
              : 0;
          const cooldownReason =
            outcome.kind === "retry_waiting"
              ? "retry_waiting"
              : outcome.kind === "blocked_network"
                ? "blocked_network"
                : "waiting_admin_decision";
          const msg =
            outcome.kind === "retry_waiting"
              ? outcome.reason
              : outcome.reason;
          if (isExplicitPmWake) {
            return queueExplicitWake(cooldownReason);
          }
          const stopped = markPmStop({
            taskId: plan.task_id,
            agentId: plan.agent_id,
            reason: cooldownReason,
            remainingMs,
          });
          sseEmit("wake_agent.delayed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            thread_key: plan.thread_key,
            error: msg,
            transient_sdk_error: outcome.kind === "blocked_network",
            status: "delayed",
          });
          return {
            ok: false,
            skipped: true,
            error: msg,
            agent_id: plan.agent_id,
            reason: cooldownReason,
            remainingMs,
            untilMs: stopped.untilMs,
            cooldownReason: stopped.cooldownReason,
            policy: PM_STOP_POLICY,
            next_owner: "PM",
          };
        }

        if (outcome.kind === "observer_bypass") {
          sseEmit("wake_agent.skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: "observer_bypass",
            thread_key: plan.thread_key,
          });
          return { ok: true, skipped: true, reason: "observer_bypass" };
        }

        if (outcome.kind === "agent_not_found") {
          const msg =
            outcome.reason ??
            `no agent registered for role "${outcome.recipient}"`;
          sseEmit("wake_agent.failed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            error: msg,
          });
          return { ok: false, error: msg, agent_id: plan.agent_id };
        }

        if (outcome.kind === "parse_failed" || outcome.kind === "no_task_id") {
          const msg =
            outcome.kind === "parse_failed"
              ? outcome.reason
              : "missing task id";
          sseEmit("wake_agent.failed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            error: msg,
          });
          return { ok: false, error: msg, agent_id: plan.agent_id };
        }

        if (outcome.kind === "dispatch_bypass_blocked") {
          sseEmit("wake_agent.failed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            error: outcome.reason,
          });
          return { ok: false, error: outcome.reason, agent_id: plan.agent_id };
        }

        if (outcome.kind === "held_in_inbox") {
          sseEmit("wake_agent.skipped", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            reason: outcome.reason,
            thread_key: plan.thread_key,
          });
          return { ok: true, skipped: true, reason: outcome.reason };
        }

        if (outcome.kind === "force_archived") {
          sseEmit("wake_agent.failed", {
            task_id: plan.task_id,
            agent_id: plan.agent_id,
            error: "force_archived",
          });
          return { ok: false, error: "force_archived", agent_id: plan.agent_id };
        }

        const fallback = `unexpected dispatch outcome: ${(outcome as { kind: string }).kind}`;
        sseEmit("wake_agent.failed", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          error: fallback,
        });
        return { ok: false, error: fallback, agent_id: plan.agent_id };
      } catch (err) {
        const msg = String(err);
        sseEmit("wake_agent.failed", {
          task_id: plan.task_id,
          agent_id: plan.agent_id,
          error: msg,
        });
        return { ok: false, error: msg, agent_id: plan.agent_id };
      }
    });
  const executePmWakeDownstream: WakeDownstreamExecutor = async (plan) => {
    const startedAt = Date.now();
    let result: Awaited<ReturnType<WakeDownstreamExecutor>>;
    try {
      result = await executePmWakeDownstreamRaw(plan);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        agent_id: plan.agent_id,
      };
    }
    const outcome = result.delayed
      ? "delayed"
      : result.skipped
        ? "skipped"
        : result.ok
          ? "ok"
          : "failed";
    const nextRetryAt = result.untilMs ??
      (result.remainingMs ? Date.now() + result.remainingMs : undefined);
    const source = plan.source ?? "runtime_wake_executor";
    const caller = plan.caller ?? "PM";
    const auditDetail = JSON.stringify({
      task_id: plan.task_id,
      thread_key: plan.thread_key,
      role: plan.role,
      agent_id: result.agent_id ?? plan.agent_id,
      reason: result.reason ?? plan.reason,
      caller,
      source,
      session_id: result.session_id ?? null,
      outcome,
      cooldown_ms: result.remainingMs ?? null,
      next_retry_at: nextRetryAt ?? null,
    });
    appendPanelRuntimeAction(resolveProjectRoot(), {
      operator: caller,
      action: "wake_downstream",
      target_task: plan.task_id,
      target_agent: result.agent_id ?? plan.agent_id,
      result: outcome,
      reason: result.reason ?? result.error ?? plan.reason,
      detail: auditDetail,
      session_id: result.session_id,
      current_leg: result.current_leg,
      blocked_target: result.blocked_target,
      cooldownReason: result.cooldownReason,
      remainingMs: result.remainingMs,
      untilMs: result.untilMs,
      source,
      caller,
      role: plan.role,
      next_retry_at: nextRetryAt,
    });
    await recordSkillInvocation(resolveProjectRoot(), {
      skill_id: "pm.wake_downstream",
      channel: source === "pm_agent_tool" ? "mcp" : source === "governance_planner" ? "governance_planner" : "agent_runtime",
      triggered_by: source,
      caller_role: "PM",
      task_id: plan.task_id,
      ...(plan.thread_key ? { thread_key: plan.thread_key } : {}),
      outcome: outcome === "failed" ? "failed" : outcome === "ok" ? "ok" : "skipped",
      summary: auditDetail,
      duration_ms: Date.now() - startedAt,
      role: plan.role,
      agent_id: result.agent_id ?? plan.agent_id,
      session_id: result.session_id,
      reason: result.reason ?? result.error ?? plan.reason,
      source,
      cooldown_ms: result.remainingMs,
      next_retry_at: nextRetryAt,
    }).catch(() => {});
    return {
      ...result,
      agent_id: result.agent_id ?? plan.agent_id,
      outcome: outcome === "failed" ? "error" : outcome,
    };
  };

  pmWakeExecutorRef = executePmWakeDownstream;

  initAutoRecoveryBridge({
    resolveProjectRoot: () => projectRoot(),
    runtime,
    wakeExecutor: () => pmWakeExecutorRef,
    performAgentRecycle: (agentId, params) =>
      performAgentRecycle(agentId, params).then((o) => ({
        new_sdk_agent_id: o.new_sdk_agent_id,
      })),
    scheduleDelayedWake: schedulePanelDelayedWakeRetry,
    dispatcher: runtime.dispatcher,
  });

  function currentPmHeartbeatConfig(): PmHeartbeatConfig {
    return readPmHeartbeatConfig(getProjectRoot());
  }

  function restartDownstreamAutoNudge(): void {
    downstreamAutoNudgeRef?.stop();
    downstreamAutoNudgeRef = null;
    const cfg = currentPmHeartbeatConfig();
    if (!cfg.enabled) return;
    downstreamAutoNudgeRef = new DownstreamAutoNudge({
      projectRoot: () => getProjectRoot(),
      wakeExecutor: () => pmWakeExecutorRef,
      pmQueueGuard: runtime.pmQueueGuard,
      panelEventBridge: runtime.panelEventBridge,
      idleMs: cfg.downstreamNoReceiptNudgeMin * 60_000,
      debounceMs: Math.max(3, cfg.downstreamNoReceiptNudgeMin) * 60_000,
      logger: console,
    });
    downstreamAutoNudgeRef.start();
  }

  function taskRowTime(row: Record<string, unknown>): number {
    const raw =
      row["updated_at"] ??
      row["created_at"] ??
      row["ts"] ??
      row["mtime"] ??
      row["at"];
    if (typeof raw === "number") return raw;
    const parsed = Date.parse(String(raw ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function rowText(row: Record<string, unknown>, key: string): string {
    return String(row[key] ?? "").trim();
  }

  /**
   * PM 自动恢复必须优先处理仍未收口的最新叶子任务。
   *
   * 同一条 ADMIN→PM 链可能同时保留根任务和追加子任务；若只发起泛化
   * patrol，模型容易回到根任务反复汇报，而真正需要执行的子任务一直
   * active。这里仅选择会话焦点，不代替 PM 作业务决策。
   */
  function selectPmHeartbeatFocus(
    rows: Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    if (rows.length === 0) return undefined;
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = rowText(row, "task_id").toUpperCase();
      if (id) byId.set(id, row);
    }
    const depthOf = (row: Record<string, unknown>): number => {
      let depth = 0;
      let parent = (
        rowText(row, "parent") || rowText(row, "parent_task_id")
      ).toUpperCase();
      const seen = new Set<string>();
      while (parent && byId.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        depth += 1;
        const parentRow = byId.get(parent)!;
        parent = (
          rowText(parentRow, "parent") || rowText(parentRow, "parent_task_id")
        ).toUpperCase();
      }
      return depth;
    };
    return [...rows].sort((a, b) => {
      const depthDiff = depthOf(b) - depthOf(a);
      if (depthDiff !== 0) return depthDiff;
      const timeDiff = taskRowTime(b) - taskRowTime(a);
      if (timeDiff !== 0) return timeDiff;
      return rowText(b, "task_id").localeCompare(rowText(a, "task_id"));
    })[0];
  }

  async function buildPmHeartbeatSnapshot(): Promise<{
    activeRoots: Record<string, unknown>[];
    focusTask?: Record<string, unknown>;
    downstream: Record<string, unknown>[];
    reportCount: number;
    lastDispatchAt: number;
    oldestRootAt: number;
    digest: string;
  }> {
    const root = getProjectRoot();
    const { tasks } = await listTasksFromLedgerAuto(root);
    const { reports } = await listReportsFromLedgerAuto(root);
    const rows = tasks as unknown as Record<string, unknown>[];
    // A root in review is waiting for ADMIN, not PM work. Excluding review
    // prevents no-change patrol sessions and duplicate in_progress reports
    // after PM has already submitted the final delivery.
    const pmActionableRootBuckets = new Set(["inbox", "active", "tasks"]);
    const openDownstreamBuckets = new Set(["inbox", "active", "review", "tasks"]);
    const activeRoots = rows.filter((row) => {
      const sender = rowText(row, "sender").toUpperCase();
      const recipient = rowText(row, "recipient").toUpperCase();
      const bucket = rowText(row, "bucket").toLowerCase();
      return (
        sender === "ADMIN" &&
        recipient.startsWith("PM") &&
        pmActionableRootBuckets.has(bucket)
      );
    });
    const downstream = rows.filter((row) => {
      const sender = rowText(row, "sender").toUpperCase();
      const recipient = rowText(row, "recipient").toUpperCase();
      const bucket = rowText(row, "bucket").toLowerCase();
      return (
        sender.startsWith("PM") &&
        !recipient.startsWith("PM") &&
        openDownstreamBuckets.has(bucket)
      );
    });
    const lastDispatchAt = downstream.reduce(
      (max, row) => Math.max(max, taskRowTime(row)),
      0,
    );
    const oldestRootAt = activeRoots.reduce((min, row) => {
      const t = taskRowTime(row);
      return t > 0 ? Math.min(min, t) : min;
    }, Number.POSITIVE_INFINITY);
    const digest = wpBuildPmHeartbeatDigestForTests({
      activeRoots,
      downstream,
      reports: reports as unknown as Record<string, unknown>[],
    });
    return {
      activeRoots,
      focusTask: selectPmHeartbeatFocus(activeRoots),
      downstream,
      reportCount: reports.length,
      lastDispatchAt,
      oldestRootAt: Number.isFinite(oldestRootAt) ? oldestRootAt : 0,
      digest,
    };
  }

  async function maybeRunPmHeartbeat(): Promise<void> {
    const cfg = currentPmHeartbeatConfig();
    if (!cfg.enabled) return;
    const activeSessions = await runtime.sessionManager.listActive();
    if (
      activeSessions.some(
        (session) =>
          String(session.protocol.agent_id ?? "").toUpperCase() === "PM-01",
      )
    ) {
      return;
    }
    const pmQueue = runtime.pmQueueGuard.snapshot();
    if (pmQueue.pm_busy || pmQueue.in_flight || pmQueue.phase === "executing") {
      return;
    }
    const snap = await buildPmHeartbeatSnapshot().catch(() => null);
    if (!snap || snap.activeRoots.length === 0) {
      pmHeartbeatLastDigest = "";
      return;
    }
    const now = Date.now();
    const decision = decidePmHeartbeatPolicy({
      config: cfg,
      nowMs: now,
      lastRunAtMs: pmHeartbeatLastRunAt,
      lastDigest: pmHeartbeatLastDigest,
      pmBusy: pmQueue.pm_busy || pmQueue.in_flight,
      activeRootCount: snap.activeRoots.length,
      lastDispatchAtMs: snap.lastDispatchAt,
      oldestRootAtMs: snap.oldestRootAt,
      digest: snap.digest,
    });
    if (!decision.shouldRun) return;
    pmHeartbeatLastRunAt = now;
    pmHeartbeatLastDigest = snap.digest;
    const focusTaskId = rowText(snap.focusTask ?? {}, "task_id");
    const focusThreadKey = rowText(snap.focusTask ?? {}, "thread_key");
    const focusTitle =
      rowText(snap.focusTask ?? {}, "subject") ||
      rowText(snap.focusTask ?? {}, "title");
    const message = [
      focusTaskId
        ? `PM 自动恢复：优先处理当前最新未收口叶子任务 ${focusTaskId}${focusTitle ? `（${focusTitle}）` : ""}。这是正式待执行任务，不是泛化巡检；请先读取该 TASK 正文并完成其要求。`
        : "PM 自动巡检：请检查当前进行中的主任务、下游回执、待汇总报告和需要催办项。",
      "如果下游已回执，请完成 review_check / 汇总报告 / 提交 ADMIN 验收；如果超过阈值无回执，请自动催办下游。",
      "请用中文简短汇报变化；没有变化时只说明当前等待点。自动巡检结论由 Runtime 写入治理日志，禁止为巡检、等待或重复催办调用 write_report。只有正式下游回执、明确终态阻塞升级或 PM 最终汇总才生成 REPORT。",
    ].join("\n");
    await fetch(`${panelUrl}/api/v2/agents/PM-01/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        intent: "patrol",
        operator_role: "ADMIN",
        client: "pm-heartbeat",
        source: "system",
        ...(focusTaskId ? { task_id: focusTaskId } : {}),
        ...(focusThreadKey ? { thread_key: focusThreadKey } : {}),
      }),
    }).catch((err: unknown) => {
      console.warn(
        "[pm-heartbeat] wake failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  function restartPmHeartbeatScheduler(): void {
    if (pmHeartbeatIntervalRef) {
      clearInterval(pmHeartbeatIntervalRef);
      pmHeartbeatIntervalRef = null;
    }
    const cfg = currentPmHeartbeatConfig();
    if (!cfg.enabled) return;
    pmHeartbeatIntervalRef = setInterval(() => {
      void maybeRunPmHeartbeat();
    }, 30_000);
    pmHeartbeatIntervalRef.unref();
  }

  restartDownstreamAutoNudge();
  restartPmHeartbeatScheduler();

  runtime.panelEventBridge.setSink((type, payload) => {
    sseEmit(type, payload);
    if (type === "codeflowmu.report_detected") {
      void handleReportArrivalGovernance(
        (payload ?? {}) as Record<string, unknown>,
      );
    }
  });
  setLifecyclePanelSink((type, payload) => {
    sseEmit(type, payload);
    if (
      type === "codeflowmu.lifecycle.review_to_active" &&
      pmWakeExecutorRef &&
      String(payload.actor ?? "").toUpperCase() === "ADMIN"
    ) {
      const taskId = String(payload.task_id ?? "").trim();
      if (!taskId) return;
      const reason = String(
        payload.reopen_reason ?? payload.reason ?? "ADMIN 打回",
      ).trim();
      void (async () => {
        const root = resolveProjectRoot();
        let threadKey: string | undefined;
        let taskPath: string | undefined;
        try {
          const hit = findTaskFileByIdPrefix(root, taskId);
          if (hit?.path) {
            const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
            const absNorm = hit.path.replace(/\\/g, "/");
            taskPath = absNorm.startsWith(`${rootNorm}/`)
              ? absNorm.slice(rootNorm.length + 1)
              : absNorm;
            const raw = readFileSync(hit.path, "utf-8");
            const fm = parseMarkdownFrontmatter(raw);
            threadKey = strField(fm, "thread_key") || undefined;
          }
        } catch {
          /* best-effort — wake message still usable without task_path */
        }
        runtime.pmQueueGuard.clearAutoNudge();
        runtime.pmQueueGuard.clearWaitingDownstream();
        runtime.reportGate?.clearWaitingForTask(taskId, "PM");
        const plan = buildAdminRejectPmWakeRequest({
          task_id: taskId,
          reason,
          actor: String(payload.actor ?? "ADMIN"),
          task_path: taskPath ?? null,
          thread_key:
            (payload.thread_key as string | undefined) ?? threadKey ?? null,
          projectRoot: root,
        });
        await pmWakeExecutorRef!(plan);
      })();
    }
  });

  /**
   * emitFailure — called by watchdog / runtime crash handlers to record a
   * system-level failure, write it to disk, and push an SSE event.
   */
  function emitFailure(opts2: {
    failure_type: FailureType;
    agent_id?: string;
    description: string;
    duration_before_detect_s?: number;
    recovered: boolean;
    recovery_action?: string;
    related_task?: string;
  }) {
    const filename = failureLogger?.write(opts2) ?? null;
    sseEmit("codeflowmu.failure", {
      ...opts2,
      filename,
      ts: Date.now(),
    });
  }
  (app as unknown as { emitFailure: typeof emitFailure }).emitFailure = emitFailure;

  // Heartbeat — keeps connection alive through idle minutes.
  const heartbeatInterval = setInterval(() => {
    sseEmit("codeflowmu.heartbeat", { uptime_s: Math.floor(process.uptime()) });
  }, 15_000).unref();

  app.get("/api/v2/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    applyPanelCorsHeaders(res, req.headers.origin);
    res.flushHeaders();

    // Send the current agent roster as the first event so the UI can bootstrap
    // without a separate fetch.
    void runtime.registry.list().then((agents) => {
      res.write(
        `data: ${JSON.stringify({ type: "codeflowmu.agents_snapshot", payload: { agents } })}\n\n`,
      );
    });

    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // Cleanup SSE subscription when server shuts down (exposed on app for
  // startWebPanel to call on close).
  const evalScheduleInterval = setInterval(
    createEvalScheduleChecker(() => getProjectRoot(), console),
    60_000,
  );
  evalScheduleInterval.unref();

  (app as unknown as { _sseCleanup: () => void })._sseCleanup = () => {
    downstreamAutoNudgeRef?.stop();
    downstreamAutoNudgeRef = null;
    if (pmHeartbeatIntervalRef) {
      clearInterval(pmHeartbeatIntervalRef);
      pmHeartbeatIntervalRef = null;
    }
    clearInterval(heartbeatInterval);
    clearInterval(evalScheduleInterval);
    if (autoArchiveStartupTimer) {
      clearTimeout(autoArchiveStartupTimer);
      autoArchiveStartupTimer = null;
    }
    if (autoArchiveDailyTimer) {
      clearInterval(autoArchiveDailyTimer);
      autoArchiveDailyTimer = null;
    }
    if (zombieStartupTimer) {
      clearTimeout(zombieStartupTimer);
      zombieStartupTimer = null;
    }
    if (zombieIntervalTimer) {
      clearInterval(zombieIntervalTimer);
      zombieIntervalTimer = null;
    }
    if (agentRecycleInterval) {
      clearInterval(agentRecycleInterval);
      agentRecycleInterval = null;
    }
    stopAutoRecoveryBridge();
    unsubscribeSse();
    cursorSyncer?.stopAutoSync();
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
    for (const client of mobileSseClients) {
      client.end();
    }
    mobileSseClients.clear();
  };

  // ── Agent Rotation Mechanism ──────────────────────────────────────────
  //
  // Problem: Cursor SDK agents carry full conversation history as context.
  // Every Agent.resume() → send() call includes ALL previous turns.
  // After N tasks, input_tokens ≈ N × average_output_tokens (linear growth).
  // Analysis of thinking log shows DEV-01 reaching 4M tokens after 27 sessions.
  //
  // Solution: "recycle" = create a fresh SDK agent (Agent.create), update
  // agents.json sdk_agent_id, inject a primer from recent reports so the
  // new instance re-establishes role context without heavy history.
  //
  // Threshold: N sessions (configurable); auto only when agent is idle.

  const recycleCfg: AgentRecycleConfig = {
    ...DEFAULT_AGENT_RECYCLE_CONFIG,
    ...opts.agentRecycle,
  };
  const recycleDataDir = opts.dataDir ?? join(os.homedir(), ".codeflowmu", "v2");

  function getAgentSessionStats(): Record<string, number> {
    return countSessionsFromThinkingLog(projectRoot());
  }

  /**
   * Build a primer message for a recycled agent. Reads the 3 most recent
   * reports for the given role, summarises them into a context-setting prompt.
   */
  function readTextSlice(filePath: string, maxLen: number): string {
    if (!existsSync(filePath)) return "";
    try {
      return readFileSync(filePath, "utf-8").slice(0, maxLen);
    } catch {
      return "";
    }
  }

  function roleCodeFromAgentId(agentId: string): string {
    const m = agentId.match(/^([A-Z]+)/);
    return m?.[1] ?? agentId;
  }

  function buildProjectStatusSummary(): string {
    const root = projectRoot();
    const v3 = fcopV3Paths(root);
    const lines: string[] = [`项目根: ${root}`];
    try {
      const n = countInboxTasks(v3.inbox);
      if (n > 0) {
        lines.push(`fcop/_lifecycle/inbox 中 TASK 文件约 ${n} 个`);
      }
    } catch { /* skip */ }
    return lines.join("\n");
  }

  function buildRecyclePrimer(agentId: string): string {
    const root = projectRoot();
    const roleCode = roleCodeFromAgentId(agentId);
    const teamRules = readTextSlice(
      join(root, "fcop", "shared", "TEAM-OPERATING-RULES.md"),
      2200,
    );
    const roleDoc = readTextSlice(
      join(root, "fcop", "shared", "roles", `${roleCode}.md`),
      2200,
    );
    const reportsDir = opts.fcopReportsDir;
    let recentReports = "";
    if (reportsDir && existsSync(reportsDir)) {
      try {
        const files = readdirSync(reportsDir)
          .filter((f) => isCanonicalReportMarkdownFilename(f))
          .sort()
          .reverse()
          .filter((f) => {
            const m = f.match(/-to-([A-Z]+-\d+)\.md$/i);
            return !m || (m[1] ?? "").toUpperCase() === agentId.toUpperCase();
          })
          .slice(0, 3);
        for (const f of files) {
          try {
            const body = readFileSync(join(reportsDir, f), "utf-8").slice(0, 800);
            recentReports += `\n\n--- ${f} ---\n${body}`;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    const adoptedBlock = formatAdoptedRuntimeEffectiveWakeSection(root);
    const ts = new Date().toISOString().slice(0, 16);
    return (
      `[换 AI — 新会话启动 ${ts}]\n` +
      `你是 **${agentId}**（角色 ${roleCode}）。此前实例已结束；本消息为无历史上下文的新会话 Primer。\n\n` +
      `## 团队运行规矩（摘要）\n${teamRules || "（未找到 TEAM-OPERATING-RULES.md）"}\n\n` +
      `## 角色要点（${roleCode}.md）\n${roleDoc || "（未找到角色文档）"}\n\n` +
      adoptedBlock +
      `## 当前项目状态\n${buildProjectStatusSummary()}\n\n` +
      `## 近期报告摘要\n${recentReports || "（暂无近期报告）"}\n\n` +
      `请读取 \`fcop/_lifecycle/inbox/\` 中发给你的最新 TASK 并执行；完成后 write_report 并 submit_review（勿直接 finish_task / archive）。`
    );
  }

  async function agentHasRunningSession(agentId: string): Promise<boolean> {
    try {
      const all = await runtime.sessionStore.listAll();
      return all.some(
        (rec) =>
          rec.protocol.agent_id === agentId &&
          rec.protocol.status === "running",
      );
    } catch {
      return false;
    }
  }

  type AgentRecycleOutcome = {
    agent_id: string;
    old_sdk_agent_id: string;
    new_sdk_agent_id: string;
    operator_role: string;
    reason: string;
    primer_preview: string;
  };

  /**
   * Shared recycle implementation (manual POST + auto idle timer).
   * @throws Error with `.code` AGENT_NOT_FOUND | AGENT_BUSY | SDK_UNAVAILABLE
   */
  async function performAgentRecycle(
    agentId: string,
    params: { reason: string; operator_role?: string },
  ): Promise<AgentRecycleOutcome> {
    if (!opts.sdkAdapter) {
      const e = new Error("sdkAdapter not available");
      (e as Error & { code: string }).code = "SDK_UNAVAILABLE";
      throw e;
    }
    const record = await runtime.registry.get(agentId);
    if (!record) {
      const e = new Error(`Agent ${agentId} not found`);
      (e as Error & { code: string }).code = "AGENT_NOT_FOUND";
      throw e;
    }
    const autoRecycleReasons = new Set(["pending_panel", "auto_idle_threshold"]);
    if (
      autoRecycleReasons.has(params.reason) &&
      (await agentHasRunningSession(agentId))
    ) {
      const e = new Error(
        `Agent ${agentId} has a running session; swap after it ends`,
      );
      (e as Error & { code: string }).code = "AGENT_BUSY";
      throw e;
    }
    const farewell =
      `[换 AI] ${agentId}：本轮协作结束，感谢付出。新 SDK 实例将接续任务，上下文已重置。`;
    console.info(`[AgentRecycler] farewell ${agentId}: ${farewell}`);
    if (thinkingLogger) {
      thinkingLogger.append("task", {
        event_type: "codeflowmu.agent_farewell",
        agent_id: agentId,
        session_id: "",
        payload: { text: farewell },
      });
    }
    const oldSdkId = record.protocol.sdk_agent_id ?? "(none)";
    const { sdk_agent_id: newSdkId } = await opts.sdkAdapter.create({
      agentId,
      role: record.protocol.role,
      layer: record.protocol.layer as "worker" | "leader" | "governance",
      runtime:
        ((record.protocol as { runtime?: string }).runtime as "local" | "cloud") ??
        "local",
    });
    await runtime.registry.updateSdkAgentId(agentId, newSdkId);
    const primer = buildRecyclePrimer(agentId);
    const allowedOperators = new Set(["ADMIN", "PM"]);
    const rawOp = String(params.operator_role ?? "ADMIN").toUpperCase();
    const op = allowedOperators.has(rawOp) ? rawOp : "ADMIN";
    const reason = params.reason;
    console.info(
      `[AgentRecycler] ${agentId} recycled: ${oldSdkId} -> ${newSdkId} (reason=${reason}, operator=${op})`,
    );
    sseEmit("codeflowmu.agent_recycled", {
      agent_id: agentId,
      old_sdk_agent_id: oldSdkId,
      new_sdk_agent_id: newSdkId,
      reason,
      operator_role: op,
      ts: Date.now(),
    });
    const stats = getAgentSessionStats();
    const state = loadRecycleState(recycleDataDir);
    state[agentId] = {
      recycled_at: new Date().toISOString(),
      sessions_at_recycle: stats[agentId] ?? 0,
      reason,
    };
    saveRecycleState(recycleDataDir, state);
    return {
      agent_id: agentId,
      old_sdk_agent_id: oldSdkId,
      new_sdk_agent_id: newSdkId,
      operator_role: op,
      reason,
      primer_preview:
        primer.slice(0, 300) + (primer.length > 300 ? "…" : ""),
    };
  }

  /**
   * GET /api/v2/agents/lifecycle-stats
   * Returns per-agent session counts and recycle recommendations.
   */
  app.get("/api/v2/agents/lifecycle-stats", async (_req: Request, res: Response) => {
    try {
      const sessionStats = getAgentSessionStats();
      const recycleState = loadRecycleState(recycleDataDir);
      const agents = await runtime.registry.list();
      const result = agents
        .filter((a) => a.protocol.layer !== "admin")
        .map((a) => {
          const aid = a.protocol.agent_id;
          const sessions_total_today = sessionStats[aid] ?? 0;
          const sessions_today = sessionsSinceLastRecycle(
            sessions_total_today,
            recycleState[aid],
          );
          const needs_recycle = sessions_today >= recycleCfg.sessionThreshold;
          const urgency =
            sessions_today >= recycleCfg.sessionThreshold * 2 ? "critical" :
            sessions_today >= recycleCfg.sessionThreshold ? "warning" : "ok";
          return {
            agent_id: aid,
            role: a.protocol.role,
            status: a.protocol.status,
            sessions_today,
            sessions_total_today,
            sessions_at_recycle: recycleState[aid]?.sessions_at_recycle ?? 0,
            recycled_at: recycleState[aid]?.recycled_at ?? null,
            recycle_threshold: recycleCfg.sessionThreshold,
            needs_recycle,
            urgency,
            auto_recycle_enabled: recycleCfg.enabled,
            // Rough token estimate: each session avg 500 output tokens
            estimated_context_k: Math.round(sessions_today * 500 * sessions_today / 2 / 1000),
          };
        });
      res.json({
        agents: result,
        threshold: recycleCfg.sessionThreshold,
        auto_recycle_enabled: recycleCfg.enabled,
      });
    } catch (err) {
      sendError(res, 500, "LIFECYCLE_STATS_FAILED", String(err));
    }
  });

  /**
   * GET /api/v2/agents/:agentId/reconcile
   * Unified agent/task reconcile (7 states + admin_hint).
   */
  app.get("/api/v2/agents/:agentId/reconcile", async (req: Request, res: Response) => {
    const agentId = String(req.params["agentId"] ?? "").trim();
    if (!agentId) {
      sendError(res, 400, "AGENT_ID_REQUIRED", "agentId required");
      return;
    }
    try {
      const root = projectRoot();
      const taskId = String(req.query["task_id"] ?? "").trim() || undefined;
      const trigger = String(req.query["trigger"] ?? "task_detail").trim() as
        | "swap_ai"
        | "wake"
        | "dispatch"
        | "recover"
        | "runtime_startup"
        | "task_detail"
        | "queue_refresh"
        | "session_ended"
        | "pm_summary";
      const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
      const { reports: reportRows } = await listReportsFromLedgerAuto(root);
      const result = await runAgentReconcile({
        projectRoot: root,
        runtime,
        agentId,
        taskId,
        trigger,
        tasks: taskRows as unknown as LedgerTaskRecord[],
        reports: reportRows as unknown as LedgerReportRecord[],
        operator: String(req.query["operator"] ?? "ADMIN"),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, 500, "AGENT_RECONCILE_FAILED", String(err));
    }
  });

  /**
   * POST /api/v2/agents/:agentId/recycle
   * Creates a fresh SDK agent for the given agentId, updates agents.json,
   * and returns the primer text for optional display.
   *
   * Body (optional): { reason?: string, task_id?: string }
   */
  app.post("/api/v2/agents/:agentId/recycle", async (req: Request, res: Response) => {
    const agentId = String(req.params["agentId"] ?? "");
    if (!agentId) {
      sendError(res, 400, "AGENT_ID_REQUIRED", "agentId path param required");
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const operatorRole = String(body.operator_role ?? "ADMIN");
    try {
      const reason = String(body.reason ?? "manual");
      const taskId = String(body.task_id ?? "").trim() || undefined;
      const autoRecycleReasons = new Set(["pending_panel", "auto_idle_threshold"]);
      const isManualSwap = !autoRecycleReasons.has(reason);
      const root = projectRoot();
      const { tasks: taskRows } = await listTasksFromLedgerAuto(root);
      const { reports: reportRows } = await listReportsFromLedgerAuto(root);
      const tasks = taskRows as unknown as LedgerTaskRecord[];
      const reports = reportRows as unknown as LedgerReportRecord[];

      if (isManualSwap && (await agentHasRunningSession(agentId))) {
        const released = await runtime.forceReleaseAgent(agentId, "switch_ai");
        if (!released.ok) {
          appendPanelRuntimeAction(root, {
            operator: operatorRole,
            action: "swap_ai",
            target_agent: agentId,
            result: "failed",
            reason: released.error ?? "release_failed",
            detail: JSON.stringify(released).slice(0, 200),
          });
          res.status(409).json({
            ok: false,
            error: released.error,
            message: `${agentId} 运行中 session 停止失败，未切换 AI`,
            release: released,
          });
          return;
        }
      }

      const swap = await handleSwapAiWithReconcile({
        projectRoot: root,
        runtime,
        agentId,
        taskId,
        operator: operatorRole,
        manualForce: isManualSwap,
        wakeExecutor: pmWakeExecutorRef,
        tasks,
        reports,
        performRecycle: () =>
          performAgentRecycle(agentId, {
            reason,
            operator_role: operatorRole,
          }),
      });

      if (swap.deferred) {
        if (isManualSwap) {
          sendError(
            res,
            409,
            "SWAP_AI_STILL_BUSY",
            `${agentId} 仍在执行中，无法切换 AI`,
          );
          return;
        }
        res.json({
          ok: true,
          deferred: true,
          reconcile: swap.reconcile,
          message: "换 AI 已设置为下次生效；当前 Agent 仍在执行，不中断当前 session。",
        });
        return;
      }
      if (swap.blocked) {
        appendPanelRuntimeAction(root, {
          operator: operatorRole,
          action: "swap_ai",
          target_agent: agentId,
          result: "skipped",
          reason: swap.reconcile.state,
          detail: swap.reconcile.admin_hint.slice(0, 200),
        });
        sendError(
          res,
          409,
          "SWAP_AI_BLOCKED",
          swap.reconcile.admin_hint.split("\n")[0] ?? "blocked",
        );
        return;
      }

      const out = swap.recycle ?? {};
      res.json({ ok: true, reconcile: swap.reconcile, ...out });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === "SDK_UNAVAILABLE") {
        sendError(res, 503, "SDK_ADAPTER_NOT_AVAILABLE", String(err));
        return;
      }
      if (code === "AGENT_NOT_FOUND") {
        sendError(res, 404, "AGENT_NOT_FOUND", String(err));
        return;
      }
      if (code === "AGENT_BUSY") {
        appendPanelRuntimeAction(projectRoot(), {
          operator: operatorRole,
          action: "swap_ai",
          target_agent: agentId,
          result: "skipped",
          reason: "agent busy",
        });
        sendError(res, 409, "AGENT_BUSY", String(err));
        return;
      }
      sendError(res, 500, "RECYCLE_FAILED", String(err));
    }
  });

  // ── Zombie session cleanup — startup + periodic ───────────────────────
  // Sessions stuck in "running" too long are cancelled via SessionManager
  // so registry reconciler + SSE session_cancelled refresh the team UI.
  {
    const ZOMBIE_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes
    const runZombieSessionCleanup = async (): Promise<number> => {
      const all = await runtime.sessionStore?.listAll?.() ?? [];
      let cleaned = 0;
      const now = Date.now();
      for (const rec of all) {
        if (rec.protocol.status !== "running") continue;
        const startedAt = rec.protocol.started_at
          ? new Date(rec.protocol.started_at).getTime()
          : 0;
        if (!startedAt || now - startedAt < ZOMBIE_MAX_AGE_MS) continue;
        const sessionId = rec.protocol.session_id;
        try {
          await runtime.sessionManager.cancelSession(
            sessionId,
            "zombie_cleanup: stuck running >20m",
          );
          cleaned++;
        } catch (cancelErr) {
          console.warn(
            `[ZombieCleanup] cancelSession failed for ${sessionId}:`,
            cancelErr,
          );
        }
      }
      if (cleaned > 0) {
        console.info(
          `[ZombieCleanup] cancelled ${cleaned} stuck session(s) (>20m running)`,
        );
        sseEmit("codeflowmu.zombie_cleanup", { cleaned, ts: Date.now() });
      }
      return cleaned;
    };

    zombieStartupTimer = setTimeout(() => {
      runZombieSessionCleanup().catch((e) =>
        console.warn("[ZombieCleanup] error:", e),
      );
    }, 5_000);
    zombieStartupTimer.unref();

    zombieIntervalTimer = setInterval(() => {
      runZombieSessionCleanup().catch((e) =>
        console.warn("[ZombieCleanup] error:", e),
      );
    }, 5 * 60 * 1000);
    zombieIntervalTimer.unref();
  }

  /**
   * POST /api/v2/agents/:agentId/cancel-active-session
   * Cancels all running sessions for the agent (ADMIN force-stop).
   */
  app.post(
    "/api/v2/agents/:agentId/cancel-active-session",
    async (req: Request, res: Response) => {
      const agentId = String(req.params["agentId"] ?? "");
      if (!agentId) {
        sendError(res, 400, "AGENT_ID_REQUIRED", "agentId path param required");
        return;
      }
      try {
        const body = (req.body as Record<string, unknown>) ?? {};
        const reason = String(body.reason ?? "admin_cancel_active_session");
        const active = await runtime.sessionManager.listActive();
        const targets = active.filter((r) => r.protocol.agent_id === agentId);
        let cancelled = 0;
        for (const rec of targets) {
          await runtime.sessionManager.cancelSession(
            rec.protocol.session_id,
            reason,
          );
          cancelled++;
        }
        const remainingActive = await runtime.sessionManager.listActive();
        const stillRunning = remainingActive.some((r) => r.protocol.agent_id === agentId);
        const currentProjectRoot = resolveProjectRoot();
        const queueAdvanced =
          !stillRunning && currentProjectRoot
            ? await advanceAgentQueue({
                projectRoot: currentProjectRoot,
                agentId,
                clearStaleRunning: true,
                dispatcher: runtime.dispatcher,
              }).catch(() => false)
            : false;
        res.json({ ok: true, agent_id: agentId, cancelled, queue_advanced: queueAdvanced });
      } catch (err) {
        sendError(res, 500, "CANCEL_SESSION_FAILED", String(err));
      }
    },
  );

  // ── Auto-recycle — periodic scan (configurable; default off) ─────────
  // When enabled: recycle only if agent is idle (no running session, no
  // current_task, status idle) and enough sessions since last recycle.
  const runAutoRecycleScan = async () => {
    if (!recycleCfg.enabled || !opts.sdkAdapter) return;
    const stats = getAgentSessionStats();
    const state = loadRecycleState(recycleDataDir);
    let agents;
    try {
      agents = await runtime.registry.list();
    } catch (e) {
      console.warn("[AgentRecycler] auto scan: list agents failed:", e);
      return;
    }
    for (const a of agents) {
      if (a.protocol.layer === "admin") continue;
      const agentId = a.protocol.agent_id;
      const sessionsToday = stats[agentId] ?? 0;
      const hasRunning = await agentHasRunningSession(agentId);
      const gate = shouldAutoRecycleAgent({
        enabled: true,
        sessionsToday,
        threshold: recycleCfg.sessionThreshold,
        agentStatus: a.protocol.status,
        hasRunningSession: hasRunning,
        currentTask: a.protocol.current_task,
        lastRecycle: state[agentId],
      });
      if (!gate.should) {
        if (
          sessionsToday >= recycleCfg.sessionThreshold &&
          gate.reason !== "below_session_threshold" &&
          gate.reason !== "auto_recycle_disabled"
        ) {
          console.info(
            `[AgentRecycler] ${agentId}: ${sessionsToday} sessions today, ` +
              `auto-recycle deferred (${gate.reason})`,
          );
        }
        continue;
      }
      try {
        await performAgentRecycle(agentId, {
          reason: "auto_idle_threshold",
          operator_role: "ADMIN",
        });
        console.info(
          `[AgentRecycler] auto-recycled ${agentId} after ${sessionsToday} sessions (idle)`,
        );
      } catch (e) {
        const code = (e as Error & { code?: string }).code;
        if (code === "AGENT_BUSY") {
          console.info(
            `[AgentRecycler] ${agentId}: threshold met but busy — will retry next scan`,
          );
        } else {
          console.warn(`[AgentRecycler] auto-recycle ${agentId} failed:`, e);
        }
      }
    }
  };

  // Only arm the 30-min timer when auto-recycle is ON — avoids confusion with
  // Cursor billing spikes (disabled scan does not call any LLM).
  if (recycleCfg.enabled) {
    agentRecycleInterval = setInterval(() => {
      void runAutoRecycleScan();
    }, recycleCfg.checkIntervalMs);
    agentRecycleInterval.unref();
    console.info(
      `[AgentRecycler] auto-recycle ON: threshold=${recycleCfg.sessionThreshold} ` +
        `sessions, interval=${Math.round(recycleCfg.checkIntervalMs / 60_000)}min, idle-only`,
    );
  } else {
    console.info(
      "[AgentRecycler] auto-recycle OFF (set agentRecycle.enabled or CODEFLOW_AGENT_AUTO_RECYCLE=1 to enable)",
    );
  }

  // ── Mobile API (TASK-002) — mount only; logic lives in src/mobile/ ───

  const mobileDataDir = recycleDataDir;
  const mobileCtx: MobilePanelContext = {
    getProjectRoot: () => resolveProjectRoot(),
    getDataDir: () => mobileDataDir,
    panelPort,
    getAdminTasksDir: () => resolveAdminTaskWriteScope().adminDir,
    getReviewsDir: () => opts.fcopReviewsDir,
    getIssuesDir: () => join(resolveProjectRoot(), "fcop", "issues"),
    getFcopReportsDir: () => opts.fcopReportsDir,
    allocateTaskSeq: (date) => _wpNextTaskSeq(resolveProjectRoot(), date),
    getUiLang: () => readPanelUiLang(resolveProjectRoot()),
    gatewayOnline: () => isMobileGatewayOnline(),
    listChatMessages: ({ agentId, limit }) => {
      const msgs = agentId
        ? directChat.filter((m) => m.agentId === agentId)
        : directChat;
      return msgs.slice(-Number(limit ?? 80));
    },
    sendChat: async (body) => {
      const collector = {
        statusCode: 200,
        body: {} as Record<string, unknown>,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: Record<string, unknown>) {
          this.body = payload;
          return this;
        },
      };
      await handleDirectSession(collector as unknown as Response, {
        agentId: String(body.agentId ?? ADMIN_CHAT_AGENT_ID),
        message: String(body.message ?? ""),
        intent: "chat",
        operatorRole: "ADMIN",
        taskId: body.taskId,
        threadKey: body.threadKey,
        attachments: Array.isArray(body.attachments) ? (body.attachments as ChatImageAttachment[]) : undefined,
        uiLang: readPanelUiLang(resolveProjectRoot()),
        source: body.source ? String(body.source) : "mobile",
        client: body.client ? String(body.client) : "pwa",
      });
      if (collector.statusCode >= 400) {
        return {
          ok: false,
          status: collector.statusCode,
          error: String(collector.body.error ?? collector.body.code ?? "CHAT_FAILED"),
        };
      }
      return { ok: true, ...collector.body };
    },
    listAlerts: (opts) => doorbellBuffer.query({ limit: opts?.limit ?? 50 }),
    subscribeMobileEvents: (res, onClose) => {
      mobileSseClients.add(res);
      res.on("close", () => {
        mobileSseClients.delete(res);
        onClose();
      });
    },
  };
  const mobileDir = pathResolve(__dirname, "../../codeflowmu-desktop/mobile");
  const mobileBundle = createMobileRoutes(mobileCtx);
  app.use("/api/v2/mobile", mobileBundle.router);
  if (existsSync(mobileDir)) {
    app.use(
      "/mobile",
      express.static(mobileDir, {
        setHeaders: (res, filePath) => {
          const name = pathBasename(filePath).toLowerCase();
          if (
            name === "index.html" ||
            name === "mobile.js" ||
            name === "mobile.css" ||
            name === "i18n.js" ||
            name === "sw.js" ||
            name === "version.json"
          ) {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
          }
        },
      }),
    );
  }

  const flowdayDir = pathResolve(__dirname, "../../flowday");
  if (existsSync(flowdayDir)) {
    app.use(
      "/flowday",
      express.static(flowdayDir, {
        setHeaders: (res, filePath) => {
          const name = pathBasename(filePath).toLowerCase();
          if (name === "index.html" || name === "sw.js" || name === "manifest.json") {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
          }
        },
      }),
    );
  }
  (app as unknown as { registerMobilePendingBind: typeof mobileBundle.registerPendingBind }).registerMobilePendingBind =
    mobileBundle.registerPendingBind;

  // ── Static assets (panel UI) — must come AFTER /api/v2/ routes ──────

  const panelDir =
    opts.panelDir ??
    pathResolve(__dirname, "../../codeflowmu-desktop/panel");

  if (existsSync(panelDir)) {
    app.use(express.static(panelDir));
    // SPA fallback: serve index.html for any non-asset route (Express 5: use /*splat)
    app.get("/*splat", (_req: Request, res: Response) => {
      const idx = join(panelDir, "index.html");
      if (existsSync(idx)) {
        res.sendFile(idx);
      } else {
        sendError(res, 404, "PANEL_NOT_FOUND", "panel/index.html not found");
      }
    });
  } else {
    app.get("/", (_req: Request, res: Response) => {
      sendError(res, 503, "PANEL_DIR_MISSING", `Panel dir not found: ${panelDir}`);
    });
  }

  return app;
}

export interface WebPanelHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the web panel server.
 *
 * Returns a handle with `.close()` for graceful shutdown.
 * If the port is already in use, logs a warning and returns null
 * (does not crash the process).
 */
export async function startWebPanel(
  runtime: Runtime,
  opts: {
    port?: number;
    panelDir?: string;
    projectRoot?: string;
    adminTasksDir?: string;
    fcopReportsDir?: string;
    fcopReviewsDir?: string;
    failuresDir?: string;
    sdkAdapter?: AgentSdkAdapter;
    fcopRuntime?: FcopRuntimeSeed;
    dataDir?: string;
    agentRecycle?: AgentRecycleConfig;
    reloadOnProjectSwitch?: boolean;
    projectRuntimeReloadScheduler?: () => void;
    logger?: { info: (m: string) => void; warn: (m: string) => void };
  } = {},
): Promise<WebPanelHandle | null> {
  const port = opts.port ?? WEB_PANEL_PORT;
  const log = opts.logger ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };

  const app = buildWebPanelApp(runtime, {
    panelDir: opts.panelDir,
    projectRoot: opts.projectRoot,
    adminTasksDir: opts.adminTasksDir,
    fcopReportsDir: opts.fcopReportsDir,
    fcopReviewsDir: opts.fcopReviewsDir,
    failuresDir: opts.failuresDir,
    sdkAdapter: opts.sdkAdapter,
    fcopRuntime: opts.fcopRuntime,
    dataDir: opts.dataDir,
    agentRecycle: opts.agentRecycle,
    reloadOnProjectSwitch: opts.reloadOnProjectSwitch,
    projectRuntimeReloadScheduler: opts.projectRuntimeReloadScheduler,
    panelPort: port,
  });
  const server = createServer(app);

  return new Promise((resolve) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.warn(
          `[web-panel] port ${port} already in use — skipping panel start ` +
            `(another instance running? use --no-panel to suppress this warning)`,
        );
        resolve(null);
      } else {
        log.warn(`[web-panel] failed to start: ${err.message}`);
        resolve(null);
      }
    });

    const bindHost = resolveWebPanelHost();
    server.listen(port, bindHost, () => {
      const url = `http://127.0.0.1:${port}`;
      log.info(
        `[web-panel] listening on ${bindHost}:${port} — local ${url} ; LAN mobile: same port on your Wi‑Fi IP`,
      );
      
      const openEditionWithoutProject =
        process.env["CODEFLOW_OPEN_EDITION"] === "1" && !opts.projectRoot;
      const pRoot = opts.projectRoot || (openEditionWithoutProject && opts.dataDir ? opts.dataDir : process.cwd());
      const stopResult = stopEvalWatcher(pRoot);
      if (stopResult.pid) {
        log.info(`[web-panel] ${stopResult.message}（默认关闭常驻监听）`);
      }
      startEvalWatcherIfConfigured(pRoot, log);

      void ensureLedgerFresh(pRoot, { rebuild: true, force: true }).catch((err) => {
        log.warn(
          `[web-panel] ledger rebuild on startup: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      if (!openEditionWithoutProject) {
        startMobileGatewayClient({
          projectRoot: pRoot,
          panelPort: port,
          log: (msg) => log.info(msg),
          writeGatewayLog: (input) => appendGatewayLog(pRoot, input),
        });
      }

      resolve({
        port,
        url,
        close: () => {
          stopMobileGatewayClient();
          // Cleanup SSE subscriptions + heartbeat timer before closing HTTP server.
          const cleanup = (app as unknown as { _sseCleanup?: () => void })._sseCleanup;
          cleanup?.();
          return new Promise<void>((res, rej) =>
            server.close((e) => (e ? rej(e) : res())),
          );
        },
      });
    });
  });
}
