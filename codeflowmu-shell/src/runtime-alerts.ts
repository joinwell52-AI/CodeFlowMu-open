/**
 * Runtime Alert Center — read-only HTTP surface + SSE ingest (design 2026-06-05).
 * Distinct from FCoP GAL and from GET /api/v2/health (machine metrics).
 */
import type { Express, Request, Response } from "express";
import {
  runtimeAlertManager,
  CATEGORY_LABELS,
  isTransientSdkError,
} from "@codeflowmu/runtime";

const INGEST_SSE_TYPES = new Set([
  "codeflow.failure",
  "codeflowmu.failure",
  "codeflowmu.failure_recorded",
  "codeflowmu.sdk.cooldown",
  "codeflowmu.lifecycle.root_review_blocked",
  "wake_agent.skipped",
  "wake_agent.failed",
  "wake_agent.delayed",
  "transient_sdk_error",
]);

function shouldIngestSse(type: string): boolean {
  if (INGEST_SSE_TYPES.has(type)) return true;
  if (type.includes("failure")) return true;
  return false;
}

/** Feed runtime alert manager from Panel SSE fan-out (no wake / lifecycle side effects). */
export function ingestRuntimeAlertFromSse(
  type: string,
  payload: Record<string, unknown>,
): void {
  if (type === "codeflowmu.sdk.cooldown") {
    const active = payload.active === true;
    const until = Number(payload.until_ms ?? payload.until ?? 0);
    const reason = String(payload.reason ?? "");
    if (active && until > Date.now()) {
      runtimeAlertManager.setSdkCooldown(until, reason);
    } else {
      runtimeAlertManager.clearSdkCooldown();
    }
    return;
  }

  if (type === "codeflowmu.lifecycle.root_review_blocked") {
    const rootId = String(payload.root_task_id ?? "");
    const childSettled = payload.child_tasks_settled === true;
    runtimeAlertManager.ingest({
      code: childSettled ? "ADMIN_PENDING_REVIEW" : "LIFECYCLE_BLOCKED",
      category: "lifecycle",
      severity: childSettled ? "P2" : "P1",
      title: childSettled ? "待 ADMIN 验收" : "生命周期阻塞",
      message: rootId
        ? childSettled
          ? `子任务已结案，根任务 ${rootId} 待 ADMIN 验收（PM final 已就绪或待提交）`
          : `子任务未完成，根任务 ${rootId} 仍在 review`
        : childSettled
          ? "根任务待 ADMIN 验收"
          : "子任务未完成，根任务无法归档",
      affected_task: rootId,
      status: "active",
    });
    return;
  }

  if (!shouldIngestSse(type)) return;

  const msg = String(
    payload.message ?? payload.description ?? payload.error ?? "",
  ).trim();
  if (payload.transient_sdk_error === true || (msg && isTransientSdkError(msg))) {
    return;
  }

  runtimeAlertManager.ingestFromEvent({
    event_type: type,
    agent_id: String(payload.agent_id ?? payload.agentId ?? ""),
    message: msg,
    description: String(payload.description ?? ""),
    error: String(payload.error ?? ""),
    task_id: String(payload.task_id ?? payload.taskId ?? payload.filename ?? ""),
    failure_type: String(payload.failure_type ?? payload.failureType ?? type),
    severity: String(payload.severity ?? ""),
    reason: String(payload.reason ?? ""),
    transient_sdk_error: payload.transient_sdk_error === true,
    payload,
  });
}

export function registerRuntimeAlertRoutes(app: Express): void {
  app.get("/api/v2/runtime/alerts", (req: Request, res: Response) => {
    const status = String(req.query.status ?? "active");
    const groupBy = req.query.group_by !== "false";
    const snap = runtimeAlertManager.getSnapshot({ groupByCategory: groupBy });
    let active = snap.active;
    if (status === "active") {
      active = active.filter((a) => a.status !== "resolved");
    }
    res.json({
      generated_at: snap.generated_at,
      overall_status: snap.overall_status,
      active,
      grouped_by_category: snap.grouped_by_category,
      cooldown: snap.cooldown,
      banner: snap.banner,
      category_labels: CATEGORY_LABELS,
    });
  });

  app.get("/api/v2/runtime/health", (_req: Request, res: Response) => {
    const snap = runtimeAlertManager.getSnapshot({ groupByCategory: true });
    const p0_toast = snap.active
      .filter((a) => runtimeAlertManager.shouldShowP0Toast(a))
      .map((a) => ({
        alert_key: a.alert_key,
        title: a.title,
        message: a.message,
        code: a.code,
      }));
    res.json({
      ok: true,
      service: "codeflowmu-runtime-alerts",
      overall_status: snap.overall_status,
      cooldown: snap.cooldown,
      banner: snap.banner,
      p0_toast,
      category_labels: CATEGORY_LABELS,
      active_count: snap.active.length,
    });
  });

  app.post("/api/v2/runtime/alerts/resolve", (req: Request, res: Response) => {
    const all = req.body?.all === true;
    if (all) {
      const resolved = runtimeAlertManager.resolveAll();
      res.json({ ok: true, resolved });
      return;
    }
    const alertKey = String(req.body?.alert_key ?? "").trim();
    if (!alertKey) {
      res.status(400).json({ ok: false, error: "alert_key is required" });
      return;
    }
    const resolved = runtimeAlertManager.resolve(alertKey);
    res.json({ ok: true, resolved: resolved ? 1 : 0 });
  });
}
