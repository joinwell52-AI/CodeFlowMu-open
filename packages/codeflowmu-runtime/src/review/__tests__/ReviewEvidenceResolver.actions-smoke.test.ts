import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendActionEvidence,
  resetActionEventIdCounterForTests,
} from "../../logs/ActionEvidenceLogger.ts";
import { resolveReviewEvidence } from "../ReviewEvidenceResolver.ts";

/**
 * Smoke: actions-YYYYMMDD.jsonl entries resolve into ReviewEvidence summary fields.
 */
describe("ReviewEvidenceResolver actions smoke", () => {
  beforeEach(() => resetActionEventIdCounterForTests());
  afterEach(() => resetActionEventIdCounterForTests());

  it("aggregates file.read, task.write, command.run, report.write from action log", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-ev-smoke-"));
    try {
      const at = "2026-06-08T12:00:00.000Z";
      const taskId = "TASK-20260608-010";
      const sessionId = "sess-ops-patrol";

      appendActionEvidence(root, {
        event_type: "file.read",
        at,
        task_id: taskId,
        session_id: sessionId,
        agent_id: "OPS",
        role: "OPS",
        status: "success",
        path: "fcop/shared/TEAM-README.md",
        call_id: "smoke-read",
      });
      appendActionEvidence(root, {
        event_type: "task.write",
        at,
        task_id: taskId,
        session_id: sessionId,
        agent_id: "OPS",
        role: "OPS",
        status: "success",
        recipient: "OPS",
        task_ref: taskId,
        call_id: "smoke-task",
      });
      appendActionEvidence(root, {
        event_type: "command.run",
        at,
        task_id: taskId,
        session_id: sessionId,
        agent_id: "OPS",
        role: "OPS",
        status: "success",
        command: "fcop_report",
        exit_code: 0,
        call_id: "smoke-cmd",
      });
      appendActionEvidence(root, {
        event_type: "report.write",
        at,
        task_id: taskId,
        session_id: sessionId,
        agent_id: "OPS",
        role: "OPS",
        status: "success",
        report_id: "REPORT-20260608-010-OPS-to-PM",
        path: "_lifecycle/review/REPORT-20260608-010-OPS-to-PM.md",
      });

      const summary = resolveReviewEvidence({
        projectRoot: root,
        task_id: taskId,
        report_id: "REPORT-20260608-010-OPS-to-PM",
        session_id: sessionId,
      });

      assert.equal(summary.task_id, taskId);
      assert.equal(summary.session.found, true);
      assert.deepEqual(summary.files.read, ["fcop/shared/TEAM-README.md"]);
      assert.equal(summary.commands.length, 1);
      assert.equal(summary.commands[0]!.command, "fcop_report");
      assert.equal(summary.commands[0]!.exit_code, 0);
      assert.equal(summary.report.found, true);
      assert.equal(summary.report_id, "REPORT-20260608-010-OPS-to-PM");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
