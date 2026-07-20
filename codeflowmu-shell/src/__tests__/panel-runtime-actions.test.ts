/**
 * panel-runtime-actions — append / query / runtime-events mapping
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  actionEvidenceToPanelAction,
  appendPanelRuntimeAction,
  mergeConsecutiveAgentFileEdits,
  queryPanelRuntimeActions,
  runtimeEventToPanelAction,
  readPanelActionsFromDisk,
  fcopLogsPanelActionsPath,
  mergeTaskLifecycleActions,
  shortenDisplayPath,
} from "../panel-runtime-actions.ts";
import { appendActionEvidence } from "@codeflowmu/runtime";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cf-panel-actions-"));
  mkdirSync(join(root, "fcop", "logs", "runtime"), { recursive: true });
  return root;
}

describe("panel-runtime-actions", () => {
  it("appendPanelRuntimeAction writes JSONL with required fields", () => {
    const root = makeRoot();
    const rec = appendPanelRuntimeAction(root, {
      operator: "ADMIN",
      action: "nudge",
      target_agent: "PM-01",
      target_task: "TASK-20260610-009",
      result: "ok",
    });
    assert.equal(rec.action, "nudge");
    assert.equal(rec.operator, "ADMIN");
    assert.equal(rec.result, "ok");
    const path = fcopLogsPanelActionsPath(root);
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { action: string; target_agent: string };
    assert.equal(parsed.action, "nudge");
    assert.equal(parsed.target_agent, "PM-01");
  });

  it("persists PM stop cooldown and ADMIN recovery guidance", () => {
    const root = makeRoot();
    const rec = appendPanelRuntimeAction(root, {
      operator: "PM",
      action: "pm_stop",
      target_agent: "DEV-01",
      target_task: "TASK-20260615-001",
      result: "skipped",
      reason: "wake_throttled",
      current_leg: "DEV",
      cooldownReason: "SDK_CIRCUIT_OPEN",
      remainingMs: 4200,
      untilMs: 123456,
      policy: "PM_STOP",
      next_owner: "ADMIN",
      message: "PM 已停手，不再重复 wake/recover",
    });
    assert.equal(rec.action, "pm_stop");
    assert.equal(rec.remainingMs, 4200);
    assert.equal(rec.cooldownReason, "SDK_CIRCUIT_OPEN");
    assert.equal(rec.policy, "PM_STOP");
    assert.equal(rec.next_owner, "ADMIN");
    assert.match(rec.message ?? "", /PM 已停手/);
  });

  it("runtimeEventToPanelAction maps wake_agent.skipped with reason", () => {
    const mapped = runtimeEventToPanelAction({
      ts: 1000,
      at: "2026-06-10T00:00:01.000Z",
      event_type: "wake_agent.skipped",
      agent_id: "OPS-01",
      task_id: "TASK-20260610-001",
      payload: { reason: "agent busy", role: "PM" },
    });
    assert.ok(mapped);
    assert.equal(mapped!.action, "wake");
    assert.equal(mapped!.result, "skipped");
    assert.equal(mapped!.reason, "agent busy");
    assert.equal(mapped!.target_agent, "OPS-01");
  });

  it("queryPanelRuntimeActions merges disk + runtime-events", () => {
    const root = makeRoot();
    appendPanelRuntimeAction(root, {
      operator: "ADMIN",
      action: "urge",
      target_task: "TASK-20260610-002",
      result: "ok",
      ts: 2000,
      at: "2026-06-10T00:00:02.000Z",
    });
    const eventsPath = join(root, "fcop", "logs", "runtime", "runtime-events-20260610.jsonl");
    writeFileSync(
      eventsPath,
      JSON.stringify({
        ts: 3000,
        at: "2026-06-10T00:00:03.000Z",
        event_type: "codeflowmu.agent_recycled",
        agent_id: "DEV-01",
        payload: { operator_role: "ADMIN", new_sdk_agent_id: "sdk-new-123" },
      }) + "\n",
      "utf-8",
    );
    const actions = queryPanelRuntimeActions(root, 10);
    assert.equal(actions.length, 2);
    assert.equal(actions[0]!.action, "swap_ai");
    assert.equal(actions[1]!.action, "urge");
    assert.equal(readPanelActionsFromDisk(root).length, 1);
  });

  it("runtimeEventToPanelAction maps runtime.session_ended with report_written", () => {
    const mapped = runtimeEventToPanelAction({
      ts: 4000,
      at: "2026-06-10T00:00:04.000Z",
      event_type: "runtime.session_ended",
      agent_id: "DEV-01",
      task_id: "TASK-20260610-021",
      session_id: "sess-1",
      payload: {
        status: "completed",
        report_written: true,
        report_path: "fcop/reports/REPORT-20260610-053-DEV-to-PM.md",
      },
    });
    assert.ok(mapped);
    assert.equal(mapped!.action, "report_written");
    assert.equal(mapped!.target_task, "TASK-20260610-021");
    assert.equal(mapped!.detail, "REPORT-20260610-053-DEV-to-PM");
  });

  it("mergeTaskLifecycleActions prefers report_written over dispatch for same task", () => {
    const merged = mergeTaskLifecycleActions([
      {
        ts: 1000,
        at: "t1",
        operator: "system",
        action: "dispatch",
        target_task: "TASK-20260610-021",
        target_agent: "DEV-01",
        result: "ok",
      },
      {
        ts: 2000,
        at: "t2",
        operator: "DEV-01",
        action: "report_written",
        target_task: "TASK-20260610-021",
        target_agent: "DEV-01",
        result: "ok",
        detail: "REPORT-20260610-053-DEV-to-PM",
      },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.action, "report_written");
    assert.equal(merged[0]!.raw_events?.length, 2);
  });

  it("mergeTaskLifecycleActions prefers approve over dispatch and report_written", () => {
    const merged = mergeTaskLifecycleActions([
      {
        ts: 1000,
        at: "t1",
        operator: "system",
        action: "dispatch",
        target_task: "TASK-20260610-021",
        result: "ok",
      },
      {
        ts: 2000,
        at: "t2",
        operator: "DEV-01",
        action: "report_written",
        target_task: "TASK-20260610-021",
        result: "ok",
      },
      {
        ts: 3000,
        at: "t3",
        operator: "ADMIN",
        action: "approve",
        target_task: "TASK-20260610-021",
        result: "ok",
      },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.action, "approve");
  });

  it("shortenDisplayPath collapses long absolute paths", () => {
    assert.equal(
      shortenDisplayPath("D:/codeflowmu/codeflowmu-desktop/panel/index.html"),
      "codeflowmu-desktop/panel/index.html",
    );
    assert.equal(shortenDisplayPath("panel/index.html"), "panel/index.html");
  });

  it("actionEvidenceToPanelAction builds ADMIN-readable edit summary", () => {
    const mapped = actionEvidenceToPanelAction({
      schema_version: "action-log-v1",
      event_id: "act-20260610-000001",
      event_type: "file.edit",
      at: "2026-06-10T14:00:00.000Z",
      task_id: "TASK-20260610-038",
      session_id: "sess-1",
      agent_id: "DEV-01",
      role: "DEV",
      source: "codeflowmu-runtime",
      status: "success",
      path: "codeflowmu-desktop/panel/index.html",
      change_type: "modified",
    });
    assert.equal(mapped.action, "agent_edit");
    assert.equal(mapped.operator, "DEV-01");
    assert.equal(mapped.object_short, "codeflowmu-desktop/panel/index.html");
    assert.ok(mapped.intent?.includes("Panel"));
    assert.equal(mapped.result_summary, "已修改");
  });

  it("mergeConsecutiveAgentFileEdits merges same-file edits", () => {
    const base = {
      ts: 1000,
      at: "t1",
      operator: "DEV-01",
      action: "agent_edit",
      target_task: "TASK-20260610-038",
      result: "ok" as const,
      object_short: "panel/index.html",
      op_type: "修改",
      intent: "修改 Panel",
      result_summary: "已修改",
    };
    const merged = mergeConsecutiveAgentFileEdits([
      { ...base, ts: 1000, at: "t1" },
      { ...base, ts: 2000, at: "t2" },
      { ...base, ts: 3000, at: "t3" },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.edit_count, 3);
    assert.equal(merged[0]!.result_summary, "已修改 3 处");
  });

  it("queryPanelRuntimeActions includes action evidence summaries", () => {
    const root = makeRoot();
    appendActionEvidence(root, {
      event_type: "file.edit",
      at: "2026-06-10T14:00:01.000Z",
      task_id: "TASK-20260610-038",
      session_id: "sess-a",
      agent_id: "DEV-01",
      role: "DEV",
      status: "success",
      path: "codeflowmu-shell/src/panel-runtime-actions.ts",
      change_type: "modified",
    });
    appendActionEvidence(root, {
      event_type: "command.run",
      at: "2026-06-10T14:00:02.000Z",
      task_id: "TASK-20260610-038",
      session_id: "sess-a",
      agent_id: "DEV-01",
      role: "DEV",
      status: "success",
      command: "npx tsx --test src/__tests__/panel-runtime-actions.test.ts",
      exit_code: 0,
    });
    const actions = queryPanelRuntimeActions(root, 10);
    assert.ok(actions.some((a) => a.action === "agent_edit"));
    assert.ok(actions.some((a) => a.action === "agent_command"));
    assert.ok(
      actions.some(
        (a) => a.action === "agent_edit" && a.operator === "DEV-01",
      ),
    );
  });

  it("queryPanelRuntimeActions merges dispatch then report for same task_id", () => {
    const root = makeRoot();
    const eventsPath = join(root, "fcop", "logs", "runtime", "runtime-events-20260610.jsonl");
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          ts: 1000,
          at: "2026-06-10T00:00:01.000Z",
          event_type: "codeflowmu.task_dispatched",
          task_id: "TASK-20260610-021",
          payload: { recipient: "DEV-01", role: "DEV" },
        }),
        JSON.stringify({
          ts: 2000,
          at: "2026-06-10T00:00:02.000Z",
          event_type: "runtime.session_ended",
          agent_id: "DEV-01",
          task_id: "TASK-20260610-021",
          payload: {
            status: "completed",
            report_written: true,
            report_path: "fcop/reports/REPORT-20260610-053-DEV-to-PM.md",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const actions = queryPanelRuntimeActions(root, 10);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.action, "report_written");
    assert.equal(actions[0]!.raw_events?.length, 2);
  });
});
