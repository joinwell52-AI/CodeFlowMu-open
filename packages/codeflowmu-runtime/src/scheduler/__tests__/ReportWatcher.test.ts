import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ReportWatcher } from "../ReportWatcher.ts";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.equal(predicate(), true, "timed out waiting for watcher event");
}

test("ReportWatcher treats immediate frontmatter enrichment as one add event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflowmu-report-watcher-"));
  const filename = "REPORT-20260713-101-QA-to-PM.md";
  const path = join(dir, filename);
  let reports = 0;
  let violations = 0;
  const watcher = new ReportWatcher({
    dir,
    onReport: () => {
      reports += 1;
    },
    onIntegrityViolation: () => {
      violations += 1;
    },
  });

  try {
    await watcher.start();
    await writeFile(path, "---\nstatus: done\n", "utf-8");
    await delay(100);
    await appendFile(path, "---\n\n# QA report\n", "utf-8");

    await waitFor(() => reports === 1);
    assert.equal(violations, 0);

    await appendFile(path, "\nlate mutation\n", "utf-8");
    await waitFor(() => violations === 1);
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
