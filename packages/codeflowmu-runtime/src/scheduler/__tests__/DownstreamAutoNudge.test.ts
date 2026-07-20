import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { WakeDownstreamExecutor } from "../../pm/PmGovernancePlanner.ts";
import type { LedgerTaskRecord } from "../../ledger/types.ts";
import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { DownstreamAutoNudge } from "../DownstreamAutoNudge.ts";
import { PmQueueGuard } from "../PmQueueGuard.ts";

const OPS_TASK_ID = "TASK-20260609-002-PM-to-OPS";
const ADMIN_TASK_ID = "TASK-20260609-001-ADMIN-to-PM";
const THREAD = "thread-downstream-nudge-test";

function ledgerRow(
  partial: Partial<LedgerTaskRecord> & Pick<LedgerTaskRecord, "task_id" | "sender" | "recipient">,
): LedgerTaskRecord {
  const filename = partial.filename ?? `${partial.task_id}.md`;
  const nowIso = "2026-06-09T10:00:00+08:00";
  return {
    filename,
    bucket: "active",
    path: `fcop/_lifecycle/active/${filename}`,
    created_at: nowIso,
    updated_at: nowIso,
    timezone: "Asia/Shanghai",
    created_at_utc: "2026-06-09T02:00:00.000Z",
    thread_key: THREAD,
    ...partial,
  };
}

async function writeLedger(root: string, rows: LedgerTaskRecord[]): Promise<void> {
  const ledgerDir = join(root, "fcop", "ledger");
  await mkdir(ledgerDir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(ledgerDir, "tasks.jsonl"), body, "utf-8");
  for (const row of rows) {
    const taskPath = isAbsolute(row.path) ? row.path : join(root, row.path);
    await mkdir(dirname(taskPath), { recursive: true });
    await writeFile(
      taskPath,
      taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          sender: row.sender,
          recipient: row.recipient,
          task_id: row.task_id,
          thread_key: row.thread_key,
          ...(row.parent ? { parent: row.parent } : {}),
          ...(row.yaml ?? {}),
        },
        `# ${row.task_id}\n\nExecute assigned work.\n`,
      ),
      "utf-8",
    );
  }
}

async function withNudgeProject<T>(
  fn: (ctx: { root: string; guard: PmQueueGuard }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-downstream-nudge-"));
  try {
    const guard = new PmQueueGuard();
    return await fn({ root, guard });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe("DownstreamAutoNudge", () => {
  for (const bucket of ["active", "review", "tasks", "inbox"] as const) {
    it(`nudges a trusted stale PM worker task in ${bucket}`, async () => {
      await withNudgeProject(async ({ root, guard }) => {
        const now = 1_700_000_000_000;
        const staleUpdated = new Date(now - 6 * 60_000).toISOString();
        let wakeCalls = 0;
        await writeLedger(root, [
          ledgerRow({
            task_id: ADMIN_TASK_ID,
            sender: "ADMIN",
            recipient: "PM",
            updated_at: staleUpdated,
          }),
          ledgerRow({
            task_id: OPS_TASK_ID,
            sender: "PM",
            recipient: "OPS",
            bucket,
            path: `fcop/_lifecycle/${bucket}/${OPS_TASK_ID}.md`,
            parent: ADMIN_TASK_ID,
            updated_at: staleUpdated,
          }),
        ]);
        const nudge = new DownstreamAutoNudge({
          projectRoot: () => root,
          wakeExecutor: () => async (req) => {
            wakeCalls += 1;
            assert.equal(req.source, "downstream_auto_nudge");
            return { ok: true, session_id: `sess-${bucket}` };
          },
          pmQueueGuard: guard,
          now: () => now,
          idleMs: 5 * 60_000,
        });
        await nudge.tick();
        assert.equal(wakeCalls, 1);
      });
    });
  }

  it("does not nudge a fresh inbox task or inbox without a trusted parent", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      const now = 1_700_000_000_000;
      let wakeCalls = 0;
      const wakeExecutor: WakeDownstreamExecutor = async () => {
        wakeCalls += 1;
        return { ok: true };
      };
      await writeLedger(root, [
        ledgerRow({ task_id: ADMIN_TASK_ID, sender: "ADMIN", recipient: "PM" }),
        ledgerRow({
          task_id: OPS_TASK_ID,
          sender: "PM",
          recipient: "OPS",
          bucket: "inbox",
          parent: ADMIN_TASK_ID,
          updated_at: new Date(now - 60_000).toISOString(),
        }),
        ledgerRow({
          task_id: "TASK-20260609-099-PM-to-QA",
          sender: "PM",
          recipient: "QA",
          bucket: "inbox",
          parent: "TASK-UNKNOWN",
          updated_at: new Date(now - 10 * 60_000).toISOString(),
        }),
      ]);
      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => wakeExecutor,
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
      });
      await nudge.tick();
      assert.equal(wakeCalls, 0);
    });
  });

  it("nudges OPS when child active exceeds idle threshold", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      let now = 1_700_000_000_000;
      const staleUpdated = new Date(now - 6 * 60_000).toISOString();
      let wakeCalls = 0;
      const wakeExecutor: WakeDownstreamExecutor = async () => {
        wakeCalls += 1;
        return { ok: true, session_id: "sess-nudge-1", agent_id: "ops-agent" };
      };

      await writeLedger(root, [
        ledgerRow({
          task_id: ADMIN_TASK_ID,
          sender: "ADMIN",
          recipient: "PM",
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: OPS_TASK_ID,
          sender: "PM",
          recipient: "OPS",
          updated_at: staleUpdated,
        }),
      ]);

      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => wakeExecutor,
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
        debounceMs: 6 * 60_000,
      });

      await nudge.tick();

      assert.equal(wakeCalls, 1);
      const snap = guard.snapshot();
      assert.equal(snap.waiting_downstream, true);
      assert.equal(snap.downstream_role, "OPS");
      assert.equal(snap.downstream_nudge_task_id, OPS_TASK_ID);
      assert.equal(snap.downstream_last_wake_session_id, "sess-nudge-1");
      assert.ok(snap.downstream_auto_nudged_at);
      assert.ok(snap.downstream_next_nudge_at);
    });
  });

  it("does not bypass dependency gate and nudges only after prerequisite report", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      const now = 1_700_000_000_000;
      const staleUpdated = new Date(now - 6 * 60_000).toISOString();
      const devTaskId = "TASK-20260609-020-PM-to-DEV";
      const qaTaskId = "TASK-20260609-021-PM-to-QA";
      let wakeCalls = 0;

      await writeLedger(root, [
        ledgerRow({
          task_id: ADMIN_TASK_ID,
          sender: "ADMIN",
          recipient: "PM",
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: devTaskId,
          sender: "PM",
          recipient: "DEV",
          parent: ADMIN_TASK_ID,
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: qaTaskId,
          sender: "PM",
          recipient: "QA",
          parent: ADMIN_TASK_ID,
          updated_at: staleUpdated,
          yaml: { depends_on: [devTaskId] },
        }),
      ]);

      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => async (req) => {
          if (req.task_id === qaTaskId) wakeCalls += 1;
          return { ok: true, session_id: "sess-after-dependency" };
        },
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
      });

      await nudge.tick();
      assert.equal(wakeCalls, 0);

      const reportsDir = join(root, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      await writeFile(
        join(reportsDir, "REPORT-20260609-020-DEV-to-PM.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            task_id: devTaskId,
            sender: "DEV",
            recipient: "PM",
            status: "done",
          },
          "# DEV done\n",
        ),
        "utf-8",
      );

      await nudge.tick();
      assert.equal(wakeCalls, 1);
    });
  });

  it("debounces repeated nudge for same task_id within debounce window", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      let now = 1_700_000_000_000;
      const staleUpdated = new Date(now - 6 * 60_000).toISOString();
      let wakeCalls = 0;
      const wakeExecutor: WakeDownstreamExecutor = async () => {
        wakeCalls += 1;
        return { ok: true, session_id: "sess-nudge-1" };
      };

      await writeLedger(root, [
        ledgerRow({
          task_id: ADMIN_TASK_ID,
          sender: "ADMIN",
          recipient: "PM",
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: OPS_TASK_ID,
          sender: "PM",
          recipient: "OPS",
          updated_at: staleUpdated,
        }),
      ]);

      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => wakeExecutor,
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
        debounceMs: 6 * 60_000,
      });

      await nudge.tick();
      now += 60_000;
      await nudge.tick();

      assert.equal(wakeCalls, 1);
      const snap = guard.snapshot();
      assert.equal(snap.downstream_nudge_task_id, OPS_TASK_ID);
      assert.ok(snap.downstream_next_nudge_at! > now);
    });
  });

  it("skips nudge when OPS REPORT exists on disk", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      let now = 1_700_000_000_000;
      const staleUpdated = new Date(now - 6 * 60_000).toISOString();
      let wakeCalls = 0;
      const wakeExecutor: WakeDownstreamExecutor = async () => {
        wakeCalls += 1;
        return { ok: true, session_id: "sess-nudge-1" };
      };

      await writeLedger(root, [
        ledgerRow({
          task_id: ADMIN_TASK_ID,
          sender: "ADMIN",
          recipient: "PM",
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: OPS_TASK_ID,
          sender: "PM",
          recipient: "OPS",
          updated_at: staleUpdated,
        }),
      ]);

      const reportsDir = join(root, "fcop", "reports");
      await mkdir(reportsDir, { recursive: true });
      const reportBody = taskMarkdown(
        {
          protocol: "fcop",
          version: 1,
          kind: "report",
          task_id: OPS_TASK_ID,
          sender: "OPS",
          recipient: "PM",
          status: "done",
        },
        "# OPS done\n",
      );
      await writeFile(
        join(reportsDir, "REPORT-20260609-003-OPS-to-PM.md"),
        reportBody,
        "utf-8",
      );

      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => wakeExecutor,
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
        debounceMs: 6 * 60_000,
      });

      await nudge.tick();

      assert.equal(wakeCalls, 0);
      assert.equal(guard.snapshot().downstream_auto_nudged_at, null);
    });
  });

  it("does not mark waiting when worker session failed", async () => {
    await withNudgeProject(async ({ root, guard }) => {
      let now = 1_700_000_000_000;
      const staleUpdated = new Date(now - 6 * 60_000).toISOString();
      const QA_TASK_ID = "TASK-20260609-010-PM-to-QA";
      let wakeCalls = 0;
      const wakeExecutor: WakeDownstreamExecutor = async () => {
        wakeCalls += 1;
        return { ok: true, session_id: "sess-qa-fail" };
      };

      await writeLedger(root, [
        ledgerRow({
          task_id: ADMIN_TASK_ID,
          sender: "ADMIN",
          recipient: "PM",
          updated_at: staleUpdated,
        }),
        ledgerRow({
          task_id: QA_TASK_ID,
          sender: "PM",
          recipient: "QA",
          updated_at: staleUpdated,
        }),
      ]);

      guard.markDownstreamWorkerFailed(QA_TASK_ID);

      const nudge = new DownstreamAutoNudge({
        projectRoot: () => root,
        wakeExecutor: () => wakeExecutor,
        pmQueueGuard: guard,
        now: () => now,
        idleMs: 5 * 60_000,
        debounceMs: 6 * 60_000,
      });

      await nudge.tick();

      assert.equal(wakeCalls, 0);
      assert.equal(guard.snapshot().waiting_downstream, false);
      assert.equal(guard.snapshot().downstream_auto_nudged_at, null);
    });
  });
});
