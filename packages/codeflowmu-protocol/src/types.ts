/**
 * codeflowmu Runtime Protocol — TypeScript type mirror of the 5 JSON schemas
 * under `packages/codeflowmu-protocol/schemas/`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEMA OWNERSHIP MATRIX (Charter 5.4 — set at P4 Day 5, 2026-05-11)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * | Schema   | SSOT                                            | Category                                              |
 * |----------|-------------------------------------------------|-------------------------------------------------------|
 * | Agent    | this repo (`schemas/agent.schema.json`)         | **codeflowmu-owned** — application-layer PCB (Char 5.4) |
 * | Task     | this repo (`schemas/task.schema.json`)          | **codeflowmu-owned** — emergence schema (Charter 5.4)   |
 * | Review   | DUAL — see §3.4 below                           | **Dual contract** — v0.3 fcop-first / yaml-fallback   |
 * | Session  | this repo (`schemas/session.schema.json`)       | **codeflowmu-owned** — emergence schema (Charter 5.4)   |
 * | Skill    | this repo (`schemas/skill.schema.json`)         | **codeflowmu-owned** — MCP registry (Charter 5.4)       |
 *
 * Charter 5.4 ("codeflowmu 仍持有应用层涌现物 — agent runtime PCB / SDK session
 * 状态 / Windows EPERM retry") is the governing principle. None of codeflowmu's
 * 5 schemas are a simple "mirror" of fcop@1.1.0 schemas:
 *
 * - **Agent** lives in `agents.json` as runtime PCB (sdk_agent_id / node /
 *   runtime / model / memory_usage / status). fcop@1.1.0's own `agent`
 *   schema describes role identity + capability (`code` / `can` / `cannot`)
 *   in `fcop.json/team.roles[]` — different facet, different storage.
 *
 * - **Task** is codeflowmu's application-layer TASK PCB. fcop@1.1.0 has no
 *   standalone Task schema; it has `ipc-envelope` of which `type=TASK` is
 *   one specialization. The fcop bridge (Day 2 TaskParser) wraps fcop's
 *   `Project.read_task$()` which validates against fcop's internal task
 *   shape; codeflowmu's Task schema is the consumer-side contract.
 *
 * - **Review** is the only schema with a DUAL contract:
 *     · v0.3 fcop-first path → fcop@1.1.0 `review.schema.json` is SSOT
 *       (`Project.write_review$()` validates; ReviewWriter._writeViaFcop
 *       discards codeflowmu-only fields like decision_duration_ms).
 *     · yaml fallback path  → this file's `schemas/review.schema.json` is
 *       SSOT (legacy compatibility for CODEFLOW_SKIP_FCOP_PROBE=1 mode +
 *       FcopClientError fallback).
 *   See Day 3 (TASK-20260511-011) ReviewWriter for the wire-up.
 *
 * - **Session** is 100% codeflowmu runtime concern. fcop@1.1.0 explicitly
 *   omits session ("fcop is a file protocol, runtime is an SDK concept" —
 *   see fcop ADR-0020 §session-recovery-hook). SessionManager + SessionStore
 *   never cross the fcop bridge.
 *
 * - **Skill** is codeflowmu's MCP server registry (`provided_by.transport`,
 *   `command`, `required_kernel`, `available_to_roles`). fcop@1.1.0's own
 *   `skill` schema describes role-capability references (`id` / `uri` /
 *   per-tool risk metadata) in `fcop.json` — different concept, different
 *   consumer.
 *
 * **For full drift analysis see `fcop/internal/p4-day5-schema-drift.md`.**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE & RULES (READ BEFORE EDITING)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - These types are a hand-maintained 1:1 mirror of the JSON Schemas in
 *   the SAME repo (`schemas/` under this package). The JSON files are
 *   the SINGLE SOURCE OF TRUTH for the **codeflowmu-owned** facet of each
 *   schema; these TS types are a consumer convenience.
 *
 * - For the **dual-contract Review schema**, the fcop-first writer path
 *   ultimately delegates to fcop@1.1.0's `review.schema.json` (in
 *   `D:\FCoP\src\fcop\_data\schemas\review.schema.json`). When working on
 *   review fields, consult BOTH schemas — codeflowmu's file is the yaml
 *   fallback contract; fcop's file is the fcop-bridge contract.
 *
 * - DO NOT add fields here that don't exist in the corresponding
 *   codeflowmu-owned schema. Application-layer field additions stay in
 *   this repo (Charter 5.4); they do NOT propagate to `D:\FCoP`.
 *
 * - DO NOT loosen field types beyond what schemas allow (e.g. don't widen
 *   an enum to `string`). If you find a Review schema divergence between
 *   the fcop-first path and the yaml-fallback path, document it in the
 *   release notes' "Semantic changes" section — do NOT silently align.
 *
 * - When schemas change, refresh this file by re-reading the schemas line
 *   by line. We deliberately don't auto-generate yet (json-schema-to-typescript
 *   tooling is a v0.x.+ choice, see design doc §3.7).
 *
 * Reference:
 * - design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §3.2 – §3.6
 * - Charter 5.4 — see `.cursor/rules/codeflowmu-project.mdc`
 * - `fcop/internal/p4-day5-schema-drift.md` (P4 Day 5 ownership matrix)
 */

// ───────────────────────────────────────────────────────────────────────────
// Shared primitives
// ───────────────────────────────────────────────────────────────────────────

/** ISO-8601 date-time string. JSON Schema `format: "date-time"`. */
export type IsoDateTime = string;

/** Risk level enum, used by Task and Skill tools. See §0.9.4. */
export type RiskLevel = "low" | "medium" | "high" | "irreversible";

// ───────────────────────────────────────────────────────────────────────────
// §3.2 Agent Schema  (mirror of schemas/agent.schema.json)
// Charter 5.4: codeflowmu-owned PCB schema. Not a mirror of fcop@1.1.0's
// `agent` schema — that one describes role identity + capability and
// lives in `fcop.json/team.roles[]`. This one is runtime PCB in
// `agents.json`. The two never collide.
// ───────────────────────────────────────────────────────────────────────────

export type AgentLayer =
  | "worker"
  | "governance"
  | "admin"
  | "leader"
  | "observer";
export type AgentNode = "local" | "cloud" | "mobile";
export type AgentRuntime = "local" | "cloud";
export type AgentStatus =
  | "idle"
  | "running"
  | "blocked"
  | "review"
  | "error"
  | "stopped";

export interface AgentModelParam {
  id: string;
  value: string | number | boolean;
}

export interface AgentModel {
  id: string;
  params?: AgentModelParam[];
}

export interface AgentMemoryUsage {
  tokens_in_context?: number;
  max_context?: number;
}

/**
 * codeflowmu Agent — defines a digital employee.
 * Direct 1:1 mirror of `schemas/agent.schema.json` v0.1.
 */
export interface Agent {
  $schema?: string;
  /** Globally unique role-level id (NOT the SDK agentId). Pattern: `^[A-Z][A-Z0-9_-]+(-\d+)?$`. */
  agent_id: string;
  /** Cursor SDK agentId returned from `Agent.create()`. Used by `Agent.resume()`. */
  sdk_agent_id?: string | null;
  /** Mapped to `roles.yaml` `roles[].id`. */
  role: string;
  /** 3-layer org structure (§0.9.1). */
  layer: AgentLayer;
  /** Which node the agent runs on. */
  node: AgentNode;
  /** Cursor SDK runtime mode. */
  runtime: AgentRuntime;
  /** For local agents: cwd path. For cloud agents: repo URL. */
  workspace?: string;
  model?: AgentModel;
  /** Active MCP skill IDs. MUST include `fcop` (kernel dependency). */
  skills: string[];
  status: AgentStatus;
  /** Currently held Task ID. `null` when idle. */
  current_task?: string | null;
  current_session?: string | null;
  memory_usage?: AgentMemoryUsage;
  started_at?: IsoDateTime;
  last_active_at?: IsoDateTime;
  /** User-defined tags (always-open extension point per §3.8). */
  labels?: Record<string, string>;
}

// ───────────────────────────────────────────────────────────────────────────
// §3.3 Task Schema  (mirror of schemas/task.schema.json)
// Charter 5.4: codeflowmu-owned emergence schema. fcop@1.1.0 has no standalone
// `task` schema — it uses `ipc-envelope` with type=TASK. Day 2 TaskParser
// (TASK-20260511-009) routes through `Project.read_task$()` which validates
// against fcop's internal envelope+TASK shape; this interface is the
// codeflowmu consumer-side contract.
// ───────────────────────────────────────────────────────────────────────────

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type TaskStatus =
  | "pending"
  | "dispatched"
  | "in_progress"
  | "review"
  | "done"
  | "blocked"
  | "cancelled";

export interface TaskStateHistoryEntry {
  state: string;
  at: IsoDateTime;
  by: string;
}

export interface ImageAttachmentRef {
  type: "image";
  url?: string;
  local_path?: string;
  mime?: string;
}

/**
 * codeflowmu Task — backward-compatible with FCoP `TASK-*.md` front-matter.
 * Direct 1:1 mirror of `schemas/task.schema.json` v0.1.
 *
 * Note: schema sets `additionalProperties: true` (FCoP front-matter is open),
 * which is reflected here by allowing `[k: string]: unknown` fallback fields.
 */
export interface Task {
  $schema?: string;
  /** MUST be `"fcop"` — FCoP kernel marker. */
  protocol: "fcop";
  fcop_version?: string;
  runtime_protocol_version?: string;
  /** Globally unique. MUST match the filename (without .md). */
  task_id: string;
  sender: string;
  recipient: string;
  priority: TaskPriority;
  thread_key?: string | null;
  /** Strong parent-child relation used for task trees and archive control. */
  parent?: string | null;
  /** Weak continuation/citation links. Never block archive. */
  references?: string[];
  parent_task?: string | null;
  status: TaskStatus;
  /** Append-only audit trail. Never delete entries. */
  state_history?: TaskStateHistoryEntry[];
  review_required?: boolean;
  review_assignee?: string | null;
  /** `high`/`irreversible` auto-trigger HITL. See §0.9.4. */
  risk_level?: RiskLevel;
  created_at?: IsoDateTime;
  updated_at?: IsoDateTime;
  deadline?: IsoDateTime | null;
  labels?: Record<string, string>;
  /** Lightweight image references carried in TASK/REPORT front-matter. */
  attachments?: ImageAttachmentRef[];
  /** FCoP front-matter is open-ended; consumers may carry extra fields. */
  [k: string]: unknown;
}

// ───────────────────────────────────────────────────────────────────────────
// §3.4 Review Schema  (mirror of schemas/review.schema.json — YAML FALLBACK CONTRACT)
// **Dual contract** — see file header. Day 3 (TASK-20260511-011) wired
// `ReviewWriter` to a fcop-first / yaml-fallback path:
//   - fcop bridge active → fcop@1.1.0 `review.schema.json` is SSOT (writer
//     filters out codeflowmu-only fields: review_id is fcop-generated,
//     decision_duration_ms is dropped, v0.1 human_approval stub is dropped).
//   - fcop bridge degraded → this interface (mirror of v0.1 codeflowmu schema)
//     is SSOT; codeflowmu-only fields (review_board, decision_duration_ms,
//     v0.1 human_approval stub shape) are preserved.
// See `fcop/internal/p4-day5-schema-drift.md` §2.2.2 for known divergence.
// ───────────────────────────────────────────────────────────────────────────

export type ReviewSubjectType = "task" | "code_change" | "report" | "role_switch";

export type ReviewDecision =
  | "approved"
  | "rejected"
  | "needs_changes"
  | "abstained"
  | "needs_human";

/** Per-member decision inside a Review Board. */
export type ReviewBoardMemberDecision =
  | "approved"
  | "rejected"
  | "needs_changes"
  | "abstained";

export interface ReviewBoardMember {
  role: string;
  agent?: string | null;
  decision: ReviewBoardMemberDecision;
  decided_at?: IsoDateTime | null;
}

export interface ReviewBoard {
  policy?: string;
  members?: ReviewBoardMember[];
  consensus_required?: number;
  consensus_reached?: boolean;
}

/**
 * Human-in-the-loop approval block.
 * Required when `Review.decision === "needs_human"` (enforced by schema `allOf`).
 */
export interface HumanApproval {
  pushed_to: "mobile" | "cli";
  pushed_at: IsoDateTime;
  approved_by?: string | null;
  approved_at?: IsoDateTime | null;
  trigger_reason: string;
}

/**
 * codeflowmu Review — verdict on a subject. Lives in `REVIEW-*.md` front-matter.
 * Direct 1:1 mirror of `schemas/review.schema.json` v0.1.
 */
export interface Review {
  $schema?: string;
  protocol: "fcop";
  runtime_protocol_version?: string;
  /** Pattern: `^REVIEW-\d{8}-\d{3}-[A-Z]+-on-TASK-\d{8}-\d{3}.*$` */
  review_id: string;
  subject_type: ReviewSubjectType;
  /** ID of the object being reviewed. */
  subject_ref: string;
  reviewer_role?: string | null;
  reviewer_agent?: string | null;
  /** Multi-reviewer mode (v0.5+). See §0.9.5.B. */
  review_board?: ReviewBoard | null;
  decision: ReviewDecision;
  rationale?: string;
  required_changes?: string | string[] | null;
  /** Required when `decision === "needs_human"`. */
  human_approval?: HumanApproval | null;
  decided_at: IsoDateTime;
  decision_duration_ms?: number | null;
  /** Open-ended for reviewer-specific metadata. */
  [k: string]: unknown;
}

// ───────────────────────────────────────────────────────────────────────────
// §3.5 Session Schema  (mirror of schemas/session.schema.json)
// Charter 5.4: codeflowmu-owned emergence schema. fcop@1.1.0 explicitly
// excludes session ("fcop is a file protocol, runtime is an SDK concept" —
// fcop ADR-0020 §session-recovery-hook). SessionManager / SessionStore /
// SessionRun never cross the fcop bridge; this schema is the only SSOT.
// ───────────────────────────────────────────────────────────────────────────

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";
export type RunStatus = "running" | "finished" | "failed" | "cancelled";

export interface SessionRunTokensUsed {
  input?: number;
  output?: number;
  thinking?: number;
}

export interface SessionRun {
  /** Pattern: `^run-[a-z0-9-]+$` */
  run_id: string;
  started_at: IsoDateTime;
  ended_at?: IsoDateTime | null;
  status: RunStatus;
  tokens_used?: SessionRunTokensUsed | null;
  tool_calls_count?: number;
  transcript_path?: string | null;
  /** Last tool name observed during SDK stream (observability). */
  last_tool?: string | null;
  /** Short preview of last tool args / action (observability). */
  last_action?: string | null;
  /** FCoP Failure hint when run ends abnormally (e.g. doorbell `TURN_LIMIT`). */
  failure_code?: string | null;
}

export interface SessionOutcome {
  files_changed?: string[];
  report_ref?: string | null;
  /** Open per schema (`additionalProperties: true`). */
  [k: string]: unknown;
}

/**
 * codeflowmu Session — an agent ↔ task conversation.
 * Direct 1:1 mirror of `schemas/session.schema.json` v0.1.
 */
export interface Session {
  $schema?: string;
  /** Pattern: `^session-[a-z0-9-]+$` */
  session_id: string;
  agent_id: string;
  task_id: string;
  started_at: IsoDateTime;
  ended_at?: IsoDateTime | null;
  status: SessionStatus;
  runs: SessionRun[];
  total_cost_usd?: number | null;
  outcome?: SessionOutcome | null;
}

// ───────────────────────────────────────────────────────────────────────────
// §3.6 Skill Schema  (mirror of schemas/skill.schema.json)
// Charter 5.4: codeflowmu-owned MCP server registry. Not a mirror of
// fcop@1.1.0's `skill` schema — that one describes role-capability
// references (id / uri / per-tool risk metadata) in `fcop.json`. This
// one describes how to spawn + mount an MCP server (provided_by.transport,
// command/url, required_kernel, available_to_roles). Different concept,
// different consumer. codeflowmu `SkillRegistry` / `MCPInjector` only read
// this schema.
// ───────────────────────────────────────────────────────────────────────────

export type SkillTransport = "stdio" | "http" | "sse";

export interface SkillProvidedBy {
  type: "mcp_server";
  transport: SkillTransport;
  /** Required for `stdio` transport. */
  command?: string;
  /** Required for `http` / `sse` transport. */
  url?: string;
  [k: string]: unknown;
}

export interface SkillTool {
  name: string;
  required_perms?: string[];
  risk_level?: RiskLevel;
  irreversible?: boolean;
  cost_sensitive?: boolean;
}

/**
 * codeflowmu Skill — an MCP server registered as a skill.
 * Direct 1:1 mirror of `schemas/skill.schema.json` v0.1.
 */
export interface Skill {
  $schema?: string;
  /** Pattern: `^[a-z][a-z0-9_-]*$` */
  skill_id: string;
  /** Pattern: `^\d+\.\d+\.\d+(-.*)?$` */
  version: string;
  displayName?: string;
  provided_by: SkillProvidedBy;
  tools: SkillTool[];
  /** Which roles can mount this skill. */
  available_to_roles: string[];
  /**
   * Hard kernel deps. Skills exposing fcop-aware tools MUST list
   * `fcop@>=1.0` or `fcop@>=1.0-pre`.
   */
  required_kernel: string[];
  compatible_runtimes?: AgentRuntime[];
  homepage?: string;
  license?: string;
}

