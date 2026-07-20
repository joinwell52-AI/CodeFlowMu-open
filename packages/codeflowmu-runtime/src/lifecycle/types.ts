export type LifecycleStage =
  | "inbox"
  | "active"
  | "review"
  | "done"
  | "archive";

export type TaskFm = {
  protocol?: string;
  version?: number;
  sender?: string;
  recipient?: string;
  task_id?: string;
  kind?: string;

  from?: string | null;
  to?: string | null;
  line?: "main" | "branch";

  state?: LifecycleStage | "dispatched";
  lifecycle_path?: string;

  driver?: string;
  reviewer?: string;
  done_authority?: string;
  archive_authority?: string;
  current_owner?: string;

  parent_task?: string;
  parent_task_id?: string;
  parent?: string;
  children?: string[];
  thread_key?: string | null;
  status?: string;
  references?: string[];
  timezone?: string;

  reports?: string[];
  review_status?: string;
  /** Hot-path / ledger projection — not a physical _lifecycle stage. */
  lifecycle_projection?: string;
  display_status?: string;
  reviewed_at?: string;
  reviewed_by?: string;
  review_note?: string;
  pm_attention_reason?: string;
  pm_attention_report_id?: string;
  rework_completed_by_report?: string;
  updated_at?: string;
  created_at_utc?: string;
  subject?: string;
  subject_id?: string;
  subject_ref?: string;
  report_type?: string;
  report_id?: string;
  decision?: string;
  final?: boolean;
  auto_final_summary?: boolean;
  source_task_id?: string;
  rework_of?: string;
  rework_index?: number;
  rework_reason?: string;
  superseded_by?: string;
  superseded_reason?: string;
  superseded_at?: string;
  archived_by_parent_mainline?: boolean;
  terminated_by_parent_archive?: boolean;
  closed_parent_residue?: boolean;
  residue_admin_action?: string;
  residue_noted_at?: string;
  residue_noted_by?: string;

  delegated_done?: boolean;
  delegated_by?: string;
  delegation_scope?: string;
  risk_level?: string;

  frozen?: boolean;
  reopened_count?: number;

  created_at?: string;
  claimed_at?: string;
  submitted_at?: string;
  approved_at?: string;
  archived_at?: string;

  approved_by?: string;
  archived_by?: string;
  archive_reason?: string;
  archive_mode?: string;
  task_type?: string;
  reopen_reason?: string;

  transitions?: Array<{
    from?: string | null;
    to?: string | null;
    action?: string;
    [key: string]: unknown;
  }>;
};

export type TaskDoc = {
  fm: TaskFm;
  body: string;
  raw: string;
};

export type LifecycleAction =
  | "submit_review"
  | "approve_review"
  | "reject_review"
  | "reopen_task"
  | "archive_task";

export type TransitionInput = {
  from: LifecycleStage | null;
  to: LifecycleStage;
  by: string;
  action: string;

  reason?: string;
  report?: string;
  decision?: "approved" | "rejected" | "reopened" | "archived" | "terminated";
  based_on?: string[];
  child_task?: string;
  parent?: string;
};

export type LifecycleTransitionResult = {
  ok: true;
  task_id: string;
  from: LifecycleStage;
  to: LifecycleStage;
  path: string;
};

export type LifecycleWriteOpts = {
  /** Allow patch/write on archive-stage files (archive_task final frozen write). */
  allowFrozenWrite?: boolean;
};

export type AppendTransitionResult =
  | { appended: true }
  | { appended: false; skipped_duplicate_transition: true };
