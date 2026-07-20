/**
 * Parse QA worker REPORT body/status for PM review_check acceptance gate.
 * Blocks virtual-PM auto approve when frontmatter says done but body says FAIL.
 */

export type QaAcceptanceVerdict = "pass" | "blocked" | "fail" | "unknown";

export type QaAcceptanceEvaluation = {
  verdict: QaAcceptanceVerdict;
  reason: string;
  /**
   * When true, the QA worker task itself did not complete and reviewCheck
   * must keep that worker branch open. A completed QA run may legitimately
   * return verdict=fail: that closes the QA task while keeping the product
   * root blocked until PM creates the next report-driven task.
   */
  blocksReview: boolean;
};

function normalizeStatus(status: string | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

/** True when ledger/filename indicates a QA→PM worker report. */
export function isQaWorkerReportToPm(
  sender: string | undefined,
  recipient: string | undefined,
): boolean {
  return (
    String(sender ?? "").trim().toUpperCase() === "QA" &&
    String(recipient ?? "").trim().toUpperCase() === "PM"
  );
}

/**
 * Derive QA acceptance from frontmatter status + markdown body.
 * `status=blocked` → dependency / precondition failure.
 * `status=done` with FAIL body → acceptance fail (must not auto approve).
 */
export function evaluateQaReportAcceptance(input: {
  status?: string;
  body?: string;
  sender?: string;
  recipient?: string;
}): QaAcceptanceEvaluation | null {
  if (!isQaWorkerReportToPm(input.sender, input.recipient)) {
    return null;
  }

  const st = normalizeStatus(input.status);
  const body = String(input.body ?? "");

  if (st === "blocked" || st === "aborted") {
    return {
      verdict: "blocked",
      reason: `QA REPORT status=${st || "blocked"}（依赖未满足或不可验收）`,
      blocksReview: true,
    };
  }

  if (st === "fail" || st === "failed") {
    return {
      verdict: "fail",
      reason: "QA REPORT frontmatter status=fail",
      blocksReview: true,
    };
  }

  const conclusionFail =
    /\*\*FAIL(?:\s*[（(][^）)]*[）)])?\*\*/i.test(body) ||
    /功能验收结论[：:]\s*\*\*FAIL/i.test(body) ||
    /##\s*结论[\s\S]{0,400}\*\*FAIL/i.test(body);

  const measurableFail =
    /FAIL\s*[（(]不可测[）)]/i.test(body) ||
    /验收结论[：:]\s*\*\*FAIL/i.test(body);

  const checklistFailRow =
    /\|\s*[^|\n]*\|\s*[^|\n]*\|\s*[^|\n]*\|\s*\*\*FAIL\*\*\s*\|/i.test(body);

  if (conclusionFail || measurableFail || checklistFailRow) {
    return {
      verdict: "fail",
      reason: "QA work completed and the product verdict is FAIL; PM must decide the next task",
      blocksReview: false,
    };
  }

  if (st === "done" || st === "completed" || st === "pass") {
    return {
      verdict: "pass",
      reason: "QA 验收通过",
      blocksReview: false,
    };
  }

  return {
    verdict: "unknown",
    reason: `QA REPORT status=${st || "unknown"} 未明确 pass/fail`,
    blocksReview: false,
  };
}
