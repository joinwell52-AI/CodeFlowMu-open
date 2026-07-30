import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { buildEvalUnifiedSnapshot } from "../eval-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function evalProject(content: string, filename = "OBSERVATION-20260730-001.md") {
  const root = mkdtempSync(join(tmpdir(), "codeflowmu-eval-snapshot-"));
  roots.push(root);
  const dir = join(root, "fcop", "internal", "eval");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
  return root;
}

test("structured EVAL uses one snapshot for report, summary and history", () => {
  const root = evalProject(`---
kind: eval-observation
created_at: 2026-07-30T10:00:00+08:00
scan:
  files_checked: 12
  assets_checked: 4
  completed: true
  parse_failures: 0
findings:
  total: 2
  by_priority: { P0: 0, P1: 1, P2: 1, P3: 0 }
  items:
    - id: one
      priority: P1
      message: "TASK-20260730-001 DEV failure"
      root_key: TASK-20260730-001
    - id: duplicate-role
      priority: P2
      message: "TASK-20260730-001 QA derivative"
      root_key: TASK-20260730-001
review:
  status: draft
  reviewed_by: null
---
# Observation
`);
  const snapshot = buildEvalUnifiedSnapshot(root);
  assert.equal(snapshot.reports.length, 1);
  assert.equal(snapshot.reports[0]?.findings.length, 1);
  assert.equal(snapshot.summary.violations_count, 1);
  assert.equal(snapshot.summary.files_checked, 12);
  assert.equal(snapshot.summary.score, 85);
  assert.equal(snapshot.history[0]?.violations, 1);
  assert.equal(snapshot.history[0]?.score, 85);
});

test("legacy priority parsing supports P0-P3 and no evidence returns N/A", () => {
  const root = evalProject(`---
kind: audit
---
- **P0**: critical item
- HIGH: high item
- P2：medium item
- LOW: low item
`, "AUDIT-20260730-002.md");
  const snapshot = buildEvalUnifiedSnapshot(root);
  assert.deepEqual(
    snapshot.reports[0]?.findings.map((finding) => finding.priority),
    ["P0", "P1", "P2", "P3"],
  );
  assert.equal(snapshot.summary.score, null);
  assert.equal(snapshot.summary.score_status, "insufficient_evidence");
});
