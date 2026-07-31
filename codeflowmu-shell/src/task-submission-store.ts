import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  evaluateTaskSpecAdmission,
  type TaskSpecCapabilityMatrixRow,
  type TaskSpecAdmissionFinding,
} from "@codeflowmu/runtime";
import {
  TaskParser,
  type ParsedTask,
} from "../../packages/codeflowmu-runtime/src/scheduler/TaskParser.ts";
import { findTaskFileByIdPrefix } from "./fcop-v3-paths.ts";

export type TaskSubmissionStatus =
  | "draft"
  | "checking"
  | "accepted"
  | "needs_revision"
  | "needs_approval"
  | "rejected"
  | "failed"
  | "abandoned"
  | "formalizing"
  | "created"
  | "formalization_failed";

export interface TaskSubmissionHistoryEntry {
  at: string;
  status: TaskSubmissionStatus;
  admission_revision: number;
  decision: "accepted" | "needs_revision" | "needs_approval" | "rejected" | null;
  content_digest: string;
  idempotency_key: string;
  note?: string;
}

export interface TaskSubmissionRecord {
  submission_id: string;
  created_at: string;
  updated_at: string;
  created_by: "ADMIN";
  recipient: "PM";
  subject: string;
  draft_body: string;
  requested_priority: "P0" | "P1" | "P2" | "P3";
  requested_parent?: string;
  requested_relation: "new" | "continue" | "child";
  requested_references: string[];
  requested_attachments: Array<Record<string, unknown>>;
  formal_thread_key: string;
  status: TaskSubmissionStatus;
  admission_revision: number;
  content_digest: string;
  formal_task_id: string | null;
  pending_formal_task_id?: string;
  decision: "accepted" | "needs_revision" | "needs_approval" | "rejected" | null;
  code: string | null;
  blocking_findings: TaskSpecAdmissionFinding[];
  capability_matrix: TaskSpecCapabilityMatrixRow[];
  checked_at?: string;
  formalized_at?: string;
  superseded_by?: string;
  idempotency_key?: string;
  error?: string;
  legacy_anomaly?: boolean;
  legacy_task_path?: string;
  migration_options?: string[];
  history: TaskSubmissionHistoryEntry[];
}

export interface TaskSubmissionDraft {
  subject: string;
  body: string;
  priority?: string;
  relation_mode?: "new" | "continue" | "child";
  parent_task_id?: string;
  references?: string[];
  attachments?: Array<Record<string, unknown>>;
  thread_key?: string;
  idempotency_key?: string;
}

const projectLocks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = projectRoot.toLowerCase();
  const previous = projectLocks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  projectLocks.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

function submissionsDir(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "task-submissions");
}

function admissionRecordsDir(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "task-spec-admission");
}

function sequencePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "runtime", "submission-sequence.json");
}

export function taskSubmissionPath(
  projectRoot: string,
  submissionId: string,
): string {
  const safe = submissionId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return join(submissionsDir(projectRoot), `${safe}.json`);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function readJsonRecord(path: string): Promise<TaskSubmissionRecord> {
  const record = JSON.parse(await readFile(path, "utf8")) as TaskSubmissionRecord;
  record.requested_attachments = Array.isArray(record.requested_attachments)
    ? record.requested_attachments
    : [];
  return record;
}

function normalizePriority(value: string | undefined): "P0" | "P1" | "P2" | "P3" {
  const normalized = String(value ?? "P2").trim().toUpperCase();
  return normalized === "P0" ||
    normalized === "P1" ||
    normalized === "P2" ||
    normalized === "P3"
    ? normalized
    : "P2";
}

function historyKey(
  record: TaskSubmissionRecord,
  status: TaskSubmissionStatus,
  decision: TaskSubmissionRecord["decision"],
): string {
  return [
    record.submission_id,
    record.content_digest || "(pending)",
    record.admission_revision,
    decision ?? status,
  ].join(":");
}

function appendHistory(
  record: TaskSubmissionRecord,
  status: TaskSubmissionStatus,
  decision: TaskSubmissionRecord["decision"],
  note?: string,
): void {
  const idempotencyKey = historyKey(record, status, decision);
  if (record.history.some((entry) => entry.idempotency_key === idempotencyKey)) {
    return;
  }
  record.history.push({
    at: new Date().toISOString(),
    status,
    admission_revision: record.admission_revision,
    decision,
    content_digest: record.content_digest,
    idempotency_key: idempotencyKey,
    ...(note ? { note } : {}),
  });
}

async function allocateSubmissionId(projectRoot: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  let state: Record<string, number> = {};
  try {
    state = JSON.parse(await readFile(sequencePath(projectRoot), "utf8")) as Record<
      string,
      number
    >;
  } catch {
    state = {};
  }
  let maximum = Number(state[date] ?? 0);
  try {
    const files = await readdir(submissionsDir(projectRoot));
    for (const file of files) {
      const match = file.match(
        new RegExp(`^SUBMISSION-${date}-(\\d+)\\.json$`, "i"),
      );
      if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
    }
  } catch {
    // First submission in this project.
  }
  const next = maximum + 1;
  state[date] = next;
  await atomicWriteJson(sequencePath(projectRoot), state);
  return `SUBMISSION-${date}-${String(next).padStart(3, "0")}`;
}

function normalizedAuthoredBody(record: TaskSubmissionRecord): string {
  return `# ${record.subject}\n\n${record.draft_body.trim()}\n`;
}

export function buildSubmissionAdmissionTask(
  projectRoot: string,
  record: TaskSubmissionRecord,
): ParsedTask {
  const frontmatter: Record<string, unknown> = {
    protocol: "fcop",
    version: "1.0",
    sender: "ADMIN",
    recipient: "PM",
    priority: record.requested_priority,
    thread_key: record.formal_thread_key,
    parent: record.requested_parent ?? "",
    references: record.requested_references,
    ...(record.requested_attachments.length > 0
      ? { attachments: record.requested_attachments }
      : {}),
  };
  return {
    filepath: taskSubmissionPath(projectRoot, record.submission_id),
    filename: `${record.submission_id}.md`,
    frontmatter,
    body: normalizedAuthoredBody(record),
    sender: "ADMIN",
    recipient: "PM",
    priority: record.requested_priority,
    thread_key: record.formal_thread_key,
  };
}

function enrichFinding(
  finding: TaskSpecAdmissionFinding,
): TaskSpecAdmissionFinding {
  if (
    finding.id === "INTERNAL_INCONSISTENCY" &&
    finding.field === "thread_key"
  ) {
    return {
      ...finding,
      expected: "Runtime-generated formal_thread_key",
      actual: finding.evidence ?? [],
      suggested_fix:
        "删除正文中硬编码的 thread_key；正式 thread_key 由 Runtime 生成，子任务从父任务继承。",
      can_auto_fix: false,
    };
  }
  return {
    ...finding,
    expected: finding.expected ?? finding.supported ?? finding.requirement,
    actual: finding.actual ?? finding.evidence ?? finding.missing,
    suggested_fix:
      finding.suggested_fix ??
      "根据阻塞字段修订任务书后创建新的 admission revision。",
    can_auto_fix: finding.can_auto_fix ?? false,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function titleFromParsedTask(task: ParsedTask, fallback: string): string {
  const heading = task.body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || fallback;
}

async function listLegacyRejectedTaskSubmissions(
  projectRoot: string,
): Promise<TaskSubmissionRecord[]> {
  let files: string[] = [];
  try {
    files = (await readdir(admissionRecordsDir(projectRoot))).filter((file) =>
      /^TASK-.*\.json$/i.test(file),
    );
  } catch {
    return [];
  }
  const rows: TaskSubmissionRecord[] = [];
  for (const file of files) {
    try {
      const proof = JSON.parse(
        await readFile(join(admissionRecordsDir(projectRoot), file), "utf8"),
      ) as Record<string, unknown>;
      if (
        proof["decision"] !== "rejected" ||
        String(proof["submission_id"] ?? "").trim()
      ) {
        continue;
      }
      const taskId = String(
        proof["formal_task_id"] ??
          proof["task_id"] ??
          basename(file, ".json"),
      )
        .trim()
        .toUpperCase();
      const hit = findTaskFileByIdPrefix(projectRoot, taskId);
      if (!hit) continue;
      const task = await TaskParser.parse(hit.path);
      const sender = String(
        task.sender ?? task.frontmatter["sender"] ?? "",
      ).toUpperCase();
      const recipient = String(
        task.recipient ?? task.frontmatter["recipient"] ?? "",
      ).toUpperCase();
      if (sender !== "ADMIN" || recipient !== "PM") continue;
      const checkedAt = String(proof["checked_at"] ?? "").trim();
      const timestamp = checkedAt || new Date(0).toISOString();
      const findings = Array.isArray(proof["blocking_findings"])
        ? (proof["blocking_findings"] as TaskSpecAdmissionFinding[]).map(
            enrichFinding,
          )
        : [];
      const parent = String(task.frontmatter["parent"] ?? "").trim();
      const subject = titleFromParsedTask(task, taskId);
      rows.push({
        submission_id: `LEGACY-${taskId}`,
        created_at: timestamp,
        updated_at: timestamp,
        created_by: "ADMIN",
        recipient: "PM",
        subject,
        draft_body: task.body.replace(/^\s*#\s+.+?\r?\n+/, "").trim(),
        requested_priority: normalizePriority(task.priority),
        ...(parent ? { requested_parent: parent } : {}),
        requested_relation: parent ? "child" : "new",
        requested_references: stringArray(task.frontmatter["references"]),
        requested_attachments: Array.isArray(task.frontmatter["attachments"])
          ? (task.frontmatter["attachments"] as Array<Record<string, unknown>>)
          : [],
        formal_thread_key: String(
          task.thread_key ?? task.frontmatter["thread_key"] ?? "",
        ).trim(),
        status: "rejected",
        admission_revision: 0,
        content_digest: String(proof["content_digest"] ?? ""),
        formal_task_id: taskId,
        decision: "rejected",
        code: String(proof["code"] ?? "TASK_SPEC_INVALID"),
        blocking_findings: findings,
        capability_matrix: [],
        checked_at: checkedAt || undefined,
        legacy_anomaly: true,
        legacy_task_path: hit.path,
        migration_options: [
          "convert_to_submission",
          "mark_legacy_invalid",
          "admin_manual_cleanup",
        ],
        error:
          "这是准入机制启用前留下的拒绝任务；Runtime 已阻止其进入 Session。",
        history: [
          {
            at: timestamp,
            status: "rejected",
            admission_revision: 0,
            decision: "rejected",
            content_digest: String(proof["content_digest"] ?? ""),
            idempotency_key: `legacy:${taskId}:${String(
              proof["content_digest"] ?? "",
            )}:rejected`,
            note: "legacy rejected formal task isolated from the formal task UI",
          },
        ],
      });
    } catch {
      // Invalid proof or task content remains fail-closed and is not promoted.
    }
  }
  return rows;
}

export async function listTaskSubmissions(
  projectRoot: string,
  options: { status?: string; limit?: number } = {},
): Promise<TaskSubmissionRecord[]> {
  let files: string[] = [];
  try {
    files = (await readdir(submissionsDir(projectRoot))).filter((file) =>
      /^SUBMISSION-.*\.json$/i.test(file),
    );
  } catch {
    files = [];
  }
  const rows: TaskSubmissionRecord[] = [];
  for (const file of files) {
    try {
      const record = await readJsonRecord(join(submissionsDir(projectRoot), file));
      if (options.status && record.status !== options.status) continue;
      rows.push(record);
    } catch {
      // A malformed record is not exposed as a formal task.
    }
  }
  const legacyRows = await listLegacyRejectedTaskSubmissions(projectRoot);
  for (const record of legacyRows) {
    if (options.status && record.status !== options.status) continue;
    rows.push(record);
  }
  rows.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return rows.slice(0, Math.max(0, Math.min(options.limit ?? 200, 500)));
}

export async function getTaskSubmission(
  projectRoot: string,
  submissionId: string,
): Promise<TaskSubmissionRecord | null> {
  if (submissionId.toUpperCase().startsWith("LEGACY-TASK-")) {
    const rows = await listLegacyRejectedTaskSubmissions(projectRoot);
    return (
      rows.find(
        (record) =>
          record.submission_id.toUpperCase() === submissionId.toUpperCase(),
      ) ?? null
    );
  }
  try {
    return await readJsonRecord(taskSubmissionPath(projectRoot, submissionId));
  } catch {
    return null;
  }
}

export async function findTaskSubmissionByIdempotencyKey(
  projectRoot: string,
  idempotencyKey: string,
): Promise<TaskSubmissionRecord | null> {
  if (!idempotencyKey.trim()) return null;
  const rows = await listTaskSubmissions(projectRoot, { limit: 500 });
  return (
    rows.find((record) => record.idempotency_key === idempotencyKey.trim()) ??
    null
  );
}

export async function createTaskSubmission(
  projectRoot: string,
  draft: TaskSubmissionDraft,
): Promise<TaskSubmissionRecord> {
  return withProjectLock(projectRoot, async () => {
    if (draft.idempotency_key) {
      const replay = await findTaskSubmissionByIdempotencyKey(
        projectRoot,
        draft.idempotency_key,
      );
      if (replay) return replay;
    }
    const submissionId = await allocateSubmissionId(projectRoot);
    const now = new Date().toISOString();
    const relation = draft.relation_mode ?? "new";
    const record: TaskSubmissionRecord = {
      submission_id: submissionId,
      created_at: now,
      updated_at: now,
      created_by: "ADMIN",
      recipient: "PM",
      subject: draft.subject.trim(),
      draft_body: draft.body.trim(),
      requested_priority: normalizePriority(draft.priority),
      ...(draft.parent_task_id
        ? { requested_parent: draft.parent_task_id.trim() }
        : {}),
      requested_relation: relation,
      requested_references: [...new Set(draft.references ?? [])],
      requested_attachments: (draft.attachments ?? []).map((attachment) => ({
        ...attachment,
      })),
      formal_thread_key:
        draft.thread_key?.trim() ||
        `submission-${submissionId.toLowerCase()}`,
      status: "draft",
      admission_revision: 1,
      content_digest: "",
      formal_task_id: null,
      decision: null,
      code: null,
      blocking_findings: [],
      capability_matrix: [],
      ...(draft.idempotency_key
        ? { idempotency_key: draft.idempotency_key.trim() }
        : {}),
      history: [],
    };
    appendHistory(record, "draft", null, "submission created");
    await atomicWriteJson(
      taskSubmissionPath(projectRoot, submissionId),
      record,
    );
    return record;
  });
}

export async function checkTaskSubmission(
  projectRoot: string,
  submissionId: string,
): Promise<TaskSubmissionRecord> {
  return withProjectLock(projectRoot, async () => {
    const record = await getTaskSubmission(projectRoot, submissionId);
    if (!record) throw new Error("TASK_SUBMISSION_NOT_FOUND");
    if (record.status === "created") return record;

    record.status = "checking";
    record.updated_at = new Date().toISOString();
    record.error = undefined;
    appendHistory(record, "checking", null, "admission started");
    await atomicWriteJson(taskSubmissionPath(projectRoot, submissionId), record);

    try {
      const result = await evaluateTaskSpecAdmission({
        projectRoot,
        task: buildSubmissionAdmissionTask(projectRoot, record),
      });
      record.content_digest = result.content_digest;
      record.decision = result.decision;
      record.code = result.code;
      record.blocking_findings = result.blocking_findings.map(enrichFinding);
      record.capability_matrix = result.capability_matrix;
      record.status = result.decision;
      record.checked_at = new Date().toISOString();
      record.updated_at = record.checked_at;
      appendHistory(record, record.status, result.decision);
      await atomicWriteJson(
        taskSubmissionPath(projectRoot, submissionId),
        record,
      );
      return record;
    } catch (error) {
      record.status = "failed";
      record.decision = null;
      record.code = "TASK_SPEC_ADMISSION_FAILED";
      record.blocking_findings = [];
      record.capability_matrix = [];
      record.error = error instanceof Error ? error.message : String(error);
      record.updated_at = new Date().toISOString();
      appendHistory(record, "failed", null, record.error);
      await atomicWriteJson(
        taskSubmissionPath(projectRoot, submissionId),
        record,
      );
      return record;
    }
  });
}

export async function reviseTaskSubmission(
  projectRoot: string,
  submissionId: string,
  draft: Partial<TaskSubmissionDraft>,
): Promise<TaskSubmissionRecord> {
  return withProjectLock(projectRoot, async () => {
    const record = await getTaskSubmission(projectRoot, submissionId);
    if (!record) throw new Error("TASK_SUBMISSION_NOT_FOUND");
    if (record.status === "created" || record.formal_task_id) {
      throw new Error("TASK_SUBMISSION_ALREADY_FORMALIZED");
    }
    if (draft.subject != null) record.subject = draft.subject.trim();
    if (draft.body != null) record.draft_body = draft.body.trim();
    if (draft.priority != null) {
      record.requested_priority = normalizePriority(draft.priority);
    }
    if (draft.parent_task_id !== undefined) {
      record.requested_parent = draft.parent_task_id?.trim() || undefined;
    }
    if (draft.relation_mode) record.requested_relation = draft.relation_mode;
    if (draft.references) {
      record.requested_references = [...new Set(draft.references)];
    }
    if (draft.attachments) {
      record.requested_attachments = draft.attachments.map((attachment) => ({
        ...attachment,
      }));
    }
    if (draft.thread_key) record.formal_thread_key = draft.thread_key.trim();
    record.admission_revision += 1;
    record.status = "draft";
    record.decision = null;
    record.code = null;
    record.content_digest = "";
    record.blocking_findings = [];
    record.error = undefined;
    record.updated_at = new Date().toISOString();
    appendHistory(record, "draft", null, "submission revised");
    await atomicWriteJson(
      taskSubmissionPath(projectRoot, submissionId),
      record,
    );
    return record;
  });
}

export async function abandonTaskSubmission(
  projectRoot: string,
  submissionId: string,
): Promise<TaskSubmissionRecord> {
  return withProjectLock(projectRoot, async () => {
    const record = await getTaskSubmission(projectRoot, submissionId);
    if (!record) throw new Error("TASK_SUBMISSION_NOT_FOUND");
    if (record.status === "created" || record.formal_task_id) {
      throw new Error("TASK_SUBMISSION_ALREADY_FORMALIZED");
    }
    record.status = "abandoned";
    record.updated_at = new Date().toISOString();
    appendHistory(record, "abandoned", record.decision, "abandoned by ADMIN");
    await atomicWriteJson(
      taskSubmissionPath(projectRoot, submissionId),
      record,
    );
    return record;
  });
}

export async function updateTaskSubmissionFormalization(
  projectRoot: string,
  submissionId: string,
  update:
    | { status: "formalizing"; pending_formal_task_id?: string }
    | { status: "created"; formal_task_id: string }
    | { status: "formalization_failed"; error: string },
): Promise<TaskSubmissionRecord> {
  return withProjectLock(projectRoot, async () => {
    const record = await getTaskSubmission(projectRoot, submissionId);
    if (!record) throw new Error("TASK_SUBMISSION_NOT_FOUND");
    if (record.status === "created") return record;
    if (
      update.status === "formalizing" &&
      record.status !== "accepted" &&
      record.status !== "formalizing"
    ) {
      throw new Error("TASK_SUBMISSION_NOT_ACCEPTED");
    }
    record.status = update.status;
    record.updated_at = new Date().toISOString();
    if (update.status === "created") {
      record.formal_task_id = update.formal_task_id;
      record.pending_formal_task_id = undefined;
      record.formalized_at = record.updated_at;
      record.error = undefined;
    } else if (update.status === "formalizing") {
      if (update.pending_formal_task_id) {
        record.pending_formal_task_id = update.pending_formal_task_id;
      }
    } else if (update.status === "formalization_failed") {
      record.error = update.error;
      record.formal_task_id = null;
      record.pending_formal_task_id = undefined;
    }
    appendHistory(
      record,
      update.status,
      record.decision,
      update.status === "formalization_failed" ? update.error : undefined,
    );
    await atomicWriteJson(
      taskSubmissionPath(projectRoot, submissionId),
      record,
    );
    return record;
  });
}

export function taskSubmissionDigestPreview(
  subject: string,
  body: string,
): string {
  return createHash("sha256")
    .update(subject.trim())
    .update("\n")
    .update(body.trim())
    .digest("hex");
}

export function taskSubmissionIdFromPath(path: string): string {
  return basename(path).replace(/\.json$/i, "");
}
