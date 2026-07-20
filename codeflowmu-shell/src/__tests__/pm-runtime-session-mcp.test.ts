import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";

test("filtered PM MCP forwards the active Runtime session to planning-artifact", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, artifact: { revision: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const filterScript = join(import.meta.dirname, "..", "fcop-mcp-filter.ts");
  const child = spawn(process.execPath, ["--import", "tsx", filterScript], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: {
      ...process.env,
      FCOP_ALLOWED_TOOLS: "pm.write_planning_artifact",
      FCOP_PROJECT_DIR: process.cwd(),
      CODEFLOWMU_AGENT_ID: "PM-01",
      CODEFLOWMU_SESSION_ID: "session-pm-planning-e2e",
      CODEFLOWMU_PANEL_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const lines = createInterface({ input: child.stdout });
    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for MCP response")), 10_000);
      lines.once("line", (line) => {
        clearTimeout(timeout);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "pm.write_planning_artifact",
        arguments: {
          task_id: "TASK-20260712-001",
          body_markdown: "# Product Brief\n\n## Product goal\nBuild FlowBoard.",
          status: "ready",
        },
      },
    })}\n`);

    const response = await responsePromise;
    const result = response["result"] as Record<string, unknown>;
    assert.equal(result["isError"], false);
    assert.equal(receivedBody?.["session_id"], "session-pm-planning-e2e");
    assert.equal(receivedBody?.["caller_role"], "PM-01");
    assert.equal(receivedBody?.["task_id"], "TASK-20260712-001");
  } finally {
    child.kill();
    server.close();
    await once(server, "close");
  }
});
