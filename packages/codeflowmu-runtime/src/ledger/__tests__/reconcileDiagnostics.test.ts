import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskMarkdown } from "../../lifecycle/__tests__/helpers.ts";
import { LedgerBuilder } from "../LedgerBuilder.ts";
import {
  isDiagnosticVisible,
  parseDiagnosticsJsonl,
  readDiagnosticsJsonl,
  reconcileTaskDiagnostics,
} from "../reconcileDiagnostics.ts";
import { resolveLedgerLayout } from "../paths.ts";
import type { LedgerLifecycleBucket, LedgerTaskRecord } from "../types.ts";

const DETECTED_AT = "2026-06-09T12:00:00+08:00";

function diskRow(
  taskId: string,
  bucket: LedgerLifecycleBucket,
  path: string,
): LedgerTaskRecord {
  return {
    task_id: taskId,
    filename: `${taskId}.md`,
    path,
    bucket,
    sender: "ADMIN",
    recipient: "OPS",
    thread_key: "t1",
    parent: null,
    related: [],
    priority: "P2",
    kind: "task",
    mtime: DETECTED_AT,
    size: 100,
    frontmatter: {},
    body_excerpt: "",
    body_hash: "",
    route: "hot_path",
    review_status: "none",
    review_decision: null,
    review_id: null,
    review_path: null,
    review_approved_at: null,
    review_approved_by: null,
    review_note: null,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    archive_path: null,
    rework_requested_at: null,
    rework_requested_by: null,
    rework_note: null,
    rework_count: 0,
    sync_status: "ok",
  } as unknown as LedgerTaskRecord;
}

function ledgerRow(
  taskId: string,
  bucket: LedgerLifecycleBucket,
  path: string,
): LedgerTaskRecord {
  return { ...diskRow(taskId, bucket, path) };
}

describe("reconcileTaskDiagnostics", () => {
  it("ledger orphan: prior ledger row without disk file → diagnostics only", () => {
    const prior = [
      ledgerRow(
        "TASK-20260609-005",
        "review",
        "fcop/_lifecycle/review/TASK-20260609-005-PM-to-OPS.md",
      ),
    ];
    const result = reconcileTaskDiagnostics([], prior, { detectedAt: DETECTED_AT });

    assert.equal(result.normalTasks.length, 0);
    assert.equal(result.summary.ledgerOrphanCount, 1);
    const orphan = result.diagnostics.find((d) => d.type === "ledger_orphan");
    assert.ok(orphan);
    assert.equal(orphan?.task_id, "TASK-20260609-005");
  });

  it("file without ledger: disk task absent from prior snapshot → normalTasks + badge", () => {
    const disk = [
      diskRow(
        "TASK-20260609-006",
        "active",
        "fcop/_lifecycle/active/TASK-20260609-006-PM-to-OPS.md",
      ),
    ];
    const result = reconcileTaskDiagnostics(disk, [], { detectedAt: DETECTED_AT });

    assert.equal(result.normalTasks.length, 1);
    assert.equal(result.normalTasks[0]?.task_id, "TASK-20260609-006");
    assert.equal(result.normalTasks[0]?.sync_status, "file_without_ledger");
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.type === "file_without_ledger" &&
          d.task_id === "TASK-20260609-006",
      ),
    );
  });

  it("bucket mismatch: file bucket wins, diagnostic recorded", () => {
    const tid = "TASK-20260609-007";
    const path = "fcop/_lifecycle/active/TASK-20260609-007-PM-to-OPS.md";
    const disk = [diskRow(tid, "active", path)];
    const prior = [ledgerRow(tid, "review", path)];
    const result = reconcileTaskDiagnostics(disk, prior, { detectedAt: DETECTED_AT });

    assert.equal(result.normalTasks.length, 1);
    assert.equal(result.normalTasks[0]?.bucket, "active");
    const mismatch = result.diagnostics.find((d) => d.type === "bucket_mismatch");
    assert.ok(mismatch);
    assert.equal(mismatch?.bucket_from_file, "active");
    assert.equal(mismatch?.bucket_from_ledger, "review");
    assert.equal(mismatch?.auto_healed, true);
    assert.equal(mismatch?.visible, false);
    assert.equal(mismatch?.severity, "info");
    assert.equal(result.summary.autoHealedCount, 1);
    assert.equal(result.summary.visibleDiagnosticsCount, 0);
    assert.equal(result.summary.diagnosticsCount, 1);
  });

  it("short disk task_id matches full routing-complete ledger row (no false orphan)", () => {
    const disk = [
      diskRow(
        "TASK-20260609-001",
        "inbox",
        "fcop/_lifecycle/inbox/TASK-20260609-001-ADMIN-to-PM.md",
      ),
    ];
    const prior = [
      ledgerRow(
        "TASK-20260609-001-ADMIN-to-PM",
        "inbox",
        "fcop/_lifecycle/inbox/TASK-20260609-001-ADMIN-to-PM.md",
      ),
      ledgerRow(
        "TASK-20260609-005-PM-to-OPS",
        "archive",
        "fcop/_lifecycle/archive/TASK-20260609-005-PM-to-OPS.md",
      ),
    ];
    const result = reconcileTaskDiagnostics(disk, prior, { detectedAt: DETECTED_AT });

    assert.equal(result.normalTasks.length, 1);
    assert.equal(result.normalTasks[0]?.task_id, "TASK-20260609-001-ADMIN-to-PM");
    assert.equal(result.normalTasks[0]?.sync_status, "ok");
    assert.equal(result.summary.ledgerOrphanCount, 1);
    const orphan = result.diagnostics.find((d) => d.type === "ledger_orphan");
    assert.ok(orphan);
    assert.equal(orphan?.task_id, "TASK-20260609-005-PM-to-OPS");
    assert.ok(
      !result.diagnostics.some(
        (d) =>
          d.type === "ledger_orphan" &&
          d.task_id?.includes("TASK-20260609-001"),
      ),
    );
    assert.ok(
      !result.diagnostics.some((d) => d.type === "file_without_ledger"),
    );
  });

  it("path mismatch: real disk path wins, diagnostic recorded", () => {
    const tid = "TASK-20260609-008";
    const diskPath = "fcop/_lifecycle/inbox/TASK-20260609-008-PM-to-OPS.md";
    const ledgerPath = "fcop/_lifecycle/review/TASK-20260609-008-PM-to-OPS.md";
    const disk = [diskRow(tid, "inbox", diskPath)];
    const prior = [ledgerRow(tid, "inbox", ledgerPath)];
    const result = reconcileTaskDiagnostics(disk, prior, { detectedAt: DETECTED_AT });

    assert.equal(result.normalTasks.length, 1);
    assert.equal(result.normalTasks[0]?.path, diskPath);
    const mismatch = result.diagnostics.find((d) => d.type === "path_mismatch");
    assert.ok(mismatch);
    assert.equal(mismatch?.actual_path, diskPath);
    assert.equal(mismatch?.ledger_path, ledgerPath);
    assert.equal(mismatch?.auto_healed, true);
    assert.equal(mismatch?.visible, false);
    assert.equal(result.summary.visibleDiagnosticsCount, 0);
  });
});

describe("isDiagnosticVisible", () => {
  it("treats visible:false as hidden; default rows stay visible", () => {
    assert.equal(isDiagnosticVisible({ visible: false }), false);
    assert.equal(isDiagnosticVisible({}), true);
    assert.equal(isDiagnosticVisible({ visible: true }), true);
  });
});

describe("LedgerBuilder rebuild + diagnostics.jsonl", () => {
  async function withTempProject(
    fn: (ctx: { root: string }) => Promise<void>,
  ): Promise<void> {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "reconcile-diag-"));
    try {
      await fn({ root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rebuild persists ledger_orphan to diagnostics.jsonl, not tasks.jsonl", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      await mkdir(layout.ledgerDir, { recursive: true });
      await writeFile(
        join(layout.ledgerDir, "tasks.jsonl"),
        [
          JSON.stringify(
            ledgerRow(
              "TASK-20260609-005",
              "review",
              "fcop/_lifecycle/review/TASK-20260609-005-PM-to-OPS.md",
            ),
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      const result = await builder.rebuild();
      assert.equal(result.tasks, 0);
      assert.equal(result.orphans, 1);
      assert.equal(result.diagnostics, 1);

      const tasks = await builder.listTasks("OPS");
      assert.equal(tasks.length, 0);

      const diagnostics = await readDiagnosticsJsonl(layout);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.type, "ledger_orphan");
      assert.equal(diagnostics[0]?.task_id, "TASK-20260609-005");
    });
  });

  it("rebuild with stale ledger bucket writes auto-healed audit but visible count is 0", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const activeDir = join(layout.lifecycleRoot, "active");
      await mkdir(activeDir, { recursive: true });
      const filename = "TASK-20260609-010-PM-to-OPS.md";
      await writeFile(
        join(activeDir, filename),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "PM",
            recipient: "OPS",
            task_id: "TASK-20260609-010-PM-to-OPS",
          },
          "# Active on disk\n",
        ),
        "utf-8",
      );
      await mkdir(layout.ledgerDir, { recursive: true });
      await writeFile(
        join(layout.ledgerDir, "tasks.jsonl"),
        [
          JSON.stringify(
            ledgerRow(
              "TASK-20260609-010-PM-to-OPS",
              "review",
              "fcop/_lifecycle/active/TASK-20260609-010-PM-to-OPS.md",
            ),
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      const result = await builder.rebuild();
      assert.equal(result.tasks, 1);
      assert.equal(result.diagnostics, 0);

      const diagnostics = await readDiagnosticsJsonl(layout);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.type, "bucket_mismatch");
      assert.equal(diagnostics[0]?.auto_healed, true);
      assert.equal(diagnostics[0]?.visible, false);
    });
  });

  it("rebuild scans real _lifecycle file into normalTasks", async () => {
    await withTempProject(async ({ root }) => {
      const layout = resolveLedgerLayout(root);
      const inboxDir = join(layout.lifecycleRoot, "inbox");
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        join(inboxDir, "TASK-20260609-009-ADMIN-to-OPS.md"),
        taskMarkdown(
          {
            protocol: "fcop",
            version: 1,
            kind: "task",
            sender: "ADMIN",
            recipient: "OPS",
            task_id: "TASK-20260609-009-ADMIN-to-OPS",
          },
          "# On disk\n",
        ),
        "utf-8",
      );

      const builder = new LedgerBuilder({ projectRoot: root });
      await builder.rebuild();
      const tasks = await builder.listTasks("OPS");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.task_id, "TASK-20260609-009");
      assert.equal(tasks[0]?.bucket, "inbox");
    });
  });
});

describe("parseDiagnosticsJsonl", () => {
  it("round-trips diagnostic lines", () => {
    const line = JSON.stringify({
      id: "ledger_orphan:TASK-1",
      task_id: "TASK-1",
      type: "ledger_orphan",
      severity: "warn",
      title: "x",
      message: "y",
      detected_at: DETECTED_AT,
    });
    const parsed = parseDiagnosticsJsonl(`${line}\n`);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.type, "ledger_orphan");
  });
});
