/**
 * AgentSdkAdapter — narrow seam between AgentRegistry and `@cursor/sdk`.
 *
 * CodeFlowMu 只有一套 Runtime：TASK → 本接口（执行插槽）→ REPORT。
 * Cursor / Gemini / Codex 是实现插槽，不是第二套调度或第二套 PM 逻辑。
 *
 * Why an adapter at all:
 *
 * - `AgentRegistry` and `RuntimeBootstrap` need three SDK calls:
 *   `create`, `resume`, `list`. Anything else (send / cancel / artifacts)
 *   is outside the registry's contract — handled by `SessionManager` (S3
 *   Phase B+).
 * - Tests must run without a real `CURSOR_API_KEY` / network. The adapter
 *   abstraction lets us inject `InMemorySdkAdapter` so 11 unit-test
 *   scenarios (TASK-009 §必交付 6) cover behavior without touching SDK.
 * - The adapter is the ONLY place that imports `@cursor/sdk` types — keeps
 *   the registry / bootstrap files SDK-version-agnostic.
 *
 * Cross-link: `_ignore/spike_sdk_doorbell/sender.ts` validated the SDK
 * surface used here (Agent.create/resume/list signatures + asyncDispose).
 * Reproduced inline (NOT git-mv'd; spike folder is preserved as historical
 * evidence per HANDOFF + REPORT-002).
 *
 * ── BUG-SDK-002 (v0.2.0-beta.2, TASK-20260510-012) ────────────────────
 *
 * QA-011 found that `Agent.create({ local: { cwd } })` followed by
 * `Agent.resume(id) → agent.send(text)` 100% fails on local agents with:
 *
 *   Agent <uuid> already has active run (code=undefined, isRetryable=false)
 *
 * Root cause (inferred from `@cursor/sdk` types — package source isn't
 * shipped): every `Agent.create()` for a local agent creates a persisted
 * run record on disk under the agent's cwd. `Symbol.asyncDispose` only
 * tears down the local IPC stream; the run record stays "active". The
 * very next `Agent.resume(id)` therefore re-binds to that still-active
 * run, and `agent.send()` is interpreted as a *second* concurrent run on
 * the same agent — the SDK rejects with the message above.
 *
 * Fix (direction B', adopted): pass `local: { force: true }` to
 * `agent.send()`. `SendOptions.local.force` is documented in
 * `node_modules/@cursor/sdk/dist/.../agent.d.ts` as:
 *
 *   "Expire the currently active persisted run, if any, before starting
 *    this message as a new follow-up run. Recovery path for local agents
 *    left wedged after a crashed CLI process."
 *
 * We adopt it as the *normal* path because v0.2 codeflowmu-shell is
 * single-shot per task (no in-process multi-turn dialog the force=true
 * would clobber). Cloud-mode senders go through a separate code path
 * — the SDK type system forbids `local: { ... }` on cloud sends, and
 * cloud has server-side `409 agent_busy` instead. See `_buildSendOptions`.
 *
 * Investigated and rejected:
 *  - Direction A (`Agent.create({ immediate: false })`) — option does
 *    not exist on `AgentOptions` (see options.d.ts).
 *  - Direction B in original form (cache the run from create() and reuse
 *    it on first send) — would require a per-process cache keyed by
 *    sdk_agent_id + survives between two `npm start` invocations? No,
 *    the persisted run on disk does. force=true is the cross-process
 *    correct answer.
 *  - Direction C (drop `prompt` from create) — `AgentOptions` doesn't
 *    accept a `prompt` field; only `Agent.prompt()` (a different API)
 *    does. Already not applicable.
 *
 * ── BUG-SDK-007 (v0.2.0-beta.3, TASK-20260511-001) ────────────────────
 *
 * QA-014 ran three real-key smokes on ADMIN's Cursor API key, each with
 * `CURSOR_DEFAULT_MODEL` set to a different value drawn from the SDK's
 * own "Available models" allowlist (`default`, `claude-sonnet-4`,
 * `claude-sonnet-4-5`). All three crashed identically at
 * `registerDefaultAgentKitIfEmpty()` (before the banner even prints):
 *
 *   fatal: Error: Agent.create failed for agent_id="DEV-01":
 *          Cannot use this model: <name>.
 *          Available models: default, composer-2, gpt-5.5, ...,
 *                            claude-sonnet-4, ..., claude-sonnet-4-5, ...
 *          (code=undefined, isRetryable=false)
 *
 * The error message is paradoxical — the rejected name appears *in*
 * the "Available models" list — which is the signature of an ACL
 * problem, not a model-name problem. Control evidence:
 *
 *   - ADMIN key + `Agent.create()` WITHOUT a model arg → success
 *     (QA-011 §六 v0.2.0-beta.1; QA-014 `.smoke-qa014-20260511-080830`)
 *   - DEV key + `Agent.create({ model: { id } })` → success
 *     (DEV-013 §四 #3 smoke under `.smoke-beta2-redux/`)
 *
 * Inferred root cause: Cursor's backend has a per-API-key ACL on the
 * "programmatically specify model on Agent.create" capability. ADMIN's
 * key tier is not in the allow-list; DEV's key tier is. The SDK does
 * NOT surface this as a 403/ACL error — it reuses the "bad model name"
 * code path, masking the real reason. This is a SDK UX bug, but the
 * application-layer workaround is straightforward:
 *
 * Fix (direction A, adopted): **never pass `model` to `Agent.create()`**,
 * regardless of `spec.modelId` or `this._opts.defaultModel`. `model` is
 * still passed through `Agent.resume()` inside `send()` (the resume
 * path is on a different ACL endpoint and QA-014 has implicit positive
 * evidence — DEV-012/013 send() calls ran cleanly on both key tiers).
 *
 * Consequences:
 *  - `CURSOR_DEFAULT_MODEL` env var becomes **send-time only**. The
 *    `Agent.create()` step is now model-agnostic for ALL key tiers,
 *    not just enterprise ones. Documented in `.env.example`.
 *  - MT-1's "wire defaultModel through Agent.create()" is partially
 *    reverted: only the create() half is reverted; send()/resume()
 *    half (where BUG-SDK-001's "Local SDK agents require an explicit
 *    model" error actually fires) is unchanged.
 *  - Test seams: TS-MODEL-1/2 (which formerly asserted Agent.create
 *    receives a model key) are flipped to assert NO model key. New
 *    TS-MODEL-6/7/8 pin the v0.2.0-beta.3 contract.
 *
 * Investigated and rejected:
 *  - Direction B (drop model from BOTH create() and send()) — would
 *    re-trigger BUG-SDK-001 on local-mode sends; QA-009 evidence
 *    documents that Agent.resume({ model: {...} }) is required for
 *    local sends to succeed.
 *  - Direction C (env switch `CURSOR_SDK_MODEL_ON_CREATE=true|false`,
 *    default false) — overengineered; the create-time model arg has
 *    no observable benefit over the send-time model arg (the SDK
 *    plans the run using the *send* model anyway).
 */

import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";
import type {
  ListAgentsOptions,
  McpServerConfig,
  ModelSelection,
} from "@cursor/sdk";

import type { AgentLayer, AgentRuntime } from "@codeflowmu/protocol";

import {
  SdkRunHandle,
  type CursorTokenEstimate,
  type SdkRunLike,
} from "../session/SdkRunHandle.ts";
import type { RunHandle } from "../types/state.ts";
import type { UiLang } from "../panel/PanelUiLang.ts";

const CURSOR_TOOL_SCHEMA_TOKEN_ESTIMATE = 430;
const CURSOR_FALLBACK_TOOL_COUNT = 28;
const CURSOR_AUTO_MODEL_ID = "auto-smart";
const CURSOR_AUTO_COST_PARAMS = [
  { id: "optimize_for", value: "cost" },
] satisfies NonNullable<ModelSelection["params"]>;

function cursorModelSelection(modelId: string): ModelSelection {
  return modelId === CURSOR_AUTO_MODEL_ID
    ? { id: modelId, params: CURSOR_AUTO_COST_PARAMS.map((param) => ({ ...param })) }
    : { id: modelId };
}

function isAgentNotFoundLike(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "").toLowerCase()
      : "";
  const text =
    error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : String(error).toLowerCase();
  return (
    code === "agent_not_found" ||
    text.includes("agent_not_found") ||
    /agent\s+[^\s]+\s+not\s+found/.test(text)
  );
}

function estimateCursorTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii * 1.2);
}

function readMcpEnvValue(config: McpServerConfig, key: string): string | undefined {
  const maybe = config as unknown as { env?: Record<string, string | undefined> };
  const value = maybe.env?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function countCursorMcpTools(mcpServers: Record<string, McpServerConfig> | undefined): number {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return 0;
  }
  let explicit = 0;
  for (const config of Object.values(mcpServers)) {
    const allowed =
      readMcpEnvValue(config, "FCOP_ALLOWED_TOOLS") ??
      readMcpEnvValue(config, "CODEFLOW_ALLOWED_TOOLS");
    if (allowed) {
      explicit += allowed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean).length;
    }
  }
  if (explicit > 0) {
    return explicit;
  }
  return CURSOR_FALLBACK_TOOL_COUNT;
}

function estimateCursorSendTokens(args: {
  text: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
}): CursorTokenEstimate {
  const estimatedTextTokens = estimateCursorTextTokens(args.text);
  const toolCount = countCursorMcpTools(args.mcpServers);
  const estimatedToolSchemaTokens = toolCount * CURSOR_TOOL_SCHEMA_TOKEN_ESTIMATE;
  return {
    provider: "cursor",
    ...(args.model ? { model: args.model } : {}),
    estimatedInputTokens: estimatedTextTokens + estimatedToolSchemaTokens,
    estimatedTextTokens,
    estimatedToolSchemaTokens,
    requestCount: 1,
    toolCount,
  };
}

/**
 * Spec used to call `Agent.create()`. Mirrors what `AgentRegistry.register`
 * extracts from a protocol-level `Agent`: enough to bootstrap an SDK agent
 * but not the whole FCoP record (avoids leaking governance fields into
 * SDK tooling that doesn't understand them).
 */
export interface AgentCreateSpec {
  /** FCoP role id, e.g. `"DEV-01"`. Used as the SDK agent's display name. */
  agentId: string;
  /** Mapped to `roles.yaml` `roles[].id`. Used for the role brief. */
  role: string;
  /** §0.9.1 layer; informs the SDK display name only. */
  layer: AgentLayer;
  /** Cursor SDK runtime mode. Currently `local` is the v0.1 reality. */
  runtime: AgentRuntime;
  /** For local agents: cwd path. For cloud agents: repo URL. */
  workspace?: string;
  /**
   * Optional model hint. BUG-SDK-007 (v0.2.0-beta.3): this field is
   * NO LONGER forwarded to `Agent.create({ model })` — Cursor's backend
   * rejects programmatic model spec on create() for ADMIN-class API
   * keys with a misleading "Cannot use this model: <name>" error.
   * The field is kept on the spec for API stability and so the registry
   * can forward it through to send()-time on AgentSendSpec.modelId
   * (where the same value DOES get fed to Agent.resume({ model })).
   * See file-level JSDoc BUG-SDK-007 section + TS-MODEL-6 contract.
   */
  modelId?: string;
}

/**
 * Spec used to call `agent.send()` on a freshly resumed SDK agent. Carries
 * the FCoP-side identifiers that `SessionManager` stamps onto the resulting
 * `RunHandle` (so transcript files / Mobile push events have the right
 * `session_id` / `agent_id` without the adapter having to invent them).
 */
/** Multimodal image — url or inline base64 (runtime-only, not persisted to TASK). */
export type SessionSdkImage =
  | { url: string }
  | { data: string; mimeType: string };

/** Runtime-enforced send mode — narrows Gemini tool surface without prompt-only heuristics. */
export type AgentRunMode = "pm_self_report_only";

export interface AgentSendSpec {
  /** Pattern: `^session-[a-z0-9-]+$`. Used as `RunHandle.session_id`. */
  sessionId: string;
  /** FCoP role id, e.g. `"DEV-01"`. Used as `RunHandle.agent_id`. */
  agentId: string;
  /** Plain text to forward to `agent.send(text)`. */
  text: string;
  /** Active project root used as the local Cursor runtime cwd. */
  workspace?: string;
  /**
   * Optional image attachments for multimodal sends (public Cursor SDK adapter).
   * Populated at send-time from disk (base64) or remote url — never from TASK frontmatter.
   */
  images?: SessionSdkImage[];
  /**
   * Optional model hint. Passed through to `Agent.resume({ model })`.
   * Defaults to the adapter's configured default model.
   */
  modelId?: string;
  /**
   * Per-send MCP server config. When set, overrides adapter-level
   * `mcpServers` for this `agent.send()` only (token-management: worker
   * agents get executor tool subset, PM gets leader subset, etc.).
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Max SDK `tool_call` events per doorbell `send()` (token guard).
   * Exceed → run cancelled, `status=failed`, `failure_code=TURN_LIMIT`.
   */
  maxToolRounds?: number;
  /** Panel UI language — controls thinking-stream / system-instruction locale. */
  uiLang?: UiLang;
  /**
   * Session pinned TASK prefix (TASK-YYYYMMDD-NNN) from TaskDispatcher /
   * SessionManager — authoritative for write_report task_id guard.
   */
  pinnedTaskId?: string;
  /** Absolute or repo-relative path to the active TASK file (basename → task id). */
  taskFilepath?: string;
  /** Optional frontmatter task_id from parsed TASK (fallback after spec fields). */
  frontmatterTaskId?: string;
  /**
   * When `pm_self_report_only`: PM may only write_report for pinned task;
   * dispatch / lifecycle governance tools are blocked at adapter runtime.
   */
  runMode?: AgentRunMode;
}

/**
 * Adapter contract — four methods, all narrow on purpose. Implementations
 * MUST be safe to call concurrently for `list`, but `create` / `resume`
 * / `send` may serialize at the implementation's discretion (the SDK
 * already enforces `409 agent_busy` server-side).
 *
 * Phase A shipped 3 methods (create / list / resume). Phase B added `send`
 * (TASK-20260509-013 §主交付 1 (c)). The reason `send` lives on the
 * adapter, not on `SessionManager` directly, is the §"adapter is the only
 * place that imports `@cursor/sdk`" rule from this file's docstring.
 */
export interface AgentSdkAdapter {
  /**
   * Create an SDK agent and return its (cloud or local) `agentId`.
   * Mirrors `Agent.create({...})` — the registry takes the returned id
   * verbatim and stores it as `record.protocol.sdk_agent_id`.
   */
  create(spec: AgentCreateSpec): Promise<{ sdk_agent_id: string }>;

  /**
   * Enumerate `sdk_agent_id`s currently visible to the SDK. Used by
   * `RuntimeBootstrap` to detect orphaned / foreign records.
   *
   * Implementations MAY filter by runtime/cwd; `RuntimeBootstrap` calls
   * with the runtime's configured cwd to scope local-runtime listings.
   */
  list(): Promise<string[]>;

  /**
   * Re-bind to an existing SDK agent. Equivalent to `Agent.resume(id)`,
   * but adapter-shaped so tests don't need a real SDK.
   *
   * MUST throw if the SDK no longer recognizes the id; callers translate
   * that into the `orphan_local` reconciliation strategy.
   *
   * Implementations MUST dispose the agent before resolving — this method
   * is for "is the agent still live" probes only. Do NOT use it to keep
   * an agent reference alive for `send`; that flow belongs to `send` itself.
   */
  resume(sdkAgentId: string): Promise<void>;

  /**
   * Resume the SDK agent and immediately call `agent.send(text)`, returning
   * a `RunHandle` that owns the resulting Run's stream / cancel / dispose
   * lifecycle. Each call is an independent SDK conversation — the adapter
   * does NOT pool agents (decision N: SDK pattern is "resume → send →
   * settled → dispose", concurrent sessions per agent live in §3.2 future
   * work, not Phase B).
   *
   * MUST throw if the SDK rejects the resume / send. Caller (SessionManager)
   * translates that into a `runtime.session_failed` event.
   */
  send(spec: AgentSendSpec, sdkAgentId: string): Promise<RunHandle>;

  /**
   * List models available to the authenticated user.
   */
  listModels(): Promise<string[]>;
}

// ───────────────────────────────────────────────────────────────────────────
// Cursor SDK-backed implementation
// ───────────────────────────────────────────────────────────────────────────

/** Construction options for `CursorSdkAdapter`. */
export interface CursorSdkAdapterOptions {
  /**
   * `CURSOR_API_KEY` to forward to every SDK call. Falls back to
   * `process.env.CURSOR_API_KEY` at call time if omitted.
   */
  apiKey?: string;
  /**
   * Default cwd for local-runtime agents. Tests override this; production
   * uses the runtime's working directory.
   */
  defaultCwd?: string;
  /**
   * Enable the Cursor local-runtime OS sandbox. Open edition turns this on
   * unconditionally so native edit/shell tools cannot escape the active cwd.
   */
  sandboxEnabled?: boolean;
  /**
   * `runtime` filter passed to `Agent.list()`. Defaults to `local` to
   * scope reconciliation to the current machine. Set to `undefined` for
   * a cross-runtime listing (rarely useful; only the runtime owner knows
   * which scope is correct).
   */
  listScope?: "local" | "cloud" | undefined;
  /**
   * Default model id forwarded ONLY to `Agent.resume({ model })` /
   * `agent.send({ model })` (BUG-SDK-007 fix, v0.2.0-beta.3 onwards;
   * Agent.create() is now intentionally model-free for ALL key tiers).
   *
   * **Required for `local` runtime** — the SDK rejects local agents
   * in `send()`/`resume()` with `Local SDK agents require an explicit
   * model. Pass model: { id: "..." } to Agent.create() or to send(),
   * or run this agent in cloud mode.` (BUG-SDK-001 / MT-1; still
   * fires on the resume half of the pipeline even after BUG-SDK-007).
   *
   * Both per-call (`spec.modelId`) and adapter-level (`defaultModel`)
   * are optional in the type system so cloud-mode users (whose SDK
   * picks a default automatically) aren't forced to set a value, but
   * `local`-mode users MUST set at least one of them.
   *
   * Reference: TASK-20260510-010-PM-to-DEV §3.1 + REPORT-20260510-009
   * §五 BUG-SDK-001.
   */
  defaultModel?: string;
  /**
   * MCP servers injected into every `agent.send()` call via
   * `SendOptions.mcpServers`. Each entry starts a subprocess (stdio)
   * or connects to a URL (http/sse) that provides tools to the agent.
   *
   * v0.3: used to wire `fcop-mcp` so agents have live FCoP write APIs
   * (write_task / write_report / etc.) instead of running tool-less.
   * Built by `sdk-factory.ts` from `PYTHON_BIN` + `projectRoot`.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** Test seam; production defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Real `@cursor/sdk` adapter. Thin wrapper — no caching, no retries.
 * The registry layer owns retry / failure semantics so they're observable
 * in the same place.
 */
export class CursorSdkAdapter implements AgentSdkAdapter {
  private readonly _opts: CursorSdkAdapterOptions;

  constructor(opts: CursorSdkAdapterOptions = {}) {
    this._opts = opts;
  }

  private _cursorSandboxOptions(): { sandboxOptions: { enabled: true } } | Record<string, never> {
    const platform = this._opts.platform ?? process.platform;
    // Cursor local OS sandbox is currently unsupported by the Windows SDK.
    // CodeFlowMu's project-root and tool-policy guards remain mandatory there.
    return this._opts.sandboxEnabled && platform !== "win32"
      ? { sandboxOptions: { enabled: true } }
      : {};
  }

  async create(spec: AgentCreateSpec): Promise<{ sdk_agent_id: string }> {
    const apiKey = this._resolveApiKey();
    // BUG-SDK-007 fix (TASK-20260511-001 / v0.2.0-beta.3): NEVER pass a
    // `model` field to Agent.create(), regardless of spec.modelId or
    // this._opts.defaultModel. See file-level JSDoc for the QA-014 +
    // QA-011 ACL evidence. The defaultModel / spec.modelId precedence
    // chain still applies on the send/resume path inside `send()`
    // below — that's where BUG-SDK-001 ("Local SDK agents require an
    // explicit model") actually fires, and where the ACL does NOT
    // reject the model arg for ADMIN-class keys.
    //
    // `spec.modelId` is still accepted on AgentCreateSpec (kept for
    // API stability + so AgentRegistry.register() can forward the
    // per-agent hint through to send()-time), but is intentionally
    // unused here. TS-MODEL-6 pins this contract.
    let agent;
    try {
      agent = await Agent.create({
        apiKey,
        name: `codeflowmu ${spec.agentId}`,
        local: {
          cwd: spec.workspace ?? this._opts.defaultCwd ?? process.cwd(),
          ...this._cursorSandboxOptions(),
        },
      });
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(
          `Agent.create failed for agent_id="${spec.agentId}": ${err.message} ` +
            `(code=${err.code}, isRetryable=${err.isRetryable})`,
        );
      }
      throw err;
    }

    const sdkAgentId = agent.agentId;
    await agent[Symbol.asyncDispose]();
    return { sdk_agent_id: sdkAgentId };
  }

  async list(): Promise<string[]> {
    const apiKey = this._resolveApiKey();
    const listOptions = this._buildListOptions(apiKey);

    let result;
    try {
      result = await Agent.list(listOptions);
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(
          `Agent.list failed: ${err.message} (code=${err.code}, isRetryable=${err.isRetryable})`,
        );
      }
      throw err;
    }
    return result.items.map((item) => item.agentId);
  }

  async resume(sdkAgentId: string): Promise<void> {
    const apiKey = this._resolveApiKey();
    let agent;
    try {
      agent = await Agent.resume(sdkAgentId, {
        apiKey,
        local: {
          cwd: this._opts.defaultCwd ?? process.cwd(),
          ...this._cursorSandboxOptions(),
        },
      });
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(
          `Agent.resume failed for sdk_agent_id="${sdkAgentId}": ${err.message} ` +
            `(code=${err.code}, isRetryable=${err.isRetryable})`,
        );
      }
      throw err;
    }
    await agent[Symbol.asyncDispose]();
  }

  async send(spec: AgentSendSpec, sdkAgentId: string): Promise<RunHandle> {
    const apiKey = this._resolveApiKey();
    // MT-1 / BUG-SDK-001 fallback chain still applies HERE on the
    // resume path (BUG-SDK-007 only reverts create-time model). Local
    // sends without an explicit model fail with "Local SDK agents
    // require an explicit model"; this layer feeds the SDK either the
    // per-task `spec.modelId` hint or the adapter-level defaultModel.
    let modelId = spec.modelId ?? this._opts.defaultModel ?? CURSOR_AUTO_MODEL_ID;
    if (modelId) {
      modelId = await this._normalizeModelId(modelId, apiKey);
    }
    const modelSelection = modelId ? cursorModelSelection(modelId) : undefined;

    const effectiveCwd = spec.workspace ?? this._opts.defaultCwd ?? process.cwd();
    let agent;
    try {
      agent = await Agent.resume(sdkAgentId, {
        apiKey,
        ...(modelSelection ? { model: modelSelection } : {}),
        local: {
          cwd: effectiveCwd,
          ...this._cursorSandboxOptions(),
        },
      });
    } catch (err) {
      // Cursor local agents are lazy: Agent.create() can return an id before
      // that id has a durable local record.  The record is materialised by
      // the first real send.  Requiring resume() to succeed before that send
      // made a normal cold start/project switch fail with agent_not_found.
      // Recreate the *same* logical id locally and continue with this send;
      // the send below is the authoritative materialisation boundary.
      if (this._opts.listScope !== "cloud" && isAgentNotFoundLike(err)) {
        try {
          agent = await Agent.create({
            agentId: sdkAgentId,
            apiKey,
            name: `codeflowmu ${spec.agentId}`,
            local: {
              cwd: effectiveCwd,
              ...this._cursorSandboxOptions(),
            },
          });
        } catch (createErr) {
          if (createErr instanceof CursorAgentError) {
            throw new Error(
              `Agent.create recovery failed for sdk_agent_id="${sdkAgentId}" (during send): ` +
                `${createErr.message} (code=${createErr.code}, isRetryable=${createErr.isRetryable})`,
            );
          }
          throw createErr;
        }
      } else {
        if (err instanceof CursorAgentError) {
          throw new Error(
            `Agent.resume failed for sdk_agent_id="${sdkAgentId}" (during send): ` +
              `${err.message} (code=${err.code}, isRetryable=${err.isRetryable})`,
          );
        }
        throw err;
      }
    }

    let run;
    try {
      // BUG-SDK-002 fix: pass `local: { force: true }` for local-mode sends
      // so any persisted-but-wedged run from a prior create()/resume() is
      // expired before this send starts a new run. See file-level JSDoc.
      const sendOptions = this._buildSendOptions(spec, modelId);
      const message =
        spec.images && spec.images.length > 0
          ? { text: spec.text, images: spec.images }
          : spec.text;
      run = await agent.send(message, sendOptions);
    } catch (err) {
      // Dispose the resumed agent if send failed — we never got to a usable
      // state. Best-effort: a failing dispose adds noise but doesn't change
      // the failure semantics for the caller.
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        // best-effort
      }
      if (err instanceof CursorAgentError) {
        throw new Error(
          `agent.send failed for sdk_agent_id="${sdkAgentId}": ${err.message} ` +
            `(code=${err.code}, isRetryable=${err.isRetryable})`,
        );
      }
      throw err;
    }

    // SdkRunHandle owns dispose from here; see SdkRunHandle._driveStream.
    const effectiveMcpServers = spec.mcpServers ?? this._opts.mcpServers;
    return new SdkRunHandle({
      agent,
      run: run as unknown as SdkRunLike,
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      projectRoot: effectiveCwd,
      ...(spec.maxToolRounds != null ? { maxToolRounds: spec.maxToolRounds } : {}),
      tokenEstimate: estimateCursorSendTokens({
        text: spec.text,
        ...(modelId ? { model: modelId } : {}),
        ...(effectiveMcpServers ? { mcpServers: effectiveMcpServers } : {}),
      }),
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const apiKey = this._resolveApiKey();
      const models = await Cursor.models.list({ apiKey });
      return models.map((m) => m.id);
    } catch (err) {
      // Fallback in case of error or key-level ACL issues
      return [
        CURSOR_AUTO_MODEL_ID,
        "composer-2.5",
        "composer-2.5-fast",
        "claude-3-5-sonnet",
        "claude-3-opus",
        "claude-3-5-haiku",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "deepseek-v3",
        "deepseek-r1"
      ];
    }
  }

  private async _normalizeModelId(modelId: string, apiKey: string): Promise<string> {
    if (!modelId) return modelId;
    if (
      modelId === CURSOR_AUTO_MODEL_ID ||
      modelId === "auto" ||
      modelId === "default"
    ) {
      return CURSOR_AUTO_MODEL_ID;
    }

    const clean = (s: string) => s.toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/-+/g, "-");

    const targetClean = clean(modelId);

    try {
      const models = await Cursor.models.list({ apiKey });
      const exactMatch = models.find(m => m.id === modelId);
      if (exactMatch) return exactMatch.id;

      const cleanMatch = models.find(m => clean(m.id) === targetClean);
      if (cleanMatch) return cleanMatch.id;

      const displayMatch = models.find(m => clean(m.displayName) === targetClean);
      if (displayMatch) return displayMatch.id;

      const fuzzyMatch = models.find(m => clean(m.id).includes(targetClean) || targetClean.includes(clean(m.id)));
      if (fuzzyMatch) return fuzzyMatch.id;
    } catch {
      // ignore
    }
    return targetClean;
  }

  private _resolveApiKey(): string {
    const apiKey = this._opts.apiKey ?? process.env["CURSOR_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "CursorSdkAdapter: missing CURSOR_API_KEY (set process.env.CURSOR_API_KEY or pass apiKey in constructor)",
      );
    }
    return apiKey;
  }

  private _buildListOptions(apiKey: string): ListAgentsOptions {
    if (this._opts.listScope === "cloud") {
      return { runtime: "cloud", apiKey };
    }
    if (this._opts.listScope === "local") {
      return {
        runtime: "local",
        cwd: this._opts.defaultCwd ?? process.cwd(),
      };
    }
    return {};
  }

  /**
   * Build the `SendOptions` passed to `agent.send(text, opts)`.
   *
   * Local mode (the v0.2 default): include `local: { force: true }` to
   * expire any persisted-but-wedged run on the agent's cwd before this
   * send starts a new one. This is the BUG-SDK-002 fix — see file-level
   * JSDoc for the full root-cause analysis.
   *
   * Cloud mode: NO `local` field. The SDK type system rejects `local`
   * options on cloud sends, and cloud has server-side `409 agent_busy`
   * concurrency control (see SDKAgent.send / SendOptions.local in
   * `@cursor/sdk` agent.d.ts).
   *
   * Undefined `listScope` (rare; only when callers omit it explicitly):
   * we treat as local because v0.2 ships local as default and forwarding
   * `force` to a non-existent local run is a no-op. Cloud users MUST
   * set `listScope: "cloud"` to opt out.
   *
   * v0.3: also merges `mcpServers` from adapter options so callers
   * (typically `sdk-factory.ts` wiring fcop-mcp) can inject tools
   * without touching the send call site.
   */
  private _buildSendOptions(spec?: AgentSendSpec, modelId?: string): {
    model?: ModelSelection;
    local?: { force: true };
    mcpServers?: Record<string, McpServerConfig>;
  } {
    const opts: {
      model?: ModelSelection;
      local?: { force: true };
      mcpServers?: Record<string, McpServerConfig>;
    } = {};

    // The model is repeated at send-time intentionally.  A lazy local agent
    // recovered above has not gone through resume({ model }), and the Cursor
    // SDK requires an explicit model on its first send.
    if (modelId) {
      opts.model = cursorModelSelection(modelId);
    }
    if (this._opts.listScope !== "cloud") {
      opts.local = { force: true };
    }
    const mcp =
      spec?.mcpServers ?? this._opts.mcpServers;
    if (mcp) {
      opts.mcpServers = mcp;
    }
    return opts;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// In-memory test double
// ───────────────────────────────────────────────────────────────────────────

/**
 * Thrown by `InMemorySdkAdapter` when a planted error fires during
 * `create` / `resume` / `list` / `send`. Tests use this class identity
 * to assert that the SDK call was the one that threw (vs. a registry- or
 * session-layer validation).
 */
export class InMemorySdkPlantedError extends Error {
  override readonly name = "InMemorySdkPlantedError";
}

/**
 * In-memory `RunHandle` for tests. Default behavior:
 *
 *   - All planted events fire synchronously via `microtask` scheduling
 *     once a listener subscribes (so `attach + emit + assert` works
 *     without timer trickery).
 *   - `whenSettled()` resolves with `status: "finished"` after one
 *     microtask, unless `settleStatus` / `settleError` are planted.
 *   - `cancel()` is idempotent and flips the eventual `whenSettled`
 *     status to `"cancelled"` if called before the natural settle.
 *
 * Tests that need fine-grained control over event timing can use
 * `emit(...)` and `settle(...)` directly.
 */
export interface InMemoryRunHandleOptions {
  sessionId: string;
  agentId: string;
  runId?: string;
  /** Auto-emit these events to subscribers in order, then auto-settle. */
  emitEvents?: import("../types/state.ts").RuntimeEvent[];
  /** Default `"finished"`. */
  settleStatus?: import("@codeflowmu/protocol").SessionRun["status"];
  /** When set, `whenSettled` rejects with this error instead of resolving. */
  settleError?: Error;
  /** Disable the auto-settle behavior; tests drive `settle()` manually. */
  manualSettle?: boolean;
}

let _inMemoryRunSeq = 0;

export class InMemoryRunHandle implements RunHandle {
  readonly run_id: string;
  readonly session_id: string;
  readonly agent_id: string;

  private readonly _listeners = new Set<
    (event: import("../types/state.ts").RuntimeEvent) => void
  >();
  private readonly _eventBuffer: import("../types/state.ts").RuntimeEvent[] = [];
  private readonly _settlePromise: Promise<
    import("@codeflowmu/protocol").SessionRun
  >;
  private _resolveSettle!: (
    run: import("@codeflowmu/protocol").SessionRun,
  ) => void;
  private _rejectSettle!: (err: Error) => void;
  private _settled = false;
  private _cancelled = false;
  private readonly _opts: InMemoryRunHandleOptions;
  private readonly _startedAt: string;

  constructor(opts: InMemoryRunHandleOptions) {
    this._opts = opts;
    this.run_id = opts.runId ?? `run-mem-${(++_inMemoryRunSeq).toString(36)}`;
    this.session_id = opts.sessionId;
    this.agent_id = opts.agentId;
    this._startedAt = new Date().toISOString();
    this._settlePromise = new Promise((resolve, reject) => {
      this._resolveSettle = resolve;
      this._rejectSettle = reject;
    });

    if (!opts.manualSettle) {
      // Schedule auto-settle on the macrotask queue (`setImmediate`), NOT
      // the microtask queue. `SessionManager.startSession` does several
      // `await` hops between `_sdk.send()` returning a handle and the
      // caller's `onEvent` listener being wired up; microtasks run inside
      // those `await` hops, so a microtask-scheduled emit would land
      // BEFORE the listener attaches. `setImmediate` defers to after the
      // surrounding async operation fully unwinds.
      //
      // Race-defense complement: `emit()` buffers events when no
      // listeners are present yet, so even if a setImmediate winner
      // races a not-yet-completed `await`-hop, no events are lost.
      setImmediate(() => this._autoDrive());
    }
  }

  isActive(): boolean {
    return !this._settled;
  }

  async cancel(reason: string): Promise<void> {
    void reason;
    this._cancelled = true;
    if (!this._settled && !this._opts.manualSettle) {
      // Force-settle as cancelled.
      this.settle({ status: "cancelled" });
    }
  }

  whenSettled(): Promise<import("@codeflowmu/protocol").SessionRun> {
    return this._settlePromise;
  }

  onEvent(
    listener: (event: import("../types/state.ts").RuntimeEvent) => void,
  ): import("../types/state.ts").Unsubscribe {
    const wasEmpty = this._listeners.size === 0;
    this._listeners.add(listener);
    // If this is the first listener, replay any buffered events.
    if (wasEmpty && this._eventBuffer.length > 0) {
      const buffered = this._eventBuffer.splice(0);
      for (const event of buffered) {
        this._deliverToListeners(event);
      }
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Manually emit an event to all subscribers. If no subscribers are
   * present yet, the event is buffered and replayed when the first one
   * subscribes (`onEvent`).
   *
   * Buffering is the correct mock semantics for "plant events should be
   * received" — the alternative (drop events emitted before `onEvent`)
   * would race with `SessionManager.startSession`, which has fs-IO
   * macrotasks (`SessionStore.save`) between `_sdk.send()` returning a
   * handle and the caller's `onEvent` being wired. SDK's real `Run.stream()`
   * has equivalent behavior — events are buffered until consumed.
   */
  emit(event: import("../types/state.ts").RuntimeEvent): void {
    if (this._listeners.size === 0) {
      this._eventBuffer.push(event);
      return;
    }
    this._deliverToListeners(event);
  }

  private _deliverToListeners(
    event: import("../types/state.ts").RuntimeEvent,
  ): void {
    for (const listener of [...this._listeners]) {
      try {
        listener(event);
      } catch (err) {
        this._listeners.delete(listener);
        // eslint-disable-next-line no-console -- mirrors SdkRunHandle contract
        console.error(
          `[InMemoryRunHandle] listener threw on run_id="${this.run_id}"; unsubscribed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Manually settle with explicit terminal status. */
  settle(opts: {
    status?: import("@codeflowmu/protocol").SessionRun["status"];
    error?: Error;
    sdkError?: string;
    failureCode?: string;
  }): void {
    if (this._settled) return;
    this._settled = true;
    if (opts.error) {
      this._rejectSettle(opts.error);
      return;
    }
    const status =
      opts.status ?? (this._cancelled ? "cancelled" : "finished");
    this._resolveSettle({
      run_id: this.run_id,
      started_at: this._startedAt,
      ended_at: new Date().toISOString(),
      status,
      tool_calls_count: 0,
      ...(opts.sdkError ? { sdk_error: opts.sdkError } : {}),
      ...(opts.failureCode ? { failure_code: opts.failureCode } : {}),
    });
  }

  private _autoDrive(): void {
    for (const event of this._opts.emitEvents ?? []) {
      this.emit(event);
    }
    if (this._opts.settleError) {
      this.settle({ error: this._opts.settleError });
      return;
    }
    this.settle({
      status:
        this._opts.settleStatus ?? (this._cancelled ? "cancelled" : "finished"),
    });
  }
}

/**
 * In-memory `AgentSdkAdapter` for tests. Records every call so `assert.deepEqual`
 * can compare the exact spy trace, and supports planting failures to exercise
 * registry / bootstrap error paths.
 *
 * Usage (test scenario 4 from TASK-009):
 *
 * ```ts
 * const sdk = new InMemorySdkAdapter();
 * sdk.failNextCreateWith("simulated SDK outage");
 * await assert.rejects(() => registry.register(spec));
 * assert.equal(sdk.calls.create.length, 1); // SDK was hit, write was rolled back
 * ```
 */
export class InMemorySdkAdapter implements AgentSdkAdapter {
  /** Set of sdk_agent_ids the SDK currently "knows about". */
  private readonly _known = new Set<string>();
  private _nextCreateId = 1;
  private _failNextCreate: string | null = null;
  private _failNextResume: string | null = null;
  private _failNextList: string | null = null;

  /** Spy trace; tests assert on this. */
  readonly calls: {
    create: AgentCreateSpec[];
    list: number;
    resume: string[];
    send: { spec: AgentSendSpec; sdk_agent_id: string }[];
  } = { create: [], list: 0, resume: [], send: [] };

  /**
   * Optional factory for `send` return values. Tests that need a richer
   * RunHandle (e.g. with planted events) inject a factory here; otherwise
   * `send` returns a default `InMemoryRunHandle` that auto-settles.
   */
  sendHandleFactory?: (
    spec: AgentSendSpec,
    sdkAgentId: string,
  ) => InMemoryRunHandle;

  /** Plant a failure for the very next `send` call. */
  private _failNextSend: string | null = null;

  /** Plant a failure for the very next `create` call. */
  failNextCreateWith(reason: string): void {
    this._failNextCreate = reason;
  }

  /** Plant a failure for the very next `resume` call. */
  failNextResumeWith(reason: string): void {
    this._failNextResume = reason;
  }

  /**
   * Plant a failure for the very next `list` call. Used by Phase B test
   * scenario 12 (TS-2.8 B-path) to verify that `RuntimeBootstrap` translates
   * an uncaught SDK error into a `RuntimeBootstrapError` HARD FAIL.
   */
  failNextListWith(reason: string): void {
    this._failNextList = reason;
  }

  /**
   * Plant a failure for the very next `send` call. Used by Phase B
   * SessionManager tests to verify the `runtime.session_failed` path.
   */
  failNextSendWith(reason: string): void {
    this._failNextSend = reason;
  }

  /** Pre-populate sdk_agent_ids the SDK should claim to know. */
  seedKnown(...ids: string[]): void {
    for (const id of ids) this._known.add(id);
  }

  /** Simulate an SDK-side deletion/expiry after local registration. */
  forgetKnown(...ids: string[]): void {
    for (const id of ids) this._known.delete(id);
  }

  /** Inspect what the SDK currently believes (read-only). */
  knownIds(): string[] {
    return [...this._known];
  }

  async create(spec: AgentCreateSpec): Promise<{ sdk_agent_id: string }> {
    this.calls.create.push(spec);
    if (this._failNextCreate !== null) {
      const reason = this._failNextCreate;
      this._failNextCreate = null;
      throw new InMemorySdkPlantedError(`create failed: ${reason}`);
    }
    const id = `sdk-fake-${String(this._nextCreateId++).padStart(4, "0")}`;
    this._known.add(id);
    return { sdk_agent_id: id };
  }

  async list(): Promise<string[]> {
    this.calls.list += 1;
    if (this._failNextList !== null) {
      const reason = this._failNextList;
      this._failNextList = null;
      throw new InMemorySdkPlantedError(`list failed: ${reason}`);
    }
    return [...this._known];
  }

  async resume(sdkAgentId: string): Promise<void> {
    this.calls.resume.push(sdkAgentId);
    if (this._failNextResume !== null) {
      const reason = this._failNextResume;
      this._failNextResume = null;
      throw new InMemorySdkPlantedError(`resume failed: ${reason}`);
    }
    if (!this._known.has(sdkAgentId)) {
      throw new InMemorySdkPlantedError(
        `resume failed: sdk_agent_id="${sdkAgentId}" is not in the SDK's known set`,
      );
    }
  }

  async send(spec: AgentSendSpec, sdkAgentId: string): Promise<RunHandle> {
    this.calls.send.push({ spec, sdk_agent_id: sdkAgentId });
    if (this._failNextSend !== null) {
      const reason = this._failNextSend;
      this._failNextSend = null;
      throw new InMemorySdkPlantedError(`send failed: ${reason}`);
    }
    if (!this._known.has(sdkAgentId)) {
      throw new InMemorySdkPlantedError(
        `send failed: sdk_agent_id="${sdkAgentId}" is not in the SDK's known set`,
      );
    }
    if (this.sendHandleFactory) {
      return this.sendHandleFactory(spec, sdkAgentId);
    }
    return new InMemoryRunHandle({
      sessionId: spec.sessionId,
      agentId: spec.agentId,
    });
  }

  async listModels(): Promise<string[]> {
    return ["auto", "default", "claude-3-5-sonnet", "gemini-2.5-flash"];
  }
}
