/**
 * Record report.write when ReportWatcher detects a new REPORT on disk.
 */

import { isAbsolute, relative, resolve } from "node:path";
import {
  inferReportTaskIdFromBody,
  inferReportTaskIdFromFilename,
  parseMarkdownFrontmatter,
  strField,
} from "../ledger/frontmatter.ts";
import { roleFromAgentId } from "../_internal/report-reconcile.ts";
import { appendActionEvidence, type ActionEvidenceWriteInput } from "./ActionEvidenceLogger.ts";

const RECORDED_REPORTS = new Set<string>();
const MAX_DEDUPE = 10_000;

export type MaybeRecordReportWriteActionInput = {
  projectRoot: string;
  filepath: string;
  filename: string;
  senderRole?: string;
  content: string;
  detected_at?: string;
};

function rememberReport(key: string): boolean {
  if (RECORDED_REPORTS.has(key)) return false;
  RECORDED_REPORTS.add(key);
  if (RECORDED_REPORTS.size > MAX_DEDUPE) {
    const first = RECORDED_REPORTS.values().next().value;
    if (first) RECORDED_REPORTS.delete(first);
  }
  return true;
}

export function resetReportWriteActionDedupeForTests(): void {
  RECORDED_REPORTS.clear();
}

function normalizePath(projectRoot: string, filepath: string): string {
  try {
    if (isAbsolute(filepath)) {
      return relative(resolve(projectRoot), resolve(filepath)).replace(/\\/g, "/");
    }
  } catch {
    /* keep */
  }
  return filepath.replace(/\\/g, "/");
}

/**
 * Append a report.write action when a REPORT file lands on disk.
 */
export function maybeRecordReportWriteAction(input: MaybeRecordReportWriteActionInput): void {
  const filepath = input.filepath.trim();
  const filename = input.filename.trim();
  if (!filepath || !filename) return;

  const dedupeKey = `${filepath}::${filename}`;
  if (!rememberReport(dedupeKey)) return;

  const fm = parseMarkdownFrontmatter(input.content);
  const reportId = filename.replace(/\.md$/i, "");
  const taskId =
    strField(fm, "task_id") ||
    inferReportTaskIdFromBody(input.content) ||
    inferReportTaskIdFromFilename(filename) ||
    "";
  const sessionId = strField(fm, "session_id") || "";
  const threadKey = strField(fm, "thread_key") || undefined;
  const sender = strField(fm, "sender") || input.senderRole || "";
  const role = sender ? sender.toUpperCase() : roleFromAgentId(sender || "UNKNOWN");

  const record: ActionEvidenceWriteInput = {
    event_type: "report.write",
    at: input.detected_at ?? new Date().toISOString(),
    task_id: taskId,
    session_id: sessionId,
    agent_id: sender || role,
    role,
    status: "success",
    thread_key: threadKey,
    report_id: reportId,
    path: normalizePath(input.projectRoot, filepath),
  };

  appendActionEvidence(input.projectRoot, record);
}
