/**
 * Report page UI helpers — intake toggle loop + unlinked group hints (TASK-20260611-011).
 */
import { taskIdFromFilename, type ThreadRow } from "./panel-task-thread-visibility.ts";

export const RP_INTAKE_TOGGLE_MAX_ROWS = 500;

export function toggleRpIntakeRowDisplay(current: string): "none" | "table-row" {
  return current === "none" ? "table-row" : "none";
}

/**
 * Mirror inline `toggleRpIntakeRows` sibling walk.
 * Buggy advance (never decrement remaining) simulates `b=el.nextElementSibling` stuck loop.
 */
export function countRpIntakeToggleSteps(
  rowCount: number,
  opts?: { buggyAdvance?: boolean; max?: number },
): number {
  const max = opts?.max ?? RP_INTAKE_TOGGLE_MAX_ROWS;
  let steps = 0;
  let remaining = rowCount;
  while (remaining > 0 && steps < max) {
    steps++;
    if (!opts?.buggyAdvance) remaining--;
  }
  return steps;
}

/** Ledger thread still groups reports when root/report_ids exist but task files absent from pool. */
export function isLedgerThreadDetachedForPool(
  row: ThreadRow | null | undefined,
  membersInPool: number,
): boolean {
  if (!row) return false;
  const tk = String(row.thread_key ?? "");
  if (tk.startsWith("_orphan_REPORT")) return true;
  if (tk.startsWith("_orphan_") && !taskIdFromFilename(row.root_task_id ?? "")) {
    return true;
  }
  const rootId = taskIdFromFilename(row.root_task_id ?? "");
  if (rootId) return false;
  if ((row.report_ids ?? []).length && tk && !tk.startsWith("_orphan")) return false;
  const hasLedgerTasks = Boolean((row.task_ids ?? []).length);
  if (!hasLedgerTasks) return false;
  return membersInPool === 0;
}

export function ledgerThreadLabelForTaskId(
  taskId: string,
  ledgerRows: ThreadRow[],
): string | null {
  const id = taskIdFromFilename(taskId) || taskId;
  if (!id || id === "UNLINKED") return null;
  for (const row of ledgerRows ?? []) {
    if (!row || row.thread_key === "_orphan_") continue;
    if (taskIdFromFilename(row.root_task_id ?? "") === id) {
      return String(row.thread_key ?? "").trim() || null;
    }
    if (
      (row.task_ids ?? []).some((t) => taskIdFromFilename(String(t)) === id)
    ) {
      return String(row.thread_key ?? "").trim() || null;
    }
  }
  return null;
}

export function reportGroupFallbackHint(
  fallbackId: string,
  ledgerRows: ThreadRow[],
): { title: string; subtitle: string } {
  const fb = String(fallbackId || "UNLINKED");
  const threadLbl = ledgerThreadLabelForTaskId(fb, ledgerRows);
  const title = `REPORT 指向 ${fb}，但任务文件不在当前 panel 加载池`;
  const subtitle = threadLbl
    ? `ledger 线程 ${threadLbl}（可能已 history 深归档、ledger 漂移或仅 REPORT 残留）`
    : "可能已 history 深归档、ledger 漂移或仅 REPORT 残留";
  return { title, subtitle };
}
