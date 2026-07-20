import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsUsePolicy } from "../policy.ts";
import { WindowsUseProvider } from "../WindowsUseProvider.ts";
import { buildWindowsUseToolDeclarations } from "../tools.ts";
import { WindowsUseError } from "../types.ts";

test("policy requires explicit app approval and blocks terminal apps", () => {
  const policy = new WindowsUsePolicy({ alwaysAllowedAppIds: ["notepad.exe"] });
  assert.equal(policy.assertAppAllowed("C:\\Windows\\notepad.exe"), "notepad.exe");
  assert.throws(
    () => policy.assertAppAllowed("calc.exe"),
    (error: unknown) => error instanceof WindowsUseError && error.code === "APP_APPROVAL_REQUIRED",
  );
  assert.throws(
    () => policy.assertAppAllowed("powershell.exe"),
    (error: unknown) => error instanceof WindowsUseError && error.code === "APP_BLOCKED",
  );
});

test("provider routes approved calls and redacts typed text from audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-windows-use-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    const provider = new WindowsUseProvider({
      projectRoot: root,
      alwaysAllowedAppIds: ["notepad.exe"],
      runHost: async (request) => {
        seen.push(request as unknown as Record<string, unknown>);
        return { ok: true, result: { typed: true } };
      },
    });
    const result = await provider.execute("windows.type_text", {
      app_id: "notepad.exe",
      window_id: "0x123",
      text: "secret-value",
    });
    assert.deepEqual(result, { typed: true });
    assert.equal(seen[0]?.command, "type_text");

    const key = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const log = await readFile(
      join(root, "fcop", "logs", "runtime", `windows-use-${key}.jsonl`),
      "utf8",
    );
    assert.doesNotMatch(log, /secret-value/);
    assert.match(log, /text_sha256/);
    assert.match(log, /text_length/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider rejects native execution outside Windows", async () => {
  const provider = new WindowsUseProvider({
    projectRoot: "/tmp/codeflowmu",
    platform: "linux",
  });
  await assert.rejects(
    () => provider.execute("windows.capabilities", {}),
    (error: unknown) => error instanceof WindowsUseError && error.code === "WINDOWS_ONLY",
  );
});

test("tool catalog exposes bounded Windows Use surface", () => {
  const declarations = buildWindowsUseToolDeclarations();
  assert.equal(declarations.length, 10);
  assert.deepEqual(
    declarations.map((item) => item.name),
    [
      "windows.capabilities",
      "windows.list_apps",
      "windows.screenshot",
      "windows.inspect_ui",
      "windows.click",
      "windows.type_text",
      "windows.keypress",
      "windows.scroll",
      "windows.invoke_ui",
      "windows.cancel",
    ],
  );
});
