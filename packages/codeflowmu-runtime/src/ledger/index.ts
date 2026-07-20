import { resolveLedgerLayout } from "./paths.ts";
import { ReportResolver } from "./ReportResolver.ts";

export { ensureLedgerLayout, resolveLedgerLayout, diagnosticsJsonlPath } from "./paths.ts";
export { LedgerBuilder, type LedgerBuilderOpts, type LedgerRebuildResult } from "./LedgerBuilder.ts";
export {
  scheduleLedgerRebuild,
  flushScheduledLedgerRebuild,
  resetScheduleLedgerRebuildForTests,
} from "./scheduleLedgerRebuild.ts";
export {
  hasProbeBootstrapMarkers,
  isProbeBootstrapLedgerTask,
} from "./probeBootstrapTask.ts";
export {
  reconcileTaskDiagnostics,
  isDiagnosticVisible,
  readLedgerTasksJsonl,
  readDiagnosticsJsonl,
  writeDiagnosticsJsonl,
  parseDiagnosticsJsonl,
  serializeDiagnosticsJsonl,
} from "./reconcileDiagnostics.ts";
export { taskSequenceKey, preferTaskId, indexLedgerTasksBySequenceKey } from "./taskIdMatch.ts";
export { ReportResolver, type ReportResolverOpts } from "./ReportResolver.ts";
export {
  reportReferencesTask,
  isChildSettledForRoot,
  areAllChildrenSettledForRoot,
} from "./lifecycleProjection.ts";
export {
  locateHotPathTask,
  approveHotPathTaskReview,
  rejectHotPathTaskReview,
  archiveHotPathTask,
  type HotPathReviewOpts,
} from "./hotPathTaskLifecycle.ts";
export {
  locateProjectedPmReviewLifecycleTask,
  approveProjectedLifecycleTaskReview,
  rejectProjectedLifecycleTaskReview,
  isTaskPendingPmReviewInLedger,
  findDoneReportIdForLifecycleTask,
  type ProjectedLifecycleReviewOpts,
} from "./projectedLifecycleTaskLifecycle.ts";
export {
  settleVirtualPmBranchHotPathTask,
  reconcileVirtualPmBranchArchives,
  VIRTUAL_PM_ACTOR,
  VIRTUAL_PM_AUTO_REVIEW_NOTE,
  VIRTUAL_PM_AUTO_ARCHIVE_REASON,
  type VirtualPmBranchSettleResult,
} from "./virtualPmBranchSettle.ts";
export {
  isVirtualPmSettlementNote,
  isTaskSettledClosed,
  isTaskReopenedForReworkFromLedger,
  type TaskReworkLedgerFields,
} from "./taskReworkSemantics.ts";

export async function resolveReportAfterWrite(
  projectRoot: string,
  reportFilePath: string,
  opts?: Pick<import("./ReportResolver.ts").ReportResolverOpts, "logger" | "panelEvents">,
): Promise<void> {
  const layout = resolveLedgerLayout(projectRoot);
  const resolver = new ReportResolver({
    projectRoot,
    lifecycleRoot: layout.lifecycleRoot,
    ...opts,
  });
  await resolver.resolve(reportFilePath);
}
export { parseMarkdownFrontmatter, strField, listField } from "./frontmatter.ts";
export {
  verifyThread,
  verifyRegression237,
  type LedgerEntityInspection,
  type LedgerRegressionVerifyResult,
  type LedgerThreadVerifyResult,
} from "./LedgerVerifier.ts";
export type {
  LedgerTaskRecord,
  LedgerReportRecord,
  LedgerThreadRecord,
  LedgerLayout,
  LedgerLifecycleBucket,
  LedgerOrphanRecord,
  DiagnosticKind,
  DiagnosticRecord,
  DiagnosticSeverity,
  ReconcileResult,
  ReconcileSummary,
} from "./types.ts";
export {
  selectCanonicalPmFinalReport,
  isAutoPmFinalSummaryReport,
  isPmFinalReportCandidate,
  applyCanonicalPmFinalReportKinds,
  type SelectCanonicalPmFinalReportOpts,
  type SelectCanonicalPmFinalReportResult,
} from "./selectCanonicalPmFinalReport.ts";
