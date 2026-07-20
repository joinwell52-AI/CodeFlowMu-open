export function titleFromTaskDoc(doc: Record<string, unknown> | null): string {
  const fm = (doc?.frontmatter ?? {}) as Record<string, unknown>;
  const subject = String(doc?.subject ?? fm.subject ?? "").trim();
  if (subject) return subject;
  const body = String(doc?.body ?? "");
  const heading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
  if (heading) return cleanReportTitleLine(heading.replace(/^#\s+/, ""));
  return "";
}

function cleanReportTitleLine(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 160);
}

export function titleFromReportDoc(doc: Record<string, unknown> | null): string {
  const fm = (doc?.frontmatter ?? {}) as Record<string, unknown>;
  const subject = String(doc?.subject ?? fm.subject ?? "").trim();
  if (subject) return subject;
  const body = String(doc?.body ?? "");
  const heading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
  if (heading) return cleanReportTitleLine(heading.replace(/^#\s+/, ""));
  const statusMatch = body.match(/^##\s*状态\s*\r?\n+([^\r\n#]+)/im);
  if (statusMatch?.[1]) return cleanReportTitleLine(statusMatch[1]);
  const conclusionMatch = body.match(/^##\s*结论\s*\r?\n+([^\r\n#]+)/im);
  if (conclusionMatch?.[1]) return cleanReportTitleLine(conclusionMatch[1]);
  const sectionMatch = body.match(/^##\s+[^\r\n]+\r?\n+([^\r\n#]+)/m);
  if (sectionMatch?.[1]) return cleanReportTitleLine(sectionMatch[1]);
  return "";
}

export function slimMobileTask(row: Record<string, unknown>): Record<string, unknown> {
  const yaml = (row.yaml ?? {}) as Record<string, unknown>;
  const title =
    String(row.subject ?? row.title ?? yaml.subject ?? "").trim() ||
    String(row.filename ?? "").replace(/\.md$/i, "");
  const parentRaw = String(row.parent_task_id ?? row.parent ?? yaml.parent ?? "").trim();
  return {
    filename: row.filename,
    task_id: row.task_id ?? row.id,
    from: row.sender ?? yaml.sender,
    to: row.recipient ?? yaml.recipient,
    status: row.display_status ?? row.bucket ?? row._state ?? row.state,
    bucket: row.scope ?? row.bucket ?? row._state ?? row.state,
    priority: row.priority ?? yaml.priority,
    title,
    parent: parentRaw || undefined,
    parent_task_id: parentRaw || undefined,
    created_at: row.created_at ?? row.ctime ?? yaml.created_at,
    updated_at: row.updated_at ?? row.mtime ?? row.last_event_at,
    sync_status: row.sync_status,
  };
}

export function slimMobileReport(row: Record<string, unknown>): Record<string, unknown> {
  const yaml = (row.yaml ?? {}) as Record<string, unknown>;
  const title =
    String(row.subject ?? row.title ?? yaml.subject ?? "").trim() ||
    String(row.report_id ?? row.filename ?? "").replace(/\.md$/i, "");
  return {
    filename: row.filename,
    report_id: row.report_id ?? row.task_id ?? row.filename,
    from: row.sender ?? row.reporter ?? yaml.sender,
    to: row.recipient ?? yaml.recipient,
    status: row.status ?? row.display_status ?? yaml.status,
    priority: row.priority ?? yaml.priority,
    task_id: row.task_id ?? yaml.task_id,
    linked_task_ids: row.linked_task_ids ?? yaml.linked_task_ids,
    title,
    preview: row.preview,
    created_at: row.created_at ?? yaml.created_at,
    updated_at: row.updated_at ?? row.mtime,
  };
}

export function isTaskOpen(row: Record<string, unknown>): boolean {
  const bucket = String(row.bucket ?? row._state ?? row.display_status ?? "").toLowerCase();
  if (["done", "archive", "archived", "closed"].includes(bucket)) return false;
  const review = String(row.review_status ?? "").toLowerCase();
  if (review === "approved" && (bucket === "done" || bucket === "archive")) return false;
  return true;
}

/** Local calendar day as YYYYMMDD (not UTC). */
export function localTodayYmdCompact(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function isReportToday(row: Record<string, unknown>, todayYmd: string): boolean {
  const fn = String(row.filename ?? "");
  if (fn.includes(todayYmd)) return true;
  const mtime = String(row.mtime ?? row.updated_at ?? row.created_at ?? "");
  if (!mtime) return false;
  const parsed = new Date(mtime);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    if (`${y}${m}${day}` === todayYmd) return true;
  }
  return mtime.slice(0, 10).replace(/-/g, "") === todayYmd;
}
