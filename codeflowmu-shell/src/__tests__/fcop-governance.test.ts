import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { listEvalAuditFiles } from "../fcop-governance.ts";

test("listEvalAuditFiles ignores legacy EVAL team REPORT files", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-eval-list-"));
  try {
    const internalEval = join(root, "fcop", "internal", "eval");
    const reports = join(root, "fcop", "reports");
    mkdirSync(internalEval, { recursive: true });
    mkdirSync(reports, { recursive: true });

    writeFileSync(
      join(internalEval, "OBSERVATION-20260605-001-panel-scan.md"),
      [
        "---",
        "subject: Panel scan",
        "observed_at: 2026-06-05T10:17:52+08:00",
        "score: 85",
        "---",
        "",
        "# Observation",
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      join(reports, "REPORT-20260605-076-EVAL-to-PM.md"),
      [
        "---",
        "sender: EVAL",
        "recipient: PM",
        "subject: Legacy team report",
        "---",
        "",
        "# Should not appear in EVAL observations",
      ].join("\n"),
      "utf-8",
    );

    const items = listEvalAuditFiles(root, 10);
    assert.deepEqual(
      items.map((item) => item.filename),
      ["OBSERVATION-20260605-001-panel-scan.md"],
    );
    assert.equal(items[0]?.source, "internal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
