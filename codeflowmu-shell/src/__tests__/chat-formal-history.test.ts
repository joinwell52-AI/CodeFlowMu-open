import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { collectFormalChatHistory } from "../chat-formal-history.ts";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cf-chat-history-"));
  const lifecycle = join(root, "fcop", "_lifecycle");
  for (const stage of ["inbox", "active", "review", "done", "archive"]) {
    mkdirSync(join(lifecycle, stage), { recursive: true });
  }
  mkdirSync(join(root, "fcop", "reports"), { recursive: true });
  writeFileSync(
    join(root, "fcop", "fcop.json"),
    JSON.stringify({ protocol_version: 3 }),
    "utf-8",
  );
  return root;
}

describe("chat-formal-history", () => {
  it("collectFormalChatHistory merges lifecycle TASK + reports with full body", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "fcop", "_lifecycle", "archive", "TASK-20260610-204-ADMIN-to-PM.md"),
      [
        "---",
        "task_id: TASK-20260610-204",
        "priority: P1",
        "created_at: 2026-06-10T10:00:00+08:00",
        "---",
        "# Admin task body 204",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(root, "fcop", "_lifecycle", "inbox", "TASK-20260610-205-ADMIN-to-PM.md"),
      "---\ntask_id: TASK-20260610-205\n---\n# Admin task body 205\n",
      "utf-8",
    );
    writeFileSync(
      join(root, "fcop", "reports", "REPORT-20260610-060-PM-to-ADMIN.md"),
      [
        "---",
        "task_id: TASK-20260610-204",
        "attachments:",
        "  - type: image",
        '    local_path: "fcop/attachments/20260610/shot.png"',
        '    mime: "image/png"',
        "---",
        "## PM summary",
        "Done.",
      ].join("\n"),
      "utf-8",
    );

    const entries = collectFormalChatHistory(root, 60);
    assert.equal(entries.length, 3);
    const admin204 = entries.find((e) => e.filename.includes("204-ADMIN"));
    const admin205 = entries.find((e) => e.filename.includes("205-ADMIN"));
    const pm060 = entries.find((e) => e.filename.includes("060-PM"));
    assert.ok(admin204);
    assert.match(admin204!.text, /Admin task body 204/);
    assert.equal(admin204!.priority, "P1");
    assert.ok(admin205);
    assert.match(admin205!.text, /Admin task body 205/);
    assert.ok(pm060);
    assert.match(pm060!.text, /PM summary/);
    assert.equal(pm060!.attachments?.length, 1);
    assert.equal(pm060!.attachments?.[0]?.local_path, "fcop/attachments/20260610/shot.png");

    rmSync(root, { recursive: true, force: true });
  });

  it("collectFormalChatHistory returns last N entries sorted by filename seq", () => {
    const root = makeRoot();
    for (let i = 1; i <= 5; i++) {
      const n = String(i).padStart(3, "0");
      writeFileSync(
        join(root, "fcop", "_lifecycle", "inbox", `TASK-20260610-${n}-ADMIN-to-PM.md`),
        `---\n---\n# T${i}\n`,
        "utf-8",
      );
    }
    const entries = collectFormalChatHistory(root, 3);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]!.filename, "TASK-20260610-003-ADMIN-to-PM.md");
    assert.equal(entries[2]!.filename, "TASK-20260610-005-ADMIN-to-PM.md");
    rmSync(root, { recursive: true, force: true });
  });
});
