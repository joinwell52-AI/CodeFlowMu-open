import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendActionEvidence } from "../../logs/ActionEvidenceLogger.ts";
import { resetActionEventIdCounterForTests } from "../../logs/ActionEvidenceLogger.ts";
import { resolveReviewEvidence } from "../ReviewEvidenceResolver.ts";

describe("ReviewEvidenceResolver", () => {
  beforeEach(() => resetActionEventIdCounterForTests());
  afterEach(() => resetActionEventIdCounterForTests());

  it("resolveReviewEvidence aggregates files, commands, and report without verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-ev-res-"));
    try {
      const at = "2026-06-07T10:00:00.000Z";
      appendActionEvidence(root, {
        event_type: "file.read",
        at,
        task_id: "TASK-20260607-010",
        session_id: "sess-ev",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        path: "docs/spec.md",
        call_id: "c1",
      });
      appendActionEvidence(root, {
        event_type: "file.write",
        at,
        task_id: "TASK-20260607-010",
        session_id: "sess-ev",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        path: "src/patch.ts",
        call_id: "c2",
      });
      appendActionEvidence(root, {
        event_type: "command.run",
        at,
        task_id: "TASK-20260607-010",
        session_id: "sess-ev",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        command: "npm test",
        exit_code: 0,
        call_id: "c3",
      });
      appendActionEvidence(root, {
        event_type: "report.write",
        at,
        task_id: "TASK-20260607-010",
        session_id: "sess-ev",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        report_id: "REPORT-20260607-010-DEV-to-PM",
        path: "_lifecycle/review/REPORT-20260607-010-DEV-to-PM.md",
      });

      const summary = resolveReviewEvidence({
        projectRoot: root,
        task_id: "TASK-20260607-010",
        report_id: "REPORT-20260607-010-DEV-to-PM",
        session_id: "sess-ev",
      });

      assert.equal(summary.task_id, "TASK-20260607-010");
      assert.equal(summary.report_id, "REPORT-20260607-010-DEV-to-PM");
      assert.equal(summary.agent_id, "DEV");
      assert.equal(summary.session.found, true);
      assert.deepEqual(summary.files.read, ["docs/spec.md"]);
      assert.deepEqual(summary.files.changed, ["src/patch.ts"]);
      assert.equal(summary.commands.length, 1);
      assert.equal(summary.commands[0]!.command, "npm test");
      assert.equal(summary.report.found, true);
      assert.equal("pass" in summary, false, "must not include pass/fail verdict");
      assert.equal("needs_admin" in summary, false, "must not include needs_admin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("session.found is false when only report.write matches session_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-ev-res-"));
    try {
      const at = "2026-06-07T10:00:00.000Z";
      appendActionEvidence(root, {
        event_type: "report.write",
        at,
        task_id: "TASK-20260607-099",
        session_id: "sess-only-report",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        report_id: "REPORT-20260607-099-DEV-to-PM",
        path: "_lifecycle/review/REPORT-20260607-099-DEV-to-PM.md",
      });

      const summary = resolveReviewEvidence({
        projectRoot: root,
        task_id: "TASK-20260607-099",
        report_id: "REPORT-20260607-099-DEV-to-PM",
        session_id: "sess-only-report",
      });

      assert.equal(summary.session.found, false);
      assert.equal(summary.report.found, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when report_id not found in action log", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-ev-res-"));
    try {
      const summary = resolveReviewEvidence({
        projectRoot: root,
        report_id: "REPORT-missing",
      });
      assert.ok(
        summary.warnings.some((w) => w.includes("report_id")),
        `expected warning, got ${JSON.stringify(summary.warnings)}`,
      );
      assert.equal(summary.report.found, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches route-suffixed and canonical task ids as one task", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-ev-res-"));
    try {
      appendActionEvidence(root, {
        event_type: "command.run",
        at: "2026-07-12T10:00:00.000Z",
        task_id: "TASK-20260712-003-PM-to-QA",
        session_id: "session-d-mrhjbg2a",
        agent_id: "QA-01",
        role: "QA",
        status: "success",
        command: "npm test",
        exit_code: 0,
      });
      const summary = resolveReviewEvidence({
        projectRoot: root,
        task_id: "TASK-20260712-003",
      });
      assert.equal(summary.session.found, true);
      assert.equal(summary.commands.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
