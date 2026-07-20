import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withTempLifecycle } from "../../lifecycle/__tests__/helpers.ts";
import { listField, parseMarkdownFrontmatter } from "../../ledger/frontmatter.ts";
import {
  maybeWriteEvalObservation,
  shouldTriggerEvalObservation,
} from "../EvalObservationGenerator.ts";
import {
  EVAL_OPS,
  EVAL_PM_FINAL,
  EVAL_ROOT,
  seedEvalCloseoutThread,
} from "./evalThreadFixture.ts";

async function listLifecycleTaskRelPaths(
  lifecycleRoot: string,
): Promise<string[]> {
  const stages = ["inbox", "active", "review", "done", "archive"] as const;
  const out: string[] = [];
  for (const stage of stages) {
    let names: string[] = [];
    try {
      names = await readdir(join(lifecycleRoot, stage));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith("TASK-") && name.endsWith(".md")) {
        out.push(`${stage}/${name}`);
      }
    }
  }
  return out.sort();
}

describe("EvalObservationGenerator.thread-v1", () => {
  it("1 — PM final report 出现后生成 OBSERVATION", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath, pmFinalFm, pmFinalContent } =
        await seedEvalCloseoutThread(rootDir, lifecycleRoot);

      assert.ok(observationPath, "expected OBSERVATION path");
      const raw = await readFile(observationPath!, "utf-8");
      assert.match(raw, /INTERNAL ONLY/);
      assert.match(raw, /kind: eval-observation/);
      const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
      assert.equal(fm.source_report, EVAL_PM_FINAL.replace(/\.md$/i, ""));
      assert.ok(
        shouldTriggerEvalObservation({
          pmReportFilename: EVAL_PM_FINAL,
          pmReportContent: pmFinalContent,
          pmReportFm: pmFinalFm,
        }),
      );
    });
  });

  it("2 — ack-only PM-to-ADMIN 不触发 OBSERVATION", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
        { ackOnlyPm: true },
      );
      assert.equal(observationPath, null);
      const evalDir = join(rootDir, "fcop", "internal", "eval");
      let names: string[] = [];
      try {
        names = await readdir(evalDir);
      } catch {
        names = [];
      }
      assert.equal(names.length, 0);
    });
  });

  it("3 — EVAL 不创建 TASK", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const seeded = await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
        skipObservation: true,
      });
      const before = await listLifecycleTaskRelPaths(lifecycleRoot);
      await maybeWriteEvalObservation({
        projectRoot: rootDir,
        pmReportPath: seeded.pmFinalPath,
        pmReportFilename: EVAL_PM_FINAL,
        pmReportContent: seeded.pmFinalContent,
        pmReportFm: seeded.pmFinalFm,
        now: () => new Date("2026-06-10T12:00:00Z"),
      });
      const after = await listLifecycleTaskRelPaths(lifecycleRoot);
      assert.deepEqual(after, before);
    });
  });

  it("4 — EVAL 不改 lifecycle 目录位置", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const seeded = await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
        skipObservation: true,
      });
      const before = await listLifecycleTaskRelPaths(lifecycleRoot);
      await maybeWriteEvalObservation({
        projectRoot: rootDir,
        pmReportPath: seeded.pmFinalPath,
        pmReportFilename: EVAL_PM_FINAL,
        pmReportContent: seeded.pmFinalContent,
        pmReportFm: seeded.pmFinalFm,
        now: () => new Date("2026-06-10T12:00:00Z"),
      });
      const after = await listLifecycleTaskRelPaths(lifecycleRoot);
      assert.deepEqual(after, before);
      assert.ok(after.some((p) => p.includes(`${EVAL_ROOT}.md`)));
    });
  });

  it("5 — 缺 action evidence 时写 evidence_gaps", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
      );
      assert.ok(observationPath);
      const raw = await readFile(observationPath!, "utf-8");
      const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
      const gaps = listField(fm, "evidence_gaps");
      assert.ok(
        gaps.some((g) => /Action Evidence/i.test(g)),
        `expected action evidence gap, got ${JSON.stringify(gaps)}`,
      );
      assert.match(raw, /证据缺口|Evidence gaps/i);
    });
  });

  it("6 — PM summary 漏报子任务时写 findings", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
        { omitPmChildMention: true },
      );
      assert.ok(observationPath);
      const raw = await readFile(observationPath!, "utf-8");
      const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
      const findings = listField(fm, "findings");
      assert.ok(
        findings.some(
          (f) => f.includes(EVAL_OPS) || /子任务|worker REPORT/i.test(f),
        ),
        `expected missing-child finding, got ${JSON.stringify(findings)}`,
      );
    });
  });

  for (const status of ["blocked", "needs_admin"] as const) {
    it(`7 — PM final status=${status} 触发 OBSERVATION`, async () => {
      await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
        const { observationPath, pmFinalContent, pmFinalFm } =
          await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
            pmFinalStatus: status,
          });
        assert.ok(observationPath, `expected OBSERVATION for ${status}`);
        assert.ok(
          shouldTriggerEvalObservation({
            pmReportFilename: EVAL_PM_FINAL,
            pmReportContent: pmFinalContent,
            pmReportFm: pmFinalFm,
          }),
        );
      });
    });
  }

  it("8 — PM in_progress REPORT 不触发 OBSERVATION", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath, pmFinalContent, pmFinalFm } =
        await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
          pmFinalStatus: "in_progress",
        });
      assert.equal(observationPath, null);
      assert.equal(
        shouldTriggerEvalObservation({
          pmReportFilename: EVAL_PM_FINAL,
          pmReportContent: pmFinalContent,
          pmReportFm: pmFinalFm,
        }),
        false,
      );
    });
  });

  it("9 — legacy blocked final（无 report_type/final）触发 OBSERVATION", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
        { pmFinalStatus: "blocked", omitFinalMarkers: true },
      );
      assert.ok(observationPath, "expected OBSERVATION for legacy blocked final");
    });
  });
});
