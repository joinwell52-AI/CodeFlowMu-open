import { roleFromAgentId } from "@codeflowmu/runtime";

import { getMobileEventStore } from "./mobileEventStore.ts";
import { isChatActivityTaskId, type RawEvent } from "./mobileActivityTypes.ts";
import { sanitizeBasename } from "./operationCompressor.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeAgent(agentId: string | undefined, fallback?: string): string {
  const raw = String(agentId ?? fallback ?? "").trim();
  if (!raw) return "DEV";
  const role = roleFromAgentId(raw);
  return role || raw.toUpperCase();
}

function ingest(projectRoot: string, raw: RawEvent): void {
  if (!projectRoot || !raw.taskId) return;
  if (isChatActivityTaskId(raw.taskId)) return;
  getMobileEventStore(projectRoot).ingest(raw);
}

export function ingestMobileThinking(
  projectRoot: string,
  payload: {
    task_id?: string;
    agent_id?: string;
    session_id?: string;
    text?: string;
    message?: string;
    content?: string;
  },
): void {
  const taskId = String(payload.task_id ?? "").trim();
  if (!taskId) return;
  ingest(projectRoot, {
    id: makeId("think"),
    taskId,
    agent: normalizeAgent(payload.agent_id),
    type: "thinking",
    text: String(payload.text ?? payload.message ?? payload.content ?? "").slice(0, 240),
    status: "running",
    at: nowIso(),
  });
}

export function ingestMobileToolCall(
  projectRoot: string,
  payload: {
    task_id?: string;
    agent_id?: string;
    tool?: string;
    status?: string;
    target?: string;
    path?: string;
    command?: string;
  },
): void {
  const taskId = String(payload.task_id ?? "").trim();
  if (!taskId) return;
  const tool = String(payload.tool ?? "").toLowerCase();
  const statusRaw = String(payload.status ?? "running").toLowerCase();
  const status =
    statusRaw === "failed" || statusRaw === "error"
      ? "failed"
      : statusRaw === "done" || statusRaw === "success" || statusRaw === "completed"
        ? "done"
        : "running";

  if (tool === "write_report" || tool === "write_report_file") {
    ingest(projectRoot, {
      id: makeId("report"),
      taskId,
      agent: normalizeAgent(payload.agent_id),
      type: "report",
      tool,
      text: statusRaw,
      status,
      at: nowIso(),
    });
    return;
  }

  const target = payload.target || payload.path || payload.command || "";
  ingest(projectRoot, {
    id: makeId("tool"),
    taskId,
    agent: normalizeAgent(payload.agent_id),
    type: "tool_call",
    tool,
    target: target ? sanitizeBasename(String(target)) : undefined,
    text: payload.command ? "shell" : undefined,
    status,
    at: nowIso(),
  });
}

export function ingestMobileSse(
  projectRoot: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  const taskId = String(payload.task_id ?? payload.taskId ?? "").trim();
  if (!taskId || isChatActivityTaskId(taskId)) return;
  const agent = normalizeAgent(
    String(payload.agent_id ?? payload.agentId ?? payload.role ?? ""),
    String(payload.reporter ?? payload.sender ?? ""),
  );
  const type = String(eventType ?? "").toLowerCase();
  if (
    type.includes("chat_message") ||
    type === "codeflowmu.chat" ||
    type.endsWith(".chat.send")
  ) {
    return;
  }

  if (type === "codeflowmu.lifecycle.task_to_review" || type.includes("submit_review")) {
    ingest(projectRoot, {
      id: makeId("move"),
      taskId,
      agent,
      type: "task_move",
      text: "submit_review",
      at: nowIso(),
    });
    return;
  }
  if (type === "codeflowmu.lifecycle.review_to_done" || type.includes("approve_review")) {
    ingest(projectRoot, {
      id: makeId("move"),
      taskId,
      agent: agent || "ADMIN",
      type: "task_move",
      text: "approve_review",
      at: nowIso(),
    });
    return;
  }
  if (type === "codeflowmu.lifecycle.review_to_active" || type.includes("reject_review")) {
    ingest(projectRoot, {
      id: makeId("move"),
      taskId,
      agent: agent || "ADMIN",
      type: "task_move",
      text: "reject_review",
      at: nowIso(),
    });
    return;
  }
  if (type === "codeflowmu.lifecycle.done_to_archive" || type.includes("archive")) {
    ingest(projectRoot, {
      id: makeId("move"),
      taskId,
      agent,
      type: "task_move",
      text: "done",
      at: nowIso(),
    });
    return;
  }
  if (type === "codeflowmu.report_detected") {
    const st = String(payload.status ?? "done").toLowerCase();
    ingest(projectRoot, {
      id: makeId("report"),
      taskId,
      agent: normalizeAgent(String(payload.reporter ?? payload.agent_id ?? ""), agent),
      type: "report",
      text: st,
      status: st.includes("fail") ? "failed" : "done",
      at: nowIso(),
    });
    return;
  }
  if (type === "codeflowmu.task_dispatched" || type.includes("claim")) {
    ingest(projectRoot, {
      id: makeId("move"),
      taskId,
      agent,
      type: "task_move",
      text: "claim",
      at: nowIso(),
    });
    return;
  }
  if (type.startsWith("wake_agent.")) {
    const reason = String(payload.reason ?? payload.code ?? type).toLowerCase();
    if (
      reason.includes("wake_throttled") ||
      reason.includes("sdk_cooldown") ||
      reason.includes("circuit") ||
      type.includes("failed")
    ) {
      ingest(projectRoot, {
        id: makeId("warn"),
        taskId,
        agent,
        type: type.includes("failed") ? "error" : "warning",
        text: reason,
        at: nowIso(),
      });
    } else if (type.includes("skipped") || type.includes("waiting")) {
      ingest(projectRoot, {
        id: makeId("wait"),
        taskId,
        agent,
        type: "wait",
        text: String(payload.reason ?? "waiting"),
        at: nowIso(),
      });
    }
    return;
  }
  if (type === "codeflowmu.failure" || type.includes("stale_busy") || type.includes("worker_failed")) {
    ingest(projectRoot, {
      id: makeId("err"),
      taskId,
      agent,
      type: "error",
      text: String(payload.reason ?? payload.code ?? type),
      status: "failed",
      at: nowIso(),
    });
  }
}
