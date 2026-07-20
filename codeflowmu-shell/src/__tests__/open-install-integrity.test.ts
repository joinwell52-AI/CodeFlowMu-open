import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startOpenInstallIntegrityGuard } from "../open-install-integrity.ts";

test("Open integrity shell restores tool code but leaves projects and legacy workspace writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-open-integrity-"));
  const toolFile = join(root, "packages", "runtime", "index.ts");
  const projectFile = join(root, "projects", "中文 Project", "index.html");
  const legacyProjectFile = join(root, "workspace", "legacy demo", "index.html");
  const injectedFile = join(root, "packages", "runtime", "injected.ts");
  const runtimeLedgerFile = join(root, "fcop", "ledger", "views", "PM.todo.md");
  const adoptedFile = join(root, "fcop", "adopted", "policy.md");
  await mkdir(join(root, "packages", "runtime"), { recursive: true });
  await mkdir(join(root, "projects", "中文 Project"), { recursive: true });
  await mkdir(join(root, "workspace", "legacy demo"), { recursive: true });
  await mkdir(join(root, "fcop", "adopted"), { recursive: true });
  await writeFile(toolFile, "export const safe = true;\n", "utf8");
  await writeFile(projectFile, "before", "utf8");
  await writeFile(legacyProjectFile, "legacy before", "utf8");
  await writeFile(adoptedFile, "protected policy\n", "utf8");

  const observed: Array<{ action: string }> = [];
  const guard = await startOpenInstallIntegrityGuard(root, {
    auditIntervalMs: 50,
    onEvent: (event) => observed.push(event),
  });
  try {
    await writeFile(toolFile, "export const compromised = true;\n", "utf8");
    await writeFile(injectedFile, "malicious();\n", "utf8");
    await writeFile(projectFile, "after", "utf8");
    await writeFile(legacyProjectFile, "legacy after", "utf8");
    await mkdir(join(root, "fcop", "ledger", "views"), { recursive: true });
    await writeFile(runtimeLedgerFile, "runtime view\n", "utf8");
    await writeFile(adoptedFile, "tampered policy\n", "utf8");
    await guard.auditNow();

    assert.equal(await readFile(toolFile, "utf8"), "export const safe = true;\n");
    await assert.rejects(() => readFile(injectedFile, "utf8"));
    assert.equal(await readFile(projectFile, "utf8"), "after");
    assert.equal(await readFile(legacyProjectFile, "utf8"), "legacy after");
    assert.equal(await readFile(runtimeLedgerFile, "utf8"), "runtime view\n");
    assert.equal(await readFile(adoptedFile, "utf8"), "protected policy\n");
    assert.ok(observed.some((event) => event.action === "restored"));
    assert.ok(observed.some((event) => event.action === "removed_untrusted"));
  } finally {
    guard.stop();
    await rm(root, { recursive: true, force: true });
  }
});
