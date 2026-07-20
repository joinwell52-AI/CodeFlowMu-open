/**
 * Public surface of the review subsystem (Sprint S4).
 *
 * Importers MAY pull from `@codeflowmu/runtime/review` (when path-mapped)
 * or `@codeflowmu/runtime` (top-level barrel — see `src/index.ts`).
 * Either way, only the symbols re-exported here are part of the package's
 * stable v0.1 contract.
 */

export {
  DefaultReviewPolicy,
  ReviewEngine,
  defaultMakeReviewId,
  parseVerdict,
  type ReviewEngineLogger,
  type ReviewEngineOptions,
  type ReviewPolicy,
  type TaskReference,
} from "./ReviewEngine.ts";

export {
  NeedsHumanGate,
  UnsupportedHumanPushSinkError,
  type HumanApprovedSpec,
  type HumanPushRequest,
  type NeedsHumanGateLogger,
  type NeedsHumanGateOptions,
} from "./NeedsHumanGate.ts";

export {
  ReviewWriter,
  renderReviewMarkdown,
  type HumanApproval,
  type ReviewDecision,
  type ReviewSubjectType,
  type ReviewVerdict,
  type ReviewWriterOptions,
} from "./ReviewWriter.ts";

export {
  ReviewWriteError,
  ReviewerNotFoundError,
  VerdictParseError,
} from "../registry/errors.ts";

export {
  resolveReviewEvidence,
  type ReviewEvidenceResolveInput,
  type ReviewEvidenceTimeWindow,
  type EvidenceSummary,
  type EvidenceSummarySession,
  type EvidenceSummaryCommand,
  type EvidenceSummaryDataQuery,
} from "./ReviewEvidenceResolver.ts";

export {
  detectReportClaims,
  evaluateReviewFactGate,
  type FactCheckVerdict,
  type FactCheckReasonCode,
  type ReportClaims,
  type FactCheckResult,
} from "./ReviewFactGate.ts";

export {
  writeFactCheckReview,
  type WriteFactCheckReviewInput,
} from "./writeFactCheckReview.ts";

export {
  resolveReviewLinkedTaskId,
  type ResolveReviewLinkedTaskIdOptions,
} from "./resolveReviewLinkedTaskId.ts";

export {
  humanApprovalApprovedAt,
  isReviewPendingHuman,
  reviewMatchesScope,
} from "./reviewHumanApproval.ts";

export {
  buildReviewGateApprovalCard,
  collectReviewGateRedFlags,
  evaluateReviewGateAutoPass,
  REVIEW_GATE_RED_FLAG_LABELS,
  type ReviewGateApprovalCard,
  type ReviewGateAutoPassResult,
  type ReviewGateBuildInput,
  type ReviewGateRedFlag,
  type ReviewGateRisk,
} from "./reviewGateApprovalCard.ts";

export {
  loadReviewDecisionPolicy,
  saveReviewDecisionPolicy,
  enabledTeamRules,
  renderReviewDecisionPolicyPromptBlock,
  policyFilePath,
  type ReviewDecisionPolicy,
  type PolicyRule,
  type PolicyRuleAction,
  type LoadReviewDecisionPolicyOpts,
} from "./ReviewDecisionPolicyLoader.ts";
