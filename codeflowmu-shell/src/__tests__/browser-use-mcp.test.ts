import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBrowserUseMcpServer } from "../sdk-factory.ts";
import { upsertBrowserUseTarget, writeBrowserUseSettings } from "../browser-use-settings.ts";

test("Browser Use MCP is opt-in and mounts for approved Chrome or Edge targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-use-mcp-"));
  try {
    assert.equal(buildBrowserUseMcpServer(root), undefined);
    upsertBrowserUseTarget(root, {
      id: "edge-erp", name: "Edge ERP", url: "https://erp.example.com", browser: "edge", loginMethod: "none",
    }, {});
    writeBrowserUseSettings(root, { enabled: true, allowedTargetIds: ["edge-erp"] });
    const server = buildBrowserUseMcpServer(root)?.["browser-use"] as { command?: string; args?: string[]; env?: Record<string, string> };
    assert.equal(server.command, "tsx");
    assert.ok(server.args?.[0]?.endsWith("browser-use-mcp.ts"));
    assert.equal(server.env?.FCOP_PROJECT_DIR, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
