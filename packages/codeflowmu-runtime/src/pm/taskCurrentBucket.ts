/**
 * Resolve lifecycle bucket from disk truth (_lifecycle path / physical_scope),
 * not ledger bucket alone.
 */

export const LIFECYCLE_STAGE_RE =
  /[/\\]_lifecycle[/\\](inbox|active|review|done|archive)(?:[/\\]|$)/i;

export type TaskBucketInput = {
  bucket?: string;
  path?: string;
  physical_scope?: string;
};

export function resolveTaskCurrentBucket(input: TaskBucketInput): string {
  const ps = String(input.physical_scope ?? "").toLowerCase().trim();
  if (ps) {
    if (/^(inbox|active|review|done|archive)$/.test(ps)) return ps;
    const fromPhysical = (ps.match(LIFECYCLE_STAGE_RE) || [])[1];
    if (fromPhysical) return String(fromPhysical).toLowerCase();
  }
  const fromPath = (String(input.path ?? "").match(LIFECYCLE_STAGE_RE) || [])[1];
  if (fromPath) return String(fromPath).toLowerCase();
  const bucket = String(input.bucket ?? "").toLowerCase();
  if (bucket === "tasks") return "active";
  return bucket;
}

/** PM downstream receipt waiting applies to trusted inbox plus active/review. */
export function isWorkerReceiptWaitingBucket(bucket: string): boolean {
  const b = String(bucket ?? "").toLowerCase();
  return b === "inbox" || b === "active" || b === "review";
}

export {
  shouldShowThreadOnTeamDynamics,
  type ShouldShowThreadOpts,
  type TeamDynamicsTask,
  aggregateLifecycleCountsFromPhysical,
  collectPmOpenMainlineTasks,
  listExecutingEvidence,
  isAdminAwaitingReviewScenario,
  hasOpenCurrentBucketTask,
  hasPmFinalReportForRoot,
} from "./teamDynamics.ts";
