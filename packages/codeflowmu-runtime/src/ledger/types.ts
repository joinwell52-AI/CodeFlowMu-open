/** ADR-0002 ledger fact records (JSONL lines). */

export type LedgerLifecycleBucket =
  | "inbox"
  | "active"
  | "review"
  | "done"
  | "archive"
  | "tasks"
  | "unknown";

export interface LedgerTaskRecord {
  task_id: string;
  filename: string;
  sender: string;
  recipient: string;
  bucket: LedgerLifecycleBucket;
  path: string;
  /** Local wall-clock ISO with numeric offset (e.g. +08:00), not bare Z. */
  created_at: string;
  updated_at: string;
  timezone: string;
  /** Machine UTC companion — only for sorting / internal use. */
  created_at_utc: string;
  updated_at_utc?: string;
  thread_key?: string;
  /** FCoP frontmatter `parent:` — explicit subtask link (tree edge). */
  parent?: string;
  /** Canonical API projection of `parent` (same value when set). */
  parent_task_id?: string;
  related?: string[];
  state?: string;
  /** Lifecycle / hot-path review projection (e.g. rejected after ADMIN reject). */
  review_status?: string;
  /** ADMIN reject / reopen only — not PM `review_note` from virtual auto-approve. */
  reopen_reason?: string;
  /** PM review note (e.g. virtual PM auto-approve); must not drive rework UI. */
  review_note?: string;
  /** ADMIN reject / reopen counter from ledger projection. */
  reopened_count?: number;
  display_status?: string;
  /** Human-readable reason when display_status=waiting_pm_attention (fact gate). */
  pm_attention_reason?: string;
  /** REPORT that produced waiting_pm_attention; absent means legacy/pre-report marker. */
  pm_attention_report_id?: string;
  /** Parsed YAML frontmatter (ledger rebuild from disk). */
  yaml?: Record<string, unknown>;
  /** Lifecycle transition log from frontmatter `transitions`. */
  transitions?: unknown[];
  /** Disk vs ledger reconciliation marker. */
  sync_status?: "ok" | "file_without_ledger";
  /** Physical disk scope/path projection used by Panel reconciliation. */
  physical_scope?: string;
  scope?: string;
}

/** Ledger row with no matching TASK file on disk (diagnostics only). */
export interface LedgerOrphanRecord {
  task_id: string;
  filename: string;
  bucket: string;
  path: string;
  sync_status: "ledger_orphan";
  ledger_updated_at?: string;
  reason: "file_missing" | "path_empty";
}

export type LedgerReportKind =
  | "worker_to_pm"
  | "pm_to_admin_ack"
  | "pm_to_admin_in_progress"
  | "pm_to_admin_final"
  | "auto_final_summary_fallback"
  | "other";

export interface LedgerReportRecord {
  report_id: string;
  task_id: string;
  /** Explicit evidence ownership; task_id remains the compatibility projection. */
  source_task_id?: string;
  filename: string;
  sender: string;
  recipient: string;
  status: string;
  /** Report validity projection used by review/rework gates. */
  valid?: boolean;
  invalidated_by?: string;
  invalid_reason?: string;
  superseded_by?: string;
  path: string;
  created_at: string;
  updated_at: string;
  timezone: string;
  created_at_utc: string;
  thread_key?: string;
  /** FCoP frontmatter `references` — used when `task_id` is absent. */
  references?: string[];
  /** Ledger rebuild: primary TASK parent for report tree (not FCoP frontmatter). */
  parent_task_id?: string;
  /** Ledger rebuild: all TASK ids this report links to (panel / API). */
  linked_task_ids?: string[];
  /** Ledger rebuild: classified report role for PM summary gating / UI. */
  report_kind?: LedgerReportKind;
  /** FCoP frontmatter `report_type` (e.g. final_summary). */
  report_type?: string;
  /** FCoP frontmatter `final: true` — PM-to-ADMIN terminal summary marker. */
  final?: boolean;
  /** Runtime `writePmAdminSummaryReport` auto thin summary marker. */
  auto_final_summary?: boolean;
  /** Immutable report revision metadata for ADMIN reject/rework cycles. */
  revision?: number;
  rework_round?: number;
  submission_attempt?: number;
  revision_of?: string;
  supersedes?: string;
  content_hash?: string;
  client_submission_id?: string;
  /** Ledger rebuild: filename / references / task_id disagree (display + diagnostics). */
  task_id_link_warning?: string;
  /** Parsed QA acceptance verdict; prevents `status: done` + FAIL body bypass. */
  qa_verdict?: "pass" | "blocked" | "fail" | "unknown";
  /** QA supplied browser/console/interaction evidence for a Web/UI delivery. */
  qa_browser_verified?: boolean;
  /** Waiting for an upstream REPORT; not a terminal child outcome. */
  dependency_pending?: boolean;
}

export interface LedgerThreadRecord {
  thread_key: string;
  root_task_id?: string;
  task_ids: string[];
  report_ids: string[];
  pending_pm_review: string[];
  /** All child tasks settled; root (hot_path or lifecycle) awaits PM summary. */
  waiting_pm_consolidation?: boolean;
}

export interface LedgerLayout {
  fcopRoot: string;
  tasksDir: string;
  reportsDir: string;
  reviewsDir: string;
  issuesDir: string;
  ledgerDir: string;
  /** fcop/ledger — diagnostics.jsonl lives here alongside tasks.jsonl */
  diagnosticsDir: string;
  lifecycleRoot: string;
}

export type DiagnosticKind =
  | "ledger_orphan"
  | "file_without_ledger"
  | "bucket_mismatch"
  | "path_mismatch"
  | "report_task_id_mismatch";

export type DiagnosticSeverity = "info" | "warn" | "error" | "critical";

/** One line in fcop/ledger/diagnostics.jsonl (survives tasks.jsonl rebuild). */
export interface DiagnosticRecord {
  id: string;
  task_id?: string;
  type: DiagnosticKind;
  severity: DiagnosticSeverity;
  title: string;
  message: string;
  expected_path?: string;
  actual_path?: string;
  ledger_path?: string;
  bucket_from_file?: string;
  bucket_from_ledger?: string;
  source?: "ledger" | "snapshot";
  detected_at: string;
  /** Stale ledger index corrected from disk during rebuild (audit only). */
  auto_healed?: boolean;
  /** When false, hide from ADMIN-visible diagnostics API and counts. */
  visible?: boolean;
}

export interface ReconcileSummary {
  lifecycleFileCount: number;
  ledgerRecordCount: number;
  /** Total diagnostics rows persisted (includes auto-healed audit rows). */
  diagnosticsCount: number;
  /** Diagnostics exposed to ADMIN UI / API counts. */
  visibleDiagnosticsCount: number;
  autoHealedCount: number;
  ledgerOrphanCount: number;
  fileWithoutLedgerCount: number;
  bucketMismatchCount: number;
  pathMismatchCount: number;
}

export interface ReconcileResult {
  normalTasks: LedgerTaskRecord[];
  diagnostics: DiagnosticRecord[];
  summary: ReconcileSummary;
}

export const LEDGER_VIEW_ROLES = [
  "ADMIN",
  "PM",
  "OPS",
  "DEV",
  "QA",
] as const;

export type LedgerViewRole = (typeof LEDGER_VIEW_ROLES)[number];
