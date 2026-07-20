import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendActionEvidence,
  nextActionEventId,
  readActionEvidenceLines,
  writeCommandOutputRefs,
  resetActionEventIdCounterForTests,
} from "../ActionEvidenceLogger.ts";
import { actionEvidenceLogPath } from "../actionLogPaths.ts";
import { ACTION_LOG_SCHEMA_VERSION } from "../actionLogPaths.ts";

describe("ActionEvidenceLogger", () => {
  beforeEach(() => resetActionEventIdCounterForTests());
  afterEach(() => resetActionEventIdCounterForTests());

  it("appendActionEvidence writes schema_version and event_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-log-"));
    try {
      const ok = appendActionEvidence(root, {
        event_type: "file.read",
        at: "2026-06-07T00:00:00.000Z",
        task_id: "TASK-20260607-001",
        session_id: "sess-1",
        agent_id: "DEV",
        role: "DEV",
        status: "success",
        path: "src/foo.ts",
      });
      assert.equal(ok, true);
      const records = readActionEvidenceLines(root);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.schema_version, ACTION_LOG_SCHEMA_VERSION);
      assert.match(records[0]!.event_id, /^act-\d{8}-\d{6}$/);
      assert.equal(records[0]!.event_type, "file.read");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("nextActionEventId increments per day", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-log-"));
    try {
      const at = new Date("2026-06-07T12:00:00.000Z");
      const id1 = nextActionEventId(root, at);
      const id2 = nextActionEventId(root, at);
      assert.equal(id1, "act-20260607-000001");
      assert.equal(id2, "act-20260607-000002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writeCommandOutputRefs stores large stdout under fcop/logs/runtime/commands/", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-log-"));
    try {
      const big = "x".repeat(5000);
      const refs = writeCommandOutputRefs({
        projectRoot: root,
        eventId: "act-20260607-000099",
        stdout: big,
      });
      assert.ok(refs.stdout_ref?.includes("fcop/logs/runtime/commands/"));
      const abs = join(root, refs.stdout_ref!);
      assert.equal(existsSync(abs), true);
      const content = await readFile(abs, "utf-8");
      assert.equal(content.length, 5000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("readActionEvidenceLines returns empty when file missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfm-act-log-"));
    try {
      assert.equal(existsSync(actionEvidenceLogPath(root)), false);
      assert.deepEqual(readActionEvidenceLines(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
