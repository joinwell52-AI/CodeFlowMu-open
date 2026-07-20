import { createHash } from "node:crypto";

import {
  queryPanelRuntimeActions,
  type PanelRuntimeActionRecord,
  type PanelRuntimeActionResult,
} from "../panel-runtime-actions.ts";
import type { ThinkConsoleEvent } from "./mobileThinkConsole.ts";
import { mobileUiText, type MobileUiLang } from "./mobileUiLocale.ts";

function normalizedTaskId(value: unknown): string {
  return String(value ?? "")
    .replace(/\.md$/i, "")
    .replace(/-(?:ADMIN|PM|DEV|QA|OPS)-to-(?:ADMIN|PM|DEV|QA|OPS)$/i, "")
    .trim();
}

function joinSummaryParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

function mapRuntimeStatus(
  result: PanelRuntimeActionResult,
): "done" | "running" | "error" {
  if (result === "failed") return "error";
  if (result === "pending" || result === "delayed") return "running";
  return "done";
}

function localizeRuntimeField(value: string, lang: MobileUiLang): string {
  if (lang !== "en") return value;
  const exact: Record<string, string> = {
    "读取代码上下文": "Read code context",
    "已读取": "Read",
    "已写入": "Written",
    "已保存": "Saved",
    "已完成": "Completed",
    "执行成功": "Succeeded",
    "执行失败": "Failed",
    "等待执行": "Waiting to run",
  };
  return exact[value.trim()] ?? value;
}

function formatAgentWorkSummary(rec: PanelRuntimeActionRecord, lang: MobileUiLang): string {
  const l = (zh: string, en: string) => mobileUiText(lang, zh, en);
  const act = rec.action;
  const operator = rec.operator || rec.target_agent || "Agent";
  const obj = rec.object_short || "";
  const intent = localizeRuntimeField(rec.intent || "", lang);
  const res = localizeRuntimeField(
    rec.result_summary ||
    (rec.result === "failed" ? l("失败", "Failed") : rec.result === "skipped" ? l("跳过", "Skipped") : l("成功", "Succeeded")),
    lang,
  );

  let headline = `${operator} ${rec.op_type || l("操作", "action")}`;
  if (act === "agent_command") {
    headline = `${operator} ${/test|vitest|jest/i.test(obj) ? l("运行测试", "ran tests") : l("运行命令", "ran a command")}`;
  } else if (act === "agent_report") {
    headline = `${operator} ${l("写回执", "wrote a report")}`;
  } else if (act === "agent_task") {
    headline = `${operator} ${l("创建任务", "created a task")}`;
  } else if (act === "agent_read") {
    headline = `${operator} ${l("读取", "read")}${obj ? ` ${obj.split("/").pop()}` : l("文件", " a file")}`;
  } else if (obj && /panel\/index\.html/i.test(obj)) {
    headline = `${operator} ${l("修改 Panel 页面", "edited the Panel page")}`;
  } else if (obj) {
    headline = `${operator} ${rec.op_type || l("修改", "edited")} ${obj.split("/").pop() || obj}`;
  }

  const objLabel =
    act === "agent_command" ? l("命令", "Command") : l("文件", "File");
  return joinSummaryParts([
    headline,
    obj ? `${objLabel}: ${obj}` : "",
    intent ? `${l("目的", "Purpose")}: ${intent}` : "",
    res ? `${l("结果", "Result")}: ${res}` : "",
  ]);
}

/** Single-line green stream text aligned with PC runtime-actions tab semantics. */
export function formatRuntimeActionSummary(
  rec: PanelRuntimeActionRecord,
  lang: MobileUiLang = "zh",
): string {
  const l = (zh: string, en: string) => mobileUiText(lang, zh, en);
  const act = rec.action || "unknown";
  const result = rec.result || "ok";
  const agent = rec.target_agent || "";
  const task = rec.target_task || rec.message || "";
  const reason = rec.reason || "";
  const detail = rec.detail || "";

  if (
    act === "agent_edit" ||
    act === "agent_write" ||
    act === "agent_read" ||
    act === "agent_command" ||
    act === "agent_report" ||
    act === "agent_task" ||
    act === "agent_query"
  ) {
    return formatAgentWorkSummary(rec, lang);
  }

  if (act === "approve") {
    return joinSummaryParts([`${l("已审批", "Approved")}: ${task}`, detail || l("任务已通过验收", "The task passed review")]);
  }
  if (act === "submit_review") {
    return joinSummaryParts([
      `${l("已提交验收", "Submitted for review")}: ${task}`,
      detail || l("Agent 已提交回执，等待审批", "The agent submitted a report and is awaiting approval"),
    ]);
  }
  if (act === "archive") {
    return joinSummaryParts([`${l("已归档", "Archived")}: ${task}`, detail || l("任务已移入归档", "The task moved to archive")]);
  }
  if (act === "reject") {
    return joinSummaryParts([
      `${l("审批拒绝", "Rejected")}: ${task}`,
      reason || detail || l("任务被退回 active", "The task returned to active"),
    ]);
  }
  if (act === "reopen") {
    return joinSummaryParts([`${l("重开任务", "Reopened task")}: ${task}`, reason || detail]);
  }
  if (act === "report_written") {
    return joinSummaryParts([
      `${agent || rec.operator || "Agent"} ${l("写回执", "wrote a report")}`,
      detail ? `${l("回执", "Report")}: ${detail}` : "",
    ]);
  }
  if (act === "session_started") {
    return joinSummaryParts([
      agent ? `${agent} ${l("已开始执行", "started")}` : l("会话已开始", "Session started"),
      task ? `${l("任务", "Task")} ${task} ${l("正在执行", "is running")}` : "",
    ]);
  }
  if (act === "dispatch" || act === "task_held") {
    if (result === "ok") {
      const to = rec.target_agent || "";
      return joinSummaryParts([
        l("任务已派发", "Task dispatched"),
        to ? `${l("已派给", "Assigned to")} ${to}` : task,
        detail,
      ]);
    }
    if (result === "skipped") {
      return joinSummaryParts([
        l("等待前置任务", "Waiting for prerequisite tasks"),
        reason || detail || l("依赖未完成，暂不启动 Agent", "Dependencies are incomplete; the agent will not start yet"),
      ]);
    }
  }
  if (act === "wake" || act === "recover") {
    if (result === "ok") {
      return joinSummaryParts([
        agent ? `${l("已唤醒", "Awakened")} ${agent}` : l("已唤醒并执行", "Agent awakened and running"),
        detail || reason,
      ]);
    }
    if (result === "skipped") {
      return joinSummaryParts([l("唤醒被跳过", "Wake skipped"), reason || detail]);
    }
    if (result === "failed") {
      return joinSummaryParts([l("唤醒失败", "Wake failed"), reason || detail]);
    }
    if (result === "delayed") {
      return joinSummaryParts([
        agent ? `${l("唤醒延迟", "Wake delayed")}: ${agent}` : l("唤醒延迟", "Wake delayed"),
        l("系统将自动重试", "The system will retry automatically"),
      ]);
    }
  }
  if (act === "swap_ai") {
    return joinSummaryParts([
      result === "ok" ? `${l("已换 AI", "AI changed")}: ${agent}` : `${l("换 AI 失败", "AI change failed")}: ${agent}`,
      detail || reason,
    ]);
  }
  if (act === "change_model") {
    return joinSummaryParts([
      `${l("已更改模型", "Model changed")}: ${agent || rec.operator}`,
      rec.model_id ? `${l("模型", "Model")} ${rec.model_id}` : detail,
    ]);
  }
  if (act === "nudge" || act === "urge") {
    if (result === "ok") {
      return joinSummaryParts([`${l("已催单", "Nudged")}: ${agent || task}`, detail]);
    }
    if (result === "skipped") {
      return joinSummaryParts([`${l("催单已跳过", "Nudge skipped")}: ${agent || task}`, reason || detail]);
    }
    return joinSummaryParts([`${l("催单失败", "Nudge failed")}: ${agent || task}`, reason || detail]);
  }

  return joinSummaryParts([
    `${rec.operator || "ADMIN"} ${act}`,
    task,
    detail,
    reason,
  ]);
}

function runtimeEventId(rec: PanelRuntimeActionRecord): string {
  const key = `${rec.at}:${rec.action}:${rec.operator}:${rec.target_task ?? ""}:${rec.detail ?? ""}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return `runtime-action-${hash}`;
}

function recordToEvent(rec: PanelRuntimeActionRecord, lang: MobileUiLang): ThinkConsoleEvent {
  const agent = rec.target_agent || rec.operator || "ADMIN";
  return {
    id: runtimeEventId(rec),
    at: rec.at,
    agent,
    taskId: normalizedTaskId(rec.target_task),
    source: "runtime_action",
    consoleKind: "runtime",
    kind: "RUNTIME",
    status: mapRuntimeStatus(rec.result),
    summary: formatRuntimeActionSummary(rec, lang),
  };
}

/** PC runtime-actions tab data as mobile green single-line stream events. */
export function readRuntimeActionStreamEvents(
  projectRoot: string,
  limit = 100,
  lang: MobileUiLang = "zh",
): ThinkConsoleEvent[] {
  const cap = Math.min(Math.max(limit, 1), 50);
  const records = queryPanelRuntimeActions(projectRoot, cap);
  return records.map((record) => recordToEvent(record, lang));
}
