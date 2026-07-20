import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  extractFinalRulesSection,
  formatAdoptedRuntimeEffectiveWakeSection,
  loadAdoptedPendingReport,
  loadRuntimeEffectivePendingSummary,
} from "../fcop-adopted-pending.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

test("extractFinalRulesSection — pulls §11 block", () => {
  const body = "## 10. 权限总表\n\nfoo\n\n## 11. 最终规则\n\n- **review** 是验收门。\n- **done** 是上级验收通过。\n\n## 12. 其他\n";
  const block = extractFinalRulesSection(body);
  assert.ok(block);
  assert.match(block!, /review.*验收门/);
  assert.doesNotMatch(block!, /权限总表/);
});

test("loadAdoptedPendingReport — includes runtime adopted clauses", () => {
  const report = loadAdoptedPendingReport(REPO_ROOT);
  assert.equal(report.dir, "fcop/adopted");
  assert.ok(report.runtimeEffectiveCount >= 2);

  const c0001 = report.clauses.find((c) => c.filename.includes("0001-lifecycle"));
  assert.ok(c0001, "0001 clause should exist");
  assert.equal(c0001!.id, "FCoP-PENDING-0001");
  assert.equal(c0001!.runtimeEffective, true);
  assert.ok(c0001!.finalRulesMarkdown);
  assert.match(c0001!.finalRulesMarkdown!, /archive.*最终封存/);
  assert.ok(c0001!.bodyMarkdown.length > 500);

  const c0002 = report.clauses.find((c) => c.filename.includes("0002-fixed-work"));
  assert.ok(c0002, "0002 pending clause should exist");
  assert.equal(c0002!.id, "FCoP-ADOPTED-0002");
  assert.equal(c0002!.runtimeEffective, true);
  assert.equal(c0002!.relativePath, "fcop/adopted/pending/0002-fixed-work-folders-and-ledger.md");
  assert.ok(c0002!.finalRulesMarkdown);
  assert.match(c0002!.finalRulesMarkdown!, /0002 = 固定工作文件夹/);
  assert.match(c0002!.finalRulesMarkdown!, /催办/);

  const c0003 = report.clauses.find((c) => c.filename.includes("0003-task-relations"));
  assert.ok(c0003, "0003 pending clause should exist");
  assert.equal(c0003!.id, "FCoP-PENDING-0003");
  assert.equal(c0003!.runtimeEffective, true);
  assert.match(c0003!.finalRulesMarkdown!, /CHILD_TASKS_OPEN/);
  assert.match(c0003!.bodyMarkdown, /Task Relations and Evidence Ownership/);
});

test("loadRuntimeEffectivePendingSummary — injects 0002 final rules", () => {
  const summary = loadRuntimeEffectivePendingSummary(REPO_ROOT);
  assert.ok(summary.length > 0);
  assert.match(summary, /fcop\/adopted\/ 与 fcop\/adopted\/pending/);
  assert.match(summary, /0002 = 固定工作文件夹/);
  assert.match(summary, /催办/);
  assert.match(summary, /0002-fixed-work-folders-and-ledger\.md/);
});

test("formatAdoptedRuntimeEffectiveWakeSection — wake/primer heading + 0002", () => {
  const block = formatAdoptedRuntimeEffectiveWakeSection(REPO_ROOT);
  assert.ok(block.length > 0);
  assert.match(block, /## adopted · 已采用 · 运行时生效/);
  assert.match(block, /0002 = 固定工作文件夹/);
});
