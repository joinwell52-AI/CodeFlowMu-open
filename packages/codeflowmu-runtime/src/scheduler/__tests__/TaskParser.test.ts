/**
 * TaskParser tests — Phase C TS-5.4 / TS-5.5 / TS-5.6 + Day 2 fcop bridge tests.
 *
 * Scope:
 *   - TS-5.4: a well-formed TASK file parses front-matter + body correctly
 *   - TS-5.5: a file with no front-matter returns `frontmatter: {}` (not throws)
 *   - TS-5.6: malformed YAML throws `TaskParseError` with `cause` chain
 *   - TS-TP-D2-1: instance API w/o fcopClient = static yaml behavior (backward compat)
 *   - TS-TP-D2-2: instance API with fcopClient stub → delegates to client.readTask;
 *                 ParsedTask is shaped from FcopTask (incl. layer from frontmatter.extra)
 *   - TS-TP-D2-3: fcopClient.readTask throws FcopClientError → falls back to yaml parse
 *   - TS-TP-D2-4: fcopClient throws AND yaml is also malformed → throws TaskParseError
 *                 (with the fcop error message preserved in `.message`)
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FcopClientError,
  type FcopProjectClient,
  type FcopTask,
} from "../../_external/fcop-client.ts";
import { TaskParser } from "../TaskParser.ts";
import { TaskParseError } from "../../registry/errors.ts";
import { withTempScheduler } from "./helpers.ts";

/**
 * Stub factory for a minimal `FcopProjectClient`. Each test that needs a
 * specific behavior overrides `readTask` (the only method TaskParser
 * actually calls). The stub never spins up pythonia, so these tests stay
 * fast and offline.
 */
function stubFcopClient(impl: {
  readTask: (filenameOrId: string) => Promise<FcopTask>;
}): FcopProjectClient {
  return impl as unknown as FcopProjectClient;
}

/**
 * Build a minimal `FcopTask` matching fcop@1.1.0's actual shape — nested
 * `frontmatter` with `extra` for codeflowmu-specific keys like `layer`.
 * Defaults reflect the most common test setup; pass overrides for
 * targeted assertions.
 */
function fakeFcopTask(overrides: Partial<FcopTask> = {}): FcopTask {
  const baseFrontmatter = {
    protocol: "fcop",
    version: 1,
    sender: "PM",
    recipient: "DEV",
    priority: "P1",
    thread_key: "example-thread" as string | null,
    subject: "test subject",
    references: [] as string[],
    risk_level: "low",
    extra: { layer: "worker" } as Record<string, unknown>,
    ...(overrides.frontmatter ?? {}),
  };
  return {
    task_id: "TASK-20260511-001",
    filename: "TASK-20260511-001-PM-to-DEV.md",
    path: "/fake/inbox/TASK-20260511-001-PM-to-DEV.md",
    date: "20260511",
    sequence: 1,
    body: "# fcop-shaped body\n",
    is_archived: false,
    sender: baseFrontmatter.sender,
    recipient: baseFrontmatter.recipient,
    priority: baseFrontmatter.priority,
    subject: baseFrontmatter.subject,
    thread_key: baseFrontmatter.thread_key,
    risk_level: baseFrontmatter.risk_level,
    references: baseFrontmatter.references,
    frontmatter: baseFrontmatter,
    ...overrides,
  };
}

describe("TaskParser", () => {
  it("TS-5.4: parses well-formed front-matter + body", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-001-PM-to-DEV.md");
      const body = `---
protocol: fcop
task_id: TASK-20260509-001-PM-to-DEV
sender: PM
recipient: DEV
priority: P1
thread_key: example-thread
layer: worker
status: pending
---

# Body line 1
Body line 2
`;
      await writeFile(path, body);

      const parsed = await TaskParser.parse(path);
      assert.equal(parsed.task_id, "TASK-20260509-001-PM-to-DEV");
      assert.equal(parsed.sender, "PM");
      assert.equal(parsed.recipient, "DEV");
      assert.equal(parsed.priority, "P1");
      assert.equal(parsed.thread_key, "example-thread");
      assert.equal(parsed.layer, "worker");
      assert.equal(parsed.frontmatter["protocol"], "fcop");
      assert.match(parsed.body, /# Body line 1/);
      assert.match(parsed.body, /Body line 2/);
      // Body must NOT contain the closing `---` delimiter.
      assert.ok(!parsed.body.startsWith("---"));
    });
  });

  it("TS-5.5: tolerates a file with no front-matter", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-002-PM-to-DEV.md");
      await writeFile(path, "# just a body, no yaml block\n");

      const parsed = await TaskParser.parse(path);
      assert.deepEqual(parsed.frontmatter, {});
      assert.equal(parsed.task_id, undefined);
      assert.equal(parsed.priority, undefined);
      assert.equal(parsed.body, "# just a body, no yaml block\n");
    });
  });

  it("TS-5.6: throws TaskParseError on malformed YAML front-matter", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-003-PM-to-DEV.md");
      // Unbalanced quote inside a string value will trip the YAML parser.
      const body = `---
protocol: fcop
task_id: "TASK-20260509-003-PM-to-DEV
sender: PM
---

# body
`;
      await writeFile(path, body);

      await assert.rejects(
        () => TaskParser.parse(path),
        (err) => {
          assert.ok(err instanceof TaskParseError);
          assert.equal((err as TaskParseError).filepath, path);
          assert.match(
            (err as Error).message,
            /YAML front-matter parse failed/,
          );
          // Cause chain preserved (the underlying yaml-package error).
          assert.ok((err as TaskParseError).cause !== undefined);
          return true;
        },
      );
    });
  });

  it("bonus: tolerates an opening --- without a closing ---", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260509-004-PM-to-DEV.md");
      // Half-written file caught by the watcher mid-edit.
      await writeFile(path, "---\nprotocol: fcop\nsender: PM\n");

      const parsed = await TaskParser.parse(path);
      assert.deepEqual(parsed.frontmatter, {});
      assert.equal(parsed.task_id, undefined);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Day 2 (TASK-20260511-009 P4 sprint) — instance API + fcop bridge
  // ─────────────────────────────────────────────────────────────────────

  it("TS-TP-D2-1: instance API without fcopClient = identical to static yaml behavior", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260511-001-PM-to-DEV.md");
      const source = `---
protocol: fcop
task_id: TASK-20260511-001-PM-to-DEV
sender: PM
recipient: DEV
priority: P1
thread_key: example-thread
layer: worker
---

# body
`;
      await writeFile(path, source);

      const instance = new TaskParser();
      const parsed = await instance.parse(path);
      assert.equal(parsed.task_id, "TASK-20260511-001-PM-to-DEV");
      assert.equal(parsed.sender, "PM");
      assert.equal(parsed.priority, "P1");
      assert.equal(parsed.layer, "worker");
      assert.match(parsed.body, /# body/);
    });
  });

  it("TS-TP-D2-2: instance API with fcopClient stub delegates to client.readTask and shapes ParsedTask correctly", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260511-001-PM-to-DEV.md");
      // The file IS NOT written — we want to prove TaskParser doesn't
      // even touch the filesystem when fcop is in the loop, beyond the
      // basename derivation.
      const readTaskCalls: string[] = [];
      const fcopClient = stubFcopClient({
        readTask: async (filenameOrId) => {
          readTaskCalls.push(filenameOrId);
          return fakeFcopTask({
            task_id: "TASK-20260511-001-PM-to-DEV",
            filename: "TASK-20260511-001-PM-to-DEV.md",
            body: "# fcop-routed body\n",
            frontmatter: {
              protocol: "fcop",
              version: 1,
              sender: "PM",
              recipient: "DEV",
              priority: "P1",
              thread_key: "example-thread",
              subject: "test subject",
              references: [],
              risk_level: "low",
              extra: { layer: "worker", status: "pending" },
            },
          });
        },
      });

      const instance = new TaskParser({ fcopClient });
      const parsed = await instance.parse(path);

      assert.deepEqual(
        readTaskCalls,
        ["TASK-20260511-001-PM-to-DEV.md"],
        "filename basename (NOT full path) forwarded to fcopClient.readTask",
      );
      assert.equal(parsed.task_id, "TASK-20260511-001-PM-to-DEV");
      assert.equal(parsed.sender, "PM");
      assert.equal(parsed.recipient, "DEV");
      assert.equal(parsed.priority, "P1");
      assert.equal(parsed.thread_key, "example-thread");
      assert.equal(
        parsed.layer,
        "worker",
        "layer is pulled from FcopTask.frontmatter.extra.layer (codeflowmu-specific key)",
      );
      assert.match(parsed.body, /fcop-routed body/);
      // Flattened frontmatter for downstream callers (TaskDispatcher passes
      // it as session_context.frontmatter — keep both fcop fields AND
      // codeflowmu `extra` keys flat).
      assert.equal(parsed.frontmatter["sender"], "PM");
      assert.equal(parsed.frontmatter["layer"], "worker");
      assert.equal(parsed.frontmatter["status"], "pending");
    });
  });

  it("TS-TP-D2-3: fcopClient.readTask throws FcopClientError → falls back to yaml on disk", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260511-002-PM-to-DEV.md");
      // Write a VALID yaml task on disk — fallback should pick it up.
      const source = `---
protocol: fcop
task_id: TASK-20260511-002-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
layer: worker
---

# fallback body
`;
      await writeFile(path, source);

      const fcopClient = stubFcopClient({
        readTask: async () => {
          throw new FcopClientError(
            "simulated fcop rejection (e.g. schema violation)",
            "FcopProjectClient.readTask",
            new Error("python-side cause"),
          );
        },
      });

      const instance = new TaskParser({ fcopClient });
      const parsed = await instance.parse(path);

      assert.equal(
        parsed.task_id,
        "TASK-20260511-002-PM-to-DEV",
        "fallback path went through static yaml parser, not the fcop stub",
      );
      assert.equal(parsed.priority, "P2");
      assert.equal(parsed.layer, "worker");
      assert.match(parsed.body, /fallback body/);
    });
  });

  it("TS-TP-D2-4: fcopClient throws AND yaml is also malformed → throws TaskParseError wrapping yaml error", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260511-003-PM-to-DEV.md");
      // Malformed yaml on disk so the fallback also fails.
      const source = `---
protocol: fcop
task_id: "unterminated
sender: PM
---

# body
`;
      await writeFile(path, source);

      const fcopClient = stubFcopClient({
        readTask: async () => {
          throw new FcopClientError(
            "fcop refused the file",
            "FcopProjectClient.readTask",
          );
        },
      });

      const instance = new TaskParser({ fcopClient });
      await assert.rejects(
        () => instance.parse(path),
        (err: unknown) => {
          if (!(err instanceof TaskParseError)) return false;
          // Message keeps the fcop error message so debugging traces
          // both layers of failure rather than masking the upstream one.
          if (!err.message.includes("fcop refused the file")) return false;
          if (err.filepath !== path) return false;
          return true;
        },
        "TaskParseError must wrap both the fcop error AND the yaml failure",
      );
    });
  });

  it("treats fallback serialized empty dependency lists as empty", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const path = join(inboxDir, "TASK-20260713-007-PM-to-DEV.md");
      await writeFile(
        path,
        `---\nprotocol: fcop\nsender: PM\nrecipient: DEV\ndepends_on: "[]"\nblocked_by: "null"\nreferences: "['TASK-20260712-909-ADMIN-to-PM']"\n---\n# task\n`,
      );
      const parsed = await TaskParser.parse(path);
      assert.equal(parsed.depends_on, undefined);
      assert.equal(parsed.blocked_by, undefined);
    });
  });
});

