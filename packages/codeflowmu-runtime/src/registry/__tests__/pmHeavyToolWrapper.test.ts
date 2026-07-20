import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPmHeavyToolWrapper,
  shouldAllowPmFcopCheck,
} from "../pmHeavyToolWrapper.ts";

describe("pmHeavyToolWrapper", () => {
  it("passes through non-PM roles unchanged", () => {
    const result = applyPmHeavyToolWrapper("DEV", "fcop_check", {}, {
      agentId: "DEV-01",
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.args, {});
  });

  it("caps list_reports limit and injects task_id scope for PM", () => {
    const result = applyPmHeavyToolWrapper(
      "PM",
      "list_reports",
      { limit: 100 },
      { taskId: "TASK-20260612-001-PM-to-DEV", agentId: "PM-01" },
    );
    assert.equal(result.allowed, true);
    assert.equal(result.args.limit, 20);
    assert.equal(result.args.task_id, "TASK-20260612-001-PM-to-DEV");
  });

  it("defaults fcop_report full=false for PM", () => {
    const result = applyPmHeavyToolWrapper("PM", "fcop_report", {}, {
      agentId: "PM-01",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.args.full, false);
  });

  it("preserves fcop_report full=true for PM", () => {
    const result = applyPmHeavyToolWrapper("PM", "fcop_report", { full: true }, {
      agentId: "PM-01",
    });
    assert.equal(result.args.full, true);
  });

  it("soft-skips fcop_check on routine PM patrol prompt", () => {
    const prompt = [
      "[PM 轻量巡检/催促 - 非正式派单 · 勿 write_task]",
      "你是 PM（leader）。请用有限次 MCP 完成生命周期巡检",
      "1. fcop_report() 或 get_team_status（二选一）",
    ].join("\n");
    const result = applyPmHeavyToolWrapper("PM", "fcop_check", {}, {
      agentId: "PM-01",
      promptRoutingText: prompt,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.skipMessage);
    const parsed = JSON.parse(result.skipMessage!) as { skipped: boolean };
    assert.equal(parsed.skipped, true);
    assert.equal(result.args.full, false);
  });

  it("allows fcop_check on ADMIN Hot Path prompt", () => {
    const prompt = [
      "[ADMIN ↔ PM · ADMIN 打回协调 · Hot Path（PM 治理核查/协调 · 不代表可修改产品代码）]",
      "**必做**：fcop_report → fcop_check → read_file/grep_files 探针 → write_report(status=done)。",
    ].join("\n");
    assert.equal(
      shouldAllowPmFcopCheck({ agentId: "PM-01", promptRoutingText: prompt }, {}),
      true,
    );
    const result = applyPmHeavyToolWrapper("PM", "fcop_check", {}, {
      agentId: "PM-01",
      promptRoutingText: prompt,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.args.full, false);
  });

  it("allows fcop_check when full=true", () => {
    const result = applyPmHeavyToolWrapper(
      "PM",
      "fcop_check",
      { full: true },
      { agentId: "PM-01", promptRoutingText: "routine patrol" },
    );
    assert.equal(result.allowed, true);
    assert.equal(result.args.full, true);
  });
});
