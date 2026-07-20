import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve as pathResolve } from "node:path";
import { resolveReportPathForAfterWrite } from "../panel-report-path.ts";

const projectRoot = "D:\\codeflowmu";

test("bare REPORT filename resolves under fcop/reports", () => {
  const name = "REPORT-20260610-090-PM-to-ADMIN.md";
  assert.equal(
    resolveReportPathForAfterWrite(projectRoot, name),
    join(projectRoot, "fcop", "reports", name),
  );
});

test("fcop/reports relative path resolves under projectRoot", () => {
  const rel = "fcop/reports/REPORT-20260610-090-PM-to-ADMIN.md";
  assert.equal(
    resolveReportPathForAfterWrite(projectRoot, rel),
    join(projectRoot, "fcop", "reports", "REPORT-20260610-090-PM-to-ADMIN.md"),
  );
});

test("absolute report path is used as-is", () => {
  const abs = pathResolve(
    projectRoot,
    "fcop",
    "reports",
    "REPORT-20260610-090-PM-to-ADMIN.md",
  );
  assert.equal(resolveReportPathForAfterWrite(projectRoot, abs), abs);
});
