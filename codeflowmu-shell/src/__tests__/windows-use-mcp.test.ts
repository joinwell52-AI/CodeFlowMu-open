import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWindowsUseMcpServer,
  mcpServersForAgentLayer,
  resolveWindowsUseHostPath,
} from "../sdk-factory.ts";
import { upsertWindowsUseTarget, writeWindowsUseAllowedTargetIds, writeWindowsUseSettings } from "../windows-use-settings.ts";

async function withHostFixture(
  run: (root: string, host: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "windows-use-mcp-"));
  const host = join(
    root,
    "packages",
    "codeflowmu-runtime",
    "src",
    "windows-use",
    "host",
    "windows_use_host.py",
  );
  try {
    await mkdir(join(host, ".."), { recursive: true });
    await writeFile(host, "# fixture\n", "utf8");
    await run(root, host);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Windows Use MCP is opt-in", async () => {
  const previous = process.env.CODEFLOW_WINDOWS_USE_ENABLED;
  delete process.env.CODEFLOW_WINDOWS_USE_ENABLED;
  try {
    assert.equal(buildWindowsUseMcpServer("python", process.cwd()), undefined);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_WINDOWS_USE_ENABLED;
    else process.env.CODEFLOW_WINDOWS_USE_ENABLED = previous;
  }
});

test("Cursor capability bus mounts the Windows Use stdio server", async () => {
  await withHostFixture(async (root, host) => {
    const previousEnabled = process.env.CODEFLOW_WINDOWS_USE_ENABLED;
    const previousAllowed = process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS;
    process.env.CODEFLOW_WINDOWS_USE_ENABLED = "1";
    process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS = "notepad.exe";
    try {
      assert.equal(resolveWindowsUseHostPath(root), host);
      const config = buildWindowsUseMcpServer("python", root);
      const server = config?.["windows-use"] as
        | { command?: string; args?: string[]; env?: Record<string, string> }
        | undefined;
      assert.equal(server?.command, "python");
      assert.deepEqual(server?.args, ["-u", host, "--mcp"]);
      assert.equal(server?.env?.CODEFLOW_WINDOWS_USE_ALLOW_APPS, "notepad.exe");

      const bus = mcpServersForAgentLayer(
        { pythonBin: "python", projectRoot: root },
        "worker",
        "DEV-01",
      );
      assert.ok(bus?.fcop, "FCoP MCP must remain mounted");
      assert.ok(bus?.["windows-use"], "Windows Use MCP must join the Cursor capability bus");
    } finally {
      if (previousEnabled === undefined) delete process.env.CODEFLOW_WINDOWS_USE_ENABLED;
      else process.env.CODEFLOW_WINDOWS_USE_ENABLED = previousEnabled;
      if (previousAllowed === undefined) delete process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS;
      else process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS = previousAllowed;
    }
  });
});

test("project settings mount Windows Use without a Shell restart", async () => {
  await withHostFixture(async (root) => {
    const previousEnabled = process.env.CODEFLOW_WINDOWS_USE_ENABLED;
    const previousAllowed = process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS;
    delete process.env.CODEFLOW_WINDOWS_USE_ENABLED;
    delete process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS;
    try {
      assert.equal(buildWindowsUseMcpServer("python", root), undefined);
      writeWindowsUseSettings(root, {
        enabled: true,
        alwaysAllowedAppIds: ["notepad.exe"],
      });
      upsertWindowsUseTarget(root, {
        id: "company-erp",
        name: "Company ERP",
        type: "web",
        target: "https://erp.example.com",
        loginMethod: "qr_code",
        loginInstruction: "Wait for the user to scan.",
      }, {});
      writeWindowsUseAllowedTargetIds(root, ["company-erp"]);
      const mounted = buildWindowsUseMcpServer("python", root);
      const server = mounted?.["windows-use"] as { env?: Record<string, string> } | undefined;
      assert.equal(server?.env?.CODEFLOW_WINDOWS_USE_ALLOW_APPS, "notepad.exe");
      const profiles = JSON.parse(server?.env?.CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON ?? "[]") as Array<Record<string, unknown>>;
      assert.equal(profiles[0]?.["loginMethod"], "qr_code");
      assert.equal(profiles[0]?.["requiresUser"], true);
      assert.equal("password" in (profiles[0] ?? {}), false);
    } finally {
      if (previousEnabled === undefined) delete process.env.CODEFLOW_WINDOWS_USE_ENABLED;
      else process.env.CODEFLOW_WINDOWS_USE_ENABLED = previousEnabled;
      if (previousAllowed === undefined) delete process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS;
      else process.env.CODEFLOW_WINDOWS_USE_ALLOW_APPS = previousAllowed;
    }
  });
});

test("PM capability bus exposes Runtime governance tools and keeps them off workers", () => {
  const previous = process.env.CODEFLOWMU_PANEL_URL;
  process.env.CODEFLOWMU_PANEL_URL = "http://127.0.0.1:3199";
  try {
    const pm = mcpServersForAgentLayer(
      { pythonBin: "python", projectRoot: process.cwd() },
      "leader",
      "PM-01",
      "session-pm-planning-001",
    );
    const pmEnv = (pm?.fcop as { env?: Record<string, string> })?.env ?? {};
    const pmTools = new Set((pmEnv.FCOP_ALLOWED_TOOLS ?? "").split(","));
    assert(pmTools.has("pm.wake_downstream"));
    assert(pmTools.has("pm.detect_thread_stall"));
    assert.equal(pmEnv.CODEFLOWMU_AGENT_ID, "PM-01");
    assert.equal(pmEnv.CODEFLOWMU_SESSION_ID, "session-pm-planning-001");
    assert.equal(pmEnv.CODEFLOWMU_PANEL_URL, "http://127.0.0.1:3199");

    const dev = mcpServersForAgentLayer(
      { pythonBin: "python", projectRoot: process.cwd() },
      "worker",
      "DEV-01",
    );
    const devEnv = (dev?.fcop as { env?: Record<string, string> })?.env ?? {};
    assert(!(devEnv.FCOP_ALLOWED_TOOLS ?? "").includes("pm.wake_downstream"));
  } finally {
    if (previous === undefined) delete process.env.CODEFLOWMU_PANEL_URL;
    else process.env.CODEFLOWMU_PANEL_URL = previous;
  }
});
