/**
 * Pure Panel UI logic for runtime dispatch-retry (Bus P0).
 * Mirrors semantics in codeflowmu-desktop/panel/index.html — keep in sync when changing rules.
 */

export type DispatchRetryRecordLike = {
  task_id?: string;
  attempt?: number;
  failureCount?: number;
  retryRound?: number;
  nextRetryAt?: number | null;
  decisionRequired?: boolean;
  forceArchived?: boolean;
  adminDecision?: string;
  provider?: string;
  adapter?: string;
  category?: string;
  lastCategory?: string;
  lastError?: string;
};

export type DispatchRetryUiState = "hidden" | "auto" | "waiting" | "force";

export function resolveDispatchRetryUiState(
  rec: DispatchRetryRecordLike | null | undefined,
): DispatchRetryUiState {
  if (!rec) return "hidden";
  const fc = Number(rec.failureCount ?? 0);
  if (!fc && !rec.forceArchived) return "hidden";
  if (rec.forceArchived) return "force";
  if (rec.decisionRequired) return "waiting";
  return "auto";
}

export function shouldShowAdminActions(
  rec: DispatchRetryRecordLike | null | undefined,
): boolean {
  return resolveDispatchRetryUiState(rec) === "waiting";
}

export function dispatchRetryTitle(state: DispatchRetryUiState): string {
  switch (state) {
    case "auto":
      return "自动重试中";
    case "waiting":
      return "等待 ADMIN 决策";
    case "force":
      return "投递已强制归档（admin_force_archive）";
    default:
      return "";
  }
}

/** Human-readable countdown until next auto retry. */
export function formatDispatchRetryCountdown(
  nextRetryAt: number | null | undefined,
  nowMs: number,
): string {
  if (nextRetryAt == null) return "—";
  const n = Number(nextRetryAt);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const diff = n - nowMs;
  if (diff <= 0) return "即将重试";
  const sec = Math.ceil(diff / 1000);
  if (sec < 60) return `${sec} 秒后重试`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min} 分 ${rem} 秒后重试`;
}

export function buildDispatchRetryMetaLines(
  rec: DispatchRetryRecordLike,
  nowMs: number,
): string[] {
  const state = resolveDispatchRetryUiState(rec);
  const lines: string[] = [];
  if (state === "auto") {
    const attempt = rec.attempt != null ? rec.attempt : rec.failureCount;
    lines.push(`attempt: ${String(attempt ?? 0)}`);
  }
  if (rec.provider) lines.push(`provider: ${rec.provider}`);
  if (rec.adapter) lines.push(`adapter: ${rec.adapter}`);
  const cat = rec.category || rec.lastCategory;
  if (cat) lines.push(`category: ${cat}`);
  lines.push(`failureCount: ${String(rec.failureCount ?? 0)}`);
  if (rec.retryRound != null) lines.push(`retryRound: ${String(rec.retryRound)}`);
  if (rec.lastError) lines.push(`lastError: ${rec.lastError}`);
  if (state === "auto" && rec.nextRetryAt != null) {
    lines.push(
      `nextRetryAt: ${formatDispatchRetryCountdown(rec.nextRetryAt, nowMs)}`,
    );
  }
  if (state === "force" && rec.adminDecision) {
    lines.push(`adminDecision: ${rec.adminDecision}`);
  }
  return lines;
}

export function listDecisionsRequired(
  records: DispatchRetryRecordLike[],
): DispatchRetryRecordLike[] {
  return (records || []).filter(
    (r) =>
      r &&
      r.decisionRequired &&
      !r.forceArchived &&
      Number(r.failureCount ?? 0) > 0,
  );
}
