import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve as pathResolve, sep } from "node:path";

import { Router, type Request, type Response } from "express";
import {
  getAdminTaskCloseout,
  GovernanceApprovalError,
  GovernanceApprovalService,
  OperationApprovalError,
  OperationApprovalService,
  parseMarkdownFrontmatter,
  type OperationApprovalRecord,
} from "@codeflowmu/runtime";

import { fcopV3Paths } from "../fcop-v3-paths.ts";
import {
  IssueClosureService,
  issueClosureErrorResponse,
} from "../issue-closure.ts";
import {
  buildIssueGithubApprovalInput,
  generateIssuePromotionBundle,
  listIssuePromotions,
  readIssuePromotion,
} from "../issue-promotion.ts";
import { executeLifecycleRuntimeAction } from "../lifecycle-runtime-bridge.ts";
import {
  ensureLedgerFresh,
  listReportsFromLedgerAuto,
  listTasksFromLedgerAuto,
  listTasksFromLedgerFile,
} from "../ledger-api-helpers.ts";
import {
  getTaskSubmission,
  listTaskSubmissions,
} from "../task-submission-store.ts";

import {
  MOBILE_CHAT_DEFAULT_LIMIT,
  MOBILE_CHAT_MAX_LIMIT,
  MobileChatStore,
  type MobileChatMessage,
} from "./mobileChatStore.ts";
import {
  MOBILE_ACTIVITY_DEFAULT_LIMIT,
  MOBILE_ACTIVITY_GLOBAL_CAP,
  MOBILE_ACTIVITY_MAX_LIMIT,
  MOBILE_TASK_ACTIVITY_DEFAULT_LIMIT,
  MOBILE_TASK_ACTIVITY_MAX_LIMIT,
} from "./operationCompressor.ts";
import { MobileBindStore } from "./mobileBindStore.ts";
import { generateMobileSessionToken, MobileDeviceStore } from "./mobileDeviceStore.ts";
import { isMobileGatewayOnline } from "./mobileGatewayClient.ts";
import { scanMobileIssues, slimMobileIssue } from "./mobileIssues.ts";
import {
  isReportToday,
  localTodayYmdCompact,
  isTaskOpen,
  slimMobileReport,
  slimMobileTask,
  titleFromReportDoc,
  titleFromTaskDoc,
} from "./mobileListMappers.ts";
import { getMobileInstanceId, resolveMobilePublicApiBase } from "./mobileInstance.ts";
import { readRuntimeActionStreamEvents } from "./mobileRuntimeActionStream.ts";
import {
  readThinkConsoleEvents,
  type ThinkConsoleEvent,
} from "./mobileThinkConsole.ts";
import { registerMobilePanelRoutes } from "./mobilePanelRoutes.ts";
import { createMobileAuthMiddleware } from "./mobilePermissions.ts";
import {
  buildAvailableTaskActions,
  buildFlowOverview,
  filterTasksForRecipient,
  findChildTasksForParent,
  isAdminToPmTask,
  normalizedTaskId,
  proxyPanelGet,
  proxyPanelPost,
  rowLinksTask,
  slimChildTasks,
} from "./mobileTaskDetail.ts";
import type { MobilePanelContext, MobileRoutesBundle } from "./types.ts";
import { normalizeMobileUiLang, type MobileUiLang } from "./mobileUiLocale.ts";

export type MobileLiveActivityEvent = ThinkConsoleEvent;

function canonicalAdmissionTaskId(value: unknown): string {
  const raw = String(value ?? "").replace(/\.md$/i, "").trim();
  return raw.match(/^TASK-\d{8}-\d{3,}/i)?.[0].toUpperCase() ?? raw.toUpperCase();
}

export function readTaskSpecAdmissionForMobile(
  projectRoot: string,
  taskId: unknown,
): Record<string, unknown> | null {
  const canonical = canonicalAdmissionTaskId(taskId);
  if (!canonical) return null;
  const path = join(
    projectRoot,
    ".codeflowmu",
    "task-spec-admission",
    `${canonical.replace(/[^A-Z0-9._-]/g, "-")}.json`,
  );
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.decision === "rejected" &&
      parsed.code === "TASK_SPEC_INVALID"
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // No current rejection for this task.
  }
  return null;
}

function activityMatchesTaskFilter(
  event: MobileLiveActivityEvent,
  taskId: string,
): boolean {
  const target = normalizedTaskId(taskId);
  if (!target) return true;
  const tid = normalizedTaskId(event.taskId);
  if (tid && (tid === target || tid.includes(target) || target.includes(tid))) {
    return true;
  }
  return event.summary.includes(target);
}

function mergeMobileLiveActivity(
  projectRoot: string,
  options: { limit?: number; taskId?: string; lang?: MobileUiLang },
): MobileLiveActivityEvent[] {
  const limit = options.limit ?? MOBILE_ACTIVITY_DEFAULT_LIMIT;
  const taskFilter = options.taskId?.trim();
  const scanCap = Math.min(Math.max(limit * 2, limit), MOBILE_ACTIVITY_GLOBAL_CAP);

  let merged: MobileLiveActivityEvent[] = [
    ...readThinkConsoleEvents(projectRoot, scanCap),
    ...readRuntimeActionStreamEvents(projectRoot, scanCap, options.lang ?? "zh"),
  ];

  if (taskFilter) {
    merged = merged.filter((e) => activityMatchesTaskFilter(e, taskFilter));
  }

  merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return merged.slice(0, limit);
}

function safeBasename(filename: string): string | null {
  const raw = String(filename ?? "").trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    return null;
  }
  return basename(raw);
}

const MAX_MOBILE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MOBILE_ATTACHMENT_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return map[mime] ?? ".bin";
}

function generateServerAttachmentFilename(mime: string): string {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(8).toString("hex");
  return `img-${stamp}-${rand}${mimeToExtension(mime)}`;
}

function sanitizeDisplayFilename(raw: string, fallback: string): string {
  const base = safeBasename(raw);
  if (!base) return fallback;
  return base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function readMarkdownDoc(filepath: string): Record<string, unknown> | null {
  if (!existsSync(filepath)) return null;
  try {
    const raw = readFileSync(filepath, "utf-8");
    const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        flat[k] = String(v);
      }
    }
    return { filename: basename(filepath), ...flat, frontmatter: fm, body };
  } catch {
    return null;
  }
}

function mapDirectChatRow(row: unknown): MobileChatMessage | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const content = String(r.text ?? r.content ?? "").trim();
  const roleRaw = String(r.role ?? "agent").toLowerCase();
  const role = roleRaw === "admin" ? "user" : roleRaw;
  const attachments = Array.isArray(r.attachments) ? (r.attachments as MobileChatMessage["attachments"]) : undefined;
  if (!content && !(attachments && attachments.length)) return null;
  const source = r.source != null ? String(r.source) : undefined;
  const client = r.client != null ? String(r.client) : undefined;
  const agentId = r.agentId != null ? String(r.agentId) : r.agent_id != null ? String(r.agent_id) : undefined;
  return {
    role,
    content,
    created_at: String(r.ts ?? r.created_at ?? new Date().toISOString()),
    ...(agentId ? { agentId } : {}),
    ...(source ? { source } : {}),
    ...(client ? { client } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
  };
}

function inferMobileClientFromRequest(req: Request): string {
  const hinted = String(req.headers["x-fcop-mobile-client"] ?? "").trim().toLowerCase();
  if (hinted === "pwa" || hinted === "ios" || hinted === "android") return hinted;
  const ua = String(req.headers["user-agent"] ?? "").toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/android/.test(ua)) return "android";
  return "pwa";
}

function chatMessageKey(m: MobileChatMessage): string {
  // Mobile send persists to JSONL then async-forwards to PC directChat — same text, different ts.
  const a = Array.isArray(m.attachments) ? m.attachments : [];
  const sig = a
    .map((x) => {
      const type = String(x?.type ?? "");
      const local = String(x?.local_path ?? "");
      const abs = String(x?.absolute_path ?? "");
      const mime = String(x?.mime ?? "");
      return `${type}|${local}|${abs}|${mime}`;
    })
    .join(",");
  return `${m.role}\u0000${m.content}\u0000${sig}`;
}

/** Merge PC directChat with mobile JSONL store so mobile-sent messages are not dropped. */
export function mergeMobileChatMessages(
  fromPc: MobileChatMessage[],
  fromStore: MobileChatMessage[],
  limit: number,
): MobileChatMessage[] {
  const merged = new Map<string, MobileChatMessage>();
  for (const m of [...fromPc, ...fromStore]) {
    merged.set(chatMessageKey(m), m);
  }
  return [...merged.values()]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-limit);
}

function listMobileChatMessages(
  ctx: MobilePanelContext,
  chatStore: MobileChatStore,
  limit: number,
): MobileChatMessage[] {
  const fromPc = ctx
    .listChatMessages({ limit })
    .map(mapDirectChatRow)
    .filter((m): m is MobileChatMessage => m != null);
  const fromStore = chatStore.listMessages(limit);
  if (fromPc.length === 0) {
    return fromStore;
  }
  return mergeMobileChatMessages(fromPc, fromStore, limit);
}

const TASK_LINK_ID_RE = /^TASK-\d{8}-\d{3,}$/i;
const REPORT_REF_RE = /^REPORT-/i;

function linkedTaskIds(row: Record<string, unknown>): string[] {
  const frontmatter = (row.frontmatter ?? {}) as Record<string, unknown>;
  const values = [
    row.task_id,
    frontmatter.task_id,
    ...(Array.isArray(row.linked_task_ids) ? row.linked_task_ids : []),
    ...(Array.isArray(frontmatter.linked_task_ids) ? frontmatter.linked_task_ids : []),
    ...(Array.isArray(row.references) ? row.references : []),
    ...(Array.isArray(frontmatter.references) ? frontmatter.references : []),
  ];
  return [...new Set(values.map(normalizedTaskId).filter((id) => TASK_LINK_ID_RE.test(id)))];
}

function linkedReportIds(row: Record<string, unknown>): string[] {
  const frontmatter = (row.frontmatter ?? {}) as Record<string, unknown>;
  const values = [
    ...(Array.isArray(row.references) ? row.references : []),
    ...(Array.isArray(frontmatter.references) ? frontmatter.references : []),
  ];
  return [
    ...new Set(
      values
        .map((v) => String(v ?? "").replace(/\.md$/i, "").trim())
        .filter((id) => REPORT_REF_RE.test(id)),
    ),
  ];
}

function enrichTaskTitle(
  projectRoot: string,
  adminTasksDir: string | undefined,
  row: Record<string, unknown>,
): string {
  const yaml = (row.yaml ?? {}) as Record<string, unknown>;
  const fromMeta = String(row.subject ?? row.title ?? yaml.subject ?? "").trim();
  if (fromMeta && !fromMeta.endsWith(".md")) return fromMeta;
  const slim = slimMobileTask(row);
  const filepath = resolveTaskFilePath(
    projectRoot,
    adminTasksDir,
    String(row.filename ?? ""),
  );
  const doc = filepath ? readMarkdownDoc(filepath) : null;
  const fromDoc = titleFromTaskDoc(doc);
  return fromDoc || String(slim.title ?? "");
}

function enrichReportTitle(
  projectRoot: string,
  reportsDir: string | undefined,
  row: Record<string, unknown>,
): string {
  const yaml = (row.yaml ?? {}) as Record<string, unknown>;
  const fromMeta = String(row.subject ?? row.title ?? yaml.subject ?? "").trim();
  if (fromMeta) return fromMeta;
  const slim = slimMobileReport(row);
  const filepath = resolveReportFilePath(
    projectRoot,
    reportsDir,
    String(row.filename ?? ""),
  );
  const doc = filepath ? readMarkdownDoc(filepath) : null;
  const fromDoc = titleFromReportDoc(doc);
  return fromDoc || String(slim.title ?? "");
}

function resolveTaskFilePath(
  projectRoot: string,
  adminTasksDir: string | undefined,
  filename: string,
): string | null {
  const safe = safeBasename(filename);
  if (!safe || !safe.endsWith(".md")) return null;
  const rows = listTasksFromLedgerFile(projectRoot, { limit: 2000 });
  const row = rows.find((r) => String(r.filename ?? "") === safe);
  if (row?.path) {
    const abs = join(projectRoot, String(row.path).replace(/^[/\\]+/, ""));
    if (existsSync(abs)) return abs;
  }
  const v3 = fcopV3Paths(projectRoot);
  const searchDirs = [
    ...(adminTasksDir ? [adminTasksDir] : []),
    join(v3.lifecycleRoot, "inbox"),
    join(v3.lifecycleRoot, "active"),
    join(v3.lifecycleRoot, "review"),
    join(v3.lifecycleRoot, "done"),
    join(v3.lifecycleRoot, "archive"),
    v3.tasks,
  ];
  for (const dir of searchDirs) {
    const p = join(dir, safe);
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveReportFilePath(
  projectRoot: string,
  reportsDir: string | undefined,
  filename: string,
): string | null {
  const safe = safeBasename(filename);
  if (!safe || !safe.endsWith(".md")) return null;
  if (reportsDir) {
    const p = join(reportsDir, safe);
    if (existsSync(p)) return p;
  }
  const v3 = fcopV3Paths(projectRoot);
  const candidates = [v3.reports, join(v3.lifecycleRoot, "done"), join(v3.lifecycleRoot, "archive")];
  for (const dir of candidates) {
    const p = join(dir, safe);
    if (existsSync(p)) return p;
  }
  return null;
}

function mobileApprovalService(ctx: MobilePanelContext): OperationApprovalService {
  return new OperationApprovalService({ projectRoot: ctx.getProjectRoot() });
}

function mobileGovernanceApprovalService(
  ctx: MobilePanelContext,
): GovernanceApprovalService {
  return new GovernanceApprovalService({ projectRoot: ctx.getProjectRoot() });
}

function mobileGovernanceApprovalStatus(status: string): string {
  if (status === "pending_approval") return "pending";
  if (["effective", "consumed"].includes(status)) return "approved";
  return status;
}

function mobileGovernanceApprovalRow(
  record: ReturnType<GovernanceApprovalService["get"]>,
): Record<string, unknown> {
  return {
    ...record,
    id: record.approval_id ?? `${record.governance_id}::${record.revision}`,
    filename:
      record.approval_id ?? `${record.governance_id}::${record.revision}`,
    kind: "governance",
    status: mobileGovernanceApprovalStatus(record.status),
    title: record.intent_summary,
    summary: record.boundary_summary,
    approval_type: "governance_boundary_change",
    from: record.authored_by,
    to: "ADMIN",
    can_approve: record.status === "pending_approval",
    material_missing: false,
  };
}

function mobileOperationApprovalStatus(record: OperationApprovalRecord): string {
  if (record.status === "pending_approval") return "pending";
  if (["approved", "executing", "succeeded", "partial_failed", "failed"].includes(record.status)) {
    return "approved";
  }
  return record.status;
}

function mobileOperationApprovalRow(record: OperationApprovalRecord): Record<string, unknown> {
  return {
    ...record,
    id: record.approval_id,
    filename: record.approval_id,
    kind: "approval",
    status: mobileOperationApprovalStatus(record),
    execution_status: record.execution.status,
    title: record.effects[0] ?? record.reason ?? record.approval_id,
    summary: record.effects.join("；"),
    approval_type: record.primary_kind,
    from: record.requested_by,
    to: "ADMIN",
    can_approve: record.status === "pending_approval",
    material_missing: false,
  };
}

async function mobileApprovalDetail(
  ctx: MobilePanelContext,
  approvalId: string,
  lang: MobileUiLang = "zh",
) {
  let record: OperationApprovalRecord;
  try {
    record = mobileApprovalService(ctx).get(approvalId);
  } catch (error) {
    if (error instanceof OperationApprovalError && error.code === "APPROVAL_NOT_FOUND") return null;
    throw error;
  }
  const merged = mobileOperationApprovalRow(record);
  const taskId = normalizedTaskId(record.task_id);
  const { tasks } = await listTasksFromLedgerAuto(ctx.getProjectRoot(), { limit: 2000 });
  const taskRow = taskId
    ? tasks.find((row) => normalizedTaskId(row.task_id ?? row.filename) === taskId)
    : undefined;
  const { reports } = await listReportsFromLedgerAuto(ctx.getProjectRoot(), { limit: 2000 });
  const reportRow = reports.find((row) => taskId && rowLinksTask(row, taskId));
  const labels =
    lang === "en"
      ? {
          action: "Action",
          targets: "Targets",
          effects: "Effects",
          nonEffects: "Not affected",
          recovery: "Recovery",
          expiresAt: "Expires at",
          listSeparator: "; ",
          targetSeparator: ", ",
        }
      : {
          action: "动作",
          targets: "目标",
          effects: "影响",
          nonEffects: "不影响",
          recovery: "恢复方式",
          expiresAt: "有效期",
          listSeparator: "；",
          targetSeparator: "、",
        };
  return {
    approval: {
      ...merged,
      body: [
        `${labels.action}: ${record.request.action.operation}`,
        `${labels.targets}: ${record.request.resource.targets.join(labels.targetSeparator)}`,
        `${labels.effects}: ${record.effects.join(labels.listSeparator)}`,
        `${labels.nonEffects}: ${record.non_effects.join(labels.listSeparator)}`,
        `${labels.recovery}: ${record.recovery}`,
        `${labels.expiresAt}: ${record.expires_at}`,
      ].join("\n\n"),
    },
    linked_task: taskRow ? slimMobileTask(taskRow) : null,
    linked_report: reportRow ? slimMobileReport(reportRow) : null,
    transitions: [],
  };
}

async function mobileGovernanceApprovalDetail(
  ctx: MobilePanelContext,
  approvalId: string,
) {
  const service = mobileGovernanceApprovalService(ctx);
  const record = service
    .list({ limit: 1000 })
    .find(
      (row) =>
        row.approval_id === approvalId ||
        `${row.governance_id}::${row.revision}` === approvalId,
    );
  if (!record) return null;
  const merged = mobileGovernanceApprovalRow(record);
  return {
    approval: {
      ...merged,
      body: [
        `意图：${record.intent_summary}`,
        `边界：${record.boundary_summary}`,
        `允许：${record.allowed_actions.join("；")}`,
        `禁止：${record.prohibited_actions.join("；")}`,
        `目标：${record.targets.join("；")}`,
        `内容哈希：${record.content_hash}`,
        `范围摘要：${record.scope_digest}`,
        `来源消息：${record.source_message_id ?? "—"}`,
      ].join("\n\n"),
    },
    linked_task: null,
    linked_report: null,
    transitions: service
      .listDecisions(record.governance_id)
      .filter((row) => row.governance_revision === record.revision),
  };
}

async function mobileUnifiedApprovalDetail(
  ctx: MobilePanelContext,
  approvalId: string,
  lang: MobileUiLang,
) {
  return (
    (await mobileGovernanceApprovalDetail(ctx, approvalId)) ??
    mobileApprovalDetail(ctx, approvalId, lang)
  );
}

function requestMobileUiLang(req: Request): MobileUiLang {
  const explicit = req.headers["x-codeflowmu-ui-lang"];
  if (explicit) return normalizeMobileUiLang(Array.isArray(explicit) ? explicit[0] : explicit);
  return normalizeMobileUiLang(req.headers["accept-language"]);
}

async function listMergedMobileApprovals(ctx: MobilePanelContext): Promise<Record<string, unknown>[]> {
  return [
    ...mobileGovernanceApprovalService(ctx)
      .list({ limit: 200 })
      .filter((row) => row.status !== "draft")
      .map(mobileGovernanceApprovalRow),
    ...mobileApprovalService(ctx)
      .list({ limit: 200 })
      .map(mobileOperationApprovalRow),
  ];
}

export function createMobileRoutes(ctx: MobilePanelContext): MobileRoutesBundle {
  const router = Router();
  const deviceStore = new MobileDeviceStore(ctx.getDataDir());
  const chatStore = new MobileChatStore(ctx.getDataDir());
  const bindStore = new MobileBindStore();
  const auth = createMobileAuthMiddleware(deviceStore);

  registerMobilePanelRoutes(router, { ctx, bindStore, deviceStore });

  router.post("/bind-confirm", (req: Request, res: Response) => {
    const { bind_id, token, device_name } = req.body as {
      bind_id?: string;
      token?: string;
      device_name?: string;
    };
    const bindId = String(bind_id ?? "").trim();
    const bindToken = String(token ?? "").trim();
    if (!bindId || !bindToken) {
      res.status(400).json({ ok: false, error: "MISSING_BIND_FIELDS" });
      return;
    }
    const attempt = bindStore.tryConfirm(bindId, bindToken);
    if (attempt.kind === "invalid") {
      res.status(403).json({ ok: false, error: "BIND_TOKEN_INVALID" });
      return;
    }
    const api_base = resolveMobilePublicApiBase(ctx.getProjectRoot());
    if (attempt.kind === "replay") {
      res.json({
        ok: true,
        replay: true,
        device_id: attempt.device_id,
        mobile_session_token: attempt.mobile_session_token,
        expires_at: attempt.expires_at,
        instance_id: getMobileInstanceId(ctx.getProjectRoot()),
        api_base,
      });
      return;
    }
    const mobileSessionToken = generateMobileSessionToken();
    const { device, expires_at } = deviceStore.bindDevice({
      device_name: String(device_name ?? "Mobile Device"),
      session_token: mobileSessionToken,
    });
    bindStore.recordSuccess(bindId, bindToken, {
      device_id: device.device_id,
      mobile_session_token: mobileSessionToken,
      expires_at,
    });
    res.json({
      ok: true,
      device_id: device.device_id,
      mobile_session_token: mobileSessionToken,
      expires_at,
      instance_id: getMobileInstanceId(ctx.getProjectRoot()),
      api_base,
    });
  });

  router.use(auth);

  router.get("/bootstrap", async (req: Request, res: Response) => {
    try {
      const projectRoot = ctx.getProjectRoot();
      await ensureLedgerFresh(projectRoot);
      const today = localTodayYmdCompact();
      const { tasks } = await listTasksFromLedgerAuto(projectRoot, { limit: 500 });
      const tasksOpen = tasks.filter((t) => isTaskOpen(t)).length;
      const { reports } = await listReportsFromLedgerAuto(projectRoot, { limit: 200 });
      const reportsToday = reports.filter((r) => isReportToday(r, today)).length;
      const issuesDir = ctx.getIssuesDir();
      const issuesOpen = scanMobileIssues(issuesDir ?? "", {
        status: "open",
        limit: 500,
        projectRoot,
      }).length;
      const approvals = await listMergedMobileApprovals(ctx);
      const approvalsPending = approvals.filter((row) =>
        ["pending", "needs_eval", "exception"].includes(String(row.status ?? "")),
      ).length;
      const alertsPayload = ctx.listAlerts({ limit: 50 });
      const alertsCount = Array.isArray(alertsPayload)
        ? alertsPayload.length
        : Number(
            (alertsPayload as { total?: number })?.total ??
              (alertsPayload as { events?: unknown[] })?.events?.length ??
              (alertsPayload as { items?: unknown[] })?.items?.length ??
              0,
          );

      res.json({
        app: "codeflowmu-mobile",
        mode: "pm_dev_team",
        instance_id: getMobileInstanceId(projectRoot),
        api_base: resolveMobilePublicApiBase(projectRoot),
        device_id: req.mobileAuth?.device_id,
        lang: ctx.getUiLang?.() ?? "zh",
        summary: {
          tasks_open: tasksOpen,
          reports_today: reportsToday,
          issues_open: issuesOpen,
          approvals_pending: approvalsPending,
          alerts: alertsCount,
        },
        status: {
          pc_online: true,
          gateway_online: ctx.gatewayOnline?.() ?? isMobileGatewayOnline(),
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/activity", (req: Request, res: Response) => {
    try {
      const projectRoot = ctx.getProjectRoot();
      const limit = Math.min(
        Math.max(Number(req.query["limit"] ?? MOBILE_ACTIVITY_DEFAULT_LIMIT), 1),
        MOBILE_ACTIVITY_MAX_LIMIT,
      );
      const events = mergeMobileLiveActivity(projectRoot, { limit, lang: requestMobileUiLang(req) });
      res.json({ ok: true, events });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/tasks/:taskId/activity", (req: Request, res: Response) => {
    try {
      const projectRoot = ctx.getProjectRoot();
      const taskId = String(req.params["taskId"] ?? "").trim();
      const limit = Math.min(
        Math.max(Number(req.query["limit"] ?? MOBILE_TASK_ACTIVITY_DEFAULT_LIMIT), 1),
        MOBILE_TASK_ACTIVITY_MAX_LIMIT,
      );
      if (!taskId) {
        res.status(400).json({ ok: false, error: "TASK_ID_REQUIRED" });
        return;
      }
      const events = mergeMobileLiveActivity(projectRoot, { limit, taskId, lang: requestMobileUiLang(req) });
      res.json({ ok: true, events });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/tasks", async (req: Request, res: Response) => {
    try {
      const projectRoot = ctx.getProjectRoot();
      const limit = Math.min(Number(req.query["limit"] ?? 200), 500);
      const recipient = String(req.query["recipient"] ?? "").trim().toUpperCase() || undefined;
      const { tasks } = await listTasksFromLedgerAuto(projectRoot, { limit: 2000 });
      const filtered = filterTasksForRecipient(tasks as Record<string, unknown>[], recipient);
      const slim = filtered.slice(0, limit).map((t) => {
        const title = enrichTaskTitle(projectRoot, ctx.getAdminTasksDir(), t);
        const admission = readTaskSpecAdmissionForMobile(
          projectRoot,
          t.task_id ?? t.filename,
        );
        const projected = admission
          ? {
              ...t,
              display_status: "task_spec_rejected",
              task_spec_admission: admission,
            }
          : t;
        const item = slimMobileTask(projected);
        return title ? { ...item, title } : item;
      });
      res.json({ tasks: slim, filtered_by: recipient ?? null });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/tasks/:filename", async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");
    const projectRoot = ctx.getProjectRoot();
    const filepath = resolveTaskFilePath(
      projectRoot,
      ctx.getAdminTasksDir(),
      filename,
    );
    if (!filepath) {
      res.status(404).json({ ok: false, error: "TASK_NOT_FOUND" });
      return;
    }
    const doc = readMarkdownDoc(filepath);
    if (!doc) {
      res.status(500).json({ ok: false, error: "TASK_READ_FAILED" });
      return;
    }
    try {
      const { tasks } = await listTasksFromLedgerAuto(projectRoot, { limit: 2000 });
      const taskRow = tasks.find((row) => String(row.filename ?? "") === filename) ?? {};
      const taskId = String(doc.task_id ?? taskRow.task_id ?? filename);
      const taskSpecAdmission = readTaskSpecAdmissionForMobile(
        projectRoot,
        taskId,
      );
      const { reports } = await listReportsFromLedgerAuto(projectRoot, { limit: 2000 });
      const relatedReports = reports
        .filter((row) => rowLinksTask(row, taskId))
        .map((row) => {
          const slim = slimMobileReport(row);
          const title = enrichReportTitle(projectRoot, ctx.getFcopReportsDir(), row);
          return title ? { ...slim, title } : slim;
        });
      const issues = scanMobileIssues(ctx.getIssuesDir() ?? "", {
        status: "all",
        limit: 500,
        projectRoot,
      })
        .filter((row) => rowLinksTask(row, taskId) || String(row.preview ?? "").includes(normalizedTaskId(taskId)))
        .map((row) => slimMobileIssue(row));
      const transitions = Array.isArray(taskRow.transitions)
        ? taskRow.transitions.slice(-10)
        : [];
      const mergedTask = {
        ...doc,
        ...taskRow,
        ...(taskSpecAdmission
          ? {
              display_status: "task_spec_rejected",
              task_spec_admission: taskSpecAdmission,
            }
          : {}),
        title: titleFromTaskDoc(doc) || String(taskRow.subject ?? doc.subject ?? doc.title ?? filename),
        status:
          (taskSpecAdmission ? "task_spec_rejected" : undefined) ??
          taskRow.display_status ??
          doc.status ??
          taskRow.bucket,
        bucket: taskRow.scope ?? taskRow.bucket ?? taskRow._state,
        from: taskRow.sender ?? doc.sender,
        to: taskRow.recipient ?? doc.recipient,
        updated_at: taskRow.updated_at,
        filename,
        thread_key: doc.thread_key ?? taskRow.thread_key,
      };
      const taskIdNorm = normalizedTaskId(taskId);
      let child_tasks: ReturnType<typeof slimChildTasks> = [];
      let flow_overview: ReturnType<typeof buildFlowOverview> = [];
      if (isAdminToPmTask(mergedTask)) {
        const children = findChildTasksForParent(mergedTask, tasks as Record<string, unknown>[]);
        child_tasks = slimChildTasks(children).map((child, idx) => {
          const row = children[idx] ?? {};
          const title = enrichTaskTitle(projectRoot, ctx.getAdminTasksDir(), row);
          return title ? { ...child, title } : child;
        });
        let closeout = null;
        try {
          closeout = await getAdminTaskCloseout(projectRoot, taskIdNorm, { ensureEval: false });
        } catch {
          closeout = null;
        }
        flow_overview = buildFlowOverview(mergedTask, children, closeout, requestMobileUiLang(req));
      }
      const available_actions = buildAvailableTaskActions(mergedTask, {
        panelPort: ctx.panelPort,
        lang: requestMobileUiLang(req),
        childTasks: isAdminToPmTask(mergedTask)
          ? findChildTasksForParent(mergedTask, tasks as Record<string, unknown>[])
          : [],
      });
      let dispatchState: Awaited<ReturnType<typeof proxyPanelGet>> | null = null;
      try {
        dispatchState = await proxyPanelGet(
          ctx.panelPort,
          `/api/v2/runtime/tasks/${encodeURIComponent(taskIdNorm)}/dispatch-state`,
        );
      } catch {
        // Task detail is authoritative from the local ledger. A temporarily
        // unavailable Panel projection must not make the Mobile read path 500.
        dispatchState = null;
      }
      res.json({
        task: mergedTask,
        task_spec_admission: taskSpecAdmission,
        related_reports: relatedReports,
        related_issues: issues,
        transitions,
        child_tasks,
        flow_overview,
        available_actions,
        dispatch_state: dispatchState?.ok ? dispatchState.body : null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post("/tasks/:filename/actions", async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");
    const action = String((req.body as { action?: string }).action ?? "").trim().toLowerCase();
    const projectRoot = ctx.getProjectRoot();
    const filepath = resolveTaskFilePath(projectRoot, ctx.getAdminTasksDir(), filename);
    if (!filepath) {
      res.status(404).json({ ok: false, error: "TASK_NOT_FOUND" });
      return;
    }
    const doc = readMarkdownDoc(filepath);
    if (!doc) {
      res.status(500).json({ ok: false, error: "TASK_READ_FAILED" });
      return;
    }
    try {
      await ensureLedgerFresh(projectRoot);
      const { tasks } = await listTasksFromLedgerAuto(projectRoot, { limit: 2000 });
      const taskRow = tasks.find((row) => String(row.filename ?? "") === filename) ?? {};
      const merged: Record<string, unknown> = { ...doc, ...taskRow, filename };
      const taskId = normalizedTaskId(merged.task_id ?? filename);
      const recipient = taskRecipientFromRow(merged);

      if (action === "nudge") {
        const panelRes = await proxyPanelPost(ctx.panelPort, "/api/v2/pm/governance/wake-downstream", {
          task_id: taskId,
          role: recipient || "PM",
          reason: "mobile_nudge",
          thread_key: merged.thread_key,
        });
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      if (action === "unstick") {
        const panelRes = await proxyPanelPost(ctx.panelPort, `/api/v2/tasks/${encodeURIComponent(taskId)}/unstick`, {
          reason: "mobile_unstick",
        });
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      if (action === "redispatch") {
        const panelRes = await proxyPanelPost(
          ctx.panelPort,
          `/api/v2/runtime/tasks/${encodeURIComponent(taskId)}/redispatch`,
          {
            mode: "repair_retry",
            role: recipient || undefined,
            idempotency_key: `mobile-redispatch:${taskId}:${Date.now()}`,
          },
        );
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      if (action === "approve") {
        const body = req.body as { note?: string };
        const panelRes = await proxyPanelPost(
          ctx.panelPort,
          `/api/v2/tasks/${encodeURIComponent(taskId)}/approve`,
          { actor: "ADMIN", note: body.note },
        );
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      if (action === "reject") {
        const reason = String((req.body as { reason?: string }).reason ?? "").trim();
        if (!reason) {
          res.status(400).json({ ok: false, error: "REJECT_REASON_REQUIRED" });
          return;
        }
        const panelRes = await proxyPanelPost(
          ctx.panelPort,
          `/api/v2/tasks/${encodeURIComponent(taskId)}/reject`,
          { actor: "ADMIN", reason },
        );
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      if (action === "archive") {
        const reason = String((req.body as { reason?: string }).reason ?? "").trim();
        const panelRes = await proxyPanelPost(
          ctx.panelPort,
          `/api/v2/tasks/${encodeURIComponent(taskId)}/archive`,
          {
            actor: "ADMIN",
            ...(reason ? { reason } : {}),
          },
        );
        res.status(panelRes.status).json(panelRes.body);
        return;
      }
      res.status(400).json({ ok: false, error: "UNKNOWN_ACTION" });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  function taskRecipientFromRow(row: Record<string, unknown>): string {
    const recip = String(row.recipient ?? row.to ?? "").trim().toUpperCase();
    if (recip) return recip.split(".")[0] ?? recip;
    const fn = String(row.filename ?? row.task_id ?? "");
    const m = fn.match(/-to-([A-Z][A-Z0-9_.-]*)/i);
    if (!m) return "";
    const code = (m[1] ?? "").toUpperCase();
    const dot = code.indexOf(".");
    return dot >= 0 ? code.slice(0, dot) : code;
  }

  router.get("/task-submissions", async (req: Request, res: Response) => {
    try {
      const status = String(req.query["status"] ?? "").trim();
      const limit = Math.min(
        Math.max(Number(req.query["limit"] ?? 200) || 200, 1),
        500,
      );
      const submissions = await listTaskSubmissions(ctx.getProjectRoot(), {
        ...(status ? { status } : {}),
        limit,
      });
      res.json({ ok: true, submissions });
    } catch (error) {
      res
        .status(500)
        .json({ ok: false, error: String(error), code: "SUBMISSION_LIST_FAILED" });
    }
  });

  router.get("/project-graph", async (_req: Request, res: Response) => {
    try {
      const panelRes = await proxyPanelGet(ctx.panelPort, "/api/v2/project-graph");
      res.status(panelRes.status).json(panelRes.body);
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: String(error),
        code: "PROJECT_GRAPH_PROXY_FAILED",
      });
    }
  });

  router.get(
    "/task-submissions/:submissionId",
    async (req: Request, res: Response) => {
      const submission = await getTaskSubmission(
        ctx.getProjectRoot(),
        String(req.params["submissionId"] ?? ""),
      );
      if (!submission) {
        res.status(404).json({
          ok: false,
          error: "TASK_SUBMISSION_NOT_FOUND",
          code: "TASK_SUBMISSION_NOT_FOUND",
        });
        return;
      }
      res.json({ ok: true, submission });
    },
  );

  for (const action of ["check", "revise", "abandon"] as const) {
    router.post(
      `/task-submissions/:submissionId/${action}`,
      async (req: Request, res: Response) => {
        try {
          const submissionId = encodeURIComponent(
            String(req.params["submissionId"] ?? ""),
          );
          const panelRes = await proxyPanelPost(
            ctx.panelPort,
            `/api/v2/task-submissions/${submissionId}/${action}`,
            req.body ?? {},
          );
          res.status(panelRes.status).json(panelRes.body);
        } catch (error) {
          res.status(503).json({
            ok: false,
            error: String(error),
            code: "TASK_SUBMISSION_PROXY_FAILED",
          });
        }
      },
    );
  }

  router.post(
    "/tasks/:taskId/fact-check-decisions",
    async (req: Request, res: Response) => {
      try {
        const taskId = encodeURIComponent(String(req.params["taskId"] ?? ""));
        const panelRes = await proxyPanelPost(
          ctx.panelPort,
          `/api/v2/tasks/${taskId}/fact-check-decisions`,
          { ...(req.body ?? {}), caller_role: "ADMIN" },
        );
        res.status(panelRes.status).json(panelRes.body);
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: String(error),
          code: "FACT_CHECK_DECISION_PROXY_FAILED",
        });
      }
    },
  );

  router.post("/tasks", async (req: Request, res: Response) => {
    const adminDir = ctx.getAdminTasksDir();
    if (!adminDir) {
      res.status(503).json({ ok: false, error: "ADMIN_DIR_NOT_CONFIGURED" });
      return;
    }
    const body = req.body as {
      title?: string;
      subject?: string;
      body?: string;
      priority?: string;
      to?: string;
      from?: string;
      attachments?: Array<{
        type?: string;
        url?: string;
        local_path?: string;
        absolute_path?: string;
        mime?: string;
        original_name?: string;
        size?: number;
        sha256?: string;
      }>;
      relation_mode?: "new" | "continue" | "child" | string;
      references?: unknown;
      parent_task_id?: string;
      current_task_id?: string;
      idempotency_key?: string;
    };
    if (body.to && String(body.to).toUpperCase() !== "PM") {
      res.status(400).json({ ok: false, error: "MOBILE_TASK_RECIPIENT_MUST_BE_PM" });
      return;
    }
    const normalizedBody = {
      title: String(body.title ?? body.subject ?? ""),
      subject: String(body.title ?? body.subject ?? ""),
      body: String(body.body ?? ""),
      priority: String(body.priority ?? "P2"),
      to: "PM",
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
      relation_mode: body.relation_mode ?? "new",
      references: Array.isArray(body.references) ? body.references : body.references,
      parent_task_id: String(body.parent_task_id ?? ""),
      current_task_id: String(body.current_task_id ?? ""),
      idempotency_key: String(
        body.idempotency_key ??
          req.get("Idempotency-Key") ??
          req.get("idempotency-key") ??
          "",
      ).trim(),
    };
    if (ctx.createAdminPmTask) {
      const result = await ctx.createAdminPmTask(normalizedBody);
      res.status(result.ok ? 200 : (result.status ?? 500)).json(result);
      return;
    }
    res.status(503).json({
      ok: false,
      error: "TASK_SUBMISSION_SERVICE_NOT_CONFIGURED",
      code: "TASK_SUBMISSION_SERVICE_NOT_CONFIGURED",
    });
  });

  router.get("/reports", async (req: Request, res: Response) => {
    try {
      const projectRoot = ctx.getProjectRoot();
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const { reports } = await listReportsFromLedgerAuto(projectRoot, { limit: 500 });
      res.json({ reports: reports.slice(0, limit).map((r) => {
        const title = enrichReportTitle(projectRoot, ctx.getFcopReportsDir(), r);
        const slim = slimMobileReport(r);
        return title ? { ...slim, title } : slim;
      }) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/reports/:filename", async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");
    const projectRoot = ctx.getProjectRoot();
    const filepath = resolveReportFilePath(
      projectRoot,
      ctx.getFcopReportsDir(),
      filename,
    );
    if (!filepath) {
      res.status(404).json({ ok: false, error: "REPORT_NOT_FOUND" });
      return;
    }
    const doc = readMarkdownDoc(filepath);
    if (!doc) {
      res.status(500).json({ ok: false, error: "REPORT_READ_FAILED" });
      return;
    }
    try {
      const { reports } = await listReportsFromLedgerAuto(projectRoot, { limit: 2000 });
      const reportRow = reports.find((row) => String(row.filename ?? "") === filename) ?? {};
      const report = { ...slimMobileReport(reportRow), ...doc };
      const reportId = String(report.report_id ?? filename).replace(/\.md$/i, "");
      const ids = linkedTaskIds({ ...reportRow, ...doc });
      const reportRefIds = linkedReportIds({ ...reportRow, ...doc });
      const { tasks } = await listTasksFromLedgerAuto(projectRoot, { limit: 2000 });
      const linkedTasks = ids.map((taskId) => {
        const row = tasks.find((task) => normalizedTaskId(task.task_id ?? task.filename) === taskId);
        if (row) {
          const slim = slimMobileTask(row);
          const title = enrichTaskTitle(projectRoot, ctx.getAdminTasksDir(), row);
          return title ? { ...slim, title } : slim;
        }
        return { task_id: taskId, title: taskId };
      });
      const linkedReports = reportRefIds
        .map((refId) => {
          const row = reports.find(
            (r) =>
              normalizedTaskId(r.report_id ?? r.filename) === normalizedTaskId(refId) ||
              String(r.filename ?? "").replace(/\.md$/i, "") === refId,
          );
          if (!row) {
            return { report_id: refId, filename: refId.endsWith(".md") ? refId : `${refId}.md`, title: refId };
          }
          const slim = slimMobileReport(row);
          const title = enrichReportTitle(projectRoot, ctx.getFcopReportsDir(), row);
          return title ? { ...slim, title } : slim;
        })
        .filter((r) => normalizedTaskId(r.report_id ?? r.filename) !== normalizedTaskId(reportId));
      const issues = scanMobileIssues(ctx.getIssuesDir() ?? "", {
        status: "all",
        limit: 500,
        projectRoot,
      })
        .filter((row) => {
          const text = JSON.stringify(row);
          return text.includes(reportId) || ids.some((taskId) => rowLinksTask(row, taskId));
        })
        .map((row) => slimMobileIssue(row));
      res.json({
        report: {
          ...report,
          title:
            enrichReportTitle(projectRoot, ctx.getFcopReportsDir(), { ...reportRow, ...doc }) ||
            report.title,
          linked_task_ids: ids,
          status: reportRow.status ?? doc.status,
          from: reportRow.sender ?? doc.sender,
          to: reportRow.recipient ?? doc.recipient,
          priority: reportRow.priority ?? doc.priority,
          created_at: reportRow.created_at ?? doc.created_at,
          updated_at: reportRow.updated_at ?? doc.updated_at,
        },
        linked_tasks: linkedTasks,
        linked_reports: linkedReports,
        related_issues: issues,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/issues", (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const status = String(req.query["status"] ?? "open");
      const rows = scanMobileIssues(ctx.getIssuesDir() ?? "", {
        status,
        limit,
        projectRoot: ctx.getProjectRoot(),
      });
      res.json({ issues: rows.map((r) => slimMobileIssue(r)) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/issues/promotions", (_req: Request, res: Response) => {
    try {
      const promotions = listIssuePromotions(ctx.getProjectRoot());
      res.json({ promotions, _meta: { count: promotions.length } });
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.get("/issues/:filename", (req: Request, res: Response) => {
    try {
      res.json(new IssueClosureService({ projectRoot: ctx.getProjectRoot() }).detail(String(req.params["filename"] ?? "")));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.post("/issues/:filename/closure/preview", (req: Request, res: Response) => {
    try {
      res.json(new IssueClosureService({ projectRoot: ctx.getProjectRoot() }).preview(String(req.params["filename"] ?? ""), req.body));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.post("/issues/:filename/close", async (req: Request, res: Response) => {
    try {
      res.json(await new IssueClosureService({ projectRoot: ctx.getProjectRoot() }).close(String(req.params["filename"] ?? ""), req.body));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.get("/issues/:filename/closure/history", (req: Request, res: Response) => {
    try {
      res.json(new IssueClosureService({ projectRoot: ctx.getProjectRoot() }).history(String(req.params["filename"] ?? "")));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.post("/issues/:filename/reopen", async (req: Request, res: Response) => {
    try {
      res.json(await new IssueClosureService({ projectRoot: ctx.getProjectRoot() }).reopen(String(req.params["filename"] ?? ""), req.body));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.post("/issues/:filename/promotion/bundle", async (req: Request, res: Response) => {
    try {
      res.json(await generateIssuePromotionBundle({
        projectRoot: ctx.getProjectRoot(),
        filename: String(req.params["filename"] ?? ""),
        actor: String(req.body?.actor ?? ""),
        expected_closure_digest: String(req.body?.expected_closure_digest ?? ""),
      }));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.get("/issues/promotion/:promotionId", (req: Request, res: Response) => {
    try {
      res.json(readIssuePromotion(ctx.getProjectRoot(), String(req.params["promotionId"] ?? "")));
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.post("/issues/promotion/:promotionId/github/prepare", (req: Request, res: Response) => {
    try {
      const preparedInput = buildIssueGithubApprovalInput({
        projectRoot: ctx.getProjectRoot(),
        promotion_id: String(req.params["promotionId"] ?? ""),
        actor: String(req.body?.actor ?? ""),
      });
      const prepared = mobileApprovalService(ctx).prepare(preparedInput);
      res.status(prepared.decision === "REQUIRE_APPROVAL" ? 202 : 200).json({ ok: true, ...prepared });
    } catch (error) {
      const out = issueClosureErrorResponse(error);
      res.status(out.status).json({ ok: false, error: out.message, code: out.code, details: out.details });
    }
  });

  router.get("/approvals", async (req: Request, res: Response) => {
    try {
      const filename = String(req.query["filename"] ?? "");
      if (filename) {
        const detail = await mobileUnifiedApprovalDetail(
          ctx,
          filename,
          requestMobileUiLang(req),
        );
        if (!detail) {
          res.status(404).json({ ok: false, error: "APPROVAL_NOT_FOUND" });
          return;
        }
        res.json(detail);
        return;
      }
      const approvals = await listMergedMobileApprovals(ctx);
      res.json({ approvals });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/approvals/:filename", async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");
    try {
      const detail = await mobileUnifiedApprovalDetail(
        ctx,
        filename,
        requestMobileUiLang(req),
      );
      if (!detail) {
        res.status(404).json({ ok: false, error: "APPROVAL_NOT_FOUND" });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  const decideApproval = async (
    req: Request,
    res: Response,
    decision: "approve" | "reject" | "changes",
  ) => {
    const approvalId = String(req.params["filename"] ?? "");
    const reason = String((req.body as { reason?: string }).reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ ok: false, error: "APPROVAL_REASON_REQUIRED" });
      return;
    }
    const governanceService = mobileGovernanceApprovalService(ctx);
    const governance = governanceService
      .list({ limit: 1000 })
      .find((row) => row.approval_id === approvalId);
    if (governance) {
      const actionId = `pwa-${decision}-${Date.now()}-${randomBytes(6).toString("hex")}`;
      const result = governanceService.decide({
        governanceId: governance.governance_id,
        revision: governance.revision,
        approvalId,
        actor: "ADMIN",
        decision:
          decision === "approve"
            ? "approved"
            : decision === "reject"
              ? "rejected"
              : "changes_requested",
        reason,
        sourceUiActionId: actionId,
        idempotencyKey: actionId,
      });
      res.json({ ok: true, ...result });
      return;
    }
    if (decision === "changes") {
      res.status(400).json({
        ok: false,
        error: "CHANGES_ONLY_FOR_GOVERNANCE",
      });
      return;
    }
    if (ctx.decideOperationApproval) {
      const decided = await ctx.decideOperationApproval(approvalId, decision, reason);
      res.status(decided.status).json(decided.body);
      return;
    }
    const proxied = await proxyPanelPost(
      ctx.panelPort,
      `/api/v2/operation-approvals/${encodeURIComponent(approvalId)}/${decision === "approve" ? "approve" : "reject"}`,
      { reason },
    );
    res.status(proxied.status).json(proxied.body);
  };

  const sendMobileApprovalError = (res: Response, error: unknown) => {
    if (error instanceof GovernanceApprovalError) {
      res.status(error.httpStatus).json({
        ok: false,
        error: error.code,
        detail: error.message,
      });
      return;
    }
    if (error instanceof OperationApprovalError) {
      res.status(error.httpStatus).json({ ok: false, error: error.code, detail: error.message });
      return;
    }
    res.status(500).json({ ok: false, error: String(error) });
  };

  router.post("/approvals/:filename/approve", async (req, res) => {
    try {
      await decideApproval(req, res, "approve");
    } catch (err) {
      sendMobileApprovalError(res, err);
    }
  });
  router.post("/approvals/:filename/reject", async (req, res) => {
    try {
      await decideApproval(req, res, "reject");
    } catch (err) {
      sendMobileApprovalError(res, err);
    }
  });
  router.post("/approvals/:filename/confirm", async (req, res) => {
    try {
      const rawDecision = String((req.body as { decision?: string }).decision ?? "");
      if (rawDecision !== "approve" && rawDecision !== "reject") {
        res.status(400).json({ ok: false, error: "APPROVAL_DECISION_INVALID" });
        return;
      }
      const decision = rawDecision;
      await decideApproval(req, res, decision);
    } catch (err) {
      sendMobileApprovalError(res, err);
    }
  });
  router.post("/approvals/:filename/changes", async (req, res) => {
    try {
      await decideApproval(req, res, "changes");
    } catch (err) {
      sendMobileApprovalError(res, err);
    }
  });

  router.post("/approvals/:filename/execute", async (req, res) => {
    res.status(410).json({
      ok: false,
      error: "AGENT_CONTROLLED_EXECUTOR_RETIRED",
      detail: "approval decision is delivered to the original Agent, which retries the exact operation itself",
    });
  });

  router.get("/alerts", (_req: Request, res: Response) => {
    try {
      const payload = ctx.listAlerts({ limit: 50 });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/chat/messages", (req: Request, res: Response) => {
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, MOBILE_CHAT_MAX_LIMIT)
        : MOBILE_CHAT_DEFAULT_LIMIT;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, messages: listMobileChatMessages(ctx, chatStore, limit) });
  });

  router.post("/chat/send", (req: Request, res: Response) => {
    const body = req.body as {
      message?: string;
      agentId?: string;
      attachments?: MobileChatMessage["attachments"];
    };
    const message = String(body.message ?? "").trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
    if (!message && (!attachments || attachments.length === 0)) {
      res.status(400).json({ ok: false, error: "MESSAGE_OR_ATTACHMENTS_REQUIRED" });
      return;
    }
    const client = inferMobileClientFromRequest(req);
    const saved = chatStore.appendUserMessage(message || "", attachments, {
      source: "mobile",
      client,
    });
    // Ack immediately after persist — do not block on PM session start (avoids Gateway PC_TIMEOUT).
    void ctx
      .sendChat({
        message,
        agentId: body.agentId,
        intent: "chat",
        attachments: attachments && attachments.length ? attachments : undefined,
        source: "mobile",
        client,
      })
      .catch(() => {
        /* forward errors are best-effort; user message already in store */
      });
    res.json({
      ok: true,
      message: saved,
      forwarded: "pending",
    });
  });

  /**
   * POST /api/v2/mobile/attachments/upload
   * Image-only base64 upload for PWA (jpeg/png/webp).
   * Returns attachment metadata (local_path / absolute_path / mime / sha256) for TASK + CHAT persistence.
   */
  router.post("/attachments/upload", async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        filename?: string;
        mime?: string;
        data_base64?: string;
      };
      const rawName = String(body.filename ?? "");
      const mime = String(body.mime ?? "").toLowerCase().trim();
      if (!MOBILE_ATTACHMENT_MIMES.has(mime)) {
        res.status(415).json({ ok: false, error: "UNSUPPORTED_IMAGE_MIME" });
        return;
      }
      const dataBase64 = String(body.data_base64 ?? "").trim();
      if (!dataBase64) {
        res.status(400).json({ ok: false, error: "MISSING_DATA_BASE64" });
        return;
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(dataBase64, "base64");
      } catch {
        res.status(400).json({ ok: false, error: "INVALID_BASE64" });
        return;
      }
      if (!buf || buf.length === 0) {
        res.status(400).json({ ok: false, error: "EMPTY_UPLOAD" });
        return;
      }
      if (buf.length > MAX_MOBILE_ATTACHMENT_BYTES) {
        res.status(413).json({
          ok: false,
          error: "ATTACHMENT_TOO_LARGE",
          layer: "shell",
          actual_bytes: buf.length,
          max_bytes: MAX_MOBILE_ATTACHMENT_BYTES,
        });
        return;
      }

      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const root = ctx.getProjectRoot();
      const relDir = `fcop/attachments/${ymd}`;
      const absDir = join(root, "fcop", "attachments", ymd);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(absDir, { recursive: true });

      const serverName = generateServerAttachmentFilename(mime);
      let final = serverName;
      let absPath = join(absDir, final);
      let relPath = `${relDir}/${final}`.replace(/\\/g, "/");
      let n = 1;
      while (existsSync(absPath)) {
        const dot = serverName.lastIndexOf(".");
        const base = dot >= 0 ? serverName.slice(0, dot) : serverName;
        const ext = dot >= 0 ? serverName.slice(dot) : "";
        final = `${base}-${++n}${ext}`;
        absPath = join(absDir, final);
        relPath = `${relDir}/${final}`.replace(/\\/g, "/");
      }

      await writeFile(absPath, buf);

      const sha256 = createHash("sha256").update(buf).digest("hex");
      const displayName = sanitizeDisplayFilename(rawName, final);

      res.json({
        ok: true,
        attachment: {
          type: "image",
          filename: displayName,
          local_path: relPath,
          absolute_path: absPath.replace(/\\/g, "/"),
          mime,
          original_name: displayName,
          size: buf.length,
          sha256,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "ATTACHMENT_SAVE_FAILED" });
    }
  });

  /**
   * GET /api/v2/mobile/files/attachment?path=fcop/attachments/...
   * Serves attachment bytes as base64 for mobile preview (thumbnails + full-size).
   */
  router.get("/files/attachment", (req: Request, res: Response) => {
    try {
      const relPathRaw = String(req.query["path"] ?? "").replace(/\\/g, "/");
      const relPath = relPathRaw.replace(/^[/\\]+/, "").replace(/\/$/, "");
      if (!relPath.startsWith("fcop/attachments/")) {
        res.status(400).json({ ok: false, error: "ATTACHMENT_PATH_NOT_ALLOWED" });
        return;
      }
      if (!relPath || relPath.includes("..") || relPath.includes("\x00")) {
        res.status(400).json({ ok: false, error: "ATTACHMENT_PATH_NOT_ALLOWED" });
        return;
      }
      const rootAbs = pathResolve(ctx.getProjectRoot());
      const fullPath = pathResolve(join(rootAbs, relPath));
      if (fullPath !== rootAbs && !fullPath.startsWith(rootAbs + sep)) {
        res.status(400).json({ ok: false, error: "ATTACHMENT_PATH_NOT_ALLOWED" });
        return;
      }
      if (!existsSync(fullPath)) {
        res.status(404).json({ ok: false, error: "FILE_NOT_FOUND" });
        return;
      }
      const buf = readFileSync(fullPath);
      const lower = fullPath.toLowerCase();
      let mime = "application/octet-stream";
      if (lower.endsWith(".png")) mime = "image/png";
      else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
      else if (lower.endsWith(".webp")) mime = "image/webp";

      res.json({
        ok: true,
        path: relPath,
        mime,
        base64: buf.toString("base64"),
        size: buf.length,
      });
    } catch {
      res.status(500).json({ ok: false, error: "ATTACHMENT_READ_FAILED" });
    }
  });

  router.get("/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeHeartbeat = () => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    };
    writeHeartbeat();
    const heartbeatTimer = setInterval(writeHeartbeat, 25000);

    const onClose = () => {
      clearInterval(heartbeatTimer);
      if (!res.writableEnded) res.end();
    };

    ctx.subscribeMobileEvents(res, onClose);

    req.on("close", onClose);
  });

  return {
    router,
    registerPendingBind: (bindId: string, token: string, ttlMs: number) => {
      bindStore.register(bindId, token, ttlMs);
    },
  };
}
