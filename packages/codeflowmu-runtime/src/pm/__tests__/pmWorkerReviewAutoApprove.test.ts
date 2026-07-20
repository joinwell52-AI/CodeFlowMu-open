import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../../ledger/LedgerBuilder.ts";
import { resolveLedgerLayout } from "../../ledger/paths.ts";
import { findTaskPathById } from "../../lifecycle/taskPathUtils.ts";
import {
  isPmWorkerReviewAutoApproveCandidate,
  reconcilePmWorkerReviewsPendingApprove,
  tryAutoApprovePmWorkerReviewTask,
} from "../pmWorkerReviewAutoApprove.ts";

const THREAD = "panel-task-019";
const ROOT_ID = "TASK-20260609-019-ADMIN-to-PM";
const DEV_ID = "TASK-20260610-001-PM-to-DEV";
const OPS_ID = "TASK-20260610-002-PM-to-OPS";
const QA_ID = "TASK-20260610-004-PM-to-QA";
const DEV_REPORT = "REPORT-20260610-008-DEV-to-PM";
const OPS_REPORT = "REPORT-20260610-009-OPS-to-PM";
const QA_BLOCKED_REPORT = "REPORT-20260610-007-QA-to-PM";

async function withProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pm-worker-auto-approve-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function seedPanelTask019(root: string): Promise<void> {
  const layout = resolveLedgerLayout(root);
  const reviewDir = join(layout.lifecycleRoot, "review");
  const activeDir = join(layout.lifecycleRoot, "active");
  const reportsDir = layout.reportsDir;
  await mkdir(reviewDir, { recursive: true });
  await mkdir(activeDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  await writeFile(
    join(activeDir, `${ROOT_ID}.md`),
    taskMarkdown(
      {
        protocol: "fcop",
        version: 1,
        kind: "task",
        sender: "ADMIN",
        recipient: "PM",
        task_id: ROOT_ID,
        thread_key: THREAD,
      },
      "# admin main\n",
    ),
    "utf-8",
  );

  for (const [id, role, reportId, body] of [
    [DEV_ID, "DEV", DEV_REPORT, "## 结论\nDEV done\n\n## 证据\n- ok\n"],
    [OPS_ID, "OPS", OPS_REPORT, "## 结论\nOPS done\n\n## 证据\n- ok\n"],
    [QA_ID, "QA", QA_BLOCKED_REPORT, "## 结论\nblocked\n"],
  ] as const) {
    await writeFile(
      join(reviewDir, `${id}.md`),
      taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          kind: "task",
          sender: "PM",
          recipient: role,
          task_id: id,
          thread_key: THREAD,
          parent: ROOT_ID,
          state: "review",
          review_status: "pending",
        },
        `# ${role}\n`,
      ),
      "utf-8",
    );
    await writeFile(
      join(reportsDir, `${reportId}.md`),
      taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          kind: "report",
          sender: role,
          recipient: "PM",
          task_id: id,
          thread_key: THREAD,
          status: reportId === QA_BLOCKED_REPORT ? "blocked" : "done",
          references: [id],
        },
        body,
      ),
      "utf-8",
    );
  }

  await new LedgerBuilder({ projectRoot: root }).rebuild();
}

describe("pmWorkerReviewAutoApprove", () => {
  it("panel-task-019: auto approves DEV/OPS review→done, skips QA blocked", async () => {
    await withProject(async (root) => {
      await seedPanelTask019(root);
      const layout = resolveLedgerLayout(root);

      const results = await reconcilePmWorkerReviewsPendingApprove(root, {
        thread_key: THREAD,
      });

      const dev = results.find((r) => r.task_id.startsWith("TASK-20260610-001"));
      const ops = results.find((r) => r.task_id.startsWith("TASK-20260610-002"));
      const qa = results.find((r) => r.task_id.startsWith("TASK-20260610-004"));

      assert.ok(dev?.reviewed, "DEV should be auto approved");
      assert.ok(ops?.reviewed, "OPS should be auto approved");
      assert.ok(!qa?.reviewed, "QA blocked must not auto approve");
      assert.match(qa?.skipped_reason ?? "", /worker_report_terminal|review_check|missing/);

      const devPath = await findTaskPathById(layout.lifecycleRoot, DEV_ID);
      const opsPath = await findTaskPathById(layout.lifecycleRoot, OPS_ID);
      const qaPath = await findTaskPathById(layout.lifecycleRoot, QA_ID);
      assert.equal(devPath?.stage, "done");
      assert.equal(opsPath?.stage, "done");
      assert.equal(qaPath?.stage, "review");

      const devFm = await readFile(devPath!.path, "utf-8");
      assert.match(devFm, /review_status:\s*approved/);
    });
  });

  it("isPmWorkerReviewAutoApproveCandidate rejects ADMIN→PM mainline", async () => {
    assert.equal(
      isPmWorkerReviewAutoApproveCandidate({
        task_id: ROOT_ID,
        filename: `${ROOT_ID}.md`,
        sender: "ADMIN",
        recipient: "PM",
        bucket: "review",
        path: "",
        created_at: "",
        updated_at: "",
        timezone: "UTC",
        created_at_utc: "",
      }),
      false,
    );
  });

  it("tryAutoApprovePmWorkerReviewTask skips missing done report", async () => {
    await withProject(async (root) => {
      const layout = resolveLedgerLayout(root);
      const reviewDir = join(layout.lifecycleRoot, "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(
        join(reviewDir, `${DEV_ID}.md`),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "DEV",
            task_id: DEV_ID,
            thread_key: THREAD,
            parent: ROOT_ID,
            review_status: "pending",
          },
          "# dev\n",
        ),
        "utf-8",
      );
      await new LedgerBuilder({ projectRoot: root }).rebuild();

      const r = await tryAutoApprovePmWorkerReviewTask(root, DEV_ID);
      assert.ok(r);
      assert.equal(r!.reviewed, false);
      assert.match(r!.skipped_reason ?? "", /missing_done_worker_report/);
    });
  });
});
