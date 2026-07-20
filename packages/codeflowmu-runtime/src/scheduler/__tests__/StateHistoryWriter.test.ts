/**
 * StateHistoryWriter tests — Phase C TS-5.7 / TS-5.8 / TS-5.9.
 *
 * Scope:
 *   - TS-5.7: first append adds the section heading + bullet (and a separator)
 *   - TS-5.8: subsequent appends only add a bullet line (no duplicate heading)
 *   - TS-5.9: missing target file → throws TaskFileNotFoundError
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StateHistoryWriter } from "../StateHistoryWriter.ts";
import { TaskFileNotFoundError } from "../../registry/errors.ts";
import { withTempScheduler } from "./helpers.ts";

const MINIMAL_TASK = `---
protocol: fcop
task_id: TASK-20260509-001-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
status: pending
---

# Body
`;

describe("StateHistoryWriter", () => {
  it("TS-5.7: first append adds heading + bullet", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-001-PM-to-DEV.md");
      await writeFile(path, MINIMAL_TASK);

      const writer = new StateHistoryWriter();
      await writer.append(path, {
        at: "2026-05-09T16:00:00Z",
        by: "runtime",
        from: "inbox",
        to: "dispatched",
        note: "session_id=session-1-mzz",
      });

      const after = await readFile(path, "utf-8");
      // Heading appears exactly once.
      const headingMatches = after.match(
        /## state_history \(auto-appended by runtime\)/g,
      );
      assert.equal(headingMatches?.length, 1);
      // Bullet has the expected shape.
      assert.match(
        after,
        /- \*\*2026-05-09T16:00:00Z\*\* \| by `runtime` \| `inbox` → `dispatched` session_id=session-1-mzz/,
      );
      // Original body is preserved (no front-matter mutation).
      assert.match(after, /^---\nprotocol: fcop/);
      assert.match(after, /# Body/);
    });
  });

  it("TS-5.8: subsequent appends only add a bullet, never duplicate the heading", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-002-PM-to-DEV.md");
      await writeFile(path, MINIMAL_TASK);

      const writer = new StateHistoryWriter();
      await writer.append(path, {
        at: "2026-05-09T16:00:00Z",
        by: "runtime",
        from: "inbox",
        to: "dispatched",
      });
      await writer.append(path, {
        at: "2026-05-09T16:01:00Z",
        by: "runtime",
        from: "dispatched",
        to: "ended",
        note: "status=completed",
      });
      await writer.append(path, {
        at: "2026-05-09T16:02:00Z",
        by: "ADMIN",
        from: "ended",
        to: "archived",
      });

      const after = await readFile(path, "utf-8");
      const headingMatches = after.match(
        /## state_history \(auto-appended by runtime\)/g,
      );
      assert.equal(headingMatches?.length, 1, "heading must appear exactly once");

      const bulletLines = after
        .split("\n")
        .filter((l) => l.startsWith("- **"));
      assert.equal(bulletLines.length, 3);
      assert.match(bulletLines[0]!, /`inbox` → `dispatched`/);
      assert.match(bulletLines[1]!, /`dispatched` → `ended`/);
      assert.match(bulletLines[1]!, /status=completed/);
      assert.match(bulletLines[2]!, /by `ADMIN` \| `ended` → `archived`/);
    });
  });

  it("TS-5.9: missing target file → throws TaskFileNotFoundError", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-999-NEVER-WRITTEN.md");
      const writer = new StateHistoryWriter();

      await assert.rejects(
        () =>
          writer.append(path, {
            at: "2026-05-09T17:00:00Z",
            by: "runtime",
            from: "inbox",
            to: "parse_failed",
          }),
        (err) => {
          assert.ok(err instanceof TaskFileNotFoundError);
          assert.equal((err as TaskFileNotFoundError).filepath, path);
          return true;
        },
      );
    });
  });
});
