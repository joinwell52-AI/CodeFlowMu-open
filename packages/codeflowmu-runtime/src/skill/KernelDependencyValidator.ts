/**
 * KernelDependencyValidator — enforce the v0.1 fcop-mcp hard-dependency
 * rule (design doc §0.5 + §0.7.5).
 *
 * Reference:
 *   - `docs/design/codeflowmu-v2-on-fcop-sdk.md` line 97 + 195 + 701 + 2339
 *     ("fcop-mcp 是内核（强依赖），mcpServers 必须挂 fcop，否则启动校验拒绝加载")
 *   - `packages/codeflowmu-protocol/schemas/skill.schema.json`
 *     `required_kernel.contains: { pattern: "^fcop@.+" }` — schema-level
 *     guarantee that EVERY loaded skill (via `SkillRegistry.load()`)
 *     contains at least one `fcop@.+` entry. We do NOT re-check that
 *     here — we just verify that the agent's `skills` list resolves to
 *     at least one such schema-valid skill.
 *   - `fcop/_lifecycle/inbox/TASK-20260509-024-PM-to-DEV.md` §主交付 2
 *
 * Three rejection reasons (PM TASK-024 §校验规则):
 *
 *   1. `no_fcop_skill`        — agent.skills ∩ registry produces zero
 *                                skills containing `fcop@.+`
 *   2. `skill_not_found`      — agent.skills lists a skill_id absent
 *                                from SkillRegistry
 *   3. `no_compatible_runtime` — none of the agent's skills declare
 *                                `compatible_runtimes` containing "local"
 *                                (decision A — Phase E: missing field
 *                                is interpreted as "compatible with all"
 *                                because skill.schema.json marks it
 *                                optional; tests TS-7.8 plant explicit
 *                                non-local-only skills to exercise this)
 *
 * Design boundary: this validator is the AUTHORITATIVE gate. Bootstrap
 * (TS-7.11) routes failures into `report.kernel_failures`; register
 * (TS-7.12) throws `KernelDependencyError`. Schema-side `contains` is
 * only a static-shape guarantee on individual skill files; this class
 * is what makes the guarantee mean something at the AGENT level.
 */

import type { Agent } from "@codeflowmu/protocol";

import { KernelDependencyError } from "../registry/errors.ts";
import type { AgentRecord } from "../types/state.ts";
import type { SkillRegistry } from "./SkillRegistry.ts";

/** Logger surface — matches `SkillRegistryLogger`. */
export interface KernelDependencyValidatorLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const NOOP_LOGGER: KernelDependencyValidatorLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/** Same shape as `KernelValidationFailureEntry` (intentional: 1:1 audit). */
export interface ValidationFailure {
  agent_id: string;
  reason:
    | "no_fcop_skill"
    | "skill_not_found"
    | "no_compatible_runtime";
  detail: string;
}

export interface KernelDependencyValidatorOptions {
  skillRegistry: SkillRegistry;
  logger?: KernelDependencyValidatorLogger;
  /**
   * The runtime mode the host process is currently running in. v0.1
   * locks this to `"local"` (cloud agents are §0.8.2 not-doing list).
   * Tests can pass `"cloud"` to verify the symmetric path, but production
   * `Runtime.create` always passes `"local"`.
   */
  hostRuntime?: "local" | "cloud";
}

/**
 * Pattern matching skill.schema.json `required_kernel.contains` —
 * declared independently so a future schema bump can be reconciled
 * by updating one constant. Tests assert this matches the schema
 * string verbatim.
 */
export const FCOP_KERNEL_PATTERN = /^fcop@.+/;

export class KernelDependencyValidator {
  private readonly _registry: SkillRegistry;
  private readonly _logger: KernelDependencyValidatorLogger;
  private readonly _hostRuntime: "local" | "cloud";

  constructor(opts: KernelDependencyValidatorOptions) {
    this._registry = opts.skillRegistry;
    this._logger = opts.logger ?? NOOP_LOGGER;
    this._hostRuntime = opts.hostRuntime ?? "local";
  }

  /** Validate an `AgentRecord` (bootstrap path). */
  validateAgent(record: AgentRecord): ValidationFailure | null {
    return this._check(
      record.protocol.agent_id,
      record.protocol.skills ?? [],
    );
  }

  /**
   * Validate an `Agent` spec before SDK.create (register path, decision S
   * in TASK-024 — checked AFTER agent-schema validation but BEFORE the
   * SDK adapter is touched, so SDK quota is preserved on rejection).
   */
  validateAgentSpec(spec: Agent): ValidationFailure | null {
    return this._check(spec.agent_id, spec.skills ?? []);
  }

  /**
   * Bulk variant — used by `RuntimeBootstrap` to build the
   * `kernel_failures[]` audit list in one pass.
   */
  validateAll(agents: AgentRecord[]): ValidationFailure[] {
    const out: ValidationFailure[] = [];
    for (const agent of agents) {
      const failure = this.validateAgent(agent);
      if (failure) out.push(failure);
    }
    return out;
  }

  /**
   * Convenience: throw `KernelDependencyError` on failure. Used by
   * `AgentRegistry.register` when the validator is wired (decision R:
   * register accepts an *optional* validator, so callers without a
   * SkillRegistry get the Phase A behavior verbatim).
   */
  assertAgentSpec(spec: Agent): void {
    const failure = this.validateAgentSpec(spec);
    if (failure) {
      throw new KernelDependencyError(
        failure.agent_id,
        failure.reason,
        failure.detail,
      );
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  private _check(
    agent_id: string,
    skill_ids: string[],
  ): ValidationFailure | null {
    // Reason #1 fast path: empty skills list cannot satisfy fcop@.+.
    // (TS-7.13 bonus.)
    if (skill_ids.length === 0) {
      const detail =
        `agent.skills is empty; v0.1 requires at least one skill ` +
        `whose required_kernel contains "${FCOP_KERNEL_PATTERN.source}"`;
      this._logger.warn(
        `[KernelDependencyValidator] reject agent_id="${agent_id}": ${detail}`,
      );
      return { agent_id, reason: "no_fcop_skill", detail };
    }

    // Reason #2: every skill_id must resolve.
    const resolved = [];
    for (const skill_id of skill_ids) {
      const rec = this._registry.getById(skill_id);
      if (!rec) {
        const detail =
          `agent references skill_id="${skill_id}" but SkillRegistry ` +
          `has no such record (did the file fail to load? check ` +
          `[SkillRegistry] warn lines)`;
        this._logger.warn(
          `[KernelDependencyValidator] reject agent_id="${agent_id}": ${detail}`,
        );
        return { agent_id, reason: "skill_not_found", detail };
      }
      resolved.push(rec);
    }

    // Reason #1 main path: at least one resolved skill must list a
    // `fcop@.+` entry in its `required_kernel`. (Schema guarantees
    // this is non-empty, so this is a tightening from "any skill"
    // to "the agent picked at least one fcop-aware skill".)
    const hasFcop = resolved.some((s) =>
      s.required_kernel.some((dep) => FCOP_KERNEL_PATTERN.test(dep)),
    );
    if (!hasFcop) {
      const detail =
        `agent's skills [${skill_ids.join(", ")}] resolve, but none of ` +
        `them declares a "fcop@..." entry in required_kernel; v0.1 ` +
        `requires fcop-mcp as the kernel skill (design doc §0.5)`;
      this._logger.warn(
        `[KernelDependencyValidator] reject agent_id="${agent_id}": ${detail}`,
      );
      return { agent_id, reason: "no_fcop_skill", detail };
    }

    // Reason #3: at least one resolved skill must declare host_runtime
    // compatibility. Per the Phase E "compatible_runtimes optional"
    // decision, a missing `compatible_runtimes` field counts as
    // "compatible with all" — schema marks the field optional, and
    // forcing every skill to declare it would be a constraint beyond
    // the schema. Tests (TS-7.8) plant explicit non-host-only skills
    // to exercise rejection.
    const compatible = resolved.some((s) => {
      if (s.compatible_runtimes === undefined) return true; // open
      return s.compatible_runtimes.includes(this._hostRuntime);
    });
    if (!compatible) {
      const detail =
        `agent's skills [${skill_ids.join(", ")}] resolve, but none of ` +
        `them declares compatible_runtimes containing "${this._hostRuntime}"; ` +
        `host_runtime="${this._hostRuntime}" cannot mount any of them`;
      this._logger.warn(
        `[KernelDependencyValidator] reject agent_id="${agent_id}": ${detail}`,
      );
      return { agent_id, reason: "no_compatible_runtime", detail };
    }

    return null;
  }
}

