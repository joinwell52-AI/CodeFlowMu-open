/**
 * MCPInjector — per-agent MCP server mount/unmount layer.
 *
 * Reference:
 *   - `docs/design/codeflowmu-v2-on-fcop-sdk.md` §0.7.5 + line 1894
 *     (Skill Runtime wraps every MCP tool call, checks risk_level)
 *   - `fcop/_lifecycle/inbox/TASK-20260509-024-PM-to-DEV.md` §主交付 3
 *
 * v0.1 = STUB MODE. No subprocess spawned, no MCP runtime wired — the
 * injector is a structured logger that records what *would* have been
 * mounted. v0.2 will swap `mode: "live"` to call into the real
 * `@cursor/sdk` MCP runtime; today that path eager-throws at ctor
 * time (decision T, mirrors `NeedsHumanGate.sink="mobile"` posture
 * from Phase D decision O).
 *
 * Why ctor-time eager-throw, not first-mount lazy throw:
 *
 *   - Composition-root failures should surface BEFORE the runtime
 *     accepts any user-facing request. A v0.1 deployment that
 *     mistakenly sets `mode: "live"` would otherwise mount agents
 *     at register-time and only blow up on first session start —
 *     the symptom would look like a session-layer bug rather than
 *     a config bug.
 *   - Same posture as `UnsupportedHumanPushSinkError` (decision O).
 *
 * Side-effects in stub mode: emits one `logger.info` line per `mount`
 * containing `agent_id` + skill_id list, so an operator reading the
 * stdout can see "what would happen in v0.2 live mode" without any
 * real MCP traffic.
 */

import { MCPInjectorLiveModeNotImplementedError } from "../registry/errors.ts";
import type { AgentSdkAdapter } from "../registry/AgentSdkAdapter.ts";
import type { AgentRecord } from "../types/state.ts";
import type { SkillRegistry, SkillProvider } from "./SkillRegistry.ts";

/** Logger surface — same shape as Phase D's `ReviewEngineLogger`. */
export interface MCPInjectorLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const NOOP_LOGGER: MCPInjectorLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/**
 * Per-mount audit entry. Returned from `mount()` so callers (typically
 * `RuntimeBootstrap` or `AgentRegistry.register`) can log "agent X
 * mounted N skills" without depending on `MCPInjector` internals.
 */
export interface MCPMount {
  agent_id: string;
  skill_id: string;
  transport: SkillProvider["transport"];
  command?: string;
  url?: string;
}

export interface MCPInjectorOptions {
  skillRegistry: SkillRegistry;
  /**
   * Reserved for v0.2 — `mode: "live"` will dispatch via the SDK adapter
   * to spawn real MCP servers. v0.1 stub mode does NOT touch the SDK,
   * but we still take the dependency so the v0.2 swap is a 1-line
   * change (uncomment the spawn call) rather than a refactor.
   */
  sdkAdapter: AgentSdkAdapter;
  logger?: MCPInjectorLogger;
  /**
   * v0.1 default = "stub". Setting "live" eager-throws
   * `MCPInjectorLiveModeNotImplementedError` from the constructor.
   */
  mode?: "stub" | "live";
}

export class MCPInjector {
  private readonly _registry: SkillRegistry;
  private readonly _logger: MCPInjectorLogger;
  private readonly _mode: "stub" | "live";

  /**
   * Per-agent mount audit table — `unmount` reads this to know what
   * the operator believes is live for an agent. v0.2 will replace
   * with a real MCP-server handle table.
   */
  private readonly _mounted = new Map<string, MCPMount[]>();

  constructor(opts: MCPInjectorOptions) {
    this._registry = opts.skillRegistry;
    this._logger = opts.logger ?? NOOP_LOGGER;
    this._mode = opts.mode ?? "stub";

    if (this._mode === "live") {
      // Decision T (mirrors O): eager-throw at composition time.
      throw new MCPInjectorLiveModeNotImplementedError();
    }

    // Touch sdkAdapter to keep the type checker happy (and ensure
    // callers can't pass undefined). v0.2 will use this to spawn.
    void opts.sdkAdapter;
  }

  /**
   * Operating mode — exposed for tests asserting the stub-path
   * was taken (TS-7.9). Mode is immutable after construction.
   */
  get mode(): "stub" | "live" {
    return this._mode;
  }

  /**
   * "Mount" every skill the given agent's role can use. v0.1 stub
   * behavior:
   *
   *   - Resolve `agent.role` → `skillRegistry.listForRole(role)` for
   *     candidate skills.
   *   - Filter by `agent.skills` membership (an agent only mounts
   *     skills it explicitly declared). This is the same filter
   *     `KernelDependencyValidator` walks — we don't re-validate
   *     here (`Runtime.create` always validates first).
   *   - Emit ONE `logger.info` line summarizing the mount.
   *   - Return the audit array so the caller can stdout-print.
   *
   * Idempotent: re-mounting an agent replaces the previous mount
   * audit (no leak); v0.2 will need to actually `unmount` first
   * to avoid duplicate spawns.
   */
  async mount(agent: AgentRecord): Promise<MCPMount[]> {
    const agentId = agent.protocol.agent_id;
    const declaredSkills = new Set(agent.protocol.skills ?? []);
    const mounts: MCPMount[] = [];

    for (const skill_id of declaredSkills) {
      const rec = this._registry.getById(skill_id);
      if (!rec) {
        this._logger.warn(
          `[MCPInjector stub] agent_id="${agentId}" declared skill_id="${skill_id}" ` +
            `but SkillRegistry has no such record; skipping`,
        );
        continue;
      }
      const provider = rec.provided_by;
      const mount: MCPMount = {
        agent_id: agentId,
        skill_id,
        transport: provider.transport,
      };
      if (provider.command !== undefined) mount.command = provider.command;
      if (provider.url !== undefined) mount.url = provider.url;
      mounts.push(mount);
    }

    this._mounted.set(agentId, mounts);

    if (mounts.length > 0) {
      const skillIdList = mounts.map((m) => m.skill_id).join(", ");
      this._logger.info(
        `[MCPInjector stub] mounting ${mounts.length} skill(s) for ` +
          `agent_id="${agentId}": ${skillIdList} ` +
          `(v0.1 — no subprocess spawned; v0.2 will wire @cursor/sdk MCP runtime)`,
      );
    } else {
      this._logger.info(
        `[MCPInjector stub] agent_id="${agentId}" has no skills to mount`,
      );
    }

    return mounts;
  }

  /**
   * Unwind a previous mount. Stub mode just clears the audit slot
   * + logs; v0.2 will SIGTERM the underlying MCP processes.
   */
  async unmount(agent_id: string): Promise<void> {
    const prev = this._mounted.get(agent_id);
    if (!prev) {
      // Idempotent: unmounting an agent that was never mounted is fine.
      return;
    }
    this._mounted.delete(agent_id);
    this._logger.info(
      `[MCPInjector stub] unmounting ${prev.length} skill(s) for ` +
        `agent_id="${agent_id}"`,
    );
  }

  /** Test/diagnostic helper — what's currently mounted for an agent. */
  getMounted(agent_id: string): MCPMount[] {
    return this._mounted.get(agent_id) ?? [];
  }

  /** All mounted agents — for stdout summaries. */
  listMounted(): string[] {
    return Array.from(this._mounted.keys());
  }
}

