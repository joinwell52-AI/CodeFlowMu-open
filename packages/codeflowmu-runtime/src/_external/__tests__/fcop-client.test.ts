/**
 * `FcopProjectClient` unit tests (P4 sprint Day 1.3, TASK-20260511-007).
 *
 * These tests **do NOT spawn Python**. They inject a stub `python(moduleName)`
 * callable via `__setPythonForTests()` so the test runs in pure Node + tsx
 * without any Python 3.12 / fcop@1.1.0 / pythonia subprocess overhead.
 *
 * 真实 fcop bridge 的 end-to-end 验证已由 DEV-005 `_spike/fcop-pythonia-spike/`
 * 完成（demo-fcop-api.ts + probe-surprises.ts，已 commit 在 e5a2413）。本文件
 * 只验证 TS 侧的契约：kwarg 转发是否正确、enum 解析是否健壮、错误是否包装成
 * `FcopClientError`、init/factory 流程是否符合 PM TASK-007 §四 Day 1.2-1.3 设计。
 *
 * Test plan（PM TASK-007 §六 Day 1.3 「5-8 个测试」）:
 *   TS-FCC-1   assertFcopReady 成功 → 返回 {fcopVersion, pythonVersion, pythonExecutable}
 *   TS-FCC-2   assertFcopReady 失败时 throw FcopClientError + 含 actionable hint
 *              (包含 "PYTHON_BIN" + "Python < 3.10" + "fcop@1.1.0" 三段指引)
 *   TS-FCC-3   create({ ensureInitialized: true, workspaceDir }) 调 Project$ + init$ kwargs 完整
 *   TS-FCC-4   create({ ensureInitialized: false }) 不调 init$
 *   TS-FCC-5   writeTask kwarg 转发正确（含 risk_level / references 可选字段）
 *   TS-FCC-6   writeReview kwarg 转发正确（含 decision='needs_human' v1.1 ADR-0025）
 *   TS-FCC-7   markHumanApproved review_id positional + kwargs 转发正确
 *   TS-FCC-8   listTasks 返回 FcopTask[]（通过 builtins.len + index 访问）
 *   TS-FCC-9   readEnumLike 容错：plain string / {value: 'xxx'} / 兜底正则三路径
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  FcopProjectClient,
  FcopClientError,
  normalizeTaskIdentifier,
  assertFcopReady,
  __setPythonForTests,
  __resetFcopBridgeForTests,
  __killRealPythonChildForTests,
  type WriteTaskSpec,
  type WriteReviewSpec,
  type MarkHumanApprovedSpec,
} from "../fcop-client.ts";

// ───────────────────────────────────────────────────────────────────────────
// Stub builder helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Records every call made to the stubbed Python bridge so a test can assert
 * `Project$()` received the right path + kwargs, `write_task$()` got
 * exactly the keys it should have got, etc.
 */
interface CallRecorder {
  projectCalls: Array<{ path: string; kwargs: Record<string, unknown> }>;
  initCalls: Array<Record<string, unknown>>;
  writeTaskCalls: Array<Record<string, unknown>>;
  listTasksCalls: Array<Record<string, unknown>>;
  writeReviewCalls: Array<Record<string, unknown>>;
  markHumanApprovedCalls: Array<{
    reviewId: string;
    kwargs: Record<string, unknown>;
  }>;
  isInitializedReturnQueue: boolean[];
  /** True after a successful `Project$()` call (controls `is_initialized`
   *  default semantics: once project exists, treat as not-yet-initialized
   *  unless the queue says otherwise). */
  projectBuilt: boolean;
}

function freshRecorder(): CallRecorder {
  return {
    projectCalls: [],
    initCalls: [],
    writeTaskCalls: [],
    listTasksCalls: [],
    writeReviewCalls: [],
    markHumanApprovedCalls: [],
    isInitializedReturnQueue: [],
    projectBuilt: false,
  };
}

/**
 * Build a fake `fcop` module proxy with `Project$` factory + `__version__`
 * + minimal task/review proxies.
 *
 * @param recorder Shared call recorder (test asserts on this).
 * @param options Override fcop version / make Project$ throw / etc.
 */
function buildFcopStub(
  recorder: CallRecorder,
  options: {
    fcopVersion?: string | (() => Promise<never>);
    projectThrows?: Error;
  } = {},
): unknown {
  const versionGetter = options.fcopVersion ?? "1.1.0";

  function buildProjectProxy(): unknown {
    return {
      is_initialized: async () => {
        // 队列优先：测试可显式控制连续两次返回的值
        if (recorder.isInitializedReturnQueue.length > 0) {
          return recorder.isInitializedReturnQueue.shift();
        }
        // 默认：build 后未 init
        return false;
      },
      init$: async (kwargs: Record<string, unknown>) => {
        recorder.initCalls.push(kwargs);
        return {
          is_initialized: true,
          config: { team: kwargs["team"] ?? "dev-team" },
        };
      },
      write_task$: async (kwargs: Record<string, unknown>) => {
        recorder.writeTaskCalls.push(kwargs);
        return buildTaskProxy(recorder.writeTaskCalls.length);
      },
      list_tasks$: async (kwargs: Record<string, unknown>) => {
        recorder.listTasksCalls.push(kwargs);
        // Pretend two tasks exist, indexable, sized via builtins.len.
        return [buildTaskProxy(1), buildTaskProxy(2)];
      },
      write_review$: async (kwargs: Record<string, unknown>) => {
        recorder.writeReviewCalls.push(kwargs);
        return buildReviewProxy({
          decision: String(kwargs["decision"] ?? "approved"),
          humanApproval: null,
        });
      },
      mark_human_approved$: async (
        reviewId: string,
        kwargs: Record<string, unknown>,
      ) => {
        recorder.markHumanApprovedCalls.push({ reviewId, kwargs });
        return buildReviewProxy({
          decision: "needs_human",
          humanApproval: {
            approver: String(kwargs["approver"] ?? "ADMIN"),
            decision: String(kwargs["decision"] ?? "approve"),
            channel: String(kwargs["channel"] ?? "cli"),
            comment: (kwargs["comment"] as string | undefined) ?? null,
          },
        });
      },
    };
  }

  return {
    __version__:
      typeof versionGetter === "string"
        ? Promise.resolve(versionGetter)
        : (versionGetter as () => Promise<never>)(),
    Project$: async (path: string, kwargs: Record<string, unknown>) => {
      recorder.projectCalls.push({ path, kwargs });
      if (options.projectThrows) {
        throw options.projectThrows;
      }
      recorder.projectBuilt = true;
      return buildProjectProxy();
    },
  };
}

/**
 * Task proxy mirroring fcop@1.1.0's actual shape:
 *   - `Task` top-level: `path / filename / task_id / date / sequence /
 *     frontmatter (nested) / body / is_archived / mtime`
 *   - `TaskFrontmatter` nested: `protocol / version / sender / recipient /
 *     priority / thread_key / subject / references / risk_level / extra`
 *
 * Day 2 (TS-FCC-1..9 updated) — Day 1 stubs were a flat shape and went
 * along with the bug in `readTask(proxy)`. Now stubs match real fcop,
 * forcing `readTask` to actually walk into `frontmatter`.
 *
 * `priority` ships as a python enum (`{value: Promise<'P1'>}`) so we keep
 * exercising `readEnumLike`'s primary branch.
 */
function buildTaskProxy(sequence: number, overrides: {
  layer?: string;
  thread_key?: string | null;
  references?: string[];
  body?: string;
} = {}): unknown {
  return {
    task_id: Promise.resolve(`TASK-20260511-00${sequence}`),
    filename: Promise.resolve(`TASK-20260511-00${sequence}-PM-to-DEV.md`),
    body: Promise.resolve(overrides.body ?? "stub body"),
    date: Promise.resolve("20260511"),
    sequence: Promise.resolve(sequence),
    is_archived: Promise.resolve(false),
    path: Promise.resolve(`/tmp/stub/TASK-20260511-00${sequence}.md`),
    frontmatter: Promise.resolve(
      buildTaskFrontmatterProxy({
        sender: "PM",
        recipient: "DEV",
        priority: "P1",
        subject: `stub task #${sequence}`,
        ...(overrides.thread_key !== undefined
          ? { thread_key: overrides.thread_key }
          : {}),
        ...(overrides.references !== undefined
          ? { references: overrides.references }
          : {}),
        ...(overrides.layer !== undefined ? { layer: overrides.layer } : {}),
      }),
    ),
  };
}

function buildTaskFrontmatterProxy(args: {
  sender: string;
  recipient: string;
  priority: string;
  subject: string | null;
  thread_key?: string | null;
  references?: string[];
  risk_level?: string;
  layer?: string;
}): unknown {
  // Build the `extra` dict proxy with the same shape pythonia exposes —
  // it must support `.keys()` returning an iterable of strings + bracket
  // access for values. We fake all of that with plain objects.
  const extraDict: Record<string, unknown> = {};
  if (args.layer !== undefined) extraDict["layer"] = args.layer;
  return {
    protocol: Promise.resolve("fcop"),
    version: Promise.resolve(1),
    sender: Promise.resolve(args.sender),
    recipient: Promise.resolve(args.recipient),
    // pythonia returns Python enum → object with `.value`
    priority: Promise.resolve({ value: Promise.resolve(args.priority) }),
    thread_key: Promise.resolve(args.thread_key ?? null),
    subject: Promise.resolve(args.subject),
    references: Promise.resolve(args.references ?? []),
    risk_level: Promise.resolve({
      value: Promise.resolve(args.risk_level ?? "low"),
    }),
    extra: Promise.resolve(buildDictProxy(extraDict)),
  };
}

/**
 * Build a stub dict proxy that mimics pythonia's representation of a
 * Python `dict[str, object]`: `.keys()` returns a list-like iterable of
 * strings, and bracket-index access returns the value as a Promise.
 *
 * Our `readPlainDict` calls `await dictProxy.keys()` → `builtins.list(...)`
 * → `builtins.len(...)` → bracket-indexed reads. For test purposes we
 * compose the same surface using plain JS objects/arrays plus a custom
 * `builtins.list` stub that just returns its input unchanged (since arrays
 * already support indexing + length).
 */
function buildDictProxy(entries: Record<string, unknown>): unknown {
  const keys = Object.keys(entries);
  // Wrap each entry value in `Promise.resolve` because the readPlainDict
  // helper `await`s every value.
  const proxy: Record<string, unknown> = {
    keys: () => Promise.resolve(keys),
  };
  for (const k of keys) {
    proxy[k] = Promise.resolve(entries[k]);
  }
  return proxy;
}

/**
 * Review proxy mirroring fcop@1.1.0's actual shape (Day 3 update):
 *
 * fcop.Review is FULLY TOP-LEVEL (no nested `frontmatter` unlike Task):
 *   path / filename / review_id / date / sequence / subject_type /
 *   subject_ref / reviewer_role / reviewer_agent / decision / rationale /
 *   required_changes / decided_at / body / is_archived / mtime /
 *   human_approval
 *
 * fcop.HumanApproval (the nested ack block when present):
 *   approver / decision / approved_at / channel / comment / evidence
 *
 * Day 1 stub omitted `body / date / mtime` AND
 * `human_approval.approved_at / evidence`. Day 3 fix adds them all to
 * match fcop's actual `Review.__dataclass_fields__`.
 */
function buildReviewProxy(args: {
  decision: string;
  humanApproval: {
    approver: string;
    decision: string;
    channel: string;
    comment: string | null;
    approved_at?: string;
    evidence?: {
      device_id?: string | null;
      ip?: string | null;
      auth_method?: string | null;
    } | null;
  } | null;
  body?: string;
  date?: string;
  mtime?: string;
}): unknown {
  return {
    review_id: Promise.resolve("REVIEW-20260511-001-QA-on-task-20260511-001"),
    filename: Promise.resolve("REVIEW-20260511-001-QA-on-task-20260511-001.md"),
    reviewer_role: Promise.resolve("QA"),
    reviewer_agent: Promise.resolve(null),
    subject_type: Promise.resolve("task"),
    subject_ref: Promise.resolve("TASK-20260511-001"),
    // Test the "enum repr string fallback" branch via plain string
    // (most common — fcop returns enum, we read .value to a string)
    decision: Promise.resolve({ value: Promise.resolve(args.decision) }),
    rationale: Promise.resolve("stub rationale"),
    required_changes: Promise.resolve([]),
    decided_at: Promise.resolve("2026-05-11T10:00:00+08:00"),
    date: Promise.resolve(args.date ?? "20260511"),
    sequence: Promise.resolve(1),
    is_archived: Promise.resolve(false),
    body: Promise.resolve(args.body ?? "stub review body"),
    mtime: Promise.resolve(args.mtime ?? "2026-05-11T10:00:00+08:00"),
    path: Promise.resolve("/tmp/stub/REVIEW-20260511-001.md"),
    human_approval: Promise.resolve(
      args.humanApproval === null
        ? null
        : {
            approver: Promise.resolve(args.humanApproval.approver),
            decision: Promise.resolve({
              value: Promise.resolve(args.humanApproval.decision),
            }),
            approved_at: Promise.resolve(
              args.humanApproval.approved_at ?? "2026-05-11T10:30:00+08:00",
            ),
            channel: Promise.resolve({
              value: Promise.resolve(args.humanApproval.channel),
            }),
            comment: Promise.resolve(args.humanApproval.comment),
            evidence: Promise.resolve(
              args.humanApproval.evidence === undefined ||
                args.humanApproval.evidence === null
                ? null
                : {
                    device_id: Promise.resolve(
                      args.humanApproval.evidence.device_id ?? null,
                    ),
                    ip: Promise.resolve(
                      args.humanApproval.evidence.ip ?? null,
                    ),
                    auth_method: Promise.resolve(
                      args.humanApproval.evidence.auth_method ?? null,
                    ),
                  },
            ),
          },
    ),
  };
}

/**
 * Stub for fcop.ValidationIssue dataclass:
 *   severity (Literal "error" | "warning" | "info")
 *   field    (str)
 *   message  (str)
 *   path     (Path | None — surfaced as string|null)
 *
 * Used by TS-FCC-12 to assert `inspectTask` deserializes a real list of
 * issues, including the `null` path branch.
 */
function buildValidationIssueProxy(args: {
  severity: string;
  field: string;
  message: string;
  path: string | null;
}): unknown {
  return {
    severity: Promise.resolve(args.severity),
    field: Promise.resolve(args.field),
    message: Promise.resolve(args.message),
    path: Promise.resolve(args.path),
  };
}

/** Stub `sys` module proxy (only `.version` + `.executable` used). */
function buildSysStub(): unknown {
  return {
    version:
      "3.12.9 (tags/v3.12.9:fdb8142, Feb  4 2025) [MSC v.1942 64 bit (AMD64)]",
    executable: "C:\\fake\\Python312\\python.exe",
  };
}

/** Stub `builtins` proxy (`.len()` + `.list()` used by readTaskList /
 *  readStringList / readPlainDict). */
function buildBuiltinsStub(): unknown {
  return {
    len: async (x: unknown) => {
      if (Array.isArray(x)) return x.length;
      throw new Error("stub builtins.len: only supports arrays");
    },
    // `builtins.list(view)` in real pythonia materializes a dict_keys view
    // into a list. Our test stub already hands `.keys()` a JS array, so
    // `list(...)` is a pass-through.
    list: async (x: unknown) => x,
  };
}

/**
 * Construct a `python(moduleName)` async function that dispatches to the right
 * canned stub based on the requested module name. Unknown module names throw.
 */
function buildPythonStub(recorder: CallRecorder, options: {
  fcopVersion?: string | (() => Promise<never>);
  projectThrows?: Error;
  fcopImportFails?: Error;
} = {}): (moduleName: string) => Promise<unknown> {
  return async (moduleName: string) => {
    if (moduleName === "fcop") {
      if (options.fcopImportFails) throw options.fcopImportFails;
      return buildFcopStub(recorder, {
        ...(options.fcopVersion !== undefined
          ? { fcopVersion: options.fcopVersion }
          : {}),
        ...(options.projectThrows !== undefined
          ? { projectThrows: options.projectThrows }
          : {}),
      });
    }
    if (moduleName === "sys") return buildSysStub();
    if (moduleName === "builtins") return buildBuiltinsStub();
    throw new Error(`buildPythonStub: unexpected module name ${moduleName}`);
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Test cases
// ───────────────────────────────────────────────────────────────────────────

describe("normalizeTaskIdentifier", () => {
  test("extracts canonical short id from short id, full filename, .md suffix, and Windows path", () => {
    assert.equal(normalizeTaskIdentifier("TASK-20260530-001"), "TASK-20260530-001");
    assert.equal(
      normalizeTaskIdentifier("TASK-20260530-001-ADMIN-to-PM"),
      "TASK-20260530-001",
    );
    assert.equal(
      normalizeTaskIdentifier("TASK-20260530-001-ADMIN-to-PM.md"),
      "TASK-20260530-001",
    );
    assert.equal(
      normalizeTaskIdentifier(
        "D:\\codeflowmu\\fcop\\_lifecycle\\inbox\\TASK-20260530-001-ADMIN-to-PM.md",
      ),
      "TASK-20260530-001",
    );
    assert.equal(
      normalizeTaskIdentifier(
        "/codeflowmu/fcop/_lifecycle/inbox/TASK-20260530-001-ADMIN-to-PM.md",
      ),
      "TASK-20260530-001",
    );
  });

  test("returns original value when pattern does not match", () => {
    const custom = "CUSTOM-TASK-FOO";
    assert.equal(normalizeTaskIdentifier(custom), custom);
  });
});

describe("FcopProjectClient (P4 sprint Day 1.3 — TASK-20260511-007)", () => {
  // Each test resets the module-level bridge cache so tests don't bleed.
  beforeEach(() => {
    __resetFcopBridgeForTests();
  });

  // Always restore real pythonia state AND kill the pythonia child Python
  // subprocess at the end. The child is spawned at the very first
  // `import 'pythonia'` (see fcop-client.ts `__killRealPythonChildForTests`
  // JSDoc); leaving it alive blocks `node --test` from exiting.
  after(() => {
    __setPythonForTests(null);
    __resetFcopBridgeForTests();
    __killRealPythonChildForTests();
  });

  test("TS-FCC-1: assertFcopReady success path returns version triple", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const result = await assertFcopReady();

    assert.equal(result.fcopVersion, "1.1.0", "fcop version is forwarded");
    assert.match(
      result.pythonVersion,
      /3\.12/,
      "Python version is forwarded from sys.version",
    );
    assert.equal(
      result.pythonExecutable,
      "C:\\fake\\Python312\\python.exe",
      "Python exe path is forwarded from sys.executable",
    );
  });

  test("TS-FCC-2: assertFcopReady failure path wraps as FcopClientError with actionable hint", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder, {
      fcopImportFails: new Error("ModuleNotFoundError: No module named 'fcop'"),
    });
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    await assert.rejects(
      () => assertFcopReady(),
      (err: unknown) => {
        if (!(err instanceof FcopClientError)) return false;
        if (err.operation !== "loadFcopModule") return false;
        // Must contain all three lines of the actionable hint
        const m = err.message;
        return (
          m.includes("PYTHON_BIN") &&
          m.includes("Python < 3.10") &&
          m.includes("fcop@1.1.0") &&
          m.includes("ModuleNotFoundError")
        );
      },
      "FcopClientError must include PYTHON_BIN + Python version + fcop install hint + original cause",
    );
  });

  test("TS-FCC-3: create with workspaceDir + ensureInitialized=true calls Project$ + init$", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      workspaceDir: "legacy/agents",
      team: "dev-team",
      lang: "zh",
    });

    assert.equal(recorder.projectCalls.length, 1, "Project$ called exactly once");
    assert.equal(recorder.projectCalls[0]?.path, "D:/fake/project");
    assert.deepEqual(
      recorder.projectCalls[0]?.kwargs,
      { strict: false, workspace_dir: "legacy/agents" },
      "Project$ receives strict=false + workspace_dir override (DEV-005 §S8 escape hatch)",
    );

    assert.equal(recorder.initCalls.length, 1, "init$ called exactly once");
    assert.deepEqual(
      recorder.initCalls[0],
      { team: "dev-team", lang: "zh", force: false },
      "init$ receives team + lang + force=false (DEV-005 §S4: no positional kwargs)",
    );

    assert.equal(client.projectRoot, "D:/fake/project");
  });

  test("TS-FCC-4: create with ensureInitialized=false skips init$", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });

    assert.equal(recorder.projectCalls.length, 1);
    assert.equal(
      recorder.initCalls.length,
      0,
      "init$ NOT called when ensureInitialized=false",
    );
  });

  test("TS-FCC-5: writeTask forwards kwargs correctly with optional fields conditionally", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    // ensureInitialized=false so init$ doesn't pollute recorder.
    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });

    // Variant A: all optional fields omitted → kwargs has 5 required keys only.
    const specMin: WriteTaskSpec = {
      sender: "PM",
      recipient: "DEV",
      priority: "P1",
      subject: "min spec",
      body: "min body",
    };
      const taskA = await client.writeTask(specMin);
    assert.deepEqual(recorder.writeTaskCalls[0], {
      sender: "PM",
      recipient: "DEV",
      priority: "P1",
      subject: "min spec",
      body: "min body",
    });
    assert.equal(taskA.task_id, "TASK-20260511-001");
    // Day 2 (D2-S1 fix): Task uses nested frontmatter shape; verify both
    // the nested object AND the convenience top-level accessors.
    assert.equal(taskA.frontmatter.sender, "PM");
    assert.equal(taskA.frontmatter.recipient, "DEV");
    assert.equal(
      taskA.frontmatter.priority,
      "P1",
      "readEnumLike pulls .value from {value: 'P1'} stub (DEV-005 §S10 enum repr)",
    );
    assert.equal(taskA.sender, "PM", "top-level sender pre-pulled");
    assert.equal(taskA.recipient, "DEV", "top-level recipient pre-pulled");
    assert.equal(taskA.priority, "P1", "top-level priority pre-pulled");
    assert.equal(taskA.body, "stub body");

    // Variant B: with optional fields → keys present in kwargs.
    const specFull: WriteTaskSpec = {
      sender: "PM",
      recipient: "DEV",
      priority: "P0",
      subject: "full spec",
      body: "full body",
      references: ["TASK-001", "TASK-002"],
      thread_key: "thread-xyz",
      risk_level: "low",
    };
    await client.writeTask(specFull);
    assert.deepEqual(recorder.writeTaskCalls[1], {
      sender: "PM",
      recipient: "DEV",
      priority: "P0",
      subject: "full spec",
      body: "full body",
      references: ["TASK-001", "TASK-002"],
      thread_key: "thread-xyz",
      risk_level: "low",
    });
  });

  test("TS-FCC-6: writeReview forwards kwargs including decision='needs_human' (v1.1 ADR-0025)", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });

    const spec: WriteReviewSpec = {
      reviewer_role: "QA",
      subject_type: "task",
      subject_ref: "TASK-20260511-001",
      decision: "needs_human",
      rationale: "PM wants ADMIN sign-off",
      required_changes: ["change-1", "change-2"],
    };
    const review = await client.writeReview(spec);

    assert.deepEqual(recorder.writeReviewCalls[0], {
      reviewer_role: "QA",
      subject_type: "task",
      subject_ref: "TASK-20260511-001",
      decision: "needs_human",
      rationale: "PM wants ADMIN sign-off",
      required_changes: ["change-1", "change-2"],
    });
    assert.equal(review.decision, "needs_human");
    assert.equal(
      review.human_approval,
      null,
      "writeReview alone leaves human_approval=null until markHumanApproved is called",
    );
  });

  test("TS-FCC-7: markHumanApproved sends review_id POSITIONAL + the rest as kwargs", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });

    const spec: MarkHumanApprovedSpec = {
      approver: "ADMIN",
      decision: "approve",
      channel: "cli",
      comment: "looks good",
    };
    const review = await client.markHumanApproved(
      "REVIEW-20260511-001-QA-on-task-20260511-001",
      spec,
    );

    assert.equal(recorder.markHumanApprovedCalls.length, 1);
    assert.equal(
      recorder.markHumanApprovedCalls[0]?.reviewId,
      "REVIEW-20260511-001-QA-on-task-20260511-001",
      "review_id is first positional arg (DEV-005 §S4: fcop signature is `(review_id, *, approver, decision, channel, comment)`)",
    );
    assert.deepEqual(recorder.markHumanApprovedCalls[0]?.kwargs, {
      approver: "ADMIN",
      decision: "approve",
      channel: "cli",
      comment: "looks good",
    });

    // Review must now reflect the human_approval block
    assert.equal(review.human_approval?.approver, "ADMIN");
    assert.equal(review.human_approval?.decision, "approve");
    assert.equal(review.human_approval?.channel, "cli");
    assert.equal(review.human_approval?.comment, "looks good");
  });

  test("TS-FCC-8: listTasks returns FcopTask[] with enum-decoded fields", async () => {
    const recorder = freshRecorder();
    const pythonStub = buildPythonStub(recorder);
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });

    const tasks = await client.listTasks({
      status: "open",
      sender: "PM",
      limit: 10,
    });

    assert.equal(tasks.length, 2, "stub returns array of 2 tasks");
    assert.deepEqual(recorder.listTasksCalls[0], {
      status: "open",
      sender: "PM",
      limit: 10,
    });

    for (const t of tasks) {
      assert.equal(typeof t.task_id, "string");
      assert.equal(typeof t.priority, "string", "priority decoded to plain string");
      assert.equal(typeof t.sequence, "number");
      assert.equal(typeof t.is_archived, "boolean");
      assert.equal(
        typeof t.frontmatter.sender,
        "string",
        "nested frontmatter populated (D2-S1 fix)",
      );
      assert.deepEqual(t.references, [], "references list materialized");
    }
  });

  test("TS-FCC-9: readEnumLike handles plain string / {value} / regex repr fallback", async () => {
    // We exercise this indirectly via writeTask. Build a custom fcop stub
    // where `frontmatter.priority` is a PLAIN STRING (some fcop deployments
    // serialize frontmatter without enum wrapping); readEnumLike's
    // plain-string branch should return it as-is.
    const recorder = freshRecorder();
    const stringPriorityFcop = (rec: CallRecorder) => ({
      __version__: Promise.resolve("1.1.0"),
      Project$: async (path: string, kwargs: Record<string, unknown>) => {
        rec.projectCalls.push({ path, kwargs });
        rec.projectBuilt = true;
        return {
          is_initialized: async () => false,
          init$: async () => undefined,
          write_task$: async (kw: Record<string, unknown>) => {
            rec.writeTaskCalls.push(kw);
            return {
              task_id: Promise.resolve("TASK-X-1"),
              filename: Promise.resolve("TASK-X-1.md"),
              body: Promise.resolve("..."),
              date: Promise.resolve("20260511"),
              sequence: Promise.resolve(1),
              is_archived: Promise.resolve(false),
              path: Promise.resolve("/tmp/x"),
              frontmatter: Promise.resolve({
                protocol: Promise.resolve("fcop"),
                version: Promise.resolve(1),
                sender: Promise.resolve("PM"),
                recipient: Promise.resolve("DEV"),
                // PLAIN STRING branch — no `.value` wrapper.
                priority: Promise.resolve("P3"),
                thread_key: Promise.resolve(null),
                subject: Promise.resolve("plain string priority"),
                references: Promise.resolve([]),
                risk_level: Promise.resolve("low"),
                extra: Promise.resolve(buildDictProxy({})),
              }),
            };
          },
        };
      },
    });
    const pythonStub = (async (moduleName: string) => {
      if (moduleName === "fcop") return stringPriorityFcop(recorder);
      if (moduleName === "sys") return buildSysStub();
      if (moduleName === "builtins") return buildBuiltinsStub();
      throw new Error(`unexpected module: ${moduleName}`);
    }) as (m: string) => Promise<unknown>;
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const task = await client.writeTask({
      sender: "PM",
      recipient: "DEV",
      priority: "P3",
      subject: "plain string priority",
      body: "...",
    });
    assert.equal(
      task.priority,
      "P3",
      "readEnumLike returns plain string as-is when proxy resolves to string",
    );
    assert.equal(task.frontmatter.priority, "P3");
  });

  test("TS-FCC-10 (Day 2): readTask(filenameOrId) forwards positional + walks nested frontmatter + populates `extra.layer`", async () => {
    // Custom stub: Project$ returns a `read_task` (NOT `read_task$` because
    // there are no kwargs — it's positional-only) that records the
    // requested filename_or_id and returns a Task proxy with a codeflowmu-
    // specific `extra.layer = "worker"` set.
    const recorder = freshRecorder();
    const readTaskCalls: string[] = [];
    const customFcop = () => ({
      __version__: Promise.resolve("1.1.0"),
      Project$: async (path: string, kwargs: Record<string, unknown>) => {
        recorder.projectCalls.push({ path, kwargs });
        recorder.projectBuilt = true;
        return {
          is_initialized: async () => false,
          init$: async () => undefined,
          read_task: async (filenameOrId: string) => {
            readTaskCalls.push(filenameOrId);
            return buildTaskProxy(7, {
              layer: "worker",
              thread_key: "p4-day2",
              references: ["TASK-20260511-007"],
              body: "# Day 2 task body\n\nfcop bridge wiring.\n",
            });
          },
        };
      },
    });
    const pythonStub = (async (moduleName: string) => {
      if (moduleName === "fcop") return customFcop();
      if (moduleName === "sys") return buildSysStub();
      if (moduleName === "builtins") return buildBuiltinsStub();
      throw new Error(`unexpected module: ${moduleName}`);
    }) as (m: string) => Promise<unknown>;
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const task = await client.readTask("TASK-20260511-007-PM-to-DEV.md");

    assert.deepEqual(
      readTaskCalls,
      ["TASK-20260511-007"],
      "filename_or_id normalized to canonical short id before Python bridge",
    );
    assert.equal(task.task_id, "TASK-20260511-007");
    assert.equal(task.filename, "TASK-20260511-007-PM-to-DEV.md");
    assert.equal(task.sender, "PM", "convenience top-level sender populated");
    assert.equal(task.recipient, "DEV");
    assert.equal(task.priority, "P1");
    assert.equal(task.thread_key, "p4-day2");
    assert.deepEqual(task.references, ["TASK-20260511-007"]);
    assert.equal(task.frontmatter.sender, "PM", "nested frontmatter accessible");
    assert.equal(
      task.frontmatter.extra["layer"],
      "worker",
      "TaskFrontmatter.extra dict deserialized — codeflowmu uses this for `layer`",
    );
    assert.match(task.body, /Day 2 task body/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Day 3 (TASK-20260511-011) — readReview / inspectTask + FcopReview
  // shape upgrade
  // ─────────────────────────────────────────────────────────────────────

  test("TS-FCC-11 (Day 3): readReview(filenameOrId) forwards positional + walks fully-top-level Review + body/date/mtime populated", async () => {
    // Custom stub: Project$ returns `read_review` (positional-only,
    // mirroring fcop.Project.read_review signature) that records
    // arguments and returns a top-level Review proxy.
    const recorder = freshRecorder();
    const readReviewCalls: string[] = [];
    const customFcop = () => ({
      __version__: Promise.resolve("1.1.0"),
      Project$: async (path: string, kwargs: Record<string, unknown>) => {
        recorder.projectCalls.push({ path, kwargs });
        recorder.projectBuilt = true;
        return {
          is_initialized: async () => false,
          init$: async () => undefined,
          read_review: async (filenameOrId: string) => {
            readReviewCalls.push(filenameOrId);
            return buildReviewProxy({
              decision: "approved",
              humanApproval: null,
              body: "# Day 3 review body\n\nReviewer approved.\n",
              date: "20260511",
              mtime: "2026-05-11T14:30:00+08:00",
            });
          },
        };
      },
    });
    const pythonStub = (async (moduleName: string) => {
      if (moduleName === "fcop") return customFcop();
      if (moduleName === "sys") return buildSysStub();
      if (moduleName === "builtins") return buildBuiltinsStub();
      throw new Error(`unexpected module: ${moduleName}`);
    }) as (m: string) => Promise<unknown>;
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const review = await client.readReview(
      "REVIEW-20260511-001-QA-on-task-20260511-001.md",
    );

    assert.deepEqual(
      readReviewCalls,
      ["REVIEW-20260511-001-QA-on-task-20260511-001.md"],
      "filename_or_id is forwarded positionally (NOT as kwargs) — fcop.Project.read_review is positional-only",
    );
    assert.equal(review.review_id, "REVIEW-20260511-001-QA-on-task-20260511-001");
    assert.equal(review.decision, "approved");
    assert.equal(review.reviewer_role, "QA");
    assert.equal(review.subject_type, "task");
    assert.equal(review.subject_ref, "TASK-20260511-001");
    // Day 3-added fields:
    assert.match(review.body, /Day 3 review body/, "body field populated (Day 3 add)");
    assert.equal(review.date, "20260511", "date field populated (Day 3 add)");
    assert.equal(
      review.mtime,
      "2026-05-11T14:30:00+08:00",
      "mtime field populated (Day 3 add)",
    );
    assert.equal(review.human_approval, null, "no ack yet → human_approval=null");
  });

  test("TS-FCC-12 (Day 3): inspectTask(filenameOrId) returns FcopValidationIssue[] including null-path branch", async () => {
    // Custom stub: Project$ returns `inspect_task` (positional-only)
    // that returns a list of 2 ValidationIssue proxies, one with
    // path=null (fcop emits null when the issue isn't file-scoped).
    const recorder = freshRecorder();
    const inspectCalls: string[] = [];
    const customFcop = () => ({
      __version__: Promise.resolve("1.1.0"),
      Project$: async (path: string, kwargs: Record<string, unknown>) => {
        recorder.projectCalls.push({ path, kwargs });
        recorder.projectBuilt = true;
        return {
          is_initialized: async () => false,
          init$: async () => undefined,
          inspect_task: async (filenameOrId: string) => {
            inspectCalls.push(filenameOrId);
            return [
              buildValidationIssueProxy({
                severity: "error",
                field: "frontmatter.recipient",
                message: "unknown recipient role 'XYZ'",
                path: "/tmp/stub/TASK-20260511-007.md",
              }),
              buildValidationIssueProxy({
                severity: "warning",
                field: "<body>",
                message: "trailing whitespace on last line",
                path: null,
              }),
            ];
          },
        };
      },
    });
    const pythonStub = (async (moduleName: string) => {
      if (moduleName === "fcop") return customFcop();
      if (moduleName === "sys") return buildSysStub();
      if (moduleName === "builtins") return buildBuiltinsStub();
      throw new Error(`unexpected module: ${moduleName}`);
    }) as (m: string) => Promise<unknown>;
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const issues = await client.inspectTask("TASK-20260511-007-PM-to-DEV.md");

    assert.deepEqual(
      inspectCalls,
      ["TASK-20260511-007"],
      "filename_or_id normalized to canonical short id before Python bridge",
    );
    assert.equal(issues.length, 2, "stub returns 2 issues");
    assert.deepEqual(issues[0], {
      severity: "error",
      field: "frontmatter.recipient",
      message: "unknown recipient role 'XYZ'",
      path: "/tmp/stub/TASK-20260511-007.md",
    });
    assert.deepEqual(
      issues[1],
      {
        severity: "warning",
        field: "<body>",
        message: "trailing whitespace on last line",
        path: null,
      },
      "issues with no filesystem path surface `path: null` (not '' nor undefined)",
    );
  });

  test("TS-FCC-13 (Day 3): markHumanApproved returns Review with full human_approval (approved_at + evidence) — Day 1 latent shape fix", async () => {
    // Same path as TS-FCC-7 but the stub now adds Day 3 fields. We
    // verify that approved_at and evidence are populated end-to-end.
    const recorder = freshRecorder();
    const customFcop = () => ({
      __version__: Promise.resolve("1.1.0"),
      Project$: async (path: string, kwargs: Record<string, unknown>) => {
        recorder.projectCalls.push({ path, kwargs });
        recorder.projectBuilt = true;
        return {
          is_initialized: async () => false,
          init$: async () => undefined,
          mark_human_approved$: async (
            reviewId: string,
            kwargs: Record<string, unknown>,
          ) => {
            recorder.markHumanApprovedCalls.push({ reviewId, kwargs });
            return buildReviewProxy({
              decision: "needs_human",
              humanApproval: {
                approver: String(kwargs["approver"] ?? "ADMIN"),
                decision: String(kwargs["decision"] ?? "approve"),
                channel: String(kwargs["channel"] ?? "cli"),
                comment: (kwargs["comment"] as string | undefined) ?? null,
                approved_at: "2026-05-11T14:35:21+08:00",
                evidence: {
                  device_id: "phone-001",
                  ip: "10.0.0.42",
                  auth_method: "biometric",
                },
              },
            });
          },
        };
      },
    });
    const pythonStub = (async (moduleName: string) => {
      if (moduleName === "fcop") return customFcop();
      if (moduleName === "sys") return buildSysStub();
      if (moduleName === "builtins") return buildBuiltinsStub();
      throw new Error(`unexpected module: ${moduleName}`);
    }) as (m: string) => Promise<unknown>;
    __setPythonForTests(
      Object.assign(pythonStub, { exit: () => undefined }),
    );

    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const review = await client.markHumanApproved(
      "REVIEW-20260511-001-QA-on-task-20260511-001",
      {
        approver: "ADMIN",
        decision: "approve",
        channel: "mobile",
        comment: "scanned",
      },
    );

    assert.equal(review.human_approval?.approver, "ADMIN");
    assert.equal(review.human_approval?.decision, "approve");
    assert.equal(review.human_approval?.channel, "mobile");
    assert.equal(
      review.human_approval?.approved_at,
      "2026-05-11T14:35:21+08:00",
      "approved_at populated end-to-end (Day 3 add)",
    );
    assert.deepEqual(
      review.human_approval?.evidence,
      { device_id: "phone-001", ip: "10.0.0.42", auth_method: "biometric" },
      "evidence dataclass surfaced as plain object with device_id/ip/auth_method (Day 3 add)",
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TS-FCC-14..18  fcop@1.5.1 upgrade compatibility guard (Lane D / 2026-05-12)
  //
  // These tests explicitly document that fcop-client.ts is compatible with
  // fcop@1.5.1 (and any future patch).  All stubs use `__version__: "1.5.1"`.
  // The client must NOT reject non-"1.1.0" version strings.
  // ──────────────────────────────────────────────────────────────────────────

  test("TS-FCC-14 (1.5.1 compat): assertFcopReady accepts fcop@1.5.1 version string (not limited to 1.1.0)", async () => {
    const recorder = freshRecorder();
    __setPythonForTests(
      Object.assign(
        async (moduleName: string) => {
          if (moduleName === "fcop")
            return buildFcopStub(recorder, { fcopVersion: "1.5.1" });
          if (moduleName === "sys") return buildSysStub();
          if (moduleName === "builtins") return buildBuiltinsStub();
          throw new Error(`unexpected module: ${moduleName}`);
        },
        { exit: () => undefined },
      ),
    );
    const result = await assertFcopReady();
    assert.equal(
      result.fcopVersion,
      "1.5.1",
      "assertFcopReady must surface the real version string, not hardcode 1.1.0",
    );
  });

  test("TS-FCC-15 (1.5.1 compat): FcopProjectClient.create with fcop@1.5.1 version string → client operational", async () => {
    const recorder = freshRecorder();
    __setPythonForTests(
      Object.assign(
        async (moduleName: string) => {
          if (moduleName === "fcop")
            return buildFcopStub(recorder, { fcopVersion: "1.5.1" });
          if (moduleName === "sys") return buildSysStub();
          if (moduleName === "builtins") return buildBuiltinsStub();
          throw new Error(`unexpected module: ${moduleName}`);
        },
        { exit: () => undefined },
      ),
    );
    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    assert.ok(client, "client created with fcop 1.5.1 version string");
    assert.equal(
      recorder.projectCalls.length,
      1,
      "Project$ called exactly once with 1.5.1 stub",
    );
  });

  test("TS-FCC-16 (1.5.1 compat): writeTask with fcop@1.5.1 stub — kwarg-syntax (S2) + Task shape fully intact", async () => {
    const recorder = freshRecorder();
    __setPythonForTests(
      Object.assign(
        async (moduleName: string) => {
          if (moduleName === "fcop")
            return buildFcopStub(recorder, { fcopVersion: "1.5.1" });
          if (moduleName === "sys") return buildSysStub();
          if (moduleName === "builtins") return buildBuiltinsStub();
          throw new Error(`unexpected module: ${moduleName}`);
        },
        { exit: () => undefined },
      ),
    );
    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const task = await client.writeTask({
      sender: "PM",
      recipient: "DEV",
      priority: "P0",
      subject: "fcop 1.5.1 upgrade test",
      body: "TS-FCC-16 guard",
    });
    assert.equal(
      recorder.writeTaskCalls.length,
      1,
      "write_task$ called once with 1.5.1 stub",
    );
    assert.ok(task.task_id, "task_id populated");
    assert.ok(task.frontmatter?.sender, "frontmatter.sender accessible (S2 kwarg + S4 shape)");
  });

  test("TS-FCC-17 (1.5.1 compat): writeReview with fcop@1.5.1 stub — enum decision (S3) + Review shape fully intact", async () => {
    const recorder = freshRecorder();
    __setPythonForTests(
      Object.assign(
        async (moduleName: string) => {
          if (moduleName === "fcop")
            return buildFcopStub(recorder, { fcopVersion: "1.5.1" });
          if (moduleName === "sys") return buildSysStub();
          if (moduleName === "builtins") return buildBuiltinsStub();
          throw new Error(`unexpected module: ${moduleName}`);
        },
        { exit: () => undefined },
      ),
    );
    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const review = await client.writeReview({
      reviewer_role: "QA",
      subject_type: "task",
      subject_ref: "TASK-20260512-021",
      decision: "approved",
      rationale: "1.5.1 compat guard",
    });
    assert.equal(
      recorder.writeReviewCalls.length,
      1,
      "write_review$ called once with 1.5.1 stub",
    );
    assert.ok(review.review_id, "review_id populated");
    assert.equal(review.decision, "approved", "decision string surfaced (S3 .value enum path)");
  });

  test("TS-FCC-18 (1.5.1 compat): markHumanApproved with fcop@1.5.1 stub — full approval chain intact", async () => {
    const recorder = freshRecorder();
    __setPythonForTests(
      Object.assign(
        async (moduleName: string) => {
          if (moduleName === "fcop")
            return {
              __version__: Promise.resolve("1.5.1"),
              Project$: async (path: string, kwargs: Record<string, unknown>) => {
                recorder.projectCalls.push({ path, kwargs });
                recorder.projectBuilt = true;
                return {
                  is_initialized: async () => false,
                  init$: async () => undefined,
                  mark_human_approved$: async (
                    reviewId: string,
                    kwargs: Record<string, unknown>,
                  ) => {
                    recorder.markHumanApprovedCalls.push({ reviewId, kwargs });
                    return buildReviewProxy({
                      decision: "needs_human",
                      humanApproval: {
                        approver: String(kwargs["approver"] ?? "ADMIN"),
                        decision: "approve",
                        channel: String(kwargs["channel"] ?? "cli"),
                        comment: null,
                        approved_at: "2026-05-12T22:30:00+08:00",
                        evidence: { device_id: "phone-001", ip: "10.0.0.1", auth_method: "biometric" },
                      },
                    });
                  },
                };
              },
            };
          if (moduleName === "sys") return buildSysStub();
          if (moduleName === "builtins") return buildBuiltinsStub();
          throw new Error(`unexpected module: ${moduleName}`);
        },
        { exit: () => undefined },
      ),
    );
    const client = await FcopProjectClient.create({
      projectRoot: "D:/fake/project",
      ensureInitialized: false,
    });
    const review = await client.markHumanApproved(
      "REVIEW-20260512-001-QA-on-task-021",
      { approver: "ADMIN", decision: "approve", channel: "mobile" },
    );
    assert.equal(
      review.human_approval?.approver,
      "ADMIN",
      "1.5.1: approver surfaced",
    );
    assert.equal(
      review.human_approval?.approved_at,
      "2026-05-12T22:30:00+08:00",
      "1.5.1: approved_at surfaced",
    );
    assert.deepEqual(
      review.human_approval?.evidence,
      { device_id: "phone-001", ip: "10.0.0.1", auth_method: "biometric" },
      "1.5.1: evidence dataclass intact",
    );
  });
});

