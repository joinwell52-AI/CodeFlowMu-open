import path from "node:path";

/**
 * `FcopProjectClient` — pythonia-backed bridge to `fcop@1.1.0` Python API.
 *
 * P4 sprint Day 1.2 (TASK-20260511-007).
 *
 * # 为什么是「外部」适配层？
 *
 * P4 主 sprint 的核心目标（PM TASK-007 §一）：
 *   > 让 codeflowmu runtime 的 task / review / human-approval 文件层
 *   > **全部走 fcop@1.1.0 Python API**（通过 pythonia 同进程嵌入）
 *
 * 这层包装做两件事：
 *
 *   1. **类型安全的窄口径**：pythonia 返回 `any`，业务调用方应该看到 TS-friendly
 *      `Task` / `Review` 结构，而不是 `Promise<any>` 的散弹枪。
 *
 *   2. **错误一次化**：fcop 的 Python 异常通过 pythonia 抛 `PythonException` 含
 *      `[***PY*** ... ***JS*** ...]` 双侧 stack。本 client 把所有 Python 抛错
 *      映射到本文件 `FcopClientError` 一种 TS error 类，业务方只 catch 一种。
 *
 *   3. **生命周期管理**：pythonia 启动一个 Python 子进程，**整个 runtime 进程内
 *      只允许一个**（同进程多个 `python('xxx')` 共享同一个子进程，但 `python.exit()`
 *      只能调一次）。本 client 用模块级单例守护。
 *
 * # DEV-005 spike 已实测的全部 12 个 surprise，本文件**已规避**：
 *
 *   - S2  PYTHON_BIN env var 必填 → `assertPythonReady()` 启动检查 + 友好报错
 *   - S3  pythonia kwarg 语法（函数名后 `$`，非 key 后 `$`）→ 内部全用 `Fn$()` 形式
 *   - S4  PM TASK §3.2 5 处 API 误用 → 本文件按 fcop@1.1.0 `inspect.signature()` 实证
 *   - S6  fcop sequence-generator 并发安全 → 本 client 不加 mutex（pythonia 已串行化）
 *   - S7  fcop_mcp NOT auto-imported → 本 client 只 `await python('fcop')`（不引 fcop_mcp）
 *   - S8  workspace_dir escape hatch → `create({ workspaceDir })` 暴露
 *   - S9  没有 `python.builtins` shortcut → 不用
 *   - S10 enum 返回 repr 而非 value → 所有读 enum 字段处用 `.value` 取字符串
 *   - S11 fcop 同进程无 file lock → 单 runtime 进程内安全，多进程留 P5
 *   - S12 默认 layout=`fcop/` → 通过 `workspaceDir` 切到 `fcop/`
 *
 * # 不在范围（PM TASK-007 §3.4 + §6.4）
 *
 *   - 不动 `AgentSdkAdapter` / `SessionManager` / `_internal/atomic-write.ts`
 *   - 不实施跨进程 file lock（P5）
 *   - 不接 fcop `event.schema`（砍到 v1.1）
 *   - 不向 fcop / pythonia 提 issue（自约束 7）
 */

/** Narrow shape we actually depend on from pythonia. */
interface PythonCallable {
  (moduleName: string): Promise<unknown>;
  exit(): void;
}

/**
 * Lazy holder for pythonia's `python` callable. We **deliberately** avoid a
 * top-level `import { python } from "pythonia"` because:
 *
 *   1. pythonia's `StdioCom` constructor (`node_modules/pythonia/src/pythonia/
 *      StdioCom.js:14`) `cp.spawn(process.env.PYTHON_BIN || 'python3', ...)`
 *      runs synchronously at module-init time.
 *   2. If `PYTHON_BIN` points at a missing executable, Node emits an
 *      unhandled `error` event on the child process and crashes with
 *      exit code 1 — **before** any of our error-handling code runs.
 *   3. We want `probeFcopBridge()` in codeflowmu-shell to be able to catch
 *      the failure and print actionable hints + `process.exit(2)`.
 *
 * Therefore: pythonia is loaded via dynamic `import()` inside
 * `getDefaultPython()`. Tests can still inject a stub via
 * `__setPythonForTests()` without ever touching the real pythonia.
 */
let pythonOverride: PythonCallable | null = null;
let pythoniaModulePromise: Promise<PythonCallable> | null = null;

async function getDefaultPython(): Promise<PythonCallable> {
  if (pythoniaModulePromise === null) {
    pythoniaModulePromise = (async () => {
      // Wrap the synchronous-on-init pythonia in a try so spawn ENOENT
      // surfaces as a rejected promise rather than an unhandled error
      // event killing the runtime.
      try {
        const mod = (await import("pythonia")) as unknown as {
          python: PythonCallable;
        };
        return mod.python;
      } catch (err) {
        throw new FcopClientError(
          formatPythonStartupError(err),
          "getDefaultPython",
          err,
        );
      }
    })();
  }
  return pythoniaModulePromise;
}

async function getPython(): Promise<PythonCallable> {
  if (pythonOverride !== null) return pythonOverride;
  return getDefaultPython();
}

// ───────────────────────────────────────────────────────────────────────────
// 公开类型 —— 业务方看到的窄口径
// ───────────────────────────────────────────────────────────────────────────

/** Priority enum aligned with `fcop.Priority` (P0-P3). */
export type Priority = "P0" | "P1" | "P2" | "P3";

/** Risk level aligned with `fcop.RiskLevel`. */
export type RiskLevel = "low" | "medium" | "high" | "irreversible";

/**
 * Review decision aligned with `fcop.ReviewDecision` (v1.1 ADR-0025 第 5 值
 * `needs_human` 已 closed BUG-SDK-004 的回归基线)。
 */
export type ReviewDecision =
  | "approved"
  | "rejected"
  | "needs_changes"
  | "abstained"
  | "needs_human";

/** Review subject type aligned with `fcop.ReviewSubjectType`. */
export type ReviewSubjectType = "task" | "report" | "role_switch" | "code_change";

/** Human approval decision aligned with `fcop.HumanApprovalDecision`. */
export type HumanApprovalDecision = "approve" | "reject";

/**
 * Human approval channel aligned with `fcop.HumanApprovalChannel`.
 * codeflowmu Mobile (PWA) 用 `mobile`，codeflowmu-shell CLI 用 `cli`。
 */
export type HumanApprovalChannel = "mobile" | "cli" | "web" | "manual_file_edit";

/**
 * Task descriptor returned by `writeTask` / `readTask` / `listTasks`.
 *
 * **STRUCTURE MATCHES fcop@1.1.0 ACTUAL SHAPE (Day 2 fix)**: fcop's `Task`
 * dataclass is `{path, filename, task_id, date, sequence, frontmatter,
 * body, is_archived, mtime}` where governance-meaningful fields like
 * `sender / recipient / priority / subject / thread_key / references /
 * risk_level / layer` all live inside the `frontmatter: TaskFrontmatter`
 * **nested** dataclass.
 *
 * Day 1 (TASK-20260511-007) shipped this interface with `sender` etc. as
 * top-level fields and our test stubs went along — but real fcop Task
 * objects would return `undefined` on `await task.sender`. Day 2 fix:
 * mirror fcop's actual structure with a nested `frontmatter` object, and
 * provide convenience top-level accessors that `readTask()` pre-populates
 * for callers that don't want to dig through the nested layer.
 *
 * `extra` carries any front-matter keys fcop doesn't define schema for
 * (e.g. codeflowmu's `layer: worker | governance | admin`, status flags,
 * etc.). fcop.TaskFrontmatter.extra is a `dict[str, object]` in Python.
 */
export interface FcopTask {
  // ── fcop.Task top-level fields ─────────────────────────────────────
  /** `task.task_id` — canonical task id (e.g. "TASK-20260511-007"). */
  task_id: string;
  /** `task.filename` — basename (e.g. "TASK-20260511-007-PM-to-DEV.md"). */
  filename: string;
  /** `task.path` — absolute filesystem path as a string. */
  path: string;
  /** `task.date` — YYYYMMDD string. */
  date: string;
  /** `task.sequence` — sequence number within the date. */
  sequence: number;
  /** `task.body` — markdown body AFTER the closing `---`. */
  body: string;
  /** `task.is_archived` — true iff fcop has archived the task. */
  is_archived: boolean;
  /** `task.frontmatter` — nested governance metadata. */
  frontmatter: FcopTaskFrontmatter;

  // ── Convenience accessors (pre-pulled from frontmatter for callers) ─
  /** `task.frontmatter.sender`. */
  sender: string;
  /** `task.frontmatter.recipient`. */
  recipient: string;
  /** `task.frontmatter.priority.value` (decoded enum). */
  priority: string;
  /** `task.frontmatter.subject` (may be null in fcop; we surface ""). */
  subject: string;
  /** `task.frontmatter.thread_key` — null if absent. */
  thread_key: string | null;
  /** `task.frontmatter.risk_level.value` (decoded enum). */
  risk_level: string;
  /** `task.frontmatter.references` (decoded tuple → array). */
  references: string[];
}

/**
 * Mirrors fcop@1.1.0 `TaskFrontmatter` dataclass. `extra` covers anything
 * outside fcop's schema (e.g. codeflowmu's `layer: worker | governance |
 * admin`).
 */
export interface FcopTaskFrontmatter {
  protocol: string;
  version: number;
  sender: string;
  recipient: string;
  priority: string;
  thread_key: string | null;
  subject: string;
  references: string[];
  risk_level: string;
  /**
   * Free-form extra fields preserved from the source `---` block.
   * codeflowmu keeps `layer` here (and historically `status: pending`).
   */
  extra: Record<string, unknown>;
}

/**
 * Review descriptor returned by `writeReview` / `readReview` /
 * `markHumanApproved`.
 *
 * **Structure mirrors fcop@1.1.0 actual shape**: fcop's `Review`
 * dataclass is **fully top-level** (no nested `frontmatter` layer
 * unlike `Task`). Day 3 (TASK-20260511-011) reconciliation —
 * inspected via `inspect.getmembers(fcop.Review)`:
 *
 *   path, filename, review_id, date, sequence, subject_type,
 *   subject_ref, reviewer_role, reviewer_agent, decision, rationale,
 *   required_changes, decided_at, body, is_archived, mtime,
 *   human_approval
 *
 * Day 1 (TASK-20260511-007) shipped this interface **without**
 * `body / date / mtime` and without `human_approval.approved_at /
 * evidence` — NOT a crash bug (unlike Day 2 D2-S1 for `FcopTask`,
 * because `Review` IS top-level so the flat read worked) but a field
 * coverage bug. Day 3 fix adds them.
 */
export interface FcopReview {
  review_id: string;
  filename: string;
  reviewer_role: string;
  reviewer_agent: string | null;
  subject_type: string;
  subject_ref: string;
  decision: string;
  rationale: string | null;
  required_changes: string[];
  decided_at: string;
  /** `review.date` — YYYYMMDD string (Day 3 added). */
  date: string;
  sequence: number;
  is_archived: boolean;
  /** `review.body` — markdown body AFTER closing `---` (Day 3 added). */
  body: string;
  /**
   * `review.mtime` — last filesystem-modification time as an ISO-8601
   * string. fcop exposes `datetime`; we stringify on the TS side
   * (Day 3 added).
   */
  mtime: string;
  path: string;
  /**
   * Present only after `markHumanApproved` was called (or external write of
   * the same effect). `null` before.
   *
   * Day 3 (TASK-20260511-011) added `approved_at` + `evidence` fields
   * to mirror fcop's `HumanApproval` dataclass.
   */
  human_approval: FcopHumanApproval | null;
}

/**
 * Human approval block embedded in `FcopReview`. Mirrors fcop's
 * `HumanApproval` dataclass exactly (`inspect.signature(fcop.HumanApproval)`
 * — Day 3 reconnaissance).
 */
export interface FcopHumanApproval {
  approver: string;
  decision: string;
  /** ISO-8601 stringified `approved_at: datetime` (Day 3 added). */
  approved_at: string;
  channel: string;
  comment: string | null;
  /**
   * `HumanApprovalEvidence` block — additional ack evidence (device_id,
   * ip, auth_method). fcop returns a nested dataclass or `None`. We
   * surface it as a plain `Record<string, unknown> | null` because
   * codeflowmu v0.3 does not type-narrow further (the Mobile/CLI ack
   * layer in v0.5 will). Day 3 added.
   */
  evidence: Record<string, unknown> | null;
}

/**
 * Validation issue returned by `Project.inspect_task()`. Mirrors fcop's
 * `ValidationIssue` dataclass — Day 3 reconnaissance via
 * `inspect.getmembers(fcop.ValidationIssue)`.
 */
export interface FcopValidationIssue {
  /** fcop literal: `"error" | "warning" | "info"`. */
  severity: string;
  /** Front-matter field path or `"<body>"` / `"<filename>"` per fcop. */
  field: string;
  /** Human-readable issue description. */
  message: string;
  /**
   * `validation.path: Path | None` — absolute path to the offending
   * file when fcop can resolve it. Surfaced as a string or `null`.
   */
  path: string | null;
}

/** Spec passed to `writeTask`. Field names mirror `fcop.Project.write_task`. */
export interface WriteTaskSpec {
  sender: string;
  recipient: string;
  priority: Priority;
  subject: string;
  body: string;
  references?: string[];
  thread_key?: string;
  slot?: string;
  risk_level?: RiskLevel;
}

/** Filter for `listTasks`. */
export interface ListTasksFilter {
  sender?: string;
  recipient?: string;
  status?: "open" | "archived" | "all";
  date?: string;
  limit?: number;
  offset?: number;
}

/** Spec passed to `writeReview`. */
export interface WriteReviewSpec {
  reviewer_role: string;
  subject_type: ReviewSubjectType;
  subject_ref: string;
  decision: ReviewDecision;
  rationale?: string;
  required_changes?: string[];
  reviewer_agent?: string;
  subject_short?: string;
  body?: string;
}

/** Spec passed to `markHumanApproved`. */
export interface MarkHumanApprovedSpec {
  approver: string;
  decision: HumanApprovalDecision;
  channel: HumanApprovalChannel;
  comment?: string;
}

/** `create()` options. */
export interface FcopProjectClientOptions {
  /** Absolute path to the project root (codeflowmu workspace). */
  projectRoot: string;
  /**
   * Override fcop's workspace layout for legacy/non-default projects.
   * If omitted, fcop's v1.0 default (`fcop/`) is used.
   */
  workspaceDir?: string;
  /**
   * Pass `false` to skip `Project.init()` when the directory is already
   * an FCoP project. Defaults to `true` (call init with `force=False`,
   * which is a no-op on already-initialized projects).
   */
  ensureInitialized?: boolean;
  /**
   * Team preset name (only used during init). Defaults to `"dev-team"`
   * (PM/DEV/QA/OPS), matches codeflowmu v0.1 governance.
   */
  team?: string;
  /** UI language for fcop init artifacts. Defaults to `"zh"`. */
  lang?: "zh" | "en";
}

// ───────────────────────────────────────────────────────────────────────────
// 错误类
// ───────────────────────────────────────────────────────────────────────────

/**
 * Single error class business code sees. Wraps any Python-side error from
 * pythonia (which throws `PythonException` with combined PY+JS stack).
 *
 * `cause` retains the original error so detailed debugging is still possible.
 */
export class FcopClientError extends Error {
  override readonly name = "FcopClientError";
  constructor(
    message: string,
    /** What was being attempted when the error happened. */
    public readonly operation: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 进程级单例 fcop module proxy
// ───────────────────────────────────────────────────────────────────────────

/**
 * pythonia 每次 `await python('fcop')` 都返回同一个 module proxy（pythonia
 * 内部 cache 命中，DEV-005 §五 S5 实测 warm import 0 ms），但启动 Python
 * 子进程**只能一次** —— 多次启动会 spawn 多个 python.exe，资源浪费。
 *
 * 本模块用闭包级 promise 守护：第一次 `loadFcopModule()` 触发实际启动 + import，
 * 后续调用复用同一个 promise（fail-once / succeed-once 语义）。
 */
let fcopModulePromise: Promise<unknown> | null = null;

/**
 * 启动 Python 子进程 + import fcop。**幂等**：同一个 runtime 进程内多次调用
 * 返回相同的 promise（第一次的结果 cache）。
 *
 * 失败时抛 `FcopClientError`，常见错误：
 *   - `PYTHON_BIN` 未设且 PATH 上 `python3` / `python` 没装 fcop
 *   - Python ≥ 3.10 没装
 *   - fcop@1.1.0 没装到当前解释器
 *
 * 业务方应在 codeflowmu-shell startup 时**主动**调一次 `assertFcopReady()`，
 * 把启动失败暴露在 banner 阶段而不是首次 dispatch 时（DEV-005 §六 P0-1）。
 */
function loadFcopModule(): Promise<unknown> {
  if (fcopModulePromise === null) {
    fcopModulePromise = (async () => {
      try {
        const python = await getPython();
        const fcop = await python("fcop");
        return fcop;
      } catch (err) {
        if (err instanceof FcopClientError) throw err;
        throw new FcopClientError(
          formatPythonStartupError(err),
          "loadFcopModule",
          err,
        );
      }
    })();
  }
  return fcopModulePromise;
}

/**
 * Public helper for `main.ts` banner: throws (actionable) if fcop is not
 * reachable, returns the version string on success.
 */
export async function assertFcopReady(): Promise<{
  fcopVersion: string;
  pythonVersion: string;
  pythonExecutable: string;
}> {
  const fcop = (await loadFcopModule()) as {
    __version__: Promise<string>;
  };
  let version: string;
  try {
    version = await fcop.__version__;
  } catch (err) {
    throw new FcopClientError(
      "fcop is importable but `fcop.__version__` failed; fcop install is corrupt.",
      "assertFcopReady",
      err,
    );
  }
  let pyVersion = "<unknown>";
  let pyExe = "<unknown>";
  try {
    const python = await getPython();
    const sys = (await python("sys")) as {
      version: Promise<string>;
      executable: Promise<string>;
    };
    pyVersion = await sys.version;
    pyExe = await sys.executable;
  } catch {
    // 非关键，不影响主功能；仅在 banner 上显示 `<unknown>` 即可。
  }
  return {
    fcopVersion: version,
    pythonVersion: pyVersion,
    pythonExecutable: pyExe,
  };
}

/**
 * Shut down the Python subprocess. Idempotent. Call this on
 * `codeflowmu-shell` graceful exit to allow Node to exit cleanly
 * (pythonia README: "Make sure to exit Python in the end").
 */
export async function disposeFcopBridge(): Promise<void> {
  // Only attempt to exit if the python module was actually loaded — calling
  // exit() before any import would force an unnecessary pythonia spawn just
  // to kill it.
  if (pythoniaModulePromise !== null) {
    try {
      const python = await pythoniaModulePromise;
      python.exit();
    } catch {
      // python may already be down or never started cleanly; idempotent.
    }
  }
  fcopModulePromise = null;
  pythoniaModulePromise = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Task identifier normalization (fcop read_task / inspect_task)
// ───────────────────────────────────────────────────────────────────────────

const TASK_SHORT_ID_RE = /^(TASK-\d{8}-\d{3,})/;

/**
 * Normalize a task filename, path, or id to the canonical short id
 * (`TASK-YYYYMMDD-NNN`) that fcop `Project.read_task` / `inspect_task`
 * resolve reliably. Non-matching input is returned unchanged.
 */
export function normalizeTaskIdentifier(value: string): string {
  let s = value;
  if (/[\\/]/.test(s)) {
    s = path.basename(s);
  }
  if (s.endsWith(".md")) {
    s = s.slice(0, -3);
  }
  const m = s.match(TASK_SHORT_ID_RE);
  if (m?.[1]) {
    return m[1];
  }
  return value;
}

// ───────────────────────────────────────────────────────────────────────────
// FcopProjectClient — 实例级 client，每个 codeflowmu project root 一个
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thin TS wrapper around a Python `fcop.Project` instance.
 *
 * 用法：
 *   ```ts
 *   const client = await FcopProjectClient.create({
 *     projectRoot: "D:/CodeFlowMu",
 *     workspaceDir: "legacy/agents", // optional escape hatch for non-default layouts
 *   });
 *   const task = await client.writeTask({
 *     sender: "PM",
 *     recipient: "DEV",
 *     priority: "P1",
 *     subject: "spike",
 *     body: "body text",
 *   });
 *   console.log(task.filename);
 *   ```
 *
 * 生命周期：
 *   - 不需要显式 `await client.close()`（client 本身无资源），但 runtime
 *     退出前**必须**调一次 `disposeFcopBridge()` 让 Python 子进程退出。
 */
export class FcopProjectClient {
  /**
   * Use `FcopProjectClient.create(...)` instead of `new FcopProjectClient(...)`.
   * Direct construction is intentionally not supported because all real fields
   * come from async Python bridge boot.
   */
  private constructor(
    private readonly _project: unknown,
    private readonly _opts: FcopProjectClientOptions,
  ) {}

  /**
   * Factory entry point. Boots the Python bridge (lazy / cached), constructs
   * a `fcop.Project` instance pointing at `opts.projectRoot`, optionally
   * runs `project.init()` to materialize the `fcop/` (or `fcop/`)
   * tree.
   */
  static async create(
    opts: FcopProjectClientOptions,
  ): Promise<FcopProjectClient> {
    const fcop = (await loadFcopModule()) as {
      Project$: (path: string, kw: Record<string, unknown>) => Promise<unknown>;
    };
    const projectKwargs: Record<string, unknown> = { strict: false };
    if (opts.workspaceDir !== undefined) {
      projectKwargs["workspace_dir"] = opts.workspaceDir;
    }
    let project: unknown;
    try {
      project = await fcop.Project$(opts.projectRoot, projectKwargs);
    } catch (err) {
      throw new FcopClientError(
        `fcop.Project(${JSON.stringify(opts.projectRoot)}, ${JSON.stringify(projectKwargs)}) failed`,
        "FcopProjectClient.create.Project",
        err,
      );
    }
    const client = new FcopProjectClient(project, opts);
    if (opts.ensureInitialized !== false) {
      await client._ensureInitialized();
    }
    return client;
  }

  /** Get the project root path this client was bound to. */
  get projectRoot(): string {
    return this._opts.projectRoot;
  }

  /**
   * Whether `fcop.Project` reports the directory as already initialized
   * (cheap query through the bridge, runs in ~1-2 ms warm).
   */
  async isInitialized(): Promise<boolean> {
    try {
      const p = this._project as { is_initialized: () => Promise<boolean> };
      return Boolean(await p.is_initialized());
    } catch (err) {
      throw new FcopClientError(
        "project.is_initialized() failed",
        "FcopProjectClient.isInitialized",
        err,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 五核心调用（PM TASK-007 §四 Day 1.2）
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Write a TASK file via fcop. Returns the materialized `FcopTask`.
   *
   * fcop 端 signature（DEV-005 §五 实证）：
   *   `Project.write_task(*, sender, recipient, priority, subject, body,
   *                       references=(), thread_key=None, slot=None,
   *                       risk_level=None) -> Task`
   */
  async writeTask(spec: WriteTaskSpec): Promise<FcopTask> {
    try {
      const p = this._project as {
        write_task$: (kw: Record<string, unknown>) => Promise<unknown>;
      };
      const kwargs: Record<string, unknown> = {
        sender: spec.sender,
        recipient: spec.recipient,
        priority: spec.priority,
        subject: spec.subject,
        body: spec.body,
      };
      if (spec.references !== undefined) kwargs["references"] = spec.references;
      if (spec.thread_key !== undefined) kwargs["thread_key"] = spec.thread_key;
      if (spec.slot !== undefined) kwargs["slot"] = spec.slot;
      if (spec.risk_level !== undefined) kwargs["risk_level"] = spec.risk_level;
      const taskProxy = await p.write_task$(kwargs);
      return await readTask(taskProxy);
    } catch (err) {
      if (err instanceof FcopClientError) throw err;
      throw new FcopClientError(
        `project.write_task(${JSON.stringify({ sender: spec.sender, recipient: spec.recipient, subject: spec.subject })}) failed`,
        "FcopProjectClient.writeTask",
        err,
      );
    }
  }

  /**
   * Read a single TASK file via fcop. The argument is a **filename or
   * task_id** (NOT a filesystem path) — fcop resolves it against the
   * project's `fcop/_lifecycle/inbox/` (or whatever `workspace_dir` was
   * configured at create() time).
   *
   * fcop 端 signature（实证）：
   *   `Project.read_task(filename_or_id: str) -> Task`
   *
   * Returns `FcopTask` with both top-level fields (path, body, date,
   * sequence, is_archived, frontmatter nested) and convenience accessors
   * (sender, recipient, priority, subject, thread_key, risk_level,
   * references) pre-pulled from `frontmatter` so callers don't need to
   * descend.
   *
   * Throws `FcopClientError` if the task doesn't exist, the file's
   * front-matter is malformed (fcop validates), or pythonia fails to
   * bridge.
   *
   * Day 2 (TASK-20260511-009) addition — Day 1 only had an *internal*
   * `readTask(proxy)` helper used by `writeTask`/`listTasks`; the public
   * `readTask(filenameOrId)` method was missing. PM TASK-009 §四 assumed
   * it existed (PM error #11); this Day 2 commit adds it.
   */
  async readTask(filenameOrId: string): Promise<FcopTask> {
    const normalized = normalizeTaskIdentifier(filenameOrId);
    try {
      const p = this._project as {
        read_task: (filenameOrId: string) => Promise<unknown>;
      };
      const taskProxy = await p.read_task(normalized);
      return await readTask(taskProxy);
    } catch (err) {
      if (err instanceof FcopClientError) throw err;
      throw new FcopClientError(
        `project.read_task(${JSON.stringify(filenameOrId)} -> ${JSON.stringify(normalized)}) failed`,
        "FcopProjectClient.readTask",
        err,
      );
    }
  }

  /**
   * List TASK files matching `filter`. Returns materialized `FcopTask[]`.
   *
   * fcop 端 signature：
   *   `Project.list_tasks(*, sender=None, recipient=None, status='open',
   *                       date=None, limit=None, offset=0) -> list[Task]`
   */
  async listTasks(filter: ListTasksFilter = {}): Promise<FcopTask[]> {
    try {
      const p = this._project as {
        list_tasks$: (kw: Record<string, unknown>) => Promise<unknown>;
      };
      const kwargs: Record<string, unknown> = {};
      if (filter.sender !== undefined) kwargs["sender"] = filter.sender;
      if (filter.recipient !== undefined) kwargs["recipient"] = filter.recipient;
      if (filter.status !== undefined) kwargs["status"] = filter.status;
      if (filter.date !== undefined) kwargs["date"] = filter.date;
      if (filter.limit !== undefined) kwargs["limit"] = filter.limit;
      if (filter.offset !== undefined) kwargs["offset"] = filter.offset;
      const tasksProxy = await p.list_tasks$(kwargs);
      return await readTaskList(tasksProxy);
    } catch (err) {
      throw new FcopClientError(
        `project.list_tasks(${JSON.stringify(filter)}) failed`,
        "FcopProjectClient.listTasks",
        err,
      );
    }
  }

  /**
   * Write a REVIEW file via fcop. Returns the materialized `FcopReview`.
   *
   * fcop 端 signature：
   *   `Project.write_review(*, reviewer_role, subject_type, subject_ref,
   *                         decision, rationale=None, required_changes=(),
   *                         reviewer_agent=None, body='', date=None,
   *                         subject_short=None) -> Review`
   */
  async writeReview(spec: WriteReviewSpec): Promise<FcopReview> {
    try {
      const p = this._project as {
        write_review$: (kw: Record<string, unknown>) => Promise<unknown>;
      };
      const kwargs: Record<string, unknown> = {
        reviewer_role: spec.reviewer_role,
        subject_type: spec.subject_type,
        subject_ref: spec.subject_ref,
        decision: spec.decision,
      };
      if (spec.rationale !== undefined) kwargs["rationale"] = spec.rationale;
      if (spec.required_changes !== undefined)
        kwargs["required_changes"] = spec.required_changes;
      if (spec.reviewer_agent !== undefined)
        kwargs["reviewer_agent"] = spec.reviewer_agent;
      if (spec.subject_short !== undefined)
        kwargs["subject_short"] = spec.subject_short;
      if (spec.body !== undefined) kwargs["body"] = spec.body;
      const reviewProxy = await p.write_review$(kwargs);
      return await readReview(reviewProxy);
    } catch (err) {
      throw new FcopClientError(
        `project.write_review(${JSON.stringify({
          reviewer_role: spec.reviewer_role,
          subject_type: spec.subject_type,
          subject_ref: spec.subject_ref,
          decision: spec.decision,
        })}) failed`,
        "FcopProjectClient.writeReview",
        err,
      );
    }
  }

  /**
   * Mark a Review as human-approved (or rejected). Returns the updated
   * `FcopReview` with `human_approval` populated.
   *
   * fcop 端 signature：
   *   `Project.mark_human_approved(review_id, *, approver, decision,
   *                                channel, comment=None,
   *                                device_id=None, ip=None,
   *                                auth_method=None) -> Review`
   */
  async markHumanApproved(
    reviewId: string,
    spec: MarkHumanApprovedSpec,
  ): Promise<FcopReview> {
    try {
      const p = this._project as {
        mark_human_approved$: (
          reviewId: string,
          kw: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      const kwargs: Record<string, unknown> = {
        approver: spec.approver,
        decision: spec.decision,
        channel: spec.channel,
      };
      if (spec.comment !== undefined) kwargs["comment"] = spec.comment;
      const reviewProxy = await p.mark_human_approved$(reviewId, kwargs);
      return await readReview(reviewProxy);
    } catch (err) {
      throw new FcopClientError(
        `project.mark_human_approved(${JSON.stringify(reviewId)}, ${JSON.stringify({ approver: spec.approver, decision: spec.decision })}) failed`,
        "FcopProjectClient.markHumanApproved",
        err,
      );
    }
  }

  /**
   * Read a single REVIEW file via fcop. The argument is a **filename or
   * review_id** (NOT a filesystem path) — fcop resolves it against the
   * project's `fcop/reviews/` (or whatever `workspace_dir` was
   * configured at create() time).
   *
   * fcop 端 signature (Day 3 reconnaissance verified):
   *   `Project.read_review(filename_or_id: str) -> Review`
   *
   * Throws `FcopClientError` if the review doesn't exist, the file's
   * front-matter is malformed (fcop validates), or pythonia fails to
   * bridge.
   *
   * Day 3 (TASK-20260511-011) addition — Day 1 only had an *internal*
   * `readReview(proxy)` helper used by `writeReview` /
   * `markHumanApproved`; the public `readReview(filenameOrId)` method
   * was missing. PM TASK-011 §3.1.4 + DEV-009 §五 prep flagged this
   * (PM error #14); Day 3 adds it.
   */
  async readReview(filenameOrId: string): Promise<FcopReview> {
    try {
      const p = this._project as {
        read_review: (filenameOrId: string) => Promise<unknown>;
      };
      const reviewProxy = await p.read_review(filenameOrId);
      return await readReview(reviewProxy);
    } catch (err) {
      throw new FcopClientError(
        `project.read_review(${JSON.stringify(filenameOrId)}) failed`,
        "FcopProjectClient.readReview",
        err,
      );
    }
  }

  /**
   * Run fcop's schema validator against a task file. Returns the list of
   * `ValidationIssue` records fcop emitted (empty list = clean).
   *
   * fcop 端 signature (Day 3 reconnaissance verified):
   *   `Project.inspect_task(filename_or_id: str) -> list[ValidationIssue]`
   *
   * Intended consumers (out of Day 3 scope but the surface is ready):
   *   - InboxWatcher boot-time schema gating (Day 4 task per PM)
   *   - PM tooling for verifying task files before re-dispatch
   *
   * Day 3 (TASK-20260511-011 §3.1.4) addition — Day 1 did not expose
   * `inspect_task` (PM error #14). Day 3 adds it.
   */
  async inspectTask(filenameOrId: string): Promise<FcopValidationIssue[]> {
    const normalized = normalizeTaskIdentifier(filenameOrId);
    try {
      const p = this._project as {
        inspect_task: (filenameOrId: string) => Promise<unknown>;
      };
      const issuesProxy = await p.inspect_task(normalized);
      return await readValidationIssueList(issuesProxy);
    } catch (err) {
      if (err instanceof FcopClientError) throw err;
      throw new FcopClientError(
        `project.inspect_task(${JSON.stringify(filenameOrId)} -> ${JSON.stringify(normalized)}) failed`,
        "FcopProjectClient.inspectTask",
        err,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 私有
  // ─────────────────────────────────────────────────────────────────────

  private async _ensureInitialized(): Promise<void> {
    const initialized = await this.isInitialized();
    if (initialized) return;
    try {
      const p = this._project as {
        init$: (kw: Record<string, unknown>) => Promise<unknown>;
      };
      await p.init$({
        team: this._opts.team ?? "dev-team",
        lang: this._opts.lang ?? "zh",
        force: false,
        // deploy_role_templates 默认 True；codeflowmu v0.x 维持 fcop 自动写 roles 文件。
      });
    } catch (err) {
      throw new FcopClientError(
        `project.init(team=${this._opts.team ?? "dev-team"}) failed`,
        "FcopProjectClient._ensureInitialized",
        err,
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 内部：把 Python proxy 拉成 plain JS 对象
// ───────────────────────────────────────────────────────────────────────────

async function readTask(proxy: unknown): Promise<FcopTask> {
  const t = proxy as {
    task_id: Promise<string>;
    filename: Promise<string>;
    body: Promise<string>;
    date: Promise<string>;
    sequence: Promise<number>;
    is_archived: Promise<boolean>;
    path: Promise<unknown>;
    frontmatter: Promise<unknown>;
  };

  // Read top-level + frontmatter proxy in parallel where possible
  // (pythonia serializes these anyway, but the awaits read clearer).
  const frontmatterProxy = await t.frontmatter;
  const frontmatter = await readTaskFrontmatter(frontmatterProxy);

  return {
    task_id: await t.task_id,
    filename: await t.filename,
    path: String(await t.path),
    date: await t.date,
    sequence: await t.sequence,
    body: await t.body,
    is_archived: await t.is_archived,
    frontmatter,
    // Pre-populate convenience accessors so callers (TaskParser, etc.)
    // don't have to know about the nested structure.
    sender: frontmatter.sender,
    recipient: frontmatter.recipient,
    priority: frontmatter.priority,
    subject: frontmatter.subject,
    thread_key: frontmatter.thread_key,
    risk_level: frontmatter.risk_level,
    references: frontmatter.references,
  };
}

async function readTaskFrontmatter(proxy: unknown): Promise<FcopTaskFrontmatter> {
  if (proxy === null || proxy === undefined) {
    // Defensive — fcop always populates frontmatter, but a permissive
    // shape lets us return a usable object when stubs simulate edge cases.
    return {
      protocol: "fcop",
      version: 1,
      sender: "",
      recipient: "",
      priority: "",
      thread_key: null,
      subject: "",
      references: [],
      risk_level: "",
      extra: {},
    };
  }
  const f = proxy as {
    protocol: Promise<string>;
    version: Promise<number>;
    sender: Promise<string>;
    recipient: Promise<string>;
    priority: Promise<unknown>;
    thread_key: Promise<string | null>;
    subject: Promise<string | null>;
    references: Promise<unknown>;
    risk_level: Promise<unknown>;
    extra: Promise<unknown>;
  };
  const subjectRaw = await f.subject;
  return {
    protocol: await f.protocol,
    version: await f.version,
    sender: await f.sender,
    recipient: await f.recipient,
    priority: await readEnumLike(f.priority),
    thread_key: await f.thread_key,
    subject: subjectRaw ?? "",
    references: await readStringList(f.references),
    risk_level: await readEnumLike(f.risk_level),
    extra: await readPlainDict(f.extra),
  };
}

/**
 * Read a Python `dict[str, object]` proxy into a JS `Record<string, unknown>`.
 * Best-effort: we only support primitives + nested arrays/dicts of primitives.
 * Anything weirder gets `String(...)`'d. fcop's `TaskFrontmatter.extra` is
 * usually small (a few codeflowmu-specific keys like `layer`, `status`).
 */
async function readPlainDict(
  proxy: Promise<unknown> | unknown,
): Promise<Record<string, unknown>> {
  const resolved = await proxy;
  if (resolved === null || resolved === undefined) return {};
  const python = await getPython();
  const builtins = (await python("builtins")) as {
    list: (x: unknown) => Promise<unknown>;
  };
  // dict.keys() comes back as a `dict_keys` view; wrap in `list(...)` for
  // index access.
  try {
    const dictProxy = resolved as {
      keys: () => Promise<unknown>;
      [key: string]: unknown;
    };
    const keysView = await dictProxy.keys();
    const keysList = await builtins.list(keysView);
    const builtinsLen = (await python("builtins")) as {
      len: (x: unknown) => Promise<number>;
    };
    const n = await builtinsLen.len(keysList);
    const out: Record<string, unknown> = {};
    const keysArr = keysList as { [idx: number]: Promise<string> | undefined };
    for (let i = 0; i < n; i++) {
      const k = await keysArr[i];
      if (typeof k !== "string") continue;
      // `dict[key]` in pythonia: use bracket-index on the proxy
      const v = await (dictProxy as { [key: string]: Promise<unknown> })[k];
      out[k] = await coerceDictValue(v);
    }
    return out;
  } catch {
    // If the proxy doesn't behave like a dict, return empty rather than
    // throw — frontmatter.extra is an optional surface.
    return {};
  }
}

async function coerceDictValue(v: unknown): Promise<unknown> {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  // Anything else: stringify for safety. codeflowmu's `extra` usage is
  // string/number/boolean only in practice.
  return String(v);
}

async function readReview(proxy: unknown): Promise<FcopReview> {
  // fcop.Review is FULLY TOP-LEVEL (no nested frontmatter unlike Task).
  // Day 3 (TASK-20260511-011) added body / date / mtime + the upgraded
  // human_approval block to mirror fcop@1.1.0's actual `Review` shape.
  const r = proxy as {
    review_id: Promise<string>;
    filename: Promise<string>;
    reviewer_role: Promise<string>;
    reviewer_agent: Promise<string | null>;
    subject_type: Promise<unknown>;
    subject_ref: Promise<string>;
    decision: Promise<unknown>;
    rationale: Promise<string | null>;
    required_changes: Promise<unknown>;
    decided_at: Promise<unknown>;
    date: Promise<string>;
    sequence: Promise<number>;
    is_archived: Promise<boolean>;
    body: Promise<string>;
    mtime: Promise<unknown>;
    path: Promise<unknown>;
    human_approval: Promise<unknown>;
  };
  return {
    review_id: await r.review_id,
    filename: await r.filename,
    reviewer_role: await r.reviewer_role,
    reviewer_agent: await r.reviewer_agent,
    subject_type: await readEnumLike(r.subject_type),
    subject_ref: await r.subject_ref,
    decision: await readEnumLike(r.decision),
    rationale: await r.rationale,
    required_changes: await readStringList(r.required_changes),
    decided_at: stringifyMaybeDatetime(await r.decided_at),
    date: await r.date,
    sequence: await r.sequence,
    is_archived: await r.is_archived,
    body: await r.body,
    mtime: stringifyMaybeDatetime(await r.mtime),
    path: String(await r.path),
    human_approval: await readHumanApproval(await r.human_approval),
  };
}

async function readHumanApproval(
  proxy: unknown,
): Promise<FcopHumanApproval | null> {
  if (proxy === null || proxy === undefined) return null;
  const h = proxy as {
    approver: Promise<string>;
    decision: Promise<unknown>;
    approved_at: Promise<unknown>;
    channel: Promise<unknown>;
    comment: Promise<string | null>;
    evidence: Promise<unknown>;
  };
  return {
    approver: await h.approver,
    decision: await readEnumLike(h.decision),
    approved_at: stringifyMaybeDatetime(await h.approved_at),
    channel: await readEnumLike(h.channel),
    comment: await h.comment,
    evidence: await readEvidenceLike(await h.evidence),
  };
}

/**
 * fcop returns `HumanApprovalEvidence` as a Python dataclass or `None`.
 * v0.3 doesn't type-narrow further — Mobile/CLI ack layer (v0.5) will.
 * Returns `null` for None; otherwise serializes known evidence fields
 * (`device_id`, `ip`, `auth_method`) plus a `__repr__` fallback.
 */
async function readEvidenceLike(
  proxy: unknown,
): Promise<Record<string, unknown> | null> {
  if (proxy === null || proxy === undefined) return null;
  // Best-effort: try the documented fields; fcop guarantees the
  // dataclass exposes these even if some are None.
  const e = proxy as {
    device_id?: Promise<string | null>;
    ip?: Promise<string | null>;
    auth_method?: Promise<string | null>;
  };
  const evidence: Record<string, unknown> = {};
  try {
    if (e.device_id !== undefined) evidence["device_id"] = await e.device_id;
  } catch {
    // tolerated — caller doesn't strictly need it
  }
  try {
    if (e.ip !== undefined) evidence["ip"] = await e.ip;
  } catch {
    // tolerated
  }
  try {
    if (e.auth_method !== undefined)
      evidence["auth_method"] = await e.auth_method;
  } catch {
    // tolerated
  }
  return evidence;
}

/**
 * fcop returns `datetime.datetime` for `decided_at`, `mtime`,
 * `approved_at`. pythonia stringifies via `__str__` which gives
 * `"2026-05-11 15:30:00.000000+00:00"`. We surface the raw string —
 * callers that need ISO-8601 can re-parse, but most codeflowmu code just
 * logs / persists this verbatim.
 */
function stringifyMaybeDatetime(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

async function readValidationIssueList(
  proxy: unknown,
): Promise<FcopValidationIssue[]> {
  // Same pattern as readTaskList — Python list exposes async-iter +
  // index access; we go via `builtins.len + arr[i]` because it's
  // strictly serialized and avoids pythonia's async-iter quirks.
  const python = await getPython();
  const builtins = (await python("builtins")) as {
    len: (x: unknown) => Promise<number>;
  };
  const n = await builtins.len(proxy);
  const out: FcopValidationIssue[] = [];
  const arr = proxy as { [idx: number]: Promise<unknown> };
  for (let i = 0; i < n; i++) {
    const issueProxy = await arr[i];
    out.push(await readValidationIssue(issueProxy));
  }
  return out;
}

async function readValidationIssue(
  proxy: unknown,
): Promise<FcopValidationIssue> {
  const v = proxy as {
    severity: Promise<string>;
    field: Promise<string>;
    message: Promise<string>;
    path: Promise<unknown>;
  };
  const rawPath = await v.path;
  return {
    severity: await v.severity,
    field: await v.field,
    message: await v.message,
    path: rawPath === null || rawPath === undefined ? null : String(rawPath),
  };
}

async function readTaskList(proxy: unknown): Promise<FcopTask[]> {
  // Pythonia 把 Python list 暴露成 async iterable，但更稳的是用 builtins.len + 索引。
  const python = await getPython();
  const builtins = (await python("builtins")) as {
    len: (x: unknown) => Promise<number>;
  };
  const n = await builtins.len(proxy);
  const out: FcopTask[] = [];
  const arr = proxy as { [idx: number]: Promise<unknown> };
  for (let i = 0; i < n; i++) {
    const taskProxy = await arr[i];
    out.push(await readTask(taskProxy));
  }
  return out;
}

async function readStringList(proxy: unknown): Promise<string[]> {
  // pythonia 给我们一个 `Promise<list>` 风格的字段；要先 await 拿到 list proxy
  // 再把它喂给 builtins.len。生产路径下没有 `await` 会让 builtins.len 接收一个
  // Promise<list> 而非 list，pythonia 会 throw 或返回错值；测试 stub 也会
  // 报「only supports arrays」（因为 Array.isArray(Promise) === false）。
  const resolved = await proxy;
  if (resolved === null || resolved === undefined) return [];
  const python = await getPython();
  const builtins = (await python("builtins")) as {
    len: (x: unknown) => Promise<number>;
  };
  const n = await builtins.len(resolved);
  const out: string[] = [];
  const arr = resolved as { [idx: number]: Promise<string> | undefined };
  for (let i = 0; i < n; i++) {
    const item = await arr[i];
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * fcop 返回 enum 字段时 pythonia 把它包成 enum proxy；取字符串值应该用 `.value`。
 * 但有些场景下 fcop 字段已经是 plain string（如 task.date）。本函数 best-effort：
 * 优先取 `.value`，失败 fallback 到 `.toString()`，再退到 `String()`。
 */
async function readEnumLike(proxy: Promise<unknown>): Promise<string> {
  const raw = await proxy;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { value?: Promise<string> | string };
    try {
      const v = await obj.value;
      if (typeof v === "string") return v;
    } catch {
      // fall through
    }
    try {
      const s = String(raw);
      // Python enum repr is like `<ReviewDecision.NEEDS_HUMAN: 'needs_human'>`；
      // 这种情形不应出现（应该走 .value 成功），但兜底用 regex 抽 value。
      const m = s.match(/:\s*'([^']+)'>/);
      if (m && m[1] !== undefined) return m[1];
      return s;
    } catch {
      return "<unknown enum>";
    }
  }
  return String(raw);
}

// ───────────────────────────────────────────────────────────────────────────
// 错误格式化
// ───────────────────────────────────────────────────────────────────────────

function formatPythonStartupError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = [
    "Failed to import `fcop` via pythonia. Likely causes:",
    "  1. PYTHON_BIN env var not set, and PATH `python3` / `python` is a Python that doesn't have fcop installed.",
    `     Current PYTHON_BIN = ${process.env["PYTHON_BIN"] ?? "<unset>"}`,
    "  2. Python < 3.10 (fcop requires 3.10+).",
    "  3. fcop@1.1.0 not installed: try `py -3 -m pip install fcop` (or `pip install fcop` on the same interpreter `PYTHON_BIN` points to).",
    "",
    "Original error from pythonia:",
    `  ${msg}`,
  ].join("\n");
  return hint;
}

// ───────────────────────────────────────────────────────────────────────────
// 仅测试 — 不进 index.ts 公共导出。
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reset the module-level cache. **Test-only**. Production code MUST NOT call
 * this; the cache is what keeps Python single-instance. Used in
 * `__tests__/fcop-client.test.ts` to simulate cold-start failures.
 */
export function __resetFcopBridgeForTests(): void {
  fcopModulePromise = null;
}

/**
 * Swap the pythonia `python` callable for a stub. **Test-only**. Pass
 * `null` to restore the lazy-loaded pythonia callable (which will be
 * dynamically imported only when actually used — see `getDefaultPython`).
 *
 * Stubs returned by `pythonStub(moduleName)` must be shaped like the relevant
 * Python module they're impersonating — see `__tests__/fcop-client.test.ts`
 * for canned `fcop` / `builtins` / `sys` stubs.
 */
export function __setPythonForTests(
  stub: PythonCallable | null,
): void {
  pythonOverride = stub;
}

/**
 * **Test-only**. If pythonia was actually loaded during a test (i.e. some
 * code path called `getDefaultPython()`), kill the child Python subprocess.
 * Idempotent and a no-op when pythonia was never touched (which is the
 * common case under stubbed tests now that pythonia is loaded lazily).
 */
export function __killRealPythonChildForTests(): void {
  if (pythoniaModulePromise === null) return;
  pythoniaModulePromise
    .then((python) => {
      try {
        python.exit();
      } catch {
        // pythonia may already be down — ignore.
      }
    })
    .catch(() => {
      // pythonia failed to load — nothing to kill.
    });
  pythoniaModulePromise = null;
}

