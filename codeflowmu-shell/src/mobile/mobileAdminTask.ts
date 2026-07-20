import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listTasksFromLedgerAuto, finalizeTaskCreateAfterDiskWrite } from "../ledger-api-helpers.ts";
import { taskIdFromFilename } from "../panel-task-thread-visibility.ts";

export async function createMobileAdminPmTask(input: {
  projectRoot: string;
  adminTasksDir: string;
  subject: string;
  body: string;
  priority?: string;
  allocateSeq: (date: string) => string;
  attachments?: Array<{
    type?: string;
    url?: string;
    local_path?: string;
    absolute_path?: string;
    mime?: string;
    original_name?: string;
    size?: number;
    sha256?: string;
  }>;
  relation_mode?: "new" | "continue" | "child";
  references?: unknown;
  parent_task_id?: string;
  current_task_id?: string;
}): Promise<{ ok: boolean; status?: number; error?: string; [key: string]: unknown }> {
  let subject = String(input.subject ?? "").trim();
  let body = String(input.body ?? "").trim();
  const priority = String(input.priority ?? "P2").trim() || "P2";
  await mkdir(input.adminTasksDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = input.allocateSeq(date);
  const filename = `TASK-${date}-${seq}-ADMIN-to-PM.md`;
  const filepath = join(input.adminTasksDir, filename);
  const normalizeTaskId = (v: unknown): string => {
    const s = String(v ?? "")
      .trim()
      .replace(/\.md$/i, "")
      .trim();
    const parsed = taskIdFromFilename(s);
    return parsed || s;
  };

  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const hasAttachments = attachments.length > 0;

  // 允许“图片-only 任务”：标题/正文留空，但 attachments 存在时给出占位内容，
  // 这样 TASK frontmatter 仍然能追溯附件路径。
  if (!hasAttachments) {
    if (!subject || !body) {
      return { ok: false, status: 400, error: "MISSING_FIELDS" };
    }
  } else {
    if (!subject) subject = "image-only-task";
    if (!body) body = "See attached images.";
  }
  const formatAttachmentsYaml = (items: typeof attachments): string[] => {
    if (items.length === 0) return [];
    const quote = (s: string) => JSON.stringify(s);
    const lines = ["attachments:"];
    for (const a of items) {
      lines.push("  -");
      if (a.local_path) lines.push(`    local_path: ${quote(a.local_path)}`);
      if (a.absolute_path) lines.push(`    absolute_path: ${quote(a.absolute_path)}`);
      if (a.mime) lines.push(`    mime: ${quote(a.mime)}`);
      if (a.original_name) lines.push(`    original_name: ${quote(a.original_name)}`);
      if (typeof a.size === "number") lines.push(`    size: ${a.size}`);
      if (a.sha256) lines.push(`    sha256: ${quote(a.sha256)}`);
      if (a.url) lines.push(`    url: ${quote(a.url)}`);
    }
    return lines;
  };

  let relationMode = String(input.relation_mode ?? "new").trim().toLowerCase() as
    | "new"
    | "continue"
    | "child";
  if (!new Set(["new", "continue", "child"]).has(relationMode)) {
    return { ok: false, status: 400, error: "INVALID_RELATION_MODE" };
  }

  const requestedRefs: string[] = Array.isArray(input.references)
    ? [...new Set<string>(input.references.map((v) => normalizeTaskId(v)).filter(Boolean))]
    : [];

  const parentTaskIdInput = normalizeTaskId(input.parent_task_id ?? "");
  const currentTaskIdInput = normalizeTaskId(input.current_task_id ?? "");
  const childParentInput = parentTaskIdInput || currentTaskIdInput;
  if (parentTaskIdInput && relationMode === "continue") {
    return { ok: false, status: 400, error: "PARENT_TASK_ID_CONFLICT" };
  }
  if (childParentInput && relationMode === "new") {
    relationMode = "child";
  }

  let relationParent = "";
  let relationThreadKey = "";
  let relationReferences: string[] = [];

  if (relationMode === "continue") {
    const ledger = await listTasksFromLedgerAuto(input.projectRoot, { limit: 500 });
    const findRelationTask = (id: string) =>
      (ledger.tasks || []).find((row) => {
        const rowId = normalizeTaskId((row as Record<string, unknown>)?.task_id);
        const rowFile = normalizeTaskId((row as Record<string, unknown>)?.filename);
        const idNorm = normalizeTaskId(id);
        return rowId === idNorm || rowFile === idNorm;
      });

    relationReferences = requestedRefs.filter((id) => Boolean(findRelationTask(id)));
    if (!relationReferences.length) {
      return { ok: false, status: 400, error: "REFERENCES_REQUIRED" };
    }
    const first = findRelationTask(relationReferences[0]!);
    relationThreadKey = String(
      (first as Record<string, unknown> | undefined)?.thread_key ??
        ((first as Record<string, unknown> | undefined)?.yaml as Record<string, unknown> | undefined)
          ?.thread_key ??
        "",
    )
      .trim();
  } else if (relationMode === "child") {
    if (!childParentInput) {
      return { ok: false, status: 400, error: "PARENT_TASK_ID_REQUIRED" };
    }
    const ledger = await listTasksFromLedgerAuto(input.projectRoot, { limit: 500 });
    const findRelationTask = (id: string) =>
      (ledger.tasks || []).find((row) => {
        const rowId = normalizeTaskId((row as Record<string, unknown>)?.task_id);
        const rowFile = normalizeTaskId((row as Record<string, unknown>)?.filename);
        const idNorm = normalizeTaskId(id);
        return rowId === idNorm || rowFile === idNorm;
      });

    const parentTask = findRelationTask(childParentInput) as Record<string, unknown> | undefined;
    const parentBucket = String(parentTask?.bucket ?? parentTask?.physical_scope ?? "").toLowerCase();
    const parentState = String(
      parentTask?.lifecycle_projection ??
        parentTask?.display_status ??
        parentTask?.state ??
        "",
    ).toLowerCase();
    if (
      !parentTask ||
      ["done", "archive"].includes(parentBucket) ||
      ["done", "archive", "archived"].includes(parentState)
    ) {
      return { ok: false, status: 400, error: "PARENT_TASK_UNAVAILABLE" };
    }
    relationParent = String(parentTask?.task_id ?? childParentInput).replace(/\.md$/i, "").trim();
    relationReferences = [relationParent];
    relationThreadKey = String(
      parentTask.thread_key ?? (parentTask.yaml as Record<string, unknown> | undefined)?.thread_key ?? "",
    ).trim();
  }

  if (relationMode === "new") {
    relationThreadKey = `panel-task-${seq}`;
    relationReferences = [];
    relationParent = "";
  } else {
    relationThreadKey = relationThreadKey || `panel-task-${seq}`;
  }

  const content = [
    "---",
    "protocol: fcop",
    'version: "1.0"',
    "sender: ADMIN",
    "recipient: PM",
    `priority: ${priority}`,
    `task_id: TASK-${date}-${seq}`,
    `thread_key: ${relationThreadKey}`,
    `parent: ${relationParent}`,
    ...(relationReferences.length
      ? ["references:", ...relationReferences.map((id) => `  - ${id}`)]
      : ["references: []"]),
    "state: inbox",
    ...formatAttachmentsYaml(attachments),
    "---",
    "",
    `# ${subject}`,
    "",
    body,
    "",
  ].join("\n");

  await writeFile(filepath, content, "utf-8");
  const finalized = await finalizeTaskCreateAfterDiskWrite(input.projectRoot, filepath);
  if (!finalized.ok) {
    return { ok: false, status: 500, error: finalized.error ?? "LEDGER_FINALIZE_FAILED" };
  }
  return {
    ok: true,
    filename,
    filepath,
    task_id: `TASK-${date}-${seq}`,
    parent_task_id: relationParent || undefined,
  };
}
