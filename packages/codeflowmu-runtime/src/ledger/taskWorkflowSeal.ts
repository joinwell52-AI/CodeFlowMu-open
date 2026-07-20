import { resolveTaskCurrentBucket } from "../pm/taskCurrentBucket.ts";
import type { LedgerTaskRecord } from "./types.ts";

/** PM review / consolidation must not mutate lifecycle for sealed tasks. */
export function isTaskWorkflowSealedForPmReview(
  task: LedgerTaskRecord | undefined,
): boolean {
  if (!task) return false;
  const bucket = resolveTaskCurrentBucket(task);
  if (bucket === "archive" || bucket === "done") return true;
  return String(task.display_status ?? "").toLowerCase() === "archived";
}
