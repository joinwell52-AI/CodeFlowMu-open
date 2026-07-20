import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  persistWorkerReceiptFailed,
  pruneStaleDownstreamReceiptFailures,
  resolveWorkerReceiptDurableHints,
} from "../workerReceiptDurableHints.ts";
import type { LedgerReportRecord, LedgerTaskRecord } from "../../ledger/types.ts";

const QA_TASK_ID = "TASK-20260609-010";

async function writeRuntimeEvent(
  root: string,
  line: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, "fcop", "logs", "runtime");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "runtime-events-20260609.jsonl");
  await writeFile(path, `${JSON.stringify(line)}\n`, { flag: "a" });
}

describe("resolveWorkerReceiptDurableHints", () => {
  it("counts downstream_auto_nudge and detects session_failed from runtime-events", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-receipt-hints-"));
    try {
      for (let i = 0; i < 3; i += 1) {
        await writeRuntimeEvent(root, {
          ts: 1_700_000_000_000 + i,
          at: "2026-06-09T10:00:00.000Z",
          event_type: "codeflowmu.downstream_auto_nudge",
          task_id: QA_TASK_ID,
          payload: { task_id: QA_TASK_ID, ok: true },
        });
      }
      await writeRuntimeEvent(root, {
        ts: 1_700_000_100_000,
        at: "2026-06-09T10:01:00.000Z",
        event_type: "runtime.session_ended",
        task_id: QA_TASK_ID,
        payload: {
          task_id: QA_TASK_ID,
          status: "failed",
          report_written: false,
        },
      });

      const hints = await resolveWorkerReceiptDurableHints(root, QA_TASK_ID);
      assert.equal(hints.nudgeCount, 3);
      assert.equal(hints.sessionFailed, true);
      assert.equal(hints.workerFailedPersisted, false);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("persistWorkerReceiptFailed survives reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-receipt-persist-"));
    try {
      await persistWorkerReceiptFailed(root, QA_TASK_ID, "session_failed");
      const hints = await resolveWorkerReceiptDurableHints(root, QA_TASK_ID);
      assert.equal(hints.workerFailedPersisted, true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("treats cursor_sdk_first_turn_abort as recoverable from runtime-events", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-receipt-first-turn-"));
    const taskId = "TASK-20260611-003";
    try {
      await writeRuntimeEvent(root, {
        ts: 1_700_000_200_000,
        at: "2026-06-11T01:46:28.000Z",
        event_type: "runtime.session_ended",
        task_id: taskId,
        session_id: "session-9-mq8d1cox",
        payload: {
          task_id: taskId,
          status: "failed",
          report_written: false,
          failure_code: "ERROR",
          failure_category: "cursor_sdk_first_turn_abort",
          is_first_turn_abort: true,
          tool_call_count: 0,
        },
      });

      const hints = await resolveWorkerReceiptDurableHints(root, taskId);
      assert.equal(hints.sessionFailed, true);
      assert.equal(hints.recoverable, true);
      assert.equal(hints.isFirstTurnAbort, true);
      assert.equal(hints.lastFailureCategory, "cursor_sdk_first_turn_abort");
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("pruneStaleDownstreamReceiptFailures removes cleared worker failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflowmu-receipt-prune-"));
    try {
      await persistWorkerReceiptFailed(root, QA_TASK_ID, "worker_failed_mark");
      const tasks = [
        {
          task_id: QA_TASK_ID,
          filename: `${QA_TASK_ID}.md`,
          sender: "PM",
          recipient: "QA",
          bucket: "active",
          path: `fcop/_lifecycle/active/${QA_TASK_ID}.md`,
        },
      ] as LedgerTaskRecord[];
      const reports = [
        {
          filename: "REPORT-20260609-010-QA-to-PM.md",
          sender: "QA",
          recipient: "PM",
          status: "done",
          task_id: QA_TASK_ID,
          references: [QA_TASK_ID],
        },
      ] as LedgerReportRecord[];
      const pruned = await pruneStaleDownstreamReceiptFailures(
        root,
        tasks,
        reports,
      );
      assert.equal(pruned, 1);
      const hints = await resolveWorkerReceiptDurableHints(root, QA_TASK_ID);
      assert.equal(hints.workerFailedPersisted, false);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
