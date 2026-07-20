/**
 * SdkRunHandle — concrete `RunHandle` backed by `@cursor/sdk`.
 *
 * Lifecycle (matches the spike `_ignore/spike_sdk_doorbell/ringer.ts`):
 *
 *   1. `Agent.resume(sdkAgentId)` → agent instance
 *   2. `agent.send(payload.text)` → run object
 *   3. `run.stream()` async iterator → emit per-event
 *   4. `run.wait()` → terminal status
 *   5. `agent[Symbol.asyncDispose]()` → release SDK resources
 *
 * Steps 1+2 happen INSIDE `CursorSdkAdapter.send`. By the time a
 * `SdkRunHandle` is constructed, the agent + run are already in flight.
 * The handle owns steps 3-5: it backgrounds the stream loop, fans out
 * `RuntimeEvent`s to subscribers, and disposes the agent on terminal.
 *
 * Reference:
 *   - design doc §3.5 (Session Schema, SessionRun)
 *   - TASK-20260509-013 §主交付 1 (cancelSession invariant: SDK cancel
 *     before persistence)
 *   - decision M (REPORT-013): SDKMessage.type → RuntimeEventType mapping
 */

import type { Agent, SDKMessage } from "@cursor/sdk";

import type { SessionRun } from "@codeflowmu/protocol";

import type {
  RunHandle,
  RuntimeEvent,
  RuntimeEventType,
  Unsubscribe,
} from "../types/state.ts";
import {
  isTransientSdkError,
  TRANSIENT_SDK_DELAYED,
  withTransientSdkRetry,
} from "../_internal/transient-sdk-error.ts";
import {
  buildSdkFailurePayloadFields,
  type SessionRunWithSdkFailure,
} from "./sdk-failure-classifier.ts";
import {
  evaluateRoleToolCall,
  formatRoleToolBlockedPayload,
  recordRoleToolBlocked,
  ROLE_TOOL_BLOCKED,
} from "../registry/RoleToolPolicy.ts";
import { guardPmProductWorkerWriteTask } from "../pm/ProductDeliveryRuntimeGate.ts";
import { guardPmDevDispatchWriteReport } from "../pm/guardPmDevDispatchWriteReport.ts";
import {
  evaluateNativeOperationBoundary,
  OperationApprovalService,
  OPERATION_APPROVAL_REQUIRED,
  OPERATION_BOUNDARY_DENIED,
} from "../approval/index.ts";

/**
 * Cursor SDK `Run` surface used by the handle. Defined as a structural
 * type instead of importing `Run` directly so this file does not pin a
 * specific `@cursor/sdk` Run-object shape (the SDK's public types are
 * intentionally narrow; the spike confirmed the runtime shape).
 *
 * Exported so `CursorSdkAdapter.send` can cast its raw SDK `Run` object
 * to this shape without `as any`.
 */
export interface SdkRunLike {
  readonly id: string;
  supports(capability: "stream" | "cancel"): boolean;
  stream(): AsyncIterable<SDKMessage>;
  wait(): Promise<{ status: string; [k: string]: unknown }>;
  cancel?(reason?: string): Promise<unknown> | unknown;
}

/**
 * `id` generator. ULID would be fancier but adds a dependency for one
 * call site; a 12-byte random hex from crypto is sufficient and matches
 * the `^[a-z0-9-]+$` pattern in `SessionRun.run_id`.
 */
function makeRunIdFromSdk(sdkRunId: string): string {
  return `run-${sdkRunId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`;
}

/**
 * Map a Cursor SDK `SDKMessage.type` to our `RuntimeEventType`. The 8
 * SDK-side names mirror the spike (`ringer.ts` switch). See decision M.
 *
 * Note: `"result"` is not in `SDKMessage["type"]`'s static type surface but
 * the SDK runtime does emit it (SPEC-codeflowmu-token-tracking §0.1). Accept
 * `string` so forward-compat unknown types are handled without casting.
 */
function mapSdkType(t: string): RuntimeEventType {
  switch (t) {
    case "system":
      return "sdk.system";
    case "thinking":
      return "sdk.thinking";
    case "assistant":
      return "sdk.assistant";
    case "tool_call":
      return "sdk.tool_call";
    case "status":
      return "sdk.status";
    case "task":
      return "sdk.task";
    case "request":
      return "sdk.request";
    case "user":
      return "sdk.user";
    case "result":
      return "sdk.result";
    default: {
      // Forward-compat: an unknown SDK type falls under sdk.system as a
      // safe default (system is already a heterogeneous bucket per spike).
      // The raw type is preserved in `event.payload.sdk_type` for audit.
      return "sdk.system";
    }
  }
}

export interface CursorTokenEstimate {
  provider: "cursor";
  model?: string;
  estimatedInputTokens: number;
  estimatedTextTokens: number;
  estimatedToolSchemaTokens: number;
  requestCount: number;
  toolCount: number;
}

/** Construction options for `SdkRunHandle`. */
export interface SdkRunHandleOptions {
  agent: Agent;
  run: SdkRunLike;
  /** Pattern: `^session-[a-z0-9-]+$`. */
  sessionId: string;
  /** Owning agent_id (FCoP role id, e.g. `"DEV-01"`). */
  agentId: string;
  /** Override the auto-derived run_id. Mostly for tests / replays. */
  runIdOverride?: string;
  /** Wall clock for event timestamps. Tests inject a controlled clock. */
  now?: () => Date;
  /**
   * Max SDK `tool_call` rounds before forced cancel (doorbell token guard).
   * Omit = no limit.
   */
  maxToolRounds?: number;
  /** Best-effort pre-send token estimate. Observability only; never blocks. */
  tokenEstimate?: CursorTokenEstimate;
  /** Project root for role-level native-tool gates (PM edit/shell block). */
  projectRoot?: string;
}

export class SdkRunHandle implements RunHandle {
  readonly run_id: string;
  readonly session_id: string;
  readonly agent_id: string;

  private readonly _agent: Agent;
  private readonly _run: SdkRunLike;
  private readonly _now: () => Date;
  private readonly _listeners = new Set<(event: RuntimeEvent) => void>();

  private _eventSeq = 0;
  private _settled = false;
  private _settlementPromise: Promise<SessionRun>;
  private readonly _startedAt: string;
  private readonly _maxToolRounds: number | undefined;
  private readonly _tokenEstimate: CursorTokenEstimate | undefined;
  private _turnLimitExceeded = false;
  private _roleToolBlocked = false;
  private _roleToolBlockedMessage: string | undefined;
  private _operationBoundaryFailureCode: string | undefined;
  private _operationBoundaryMessage: string | undefined;
  private readonly _projectRoot: string | undefined;
  private readonly _gateCheckedToolCallIds = new Set<string>();
  private _lastToolName: string | null = null;
  private _lastAction: string | null = null;

  constructor(opts: SdkRunHandleOptions) {
    this._agent = opts.agent;
    this._run = opts.run;
    this.run_id = opts.runIdOverride ?? makeRunIdFromSdk(opts.run.id);
    this.session_id = opts.sessionId;
    this.agent_id = opts.agentId;
    this._now = opts.now ?? (() => new Date());
    this._startedAt = this._now().toISOString();
    this._maxToolRounds = opts.maxToolRounds;
    this._tokenEstimate = opts.tokenEstimate;
    this._projectRoot = opts.projectRoot;
    this._settlementPromise = this._driveStream();
  }

  isActive(): boolean {
    return !this._settled;
  }

  async cancel(reason: string): Promise<void> {
    if (this._settled) {
      // Idempotent — see TASK-013 §主交付 1 invariant: cancel(twice) succeeds.
      return;
    }
    if (this._run.supports("cancel") && this._run.cancel) {
      try {
        await this._run.cancel(reason);
      } catch {
        // Cancellation is best-effort — the SDK's own state machine will
        // surface a terminal `error` or `cancelled` status via wait().
        // We swallow here to keep cancel(reason) idempotent.
      }
    }
  }

  whenSettled(): Promise<SessionRun> {
    return this._settlementPromise;
  }

  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private async _driveStream(): Promise<SessionRun> {
    let toolCallsCount = 0;
    /** Cursor SDK emits running + completed for the same MCP call_id — count once. */
    const countedToolCallIds = new Set<string>();
    try {
      if (this._run.supports("stream")) {
        for await (const message of this._run.stream()) {
          this._dispatch(this._toEvent(message));
          if (message.type === "tool_call") {
            this._noteToolCall(message);
            if (await this._maybeBlockRoleToolCall(message)) {
              break;
            }
            const callId = this._toolCallId(message);
            if (callId != null) {
              if (countedToolCallIds.has(callId)) {
                continue;
              }
              if (
                this._maxToolRounds != null &&
                countedToolCallIds.size >= this._maxToolRounds
              ) {
                this._turnLimitExceeded = true;
                await this.cancel(
                  `max_tool_rounds_exceeded:${this._maxToolRounds}`,
                );
                break;
              }
              countedToolCallIds.add(callId);
              toolCallsCount = countedToolCallIds.size;
            } else {
              if (
                this._maxToolRounds != null &&
                toolCallsCount >= this._maxToolRounds
              ) {
                this._turnLimitExceeded = true;
                await this.cancel(
                  `max_tool_rounds_exceeded:${this._maxToolRounds}`,
                );
                break;
              }
              toolCallsCount += 1;
            }
          }
        }
      }
      const waitOutcome = await withTransientSdkRetry(
        () => this._run.wait(),
        {
          onRetry: (attempt, delayMs, error) => {
            this._dispatch({
              event_id: `${this.run_id}-wait-retry-${attempt}`,
              at: this._now().toISOString(),
              event_type: "sdk.status",
              session_id: this.session_id,
              run_id: this.run_id,
              agent_id: this.agent_id,
              payload: {
                status: "retrying",
                transient_sdk_error: true,
                attempt,
                delay_ms: delayMs,
                error: error.message,
              },
            });
          },
        },
      );

      const endedAt = this._now().toISOString();

      if (!waitOutcome.ok) {
        this._settled = true;
        return {
          run_id: this.run_id,
          started_at: this._startedAt,
          ended_at: endedAt,
          status: "finished",
          tool_calls_count: toolCallsCount,
          failure_code: TRANSIENT_SDK_DELAYED,
        };
      }

      const result = waitOutcome.value;
      const sdkError = this._extractSdkError(result);
      const enrichedRaw = this._withTokenEstimate(result);
      const durationMs = Math.max(
        0,
        new Date(endedAt).getTime() - new Date(this._startedAt).getTime(),
      );
      const sdkFailureFields =
        String(result.status).toLowerCase() === "error" ||
        String(result.status).toLowerCase() === "failed"
          ? buildSdkFailurePayloadFields({
              status: result.status,
              tool_call_count: toolCallsCount,
              duration_ms: durationMs,
              raw: enrichedRaw,
              error_message: sdkError || undefined,
              agent_id: this.agent_id,
              session_id: this.session_id,
            })
          : undefined;
      // Dispatch sdk.result so UsageFileLogger captures token consumption.
      // The SDK's wait() returns the full SDKResultMessage at runtime (with
      // total_cost_usd / usage / modelUsage) even though the TypeScript surface
      // only exposes { status; [k]: unknown }. Per SPEC-codeflowmu-token-tracking §8.
      this._dispatch({
        event_id: `${this.run_id}-${(this._eventSeq++).toString(36)}`,
        at: endedAt,
        event_type: "sdk.result",
        session_id: this.session_id,
        run_id: this.run_id,
        agent_id: this.agent_id,
        payload: {
          sdk_type: "result",
          raw: enrichedRaw,
          status: result.status,
          ...(sdkError ? { error: sdkError, message: sdkError } : {}),
          ...((result as Record<string, unknown>).stop_reason
            ? { stop_reason: (result as Record<string, unknown>).stop_reason }
            : {}),
          ...(sdkFailureFields ?? {}),
        },
      });
      const resolvedStatus =
        this._turnLimitExceeded || this._roleToolBlocked || this._operationBoundaryFailureCode
          ? "failed"
          : this._resolveWaitStatus(result);
      const sessionRun: SessionRun & SessionRunWithSdkFailure = {
        run_id: this.run_id,
        started_at: this._startedAt,
        ended_at: endedAt,
        status: resolvedStatus,
        tool_calls_count: toolCallsCount,
        ...(this._lastToolName ? { last_tool: this._lastToolName } : {}),
        ...(this._lastAction ? { last_action: this._lastAction } : {}),
        ...(this._operationBoundaryFailureCode
          ? { failure_code: this._operationBoundaryFailureCode }
          : this._roleToolBlocked
            ? { failure_code: ROLE_TOOL_BLOCKED }
          : this._turnLimitExceeded
            ? { failure_code: "TURN_LIMIT" as const }
            : this._transientFailureCode(result)),
        ...(this._roleToolBlocked && this._roleToolBlockedMessage
          ? { sdk_error: this._roleToolBlockedMessage }
          : {}),
        ...(this._operationBoundaryMessage
          ? { sdk_error: this._operationBoundaryMessage }
          : {}),
        ...(resolvedStatus === "failed" && sdkError ? { sdk_error: sdkError } : {}),
        ...(resolvedStatus === "failed" && sdkFailureFields
          ? { sdk_failure_detail: sdkFailureFields }
          : {}),
      };
      this._settled = true;
      return sessionRun;
    } catch (err) {
      if (isTransientSdkError(err)) {
        this._settled = true;
        return {
          run_id: this.run_id,
          started_at: this._startedAt,
          ended_at: this._now().toISOString(),
          status: "finished",
          tool_calls_count: toolCallsCount,
          failure_code: TRANSIENT_SDK_DELAYED,
        };
      }
      throw err;
    } finally {
      try {
        // Cursor SDK's public Agent type omits the async-dispose symbol from
        // its type surface even though the runtime does implement it (per
        // spike `_ignore/spike_sdk_doorbell/sender.ts` line 114). Cast keeps
        // this site honest about the gap without disabling tsc globally.
        const disposable = this._agent as unknown as {
          [Symbol.asyncDispose]?: () => Promise<void>;
        };
        await disposable[Symbol.asyncDispose]?.();
      } catch {
        // Dispose failure is not actionable from this layer — best-effort.
      }
    }
  }

  private _dispatch(event: RuntimeEvent): void {
    for (const listener of [...this._listeners]) {
      try {
        listener(event);
      } catch (err) {
        // Per RunHandle.onEvent contract: throwing listener gets unsubbed.
        this._listeners.delete(listener);
        // eslint-disable-next-line no-console -- contract-mandated visibility
        console.error(
          `[SdkRunHandle] listener threw on run_id="${this.run_id}"; unsubscribed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private _withTokenEstimate(result: { status: string; [k: string]: unknown }): {
    status: string;
    [k: string]: unknown;
  } {
    if (!this._tokenEstimate) {
      return result;
    }

    const raw = result as Record<string, unknown>;
    const existingUsage =
      raw.usage && typeof raw.usage === "object"
        ? (raw.usage as Record<string, unknown>)
        : {};
    const estimate = this._tokenEstimate;
    const usage = {
      ...existingUsage,
      estimated_input_tokens:
        existingUsage.estimated_input_tokens ?? estimate.estimatedInputTokens,
      estimated_text_tokens:
        existingUsage.estimated_text_tokens ?? estimate.estimatedTextTokens,
      estimated_tool_schema_tokens:
        existingUsage.estimated_tool_schema_tokens ??
        estimate.estimatedToolSchemaTokens,
      request_count: existingUsage.request_count ?? estimate.requestCount,
      tool_count: existingUsage.tool_count ?? estimate.toolCount,
    };

    const modelUsage =
      raw.modelUsage && typeof raw.modelUsage === "object"
        ? { ...(raw.modelUsage as Record<string, unknown>) }
        : {};
    if (estimate.model) {
      const modelEntry =
        modelUsage[estimate.model] && typeof modelUsage[estimate.model] === "object"
          ? (modelUsage[estimate.model] as Record<string, unknown>)
          : {};
      modelUsage[estimate.model] = {
        ...modelEntry,
        estimatedInputTokens:
          modelEntry.estimatedInputTokens ?? estimate.estimatedInputTokens,
        estimatedTextTokens:
          modelEntry.estimatedTextTokens ?? estimate.estimatedTextTokens,
        estimatedToolSchemaTokens:
          modelEntry.estimatedToolSchemaTokens ??
          estimate.estimatedToolSchemaTokens,
      };
    }

    return {
      ...raw,
      status: result.status,
      provider: raw.provider ?? "cursor",
      usage,
      ...(Object.keys(modelUsage).length > 0 ? { modelUsage } : {}),
    } as { status: string; [k: string]: unknown };
  }

  private _noteToolCall(message: SDKMessage): void {
    const raw = message as unknown as Record<string, unknown>;
    const name =
      (typeof raw.name === "string" && raw.name) ||
      (typeof raw.tool_name === "string" && raw.tool_name) ||
      (typeof raw.tool === "string" && raw.tool) ||
      null;
    if (name) this._lastToolName = name;
    const args = raw.args ?? raw.arguments ?? raw.input;
    if (args !== undefined) {
      const s = typeof args === "string" ? args : JSON.stringify(args);
      this._lastAction = s.slice(0, 200);
    }
  }

  private _toEvent(message: SDKMessage): RuntimeEvent {
    return {
      event_id: `${this.run_id}-${(this._eventSeq++).toString(36)}`,
      at: this._now().toISOString(),
      event_type: mapSdkType(message.type as string),
      session_id: this.session_id,
      run_id: this.run_id,
      agent_id: this.agent_id,
      payload: { sdk_type: message.type, raw: message },
    };
  }

  /** Stable id for Cursor MCP tool_call pairs (running + completed share call_id). */
  private _toolCallId(message: SDKMessage): string | null {
    if (message.type !== "tool_call") return null;
    const raw = message as SDKMessage & {
      call_id?: string;
      id?: string;
      tool_use_id?: string;
    };
    const id = raw.call_id ?? raw.tool_use_id ?? raw.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private _toolCallIsRunning(message: SDKMessage): boolean {
    if (message.type !== "tool_call") return false;
    const raw = message as SDKMessage & { status?: string };
    const status = String(raw.status ?? "running").toLowerCase();
    return status === "running" || status === "in_progress" || status === "started";
  }

  private _extractToolCallArgs(message: SDKMessage): Record<string, unknown> {
    const raw = message as unknown as Record<string, unknown>;
    const args = raw.args ?? raw.arguments ?? raw.input;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { command: args };
      }
    }
    return {};
  }

  private _extractToolCallName(message: SDKMessage): string {
    const raw = message as unknown as Record<string, unknown>;
    return (
      (typeof raw.name === "string" && raw.name) ||
      (typeof raw.tool_name === "string" && raw.tool_name) ||
      (typeof raw.tool === "string" && raw.tool) ||
      "unknown"
    );
  }

  private async _maybeBlockRoleToolCall(message: SDKMessage): Promise<boolean> {
    if (!this._toolCallIsRunning(message)) return false;

    const callId = this._toolCallId(message);
    if (callId != null) {
      if (this._gateCheckedToolCallIds.has(callId)) return false;
      this._gateCheckedToolCallIds.add(callId);
    }

    const toolName = this._extractToolCallName(message);
    const args = this._extractToolCallArgs(message);
    const projectRoot = this._projectRoot ?? process.cwd();
    const operationBoundary = await evaluateNativeOperationBoundary({
      toolName,
      args,
      projectRoot,
      projectId: projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "project",
      agentId: this.agent_id,
      sessionId: this.session_id,
    });
    if (operationBoundary.decision !== "ALLOW") {
      if (operationBoundary.decision === "REQUIRE_APPROVAL") {
        const prepared = new OperationApprovalService({ projectRoot }).prepare(operationBoundary.input);
        if (prepared.decision === "REQUIRE_APPROVAL") {
          this._operationBoundaryFailureCode = OPERATION_APPROVAL_REQUIRED;
          this._operationBoundaryMessage = JSON.stringify({
            code: OPERATION_APPROVAL_REQUIRED,
            approval_id: prepared.approval.approval_id,
            operation_digest: prepared.approval.operation_digest,
            reason: prepared.approval.reason,
          });
        }
      } else {
        this._operationBoundaryFailureCode = OPERATION_BOUNDARY_DENIED;
        this._operationBoundaryMessage = JSON.stringify({
          code: OPERATION_BOUNDARY_DENIED,
          reason: operationBoundary.reason,
        });
      }
      if (this._operationBoundaryFailureCode) {
        this._dispatch({
          event_id: `${this.run_id}-operation-boundary-${(this._eventSeq++).toString(36)}`,
          at: this._now().toISOString(),
          event_type: "sdk.status",
          session_id: this.session_id,
          run_id: this.run_id,
          agent_id: this.agent_id,
          payload: {
            status: "failed",
            failure_code: this._operationBoundaryFailureCode,
            tool: toolName,
            message: this._operationBoundaryMessage,
          },
        });
        await this.cancel(`operation_boundary:${toolName}`);
        return true;
      }
    }
    let asyncBlockedReason: string | undefined;
    if (/\b(?:write_task|create_task)$/i.test(toolName)) {
      const productGate = await guardPmProductWorkerWriteTask({
        projectRoot,
        agentId: this.agent_id,
        args,
      });
      if (!productGate.allowed) {
        asyncBlockedReason = JSON.stringify({
          code: productGate.code,
          reason: productGate.reason,
          required_action: productGate.required_action,
          findings: productGate.findings,
        });
      }
    }
    if (!asyncBlockedReason && /\bwrite_report$/i.test(toolName)) {
      const closeGate = await guardPmDevDispatchWriteReport(projectRoot, args, {
        agentId: this.agent_id,
      });
      if (!closeGate.allowed) {
        asyncBlockedReason = JSON.stringify({
          code: closeGate.code,
          reason: closeGate.skipped_reason ?? "close_gate_failed",
          findings: closeGate.findings,
        });
      }
    }
    const gate = asyncBlockedReason
      ? { allow: false, severity: "block" as const, reason: asyncBlockedReason }
      : evaluateRoleToolCall({
      agentId: this.agent_id,
      toolName,
      args,
      projectRoot,
      channel: "cursor_sdk",
    });
    if (gate.allow) return false;

    const blockedMessage = formatRoleToolBlockedPayload(gate);
    await recordRoleToolBlocked({
      projectRoot,
      agentId: this.agent_id,
      toolName,
      reason: gate.reason,
      channel: "cursor_sdk",
      sessionId: this.session_id,
      runId: this.run_id,
    });

    this._roleToolBlocked = true;
    this._roleToolBlockedMessage = blockedMessage;
    this._dispatch({
      event_id: `${this.run_id}-role-tool-blocked-${(this._eventSeq++).toString(36)}`,
      at: this._now().toISOString(),
      event_type: "sdk.status",
      session_id: this.session_id,
      run_id: this.run_id,
      agent_id: this.agent_id,
      payload: {
        status: "failed",
        failure_code: ROLE_TOOL_BLOCKED,
        tool: toolName,
        message: blockedMessage,
      },
    });
    await this.cancel(`role_tool_blocked:${toolName}`);
    return true;
  }

  private _transientFailureCode(
    result: { status: string; [k: string]: unknown },
  ): Pick<SessionRun, "failure_code"> | Record<string, never> {
    const errMsg = this._extractSdkError(result);
    if (result.status === "error" && isTransientSdkError(errMsg)) {
      return { failure_code: TRANSIENT_SDK_DELAYED };
    }
    return {};
  }

  private _extractSdkError(result: { status: string; [k: string]: unknown }): string {
    const raw = result as Record<string, unknown>;
    return String(
      raw.error ??
        raw.message ??
        raw.stop_reason ??
        raw.failure_reason ??
        "",
    ).trim();
  }

  private _resolveWaitStatus(result: {
    status: string;
    [k: string]: unknown;
  }): SessionRun["status"] {
    const errMsg = this._extractSdkError(result);
    if (result.status === "error" && isTransientSdkError(errMsg)) {
      return "finished";
    }
    return this._mapWaitStatus(result.status);
  }

  private _mapWaitStatus(s: string): SessionRun["status"] {
    // Cursor SDK terminal `wait()` statuses (per spike) are
    // `success | error | cancelled`. We map to our 4-value union
    // `running | finished | failed | cancelled`.
    if (s === "cancelled") return "cancelled";
    if (s === "error") return "failed";
    return "finished";
  }
}
