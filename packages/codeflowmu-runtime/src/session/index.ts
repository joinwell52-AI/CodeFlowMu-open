export {
  SessionManager,
  type SessionManagerOptions,
  type SessionStartPayload,
  type SessionHandle,
  type EmergencyStopResult,
} from "./SessionManager.ts";

export {
  SessionStore,
  type SessionStoreOptions,
} from "./SessionStore.ts";

export {
  SessionLeaseStore,
  SessionLeaseConflictError,
  type SessionLeaseKey,
  type SessionLeaseRecord,
} from "./SessionLeaseStore.ts";

export {
  TranscriptWriter,
  type TranscriptWriterOptions,
  type TranscriptEntryKind,
} from "./TranscriptWriter.ts";

export {
  SdkRunHandle,
  type SdkRunHandleOptions,
  type SdkRunLike,
} from "./SdkRunHandle.ts";

export type { RunHandle } from "./RunHandle.ts";

export {
  buildSdkFailurePayloadFields,
  classifySdkFailureCategory,
  extractSdkErrorDetails,
  isSdkResultNoDetail,
  pickSdkFailureFieldsFromPayload,
  rebuildSdkFailureForSessionEnd,
  suggestedActionsForCategory,
  SDK_FAILURE_PAYLOAD_KEYS,
  type BuildSdkFailurePayloadContext,
  type ClassifySdkFailureInput,
  type RebuildSdkFailureForSessionEndInput,
  type SdkFailureCategory,
  type SdkFailureDetail,
  type SdkFailurePayloadFields,
  type SessionRunWithSdkFailure,
} from "./sdk-failure-classifier.ts";
