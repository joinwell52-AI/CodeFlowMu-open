import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withTempLifecycle } from "../../lifecycle/__tests__/helpers.ts";
import {
  ensureEvalObservationForCloseout,
  getAdminTaskCloseout,
} from "../EvalObservationGenerator.ts";
import {
  EVAL_PM_FINAL,
  EVAL_ROOT,
  EVAL_THREAD,
  seedEvalCloseoutThread,
} from "./evalThreadFixture.ts";

describe("PmSummaryEvalIntegration", () => {
  it("PM final → EVAL → getAdminTaskCloseout 同屏数据", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
      );
      assert.ok(observationPath);

      const closeout = await getAdminTaskCloseout(rootDir, EVAL_ROOT);
      assert.ok(closeout, "expected closeout for ADMIN root");
      assert.equal(closeout!.root_task_id, "TASK-20260610-101");
      assert.equal(closeout!.thread_key, EVAL_THREAD);

      assert.ok(closeout!.pm_final_report, "expected PM final report");
      assert.equal(
        closeout!.pm_final_report!.report_id,
        EVAL_PM_FINAL.replace(/\.md$/i, ""),
      );
      assert.match(closeout!.pm_final_report!.content, /PM 总报告/);

      assert.ok(closeout!.eval_observation, "expected EVAL observation");
      assert.equal(closeout!.eval_observation!.internal_only, true);
      assert.equal(closeout!.eval_observation!.bypass_observation, true);
      assert.equal(closeout!.eval_observation!.drives_lifecycle, false);
      assert.equal(
        closeout!.eval_observation!.source_report,
        EVAL_PM_FINAL.replace(/\.md$/i, ""),
      );

      assert.deepEqual(closeout!.labels, {
        internal_only: true,
        bypass_observation: true,
        drives_lifecycle: false,
      });

      const obsRaw = await readFile(observationPath!, "utf-8");
      assert.match(obsRaw, /不驱动 lifecycle/);
    });
  });

  it("PM blocked final → EVAL → getAdminTaskCloseout 识别 pm_final_report", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { observationPath } = await seedEvalCloseoutThread(
        rootDir,
        lifecycleRoot,
        { pmFinalStatus: "blocked" },
      );
      assert.ok(observationPath);

      const closeout = await getAdminTaskCloseout(rootDir, EVAL_ROOT);
      assert.ok(closeout?.pm_final_report, "expected PM blocked final report");
      assert.equal(closeout!.pm_final_report!.status, "blocked");
      assert.ok(closeout!.eval_observation, "expected EVAL for blocked final");
      assert.equal(closeout!.eval_observation!.drives_lifecycle, false);
    });
  });

  it("PM final 仅 references（无 task_id）时 ensureEvalObservationForCloseout 可生成", async () => {
    await withTempLifecycle(async ({ rootDir, lifecycleRoot }) => {
      const { pmFinalPath } = await seedEvalCloseoutThread(rootDir, lifecycleRoot, {
        skipObservation: true,
      });
      let raw = await readFile(pmFinalPath, "utf-8");
      raw = raw
        .replace(/^task_id:.*\n/m, "")
        .replace(/^thread_key:.*\n/m, "");
      await writeFile(pmFinalPath, raw, "utf-8");

      const result = await ensureEvalObservationForCloseout(rootDir, EVAL_ROOT);
      assert.equal(result.generated, true);
      assert.ok(result.path);

      const closeout = await getAdminTaskCloseout(rootDir, EVAL_ROOT, {
        ensureEval: false,
      });
      assert.ok(closeout?.eval_observation);
    });
  });
});
