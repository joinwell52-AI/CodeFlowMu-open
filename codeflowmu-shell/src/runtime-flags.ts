/**
 * Shell runtime feature flags resolved from process environment.
 * Kept in a small module so main.ts wiring stays testable without booting Runtime.
 */

/** REVIEW-01 (legacy ReviewEngine). Off unless CODEFLOWMU_LEGACY_REVIEW_ENGINE=1. */
export function resolveLegacyReviewEngine(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CODEFLOWMU_LEGACY_REVIEW_ENGINE === "1";
}
