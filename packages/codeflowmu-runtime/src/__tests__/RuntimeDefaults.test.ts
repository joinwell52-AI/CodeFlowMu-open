import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemorySdkAdapter } from "../registry/AgentSdkAdapter.ts";
import { Runtime } from "../Runtime.ts";
import { plantSkill, quietLogger } from "../skill/__tests__/helpers.ts";

async function withTempRuntime(
  fn: (ctx: {
    rootDir: string;
    stateDir: string;
    inboxDir: string;
    reportsDir: string;
    skillsDir: string;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-runtime-defaults-"));
  const stateDir = join(rootDir, ".codeflowmu", "state");
  const lifecycleRoot = join(rootDir, "fcop", "_lifecycle");
  const inboxDir = join(lifecycleRoot, "inbox");
  const reportsDir = join(rootDir, "fcop", "reports");
  const skillsDir = join(stateDir, "skills");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(join(lifecycleRoot, "active"), { recursive: true });
  await mkdir(join(lifecycleRoot, "review"), { recursive: true });
  await mkdir(join(lifecycleRoot, "done"), { recursive: true });
  await mkdir(join(lifecycleRoot, "archive"), { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await plantSkill(skillsDir, { skill_id: "fcop" });

  try {
    await fn({ rootDir, stateDir, inboxDir, reportsDir, skillsDir });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("Runtime default fix-slice gates", () => {
  it("keeps ReviewEngine disabled unless legacyReviewEngine=true", async () => {
    await withTempRuntime(async ({ stateDir, inboxDir, reportsDir, skillsDir }) => {
      const runtime = await Runtime.create({
        sdkAdapter: new InMemorySdkAdapter(),
        persistDir: stateDir,
        inboxDir,
        fcopReportsDir: reportsDir,
        skillsDir,
        logger: quietLogger(),
      });
      (
        runtime.reviewEngine as unknown as { start: () => void }
      ).start = () => {
        throw new Error("legacy review engine should be disabled by default");
      };

      await runtime.start();
      await runtime.stop();
    });
  });

  it("keeps ReportDispatcher disabled by default while ReportWatcher stays active", async () => {
    await withTempRuntime(async ({ stateDir, inboxDir, reportsDir, skillsDir }) => {
      const runtime = await Runtime.create({
        sdkAdapter: new InMemorySdkAdapter(),
        persistDir: stateDir,
        inboxDir,
        fcopReportsDir: reportsDir,
        skillsDir,
        logger: quietLogger(),
      });

      assert.ok(runtime.reportWatcher);
      assert.equal(runtime.reportDispatcher, null);
    });
  });

  it("enables ReportDispatcher only through legacyReportDispatcher=true", async () => {
    await withTempRuntime(async ({ stateDir, inboxDir, reportsDir, skillsDir }) => {
      const runtime = await Runtime.create({
        sdkAdapter: new InMemorySdkAdapter(),
        persistDir: stateDir,
        inboxDir,
        fcopReportsDir: reportsDir,
        skillsDir,
        legacyReportDispatcher: true,
        logger: quietLogger(),
      });

      assert.ok(runtime.reportWatcher);
      assert.ok(runtime.reportDispatcher);
    });
  });
});
