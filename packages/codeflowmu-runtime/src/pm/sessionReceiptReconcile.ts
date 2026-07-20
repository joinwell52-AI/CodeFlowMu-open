/**
 * Session / REPORT reconcile — four queue states for Panel bottom bar.
 *
 * running | waiting_report | recoverable | failed
 */

export type SessionReceiptQueueState =
  | "running"
  | "waiting_report"
  | "recoverable"
  | "failed"
  | "none";

export const RECOVERABLE_FAILURE_CODES = new Set([
  "TURN_LIMIT",
  "TRANSIENT_SDK_DELAYED",
  "TIMEOUT",
  "ABORTED",
  "SOCKET_DISCONNECTED",
  "SOCKET_DISCONNECT",
]);

export interface SessionFailureRecoverHints {
  failureCategory?: string | null;
  isFirstTurnAbort?: boolean;
}

export function isFirstTurnAbortFailure(
  hints?: SessionFailureRecoverHints,
): boolean {
  const category = String(hints?.failureCategory ?? "").trim();
  return (
    hints?.isFirstTurnAbort === true ||
    category === "cursor_sdk_first_turn_abort"
  );
}

export function isRecoverableSessionFailure(
  failureCode: string | null | undefined,
  status: string | null | undefined,
  hints?: SessionFailureRecoverHints,
): boolean {
  const code = String(failureCode ?? "").trim().toUpperCase();
  if (code && RECOVERABLE_FAILURE_CODES.has(code)) return true;
  if (isFirstTurnAbortFailure(hints)) return true;
  const st = String(status ?? "").trim().toLowerCase();
  return st === "timeout" || st === "aborted";
}

export interface SessionEventSummary {
  lastSessionId: string | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastSessionStatus: string | null;
  lastFailureCode: string | null;
  lastFailureCategory: string | null;
  isFirstTurnAbort: boolean;
  reportWrittenOnEnd: boolean;
  /** Latest session started but no matching ended for same session_id. */
  sessionUnsettled: boolean;
  /** Agent still marked running in registry. */
  agentRunning: boolean;
}

export interface SessionReceiptReconcileInput {
  summary: SessionEventSummary;
  hasReportOnDisk: boolean;
  latestReportStatus: string;
  workerFailedPersisted: boolean;
}

export interface SessionReceiptReconcileResult {
  queueState: SessionReceiptQueueState;
  reasonCode: string;
  suggestedAction: "wait" | "recover" | "review_report" | null;
  recoverable: boolean;
}

const PASS_REPORT = new Set(["done", "completed", "pass", "passed"]);
const FAIL_REPORT = new Set(["failed", "blocked", "cancelled", "force_archived"]);

export function reconcileSessionReceiptQueue(
  input: SessionReceiptReconcileInput,
): SessionReceiptReconcileResult {
  const { summary, hasReportOnDisk, latestReportStatus, workerFailedPersisted } =
    input;
  const latest = String(latestReportStatus ?? "").toLowerCase();

  if (FAIL_REPORT.has(latest)) {
    return {
      queueState: "failed",
      reasonCode: "report_terminal",
      suggestedAction: "review_report",
      recoverable: false,
    };
  }

  if (hasReportOnDisk || PASS_REPORT.has(latest)) {
    return {
      queueState: "none",
      reasonCode: "report_done",
      suggestedAction: "review_report",
      recoverable: false,
    };
  }

  if (summary.agentRunning) {
    return {
      queueState: "running",
      reasonCode: "agent_running",
      suggestedAction: "wait",
      recoverable: false,
    };
  }

  if (summary.sessionUnsettled) {
    return {
      queueState: "recoverable",
      reasonCode: "session_unsettled",
      suggestedAction: "recover",
      recoverable: true,
    };
  }

  const endedFailed =
    summary.lastSessionStatus === "failed" ||
    summary.lastSessionStatus === "timeout";
  const recoverable =
    endedFailed &&
    !summary.reportWrittenOnEnd &&
    isRecoverableSessionFailure(
      summary.lastFailureCode,
      summary.lastSessionStatus,
      {
        failureCategory: summary.lastFailureCategory,
        isFirstTurnAbort: summary.isFirstTurnAbort,
      },
    );

  if (recoverable) {
    return {
      queueState: "recoverable",
      reasonCode: summary.lastFailureCode ?? "session_failed_recoverable",
      suggestedAction: "recover",
      recoverable: true,
    };
  }

  if (
    endedFailed &&
    !summary.reportWrittenOnEnd &&
    !recoverable
  ) {
    return {
      queueState: "failed",
      reasonCode: summary.lastFailureCode ?? "session_failed",
      suggestedAction: null,
      recoverable: false,
    };
  }

  if (workerFailedPersisted && !recoverable) {
    return {
      queueState: "failed",
      reasonCode: "worker_failed_persisted",
      suggestedAction: null,
      recoverable: false,
    };
  }

  if (summary.lastEndedAt && !summary.reportWrittenOnEnd) {
    return {
      queueState: "waiting_report",
      reasonCode: "session_ended_no_report",
      suggestedAction: "wait",
      recoverable: false,
    };
  }

  return {
    queueState: "waiting_report",
    reasonCode: "pending_worker_report",
    suggestedAction: "wait",
    recoverable: false,
  };
}
