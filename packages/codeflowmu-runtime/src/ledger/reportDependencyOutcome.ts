/**
 * Distinguish a real worker execution failure from a report that was written
 * only because an upstream dependency had not finished yet.
 *
 * The latter is not a terminal child outcome. Runtime should keep the task in
 * the dependency queue and release it after the prerequisite REPORT arrives.
 */
export function isDependencyPendingReport(input: {
  status?: string;
  body?: string;
  explicitMarker?: unknown;
}): boolean {
  const status = String(input.status ?? "").trim().toLowerCase();
  if (!["blocked", "failed", "aborted"].includes(status)) return false;

  if (
    input.explicitMarker === true ||
    String(input.explicitMarker ?? "").trim().toLowerCase() === "true"
  ) {
    return true;
  }

  const body = String(input.body ?? "");
  return (
    /\bdependency[_ -]?pending\b/i.test(body) ||
    /\bwaiting\s+for\s+(?:an?\s+)?(?:upstream|prerequisite|dependency)\b/i.test(body) ||
    /\bupstream\b[\s\S]{0,180}\b(?:active|not\s+(?:done|delivered|completed)|no\s+report)\b/i.test(body) ||
    /(?:上游|前置|依赖)[\s\S]{0,180}(?:尚未|未|缺少)[\s\S]{0,100}(?:完成|交付|回执|报告|REPORT)/i.test(body) ||
    /(?:等待|需等待)[\s\S]{0,100}(?:DEV|QA|OPS|上游|前置|依赖)[\s\S]{0,100}(?:完成|交付|回执|报告|REPORT)/i.test(body)
  );
}
