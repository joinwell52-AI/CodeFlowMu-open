export type {
  LifecycleAction,
  LifecycleStage,
  LifecycleTransitionResult,
  LifecycleWriteOpts,
  TaskDoc,
  TaskFm,
  TransitionInput,
  AppendTransitionResult,
} from "./types.ts";

export { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";
export { TransitionRecorder } from "./TransitionRecorder.ts";
export {
  isDuplicateTransition,
  transitionCompareFromInput,
  transitionCompareFromRecord,
} from "./transitionIdempotency.ts";
export {
  assertYamlFallbackWriteAllowed,
  YamlFallbackWriteBlockedError,
  type LifecycleWriteContext,
} from "./yamlFallbackGuard.ts";
export {
  trimTaskTransitions,
  type TrimTaskTransitionsOpts,
  type TrimTaskTransitionsResult,
} from "./trimTaskTransitions.ts";
export {
  inferTaskLine,
  resolveArchiveAuthority,
  resolveDoneAuthority,
  resolveDriver,
  resolveReviewer,
  taskRouteRoles,
} from "./authorityDefaults.ts";
export { AuthorityGuard, AuthorityError } from "./AuthorityGuard.ts";
export { ArchiveGuard } from "./ArchiveGuard.ts";
export {
  ChildTasksNotAcceptedError,
  ChildTasksOpenError,
  collectRelatedChildTasks,
  terminateOpenChildTasksByParentArchive,
  terminateSingleChildAsParentResidue,
  type NotAcceptedChildRef,
  type OpenChildTaskRef,
} from "./childTaskArchiveGate.ts";
export {
  CLOSED_PARENT_RESIDUE_DISPLAY,
  hasExplicitParentInFm,
  isAdminMainlineRootTask,
  isAdminMainlineTaskFilename,
  isArchivedByParentMainline,
  isClosedParentResidueMarked,
  isClosedParentResidueTask,
  isParentTaskClosed,
  isStateBucketMismatch,
  isTaskOpenForArchiveGate,
} from "./closedParentResidue.ts";
export {
  LifecycleStateMachine,
  type LifecycleStateMachineOpts,
} from "./LifecycleStateMachine.ts";
export { LifecycleKernel } from "./LifecycleKernel.ts";
export {
  findTaskPathById,
  findTaskPathByIdSync,
  findTaskLocationById,
  lifecycleRelPath,
  lifecycleRootFromTaskPath,
  normalizePath,
  resolveTaskFileForMutation,
  stageFromPath,
  type TaskLocation,
  type TaskStorageKind,
} from "./taskPathUtils.ts";
export {
  repairMisplacedArchivedTasks,
  isHalfArchivedTaskFile,
  type RepairMisplacedArchiveResult,
} from "./repairMisplacedArchive.ts";
export {
  reconcileReworkSupersededTasks,
  type ReworkReconcileResult,
} from "./reconcileReworkSuperseded.ts";
