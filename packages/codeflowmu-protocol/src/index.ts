export {
  loadSchema,
  getValidator,
  validate,
  isSchemaName,
  type SchemaName,
  type ValidationResult,
} from "./validator.ts";

// Schema-mirror TypeScript types. See `src/types.ts` for governance rules
// (do NOT extend without first updating the JSON schema; do NOT extend the
// JSON schema without first going through the D:\FCoP repo per §8.0 Hard
// Rule #4).
export type {
  IsoDateTime,
  RiskLevel,
  // Agent
  Agent,
  AgentLayer,
  AgentNode,
  AgentRuntime,
  AgentStatus,
  AgentModel,
  AgentModelParam,
  AgentMemoryUsage,
  // Task
  Task,
  TaskPriority,
  TaskStatus,
  TaskStateHistoryEntry,
  // Review
  Review,
  ReviewSubjectType,
  ReviewDecision,
  ReviewBoard,
  ReviewBoardMember,
  ReviewBoardMemberDecision,
  HumanApproval,
  // Session
  Session,
  SessionStatus,
  SessionRun,
  SessionRunTokensUsed,
  RunStatus,
  SessionOutcome,
  // Skill
  Skill,
  SkillTransport,
  SkillProvidedBy,
  SkillTool,
} from "./types.ts";
