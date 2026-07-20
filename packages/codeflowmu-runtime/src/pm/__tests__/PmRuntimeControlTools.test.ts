import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import {
  PM_RUNTIME_CONTROL_TOOL_DEFINITIONS,
  PM_RUNTIME_CONTROL_TOOL_NAMES,
  invokePmRuntimeControlTool,
} from "../PmRuntimeControlTools.ts";
import { PM_BUILTIN_SKILLS } from "../PmSkillManifest.ts";

describe("PmRuntimeControlTools", () => {
  it("keeps every PM builtin manifest skill backed by a real Runtime tool", () => {
    assert.deepEqual(
      [...PM_RUNTIME_CONTROL_TOOL_NAMES].sort(),
      PM_BUILTIN_SKILLS.map((skill) => skill.skill_id).sort(),
    );
    for (const definition of PM_RUNTIME_CONTROL_TOOL_DEFINITIONS) {
      assert.equal(definition.inputSchema.type, "object");
    }
  });

  it("calls the Runtime wake endpoint and returns the real session id", async () => {
    let received: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received = JSON.parse(raw) as Record<string, unknown>;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          plan: { task_id: "TASK-20260712-005" },
          result: {
            ok: true,
            outcome: "ok",
            agent_id: "DEV-01",
            session_id: "session-real-1",
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const result = await invokePmRuntimeControlTool({
        toolName: "pm.wake_downstream",
        args: {
          task_id: "TASK-20260712-005",
          role: "DEV",
          reason: "pm_programmatic_wake",
          thread_key: "thread-famous-sayings",
        },
        agentId: "PM-01",
        sessionId: "pm-session-1",
        panelUrl: `http://127.0.0.1:${address.port}`,
      });
      assert.equal(result.ok, true);
      assert.equal(result.session_id, "session-real-1");
      assert.equal(received?.["source"], "pm_agent_tool");
      assert.equal(received?.["caller_session_id"], "pm-session-1");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("rejects non-PM callers before touching Runtime", async () => {
    const result = await invokePmRuntimeControlTool({
      toolName: "pm.wake_downstream",
      args: { task_id: "TASK-20260712-005", role: "DEV" },
      agentId: "DEV-01",
      panelUrl: "http://127.0.0.1:1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "error");
  });

  it("forwards planning evidence with the real caller Session", async () => {
    let received: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received = JSON.parse(raw) as Record<string, unknown>;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, invocation: { invocation_id: "inv-1" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const result = await invokePmRuntimeControlTool({
        toolName: "pm.record_planning_skill_evidence",
        args: {
          skill_id: "pm-product-design-brief",
          task_id: "TASK-20260712-901",
          input_context: "target users",
          output_summary: "selected workflow",
          brief_section: "用户流程",
          product_decisions: ["task-first flow"],
        },
        agentId: "PM-01",
        sessionId: "session-real-pm-901",
        panelUrl: `http://127.0.0.1:${address.port}`,
      });
      assert.equal(result.ok, true);
      assert.equal(received?.["session_id"], "session-real-pm-901");
      assert.deepEqual(received?.["product_decisions"], ["task-first flow"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("writes planning Markdown through Runtime instead of shell", async () => {
    let received: Record<string, unknown> | null = null;
    let requestPath = "";
    const server = createServer((req, res) => {
      requestPath = req.url ?? "";
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received = JSON.parse(raw) as Record<string, unknown>;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, artifact: { revision: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const result = await invokePmRuntimeControlTool({
        toolName: "pm.write_planning_artifact",
        args: {
          task_id: "TASK-20260712-902",
          body_markdown: "# Product Brief\n\n## 产品目标\n交付站会小助手。",
          status: "ready",
        },
        agentId: "PM-01",
        sessionId: "session-real-pm-902",
        panelUrl: `http://127.0.0.1:${address.port}`,
      });
      assert.equal(result.ok, true);
      assert.equal(requestPath, "/api/v2/pm/governance/planning-artifact");
      assert.equal(received?.["session_id"], "session-real-pm-902");
      assert.equal(received?.["caller_role"], "PM-01");
      assert.match(String(received?.["body_markdown"]), /站会小助手/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});
