import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { quarantineStaleReportTmps } from "../report-tmp-quarantine.ts";

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "codeflowmu-quarantine-"));
}

const REPORT = "REPORT-20260509-001-DEV-to-PM.md";

test("quarantine: stale tmp with existing md moves to internal quarantine", async () => {
  const root = newTempDir();
  const reportsDir = join(root, "fcop", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const tmpName = `${REPORT}.999.1.deadbeef.tmp`;
  const tmpPath = join(reportsDir, tmpName);
  const mdPath = join(reportsDir, REPORT);

  await fs.writeFile(mdPath, "# done\n", "utf-8");
  await fs.writeFile(tmpPath, "partial", "utf-8");

  const old = Date.now() - 6 * 60 * 1000;
  await fs.utimes(tmpPath, old / 1000, old / 1000);

  const result = await quarantineStaleReportTmps(reportsDir, root);
  assert.deepEqual(result.quarantined, [tmpName]);
  assert.deepEqual(result.orphans, []);

  const quarantinePath = join(
    root,
    "fcop",
    "internal",
    "quarantine",
    "tmp-reports",
    tmpName,
  );
  await fs.access(quarantinePath);
  await fs.access(mdPath);
  await assert.rejects(() => fs.access(tmpPath));
});

test("quarantine: tmp only is orphan, not deleted", async () => {
  const root = newTempDir();
  const reportsDir = join(root, "fcop", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const tmpName = `${REPORT}.12345.${Date.now()}.cafebabe.tmp`;
  const tmpPath = join(reportsDir, tmpName);
  await fs.writeFile(tmpPath, "orphan", "utf-8");

  const old = Date.now() - 6 * 60 * 1000;
  await fs.utimes(tmpPath, old / 1000, old / 1000);

  const warns: string[] = [];
  const result = await quarantineStaleReportTmps(reportsDir, root, {
    warn: (m) => warns.push(m),
  });

  assert.deepEqual(result.orphans, [tmpName]);
  assert.deepEqual(result.quarantined, []);
  await fs.access(tmpPath);
  assert.ok(warns.some((w) => w.includes("orphan_tmp_report")));
});

test("quarantine: fresh tmp with md is left in place", async () => {
  const root = newTempDir();
  const reportsDir = join(root, "fcop", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const tmpName = `${REPORT}.12345.${Date.now()}.cafebabe.tmp`;
  await fs.writeFile(join(reportsDir, REPORT), "# ok\n", "utf-8");
  await fs.writeFile(join(reportsDir, tmpName), "writing", "utf-8");

  const result = await quarantineStaleReportTmps(reportsDir, root);
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(result.orphans, []);
  await fs.access(join(reportsDir, tmpName));
});
