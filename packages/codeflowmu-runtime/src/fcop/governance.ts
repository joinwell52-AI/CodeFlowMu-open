/**
 * 治理层报告不得进入 PM 团队整合环（ReportWatcher / ReportDispatcher）。
 */
export const GOVERNANCE_REPORT_SENDERS = new Set(["EVAL", "SYSTEM", "AUTO-AUDIT"]);

export function isGovernanceReportToPm(filename: string, senderRole: string): boolean {
  if (GOVERNANCE_REPORT_SENDERS.has(senderRole.toUpperCase())) return true;
  if (/-EVAL-/i.test(filename)) return true;
  if (/-AUTO-AUDIT/i.test(filename)) return true;
  if (/-SYSTEM-to-PM/i.test(filename)) return true;
  return false;
}

/** Worker REPORT to PM (excludes governance / EVAL / SYSTEM observation reports). */
export function isWorkerReportToPm(
  filename: string,
  sender: string,
  recipient: string,
): boolean {
  if (recipient.toUpperCase() !== "PM") return false;
  if (sender.toUpperCase() === "PM") return false;
  return !isGovernanceReportToPm(filename, sender);
}
