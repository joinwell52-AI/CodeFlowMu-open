import {
  evaluateReportAttribution,
  type ReportAttributionResult,
} from "./reportAttribution.ts";

export type Panel104AcceptanceInput = {
  diagnostics: unknown[];
  devReports: Array<{ filename: string; fm: Record<string, unknown> }>;
  expectedDevTaskId: string;
};

export type Panel104AcceptanceResult = {
  pass: boolean;
  diagnosticsCount: number;
  attributionErrors: string[];
  attributionResults: ReportAttributionResult[];
};

/** diagnostics=0 does not imply attribution PASS (105 case 4). */
export function evaluatePanel104Acceptance(
  input: Panel104AcceptanceInput,
): Panel104AcceptanceResult {
  const expected = input.expectedDevTaskId.replace(/\.md$/i, "").trim();
  const attributionResults = input.devReports.map((r) =>
    evaluateReportAttribution(r.filename, r.fm),
  );
  const attributionErrors: string[] = [];
  for (let i = 0; i < input.devReports.length; i++) {
    const row = input.devReports[i]!;
    const result = attributionResults[i]!;
    if (!result.pass) {
      for (const err of result.errors) {
        attributionErrors.push(`${row.filename}: ${err}`);
      }
    }
  }
  const hasValidDevReceipt = input.devReports.some((r) => {
    const result = evaluateReportAttribution(r.filename, r.fm);
    return (
      result.pass &&
      result.filenameTaskId === expected &&
      result.fmTaskId === expected &&
      result.refTaskId === expected
    );
  });
  return {
    pass: hasValidDevReceipt && attributionErrors.length === 0,
    diagnosticsCount: input.diagnostics.length,
    attributionErrors,
    attributionResults,
  };
}
