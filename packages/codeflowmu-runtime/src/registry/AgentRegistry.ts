/**
 * AgentRegistry — the runtime's PCB table (process-control-block table).
 *
 * Sprint S2 shipped JSDoc-only skeletons that threw `not-implemented`.
 * Sprint S3 Phase A (this file) lands the 6 method bodies, wiring:
 *
 *   - ajv schema validation (via `@codeflowmu/protocol`) for every write
 *   - `AgentSdkAdapter` for SDK side effects (testable via InMemory adapter)
 *   - `PersistentStore` for atomic-write durability (decision 1)
 *   - layer=admin gating BEFORE any SDK call (TASK-009 §必交付 2 invariant)
 *   - `_isBootstrapping` race-defense flag for `RuntimeBootstrap` (decision 2)
 *
 * Reference:
 * - design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §2.1 subsystem 3,
 *   §3.2 Agent Schema, §0.9.1 layer enforcement
 * - `fcop/_lifecycle/inbox/TASK-20260509-009-PM-to-DEV.md` §必交付 2
 * - `docs/crash-recovery.md` decision 1 (write timing) + decision 2
 *   (RuntimeNotReady race-defense)
 */

import { validate as validateAgainstSchema } from "@codeflowmu/protocol";
import type { Agent, AgentLayer } from "@codeflowmu/protocol";

import type {
  AgentRecord,
  RuntimeBindingMode,
} from "../types/state.ts";
import type { KernelDependencyValidator } from "../skill/KernelDependencyValidator.ts";
import type { MCPInjector } from "../skill/MCPInjector.ts";
import type { AgentSdkAdapter } from "./AgentSdkAdapter.ts";
import { createVerifiedSdkBinding } from "./verifiedSdkBinding.ts";
import {
  TransientSdkDelayedError,
  withTransientSdkRetry,
} from "../_internal/transient-sdk-error.ts";
import type { PersistentStore } from "./PersistentStore.ts";
import {
  AgentNotFoundError,
  LayerViolationError,
  RuntimeNotReadyError,
  ValidationError,
} from "./errors.ts";

/** Filter passed to `AgentRegistry.list`. All fields optional and AND-combined. */
export interface AgentRegistryFilter {
  layer?: AgentLayer;
  role?: string;
  /** Matches `Agent.status` from `@codeflowmu/protocol`. */
  status?: Agent["status"];
}

/**
 * Constructor options for the AgentRegistry. Concrete wiring lives in
 * the caller's composition root so the registry itself stays
 * dependency-free.
 *
 * Phase E (S5) added two OPTIONAL hooks (decision R + T) — when they're
 * absent the registry behaves exactly as in Phase A/B/C/D; when they're
 * provided, `register()` runs the kernel-dep validator before SDK.create
 * and the MCP injector after store.upsert. The "optional" property is
 * load-bearing: tests that don't care about Phase E (e.g. all 18 Phase A
 * tests + the existing register scenarios) construct `AgentRegistry`
 * with `{ store, sdk }` and observe zero behavior change.
 */
export interface AgentRegistryOptions {
  store: PersistentStore;
  sdk: AgentSdkAdapter;
  /**
   * Phase E hook — when provided, `register()` calls
   * `assertAgentSpec(spec)` BEFORE `SDK.create` (decision S: same
   * pre-flight slot as `layer=admin`). Failure throws
   * `KernelDependencyError` with `agents.json` and SDK both
   * untouched (TS-7.12 invariant).
   */
  kernelValidator?: KernelDependencyValidator;
  /**
   * Phase E hook — when provided, `register()` calls
   * `mount(record)` AFTER `store.upsert` succeeds (decision T:
   * mount-on-register so the new agent has its skills wired
   * before the next `startSession`). Stub mode is logger-only;
   * mount failures throw and roll back the store + SDK (we
   * don't leave a half-mounted record).
   */
  mcpInjector?: MCPInjector;
}

/**
 * AgentRegistry — central directory of agent instances.
 *
 * Lifecycle (Phase A complete):
 *
 * 1. `register(spec)` → schema validate → SDK `create` → write `agents.json`.
 * 2. `resume(agentId)` → SDK `resume` + bookkeeping update.
 * 3. `list(filter)` → in-memory query, never hits SDK.
 * 4. `get(agentId)` → in-memory query, returns `null` if absent.
 * 5. `updateRuntimeBinding(agentId, mode)` → swap local↔cloud (no automatic
 *    resume; caller drives that explicitly to keep side effects boxed).
 * 6. `markFailed(agentId, reason)` → put agent into terminal `error` state.
 *
 * Invariants enforced HERE (NOT delegated to SDK):
 *
 * - `register({ layer: "admin" })` throws `LayerViolationError` BEFORE
 *   the SDK is touched (§0.9.1 + §3.2).
 * - Every `agentSpec` write is ajv-validated against `@codeflowmu/protocol`
 *   `agent` schema before persistence (TASK-009 invariant).
 * - During `RuntimeBootstrap.run()`, `register` throws `RuntimeNotReadyError`
 *   (race-defense per crash-recovery.md decision 2).
 * - `agents.json` write failures roll back atomically — `JsonFileStore`'s
 *   write-temp + rename means no partial state ever exists (decision 1).
 */
export class AgentRegistry {
  private readonly _store: PersistentStore;
  private readonly _sdk: AgentSdkAdapter;
  private readonly _kernelValidator: KernelDependencyValidator | null;
  private readonly _mcpInjector: MCPInjector | null;
  private _isBootstrapping = false;
  private readonly _bindingRecoveries = new Map<string, Promise<AgentRecord>>();

  constructor(opts: AgentRegistryOptions) {
    this._store = opts.store;
    this._sdk = opts.sdk;
    this._kernelValidator = opts.kernelValidator ?? null;
    this._mcpInjector = opts.mcpInjector ?? null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Bootstrap race-defense (used by RuntimeBootstrap)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Mark the registry as bootstrapping; reject `register` until cleared.
   * Called only by `RuntimeBootstrap` — left package-private via naming
   * convention rather than a TS access modifier so RuntimeBootstrap (in
   * the same package) can call it without breaking the public API.
   *
   * @internal
   */
  _setBootstrapping(value: boolean): void {
    this._isBootstrapping = value;
  }

  /** Read-only probe of the bootstrapping flag. Used by tests. */
  get isBootstrapping(): boolean {
    return this._isBootstrapping;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────

  /**
   * First-time creation of an agent.
   *
   * @param agentSpec — protocol-level Agent description from `roles.yaml`.
   *   Validated against `@codeflowmu/protocol` `agent` schema before SDK call.
   * @returns the persisted AgentRecord with `sdk_agent_id` populated.
   *
   * @throws `RuntimeNotReadyError` if `RuntimeBootstrap.run()` is in progress.
   * @throws `ValidationError` if `agentSpec` fails schema validation.
   * @throws `LayerViolationError` if `agentSpec.layer === "admin"` (admin
   *   agents are not spawnable via the runtime; ADMIN entry only).
   * @throws `Error` (verbatim from SDK adapter) if SDK `create` fails —
   *   `agents.json` is NOT modified in that case.
   */
  async register(agentSpec: Agent): Promise<AgentRecord> {
    if (this._isBootstrapping) {
      throw new RuntimeNotReadyError();
    }

    // Layer-admin check happens BEFORE schema validation: it's a
    // governance-level reject that doesn't depend on the rest of the
    // shape being well-formed. (Test scenario 3 requires SDK adapter
    // is NOT touched in this path — verifying via spy.)
    if (agentSpec.layer === "admin") {
      throw new LayerViolationError("admin");
    }

    const result = await validateAgainstSchema("agent", agentSpec);
    if (!result.valid) {
      throw new ValidationError(
        `agentSpec failed @codeflowmu/protocol agent schema (${result.errors?.length ?? 0} error(s))`,
        result.errors ?? [],
      );
    }

    // Phase E hook (decision R + S): kernel-dep validation runs AFTER
    // schema validation but BEFORE SDK.create — same race-defense slot
    // as the layer=admin reject. When `_kernelValidator` is null
    // (Phase A-D wiring), this is a no-op and the registry behaves
    // exactly as before. Test scenario 12 (TS-7.12) verifies the
    // SDK adapter is NOT touched on rejection.
    if (this._kernelValidator) {
      this._kernelValidator.assertAgentSpec(agentSpec);
    }

    // SDK adapter call — if it throws, agents.json is untouched (we
    // haven't called the store yet).
    //
    // Do not immediately call resume() as a creation-time gate.  The real
    // Cursor SDK may return a durable agent id before that id is visible to
    // a second resume request.  Treating this short visibility window as a
    // permanent failure made a normal project switch abort Shell startup
    // with agent_not_found.  RuntimeBootstrap / the first real session are
    // the reconciliation points for stale bindings; registration only needs
    // a successful SDK create plus a durable local record.
    const createResult = await withTransientSdkRetry(async () => {
      const created = await this._sdk.create({
        agentId: agentSpec.agent_id,
        role: agentSpec.role,
        layer: agentSpec.layer,
        runtime: agentSpec.runtime,
        ...(agentSpec.workspace !== undefined
          ? { workspace: agentSpec.workspace }
          : {}),
        ...(agentSpec.model?.id !== undefined
          ? { modelId: agentSpec.model.id }
          : {}),
      });
      return created.sdk_agent_id;
    });
    if (!createResult.ok) {
      throw new TransientSdkDelayedError(
        createResult.lastError.message,
        createResult.lastError,
      );
    }
    const sdk_agent_id = createResult.value;

    const now = new Date().toISOString();
    const record: AgentRecord = {
      protocol: {
        ...agentSpec,
        sdk_agent_id,
        status: "idle",
        ...(agentSpec.started_at ? {} : { started_at: now }),
        last_active_at: now,
      },
      runtime_binding_mode: agentSpec.runtime,
      runtime_last_reconciled_at: now,
    };

    await this._store.upsert(record);

    // Phase E hook (decision T): mount the agent's skills after the
    // record is durable. v0.1 stub mode just logs; v0.2 will spawn
    // real MCP processes. Mount failures DO bubble (the agent is
    // already in agents.json, but the operator clearly needs to
    // know — they likely have a misconfigured skill registration).
    if (this._mcpInjector) {
      await this._mcpInjector.mount(record);
    }

    return record;
  }

  /**
   * Re-bind to an SDK agent that already exists (typically after a
   * runtime crash). Reads `agents.json` for the bookkeeping fields and
   * calls SDK `resume(sdk_agent_id)` to re-establish the live binding.
   *
   * @param agentId — the FCoP-level `agent_id` (e.g. `"DEV-01"`), NOT
   *   the SDK `sdk_agent_id`. Internal lookup translates one to the other.
   * @returns the AgentRecord with `runtime_last_reconciled_at` updated to now.
   *
   * @throws `AgentNotFoundError` if `agents.json` does not contain `agentId`.
   * @throws `Error` (verbatim from SDK adapter) if `resume` fails. The
   *   record is NOT modified in this case — the caller may follow up
   *   with `markFailed()` if they want to record the failure.
   */
  async resume(agentId: string): Promise<AgentRecord> {
    const record = await this._loadOrThrow(agentId);
    if (!record.protocol.sdk_agent_id) {
      throw new AgentNotFoundError(
        `${agentId} (record exists but has no sdk_agent_id; was it ever registered?)`,
      );
    }

    try {
      await this._sdk.resume(record.protocol.sdk_agent_id);
    } catch (err) {
      // Re-throw with context but preserve original error class (instanceof
      // checks in tests still work via cause chain).
      const message =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `Agent.resume failed for sdk_agent_id="${record.protocol.sdk_agent_id}" (agent_id="${agentId}"): ${message}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cause: err } as any,
      );
    }

    const now = new Date().toISOString();
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        last_active_at: now,
      },
      runtime_last_reconciled_at: now,
    };
    await this._store.upsert(updated);
    return updated;
  }

  /**
   * Query the in-memory PCB. Never hits the SDK.
   *
   * @param filter — optional filter. If omitted or empty, returns ALL records.
   *   Multiple filter fields are AND-combined.
   * @returns array, possibly empty.
   */
  async list(filter?: AgentRegistryFilter): Promise<AgentRecord[]> {
    const records = await this._store.loadAll();
    if (!filter) return records;

    return records.filter((r) => {
      if (filter.layer !== undefined && r.protocol.layer !== filter.layer) {
        return false;
      }
      if (filter.role !== undefined && r.protocol.role !== filter.role) {
        return false;
      }
      if (filter.status !== undefined && r.protocol.status !== filter.status) {
        return false;
      }
      return true;
    });
  }

  /**
   * Single-record lookup by `agent_id`.
   *
   * @returns the record, or `null` if no such agent. Does NOT throw on
   *   missing — that's a normal flow signal for "not registered yet".
   */
  async get(agentId: string): Promise<AgentRecord | null> {
    const records = await this._store.loadAll();
    return records.find((r) => r.protocol.agent_id === agentId) ?? null;
  }

  /**
   * Switch the runtime binding mode (local ↔ cloud) for an existing agent.
   *
   * **Phase A behavior**: this method ONLY updates the persisted binding
   * mode. It does NOT call `resume` to migrate the SDK agent. The caller
   * must invoke `registry.resume(agentId)` explicitly if they want the
   * SDK side to follow the binding swap. Rationale: avoid implicit
   * side-effect chains; let `RuntimeBootstrap` and the operator stay
   * in charge of when SDK calls happen.
   *
   * @throws `AgentNotFoundError` if `agentId` is not registered.
   *
   * Cross-link: §0.7.4 three-node distributed runtime.
   */
  async updateRuntimeBinding(
    agentId: string,
    runtime: RuntimeBindingMode,
  ): Promise<void> {
    const record = await this._loadOrThrow(agentId);
    if (record.runtime_binding_mode === runtime) return; // no-op

    const updated: AgentRecord = {
      ...record,
      runtime_binding_mode: runtime,
      protocol: {
        ...record.protocol,
        runtime,
      },
    };
    await this._store.upsert(updated);
  }

  /**
   * Mark an agent as failed. Sets `status = "error"` and records
   * `runtime_failure` for diagnostics.
   *
   * @throws `AgentNotFoundError` if `agentId` is not registered.
   */
  async markFailed(agentId: string, error: string): Promise<void> {
    const record = await this._loadOrThrow(agentId);
    const failed_at = new Date().toISOString();
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        status: "error",
        last_active_at: failed_at,
      },
      runtime_failure: {
        failed_at,
        reason: error,
      },
    };
    await this._store.upsert(updated);
  }

  /**
   * Replace the SDK-side agent identity for an existing agent record.
   * Used by the Agent Rotation Mechanism: after `sdkAdapter.create()`
   * returns a fresh `sdk_agent_id`, call this so subsequent
   * `startSession()` calls bind to the new (empty-context) agent.
   *
   * Intentionally does NOT reset `status` — the caller is responsible
   * for ensuring no session is running at the time of rotation.
   *
   * @throws `AgentNotFoundError` if `agentId` is not registered.
   */
  async updateSdkAgentId(agentId: string, newSdkAgentId: string): Promise<void> {
    const record = await this._loadOrThrow(agentId);
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        sdk_agent_id: newSdkAgentId,
        last_active_at: new Date().toISOString(),
      },
    };
    await this._store.upsert(updated);
  }

  /**
   * Update the model hint used for subsequent SDK sends.
   *
   * This only changes runtime persistence; it does not rotate or resume the
   * SDK-side agent. The next `SessionManager.startSession()` reads the updated
   * record and forwards `model.id` as `modelId`.
   *
   * @throws `AgentNotFoundError` if `agentId` is not registered.
   */
  async updateModel(agentId: string, modelId: string): Promise<void> {
    const record = await this._loadOrThrow(agentId);
    const now = new Date().toISOString();
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        model: { id: modelId },
        last_active_at: now,
      },
      runtime_last_reconciled_at: now,
    };
    await this._store.upsert(updated);
  }

  /**
   * Recreate an SDK binding after a live send/resume reports agent_not_found.
   * Concurrent chat/patrol/TASK callers share one recovery promise, and the
   * verified id + canonical workspace replace the old record atomically.
   */
  async recoverSdkBinding(
    agentId: string,
    expectedWorkspace?: string,
  ): Promise<AgentRecord> {
    const inFlight = this._bindingRecoveries.get(agentId);
    if (inFlight) return inFlight;

    const recovery = (async () => {
      const record = await this._loadOrThrow(agentId);
      const workspace = expectedWorkspace ?? record.protocol.workspace;
      const createSpec = {
        agentId: record.protocol.agent_id,
        role: record.protocol.role,
        layer: record.protocol.layer,
        runtime: record.protocol.runtime,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(record.protocol.model?.id !== undefined
          ? { modelId: record.protocol.model.id }
          : {}),
      };
      let newSdkAgentId: string;
      if (record.protocol.runtime === "local") {
        const created = await withTransientSdkRetry(async () => {
          const result = await this._sdk.create(createSpec);
          return result.sdk_agent_id;
        });
        if (!created.ok) {
          throw new TransientSdkDelayedError(
            created.lastError.message,
            created.lastError,
          );
        }
        newSdkAgentId = created.value;
      } else {
        newSdkAgentId = await createVerifiedSdkBinding(this._sdk, createSpec);
      }
      const now = new Date().toISOString();
      const updated: AgentRecord = {
        ...record,
        protocol: {
          ...record.protocol,
          sdk_agent_id: newSdkAgentId,
          ...(workspace !== undefined ? { workspace } : {}),
          status: "idle",
          last_active_at: now,
        },
        runtime_last_reconciled_at: now,
        runtime_failure: undefined,
      };
      await this._store.upsert(updated);
      return updated;
    })();
    this._bindingRecoveries.set(agentId, recovery);
    try {
      return await recovery;
    } finally {
      if (this._bindingRecoveries.get(agentId) === recovery) {
        this._bindingRecoveries.delete(agentId);
      }
    }
  }

  /**
   * Update the workspace used for subsequent SDK sends.
   *
   * Open edition can switch from the install root to an external project root
   * after first-run initialization. Existing agent records must follow that
   * active project without recreating SDK agents or clearing user config.
   */
  async updateWorkspace(agentId: string, workspace: string): Promise<void> {
    const record = await this._loadOrThrow(agentId);
    if (record.protocol.workspace === workspace) return;
    const now = new Date().toISOString();
    const updated: AgentRecord = {
      ...record,
      protocol: {
        ...record.protocol,
        workspace,
        last_active_at: now,
      },
      runtime_last_reconciled_at: now,
    };
    await this._store.upsert(updated);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private async _loadOrThrow(agentId: string): Promise<AgentRecord> {
    const records = await this._store.loadAll();
    const record = records.find((r) => r.protocol.agent_id === agentId);
    if (!record) throw new AgentNotFoundError(agentId);
    return record;
  }
}
