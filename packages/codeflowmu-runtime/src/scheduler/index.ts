/**
 * Public barrel for the scheduler layer (Sprint S3 Phase C).
 *
 * Mirrors `registry/index.ts` and `session/index.ts` — re-exports the
 * scheduler-side classes, types, and errors that consumers (Runtime.ts,
 * E2E demo, future S4 Skill Runtime) need.
 */

export {
  InboxWatcher,
  type InboxEvent,
  type InboxEventHandler,
  type InboxValidationFailPolicy,
  type InboxWatcherOpts,
} from "./InboxWatcher.ts";

export {
  TaskParser,
  validateDurableTaskForDispatch,
  type ParsedTask,
  type DurableTaskValidationOptions,
} from "./TaskParser.ts";

export {
  StateHistoryWriter,
  type StateHistoryEntry,
} from "./StateHistoryWriter.ts";

export {
  TaskDispatcher,
  type TaskDispatcherLogger,
  type TaskDispatcherOpts,
  type AdHocPriority,
  type AdhocQueueItem,
  type DispatchOutcome,
  type DispatchControlPlaneOptions,
} from "./TaskDispatcher.ts";

export {
  PlanScheduler,
  type PlanSchedulerOptions,
  type PlanSchedulerLogger,
  type PlanStatus,
  type SprintItem,
  type SprintState,
} from "./PlanScheduler.ts";

export {
  FixedTaskRunner,
  buildDefaultRules,
  type FixedTaskRunnerLogger,
  type ScheduleRule,
  type ScheduleEntry,
} from "./FixedTaskRunner.ts";

export {
  ReportWatcher,
  type ReportEvent,
  type ReportEventHandler,
  type ReportWatcherOpts,
} from "./ReportWatcher.ts";

export { ReportWatcherSeenStore } from "./ReportWatcherSeenStore.ts";

export {
  ReportDispatcher,
  type ReportDispatcherOpts,
} from "./ReportDispatcher.ts";

export {
  PmQueueGuard,
  isPmToWorkerDispatch,
  type PmQueueSnapshot,
  type PmQueuePhase,
  type PmQueueReleaseReason,
  type PmQueueGuardOpts,
} from "./PmQueueGuard.ts";

export {
  DownstreamAutoNudge,
  ledgerHasWorkerReportForTask,
  DEFAULT_DOWNSTREAM_NUDGE_IDLE_MS,
  DEFAULT_DOWNSTREAM_NUDGE_DEBOUNCE_MS,
  DEFAULT_DOWNSTREAM_NUDGE_POLL_MS,
  DOWNSTREAM_AUTO_NUDGE_EVENT,
  type DownstreamAutoNudgeOpts,
  type DownstreamAutoNudgeLogger,
} from "./DownstreamAutoNudge.ts";

export {
  ReportActionResolver,
  type ReportActionOutcome,
  type ReportActionRequest,
  type ReportActionResolverOpts,
} from "./ReportActionResolver.ts";

export {
  LifecycleGovernor,
  lifecycleRootFromInboxDir,
  type LifecycleGovernorOpts,
  type LifecycleGovernorLogger,
} from "./LifecycleGovernor.ts";

export {
  ReportGate,
  type ReportGateOpts,
  type EnsureReciprocalReportInput,
} from "./ReportGate.ts";

// Scheduler-layer errors live in registry/errors.ts (Phase B decision J).
// Re-export here for ergonomic single-import consumers.
export {
  TaskParseError,
  TaskFileNotFoundError,
} from "../registry/errors.ts";
