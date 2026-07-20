/**
 * InboxWatcher tests — Phase C TS-5.1 / TS-5.2 / TS-5.3.
 *
 * Scope:
 *   - TS-5.1: chokidar `add` event for a TASK-*.md fires the handler
 *   - TS-5.2: REPORT-*.md / HANDOFF-*.md / arbitrary .md are silently ignored
 *   - TS-5.3: a throwing handler does NOT take the watcher down; peer
 *     handlers / subsequent events still fire.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FcopClientError,
  type FcopProjectClient,
  type FcopValidationIssue,
} from "../../_external/fcop-client.ts";
import { InboxWatcher, type InboxEvent } from "../InboxWatcher.ts";
import { quietLogger, waitFor, withTempScheduler } from "./helpers.ts";

/**
 * Stub a minimal `FcopProjectClient`. InboxWatcher only calls
 * `inspectTask()` on the bridge, so each test overrides that method.
 * No pythonia spin-up — Day 4 tests stay fast + offline (same idiom as
 * Day 2 `TaskParser` / Day 3 `ReviewWriter` / Day 3 `NeedsHumanGate`).
 */
function stubFcopClient(impl: {
  inspectTask: (filenameOrId: string) => Promise<FcopValidationIssue[]>;
}): FcopProjectClient {
  return impl as unknown as FcopProjectClient;
}

const VALID_TASK_BODY = `---
protocol: fcop
task_id: TASK-20260509-001-PM-to-DEV
sender: PM
recipient: DEV
priority: P2
state: inbox
---

# A task body
`;

const VALID_OPS_TASK_BODY = VALID_TASK_BODY.replace("recipient: DEV", "recipient: OPS");

describe("InboxWatcher", () => {
  it("TS-5.1: fires handler on add of a TASK-*.md file", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const watcher = new InboxWatcher({ dir: inboxDir, logger: quietLogger() });
      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();

        await writeFile(
          join(inboxDir, "TASK-20260509-001-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );

        const got = await waitFor(() => events[0], {
          what: "first task_added event",
          timeoutMs: 4000,
        });

        assert.equal(got.kind, "task_added");
        assert.equal(got.filename, "TASK-20260509-001-PM-to-DEV.md");
        assert.equal(got.sender, "PM");
        assert.equal(got.recipient, "DEV");
        assert.ok(got.filepath.endsWith("TASK-20260509-001-PM-to-DEV.md"));
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-5.2: ignores REPORT-*.md, HANDOFF-*.md, and arbitrary .md files", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const logger = quietLogger();
      const watcher = new InboxWatcher({ dir: inboxDir, logger });
      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();

        await writeFile(
          join(inboxDir, "REPORT-20260509-001-DEV-to-PM.md"),
          VALID_TASK_BODY,
        );
        await writeFile(
          join(inboxDir, "HANDOFF-20260509-001-PM-to-OPS.md"),
          VALID_TASK_BODY,
        );
        await writeFile(join(inboxDir, "random-notes.md"), "hello");

        // Now drop ONE valid TASK file to confirm the watcher is alive.
        await writeFile(
          join(inboxDir, "TASK-20260509-002-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );

        const got = await waitFor(() => events[0], { timeoutMs: 4000 });
        assert.equal(events.length, 1);
        assert.equal(got.filename, "TASK-20260509-002-PM-to-DEV.md");
        // No warnings should have been logged for the silently-ignored peers.
        assert.equal(logger.warns.length, 0);
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-5.3: a throwing handler does not take the watcher down", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const logger = quietLogger();
      const watcher = new InboxWatcher({ dir: inboxDir, logger });
      const peerEvents: InboxEvent[] = [];
      let throwingCalls = 0;

      const throwingHandler = (): void => {
        throwingCalls += 1;
        throw new Error("boom");
      };
      watcher.onEvent(throwingHandler);
      watcher.onEvent((evt) => {
        peerEvents.push(evt);
      });
      try {
        await watcher.start();

        await writeFile(
          join(inboxDir, "TASK-20260509-001-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        await writeFile(
          join(inboxDir, "TASK-20260509-002-PM-to-OPS.md"),
          VALID_OPS_TASK_BODY,
        );

        await waitFor(() => peerEvents.length >= 2, { timeoutMs: 4000 });

        assert.equal(peerEvents.length, 2);
        assert.equal(throwingCalls, 2);
        // Two errors should have been logged via the watcher's logger.
        assert.ok(
          logger.errors.some((s) => s.includes("handler threw")),
          `expected an error log mentioning "handler threw"; got: ${logger.errors.join(" / ")}`,
        );
      } finally {
        await watcher.stop();
      }
    });
  });

  it("rejects a zero-byte TASK before any handler can dispatch it", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const logger = quietLogger();
      const watcher = new InboxWatcher({ dir: inboxDir, logger });
      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(join(inboxDir, "TASK-20260509-099-ADMIN-to-PM.md"), "");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(events.length, 0);
        assert.ok(logger.warns.some((line) => line.includes("not durable/complete")));
      } finally {
        await watcher.stop();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Day 4 (TASK-20260511-013 §2.1) — fcop pre-dispatch schema gating
  // ─────────────────────────────────────────────────────────────────────

  it("TS-IW-D4-1: without fcopClient → behaves exactly like Day 1 (back-compat, no gate)", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const logger = quietLogger();
      const watcher = new InboxWatcher({ dir: inboxDir, logger });
      assert.equal(watcher.fcopClientWired, false);
      assert.equal(
        watcher.onValidationFail,
        "dispatch_anyway",
        "default policy must be dispatch_anyway per PM TASK-013 §2.1",
      );

      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(
          join(inboxDir, "TASK-20260509-001-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        const got = await waitFor(() => events[0], { timeoutMs: 4000 });
        assert.equal(got.kind, "task_added");
        // No fcop-related warnings since no client was wired.
        assert.equal(
          logger.warns.filter((w) => w.includes("fcop")).length,
          0,
          "no fcopClient → no fcop log line",
        );
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-IW-D4-2: with fcopClient + inspectTask returns [] → happy path dispatches", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const inspectCalls: string[] = [];
      const fcopClient = stubFcopClient({
        inspectTask: async (filenameOrId) => {
          inspectCalls.push(filenameOrId);
          return [];
        },
      });
      const logger = quietLogger();
      const watcher = new InboxWatcher({ dir: inboxDir, logger, fcopClient });
      assert.equal(watcher.fcopClientWired, true);

      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(
          join(inboxDir, "TASK-20260509-007-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        const got = await waitFor(() => events[0], { timeoutMs: 4000 });
        assert.equal(got.filename, "TASK-20260509-007-PM-to-DEV.md");
        // Gate ran exactly once with the basename (NOT the full path).
        assert.deepEqual(
          inspectCalls,
          ["TASK-20260509-007-PM-to-DEV.md"],
          "inspectTask is called once per add event with the basename only",
        );
        // No warnings — clean validation.
        assert.equal(logger.warns.length, 0);
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-IW-D4-3: severity='error' issue under default policy (dispatch_anyway) → still dispatches with a warning", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const fcopClient = stubFcopClient({
        inspectTask: async () => [
          {
            severity: "error",
            field: "frontmatter.recipient",
            message: "unknown recipient role 'XYZ'",
            path: null,
          },
          {
            severity: "warning",
            field: "<body>",
            message: "trailing whitespace",
            path: null,
          },
        ],
      });
      const logger = quietLogger();
      const watcher = new InboxWatcher({
        dir: inboxDir,
        logger,
        fcopClient,
        // explicit even though it's the default — TS-IW-D4-3 钉死契约
        onValidationFail: "dispatch_anyway",
      });

      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(
          join(inboxDir, "TASK-20260509-008-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        const got = await waitFor(() => events[0], { timeoutMs: 4000 });
        assert.equal(got.filename, "TASK-20260509-008-PM-to-DEV.md");
        // Warning was logged for the error-severity issue.
        const fcopWarn = logger.warns.find((w) =>
          w.includes("fcop validation error(s)") &&
          w.includes("dispatch_anyway"),
        );
        assert.ok(
          fcopWarn,
          `expected dispatch_anyway warning; got: ${logger.warns.join(" / ")}`,
        );
        assert.match(
          fcopWarn!,
          /\[frontmatter\.recipient\] unknown recipient role 'XYZ'/,
        );
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-IW-D4-3b: severity='error' issue under onValidationFail='reject' → does NOT dispatch", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const fcopClient = stubFcopClient({
        inspectTask: async () => [
          {
            severity: "error",
            field: "frontmatter.priority",
            message: "invalid priority 'X9'",
            path: null,
          },
        ],
      });
      const logger = quietLogger();
      const watcher = new InboxWatcher({
        dir: inboxDir,
        logger,
        fcopClient,
        onValidationFail: "reject",
      });

      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(
          join(inboxDir, "TASK-20260509-009-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        // Give the gate a few cycles to definitely have run + decided.
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(events.length, 0, "reject policy must drop the event");
        const rejectWarn = logger.warns.find((w) =>
          w.includes("rejected") && w.includes("reject"),
        );
        assert.ok(
          rejectWarn,
          `expected reject warning; got: ${logger.warns.join(" / ")}`,
        );
      } finally {
        await watcher.stop();
      }
    });
  });

  it("TS-IW-D4-4: FcopClientError from inspectTask → degrade to dispatch_anyway with a warning (same as Day 2 TaskParser fallback idiom)", async () => {
    await withTempScheduler(async ({ inboxDir }) => {
      const fcopClient = stubFcopClient({
        inspectTask: async () => {
          throw new FcopClientError(
            "fcop bridge is sad",
            "inspectTask",
            new Error("stub cause"),
          );
        },
      });
      const logger = quietLogger();
      const watcher = new InboxWatcher({
        dir: inboxDir,
        logger,
        fcopClient,
        // Even with the strictest policy, FcopClientError MUST degrade —
        // a degraded fcop bridge must never silently eat tasks.
        onValidationFail: "reject",
      });

      const events: InboxEvent[] = [];
      watcher.onEvent((evt) => {
        events.push(evt);
      });
      try {
        await watcher.start();
        await writeFile(
          join(inboxDir, "TASK-20260509-010-PM-to-DEV.md"),
          VALID_TASK_BODY,
        );
        const got = await waitFor(() => events[0], { timeoutMs: 4000 });
        assert.equal(got.filename, "TASK-20260509-010-PM-to-DEV.md");
        const degradeWarn = logger.warns.find((w) =>
          w.includes("inspectTask failed") &&
          w.includes("degrading to dispatch_anyway"),
        );
        assert.ok(
          degradeWarn,
          `expected degrade warning; got: ${logger.warns.join(" / ")}`,
        );
      } finally {
        await watcher.stop();
      }
    });
  });
});
