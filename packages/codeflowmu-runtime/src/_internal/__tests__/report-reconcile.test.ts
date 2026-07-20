import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findReportForTaskOnDisk,
  getLatestTransitionAtMs,
  reportBlocksCurrentRoundWake,
} from "../report-reconcile.ts";

const TASK_ID = "TASK-20260609-001-ADMIN-to-PM";
const REPORT_NAME = "REPORT-20260609-001-PM-to-ADMIN.md";

function reportMarkdown(createdAt: string): string {
  return `---
protocol: fcop
version: 1
kind: report
task_id: ${TASK_ID}
sender: PM
recipient: ADMIN
status: done
created_at: ${createdAt}
---

# PM final report
`;
}

function taskWithTransitions(transitionsYaml: string): string {
  return `---
protocol: fcop
version: 1
task_id: ${TASK_ID}
from: ADMIN
to: PM
driver: PM
reviewer: ADMIN
transitions:
${transitionsYaml}
---

# Task
`;
}

async function withProject<T>(
  fn: (ctx: { rootDir: string }) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-report-reconcile-"));
  await mkdir(join(rootDir, "fcop", "reports"), { recursive: true });
  await mkdir(join(rootDir, "fcop", "_lifecycle", "active"), { recursive: true });
  try {
    return await fn({ rootDir });
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("report-reconcile wake guard", () => {
  it("reportBlocksCurrentRoundWake: stale report before latest transition does not block", () => {
    const rejectAt = Date.parse("2026-06-09T12:00:00+08:00");
    const reportAt = Date.parse("2026-06-09T10:00:00+08:00");
    assert.equal(reportBlocksCurrentRoundWake(reportAt, rejectAt), false);
  });

  it("reportBlocksCurrentRoundWake: report after transition blocks", () => {
    const rejectAt = Date.parse("2026-06-09T10:00:00+08:00");
    const reportAt = Date.parse("2026-06-09T12:00:00+08:00");
    assert.equal(reportBlocksCurrentRoundWake(reportAt, rejectAt), true);
  });

  it("reportBlocksCurrentRoundWake: no transitions still blocks when report exists", () => {
    const reportAt = Date.parse("2026-06-09T10:00:00+08:00");
    assert.equal(reportBlocksCurrentRoundWake(reportAt, null), true);
  });

  it("getLatestTransitionAtMs picks max transitions[].at", () => {
    const ms = getLatestTransitionAtMs({
      transitions: [
        { at: "2026-06-09T08:00:00+08:00" },
        { at: "2026-06-09T12:00:00+08:00" },
        { at: "2026-06-09T10:00:00+08:00" },
      ],
    });
    assert.equal(ms, Date.parse("2026-06-09T12:00:00+08:00"));
  });

  it("ADMIN reject_review 后旧 PM REPORT 不阻止 wake", async () => {
    await withProject(async ({ rootDir }) => {
      const rejectAt = "2026-06-09T12:00:00+08:00";
      const oldReportAt = "2026-06-09T10:00:00+08:00";
      await writeFile(
        join(rootDir, "fcop", "_lifecycle", "active", `${TASK_ID}.md`),
        taskWithTransitions(
          `  - at: "${rejectAt}"\n    from: review\n    to: active\n    by: ADMIN\n    action: reject_review`,
        ),
        "utf-8",
      );
      await writeFile(
        join(rootDir, "fcop", "reports", REPORT_NAME),
        reportMarkdown(oldReportAt),
        "utf-8",
      );

      const blocks = await findReportForTaskOnDisk({
        projectRoot: rootDir,
        taskId: TASK_ID,
        reporter: "PM",
        reportRecipient: "ADMIN",
      });
      assert.equal(blocks, false);
    });
  });

  it("无新 transition 时本轮 REPORT 仍阻止重复 wake", async () => {
    await withProject(async ({ rootDir }) => {
      const transitionAt = "2026-06-09T10:00:00+08:00";
      const reportAt = "2026-06-09T11:00:00+08:00";
      await writeFile(
        join(rootDir, "fcop", "_lifecycle", "active", `${TASK_ID}.md`),
        taskWithTransitions(
          `  - at: "${transitionAt}"\n    from: active\n    to: review\n    by: PM\n    action: submit_review`,
        ),
        "utf-8",
      );
      await writeFile(
        join(rootDir, "fcop", "reports", REPORT_NAME),
        reportMarkdown(reportAt),
        "utf-8",
      );

      const blocks = await findReportForTaskOnDisk({
        projectRoot: rootDir,
        taskId: TASK_ID,
        reporter: "PM",
        reportRecipient: "ADMIN",
      });
      assert.equal(blocks, true);
    });
  });

  it("PM 重新写 REPORT 后同一轮再次 wake 可被跳过", async () => {
    await withProject(async ({ rootDir }) => {
      const rejectAt = "2026-06-09T12:00:00+08:00";
      const newReportAt = "2026-06-09T14:00:00+08:00";
      await writeFile(
        join(rootDir, "fcop", "_lifecycle", "active", `${TASK_ID}.md`),
        taskWithTransitions(
          `  - at: "${rejectAt}"\n    from: review\n    to: active\n    by: ADMIN\n    action: reject_review`,
        ),
        "utf-8",
      );
      await writeFile(
        join(rootDir, "fcop", "reports", REPORT_NAME),
        reportMarkdown(newReportAt),
        "utf-8",
      );

      const blocks = await findReportForTaskOnDisk({
        projectRoot: rootDir,
        taskId: TASK_ID,
        reporter: "PM",
        reportRecipient: "ADMIN",
      });
      assert.equal(blocks, true);
    });
  });
});
