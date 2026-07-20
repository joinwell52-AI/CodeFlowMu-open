import { parse as parseYaml } from "yaml";

const FRONTMATTER_OPEN = /^---\r?\n/;

export function parseMarkdownFrontmatter(
  content: string,
): Record<string, unknown> {
  if (!FRONTMATTER_OPEN.test(content)) return {};
  const start = content.match(FRONTMATTER_OPEN)![0]!.length;
  const end = content.indexOf("\n---", start);
  if (end < 0) return {};
  const yamlBody = content
    .slice(start, end)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  try {
    const parsed = parseYaml(yamlBody);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
    : {};
  } catch {
    return {};
  }
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Render YAML frontmatter block (without trailing body). */
export function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function strField(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  if (v == null) return "";
  return String(v).trim();
}

export function listField(fm: Record<string, unknown>, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

const TASK_ID_LONG_RE =
  /TASK-\d{8}-\d{3,}-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+/gi;
const TASK_ID_SHORT_RE = /TASK-\d{8}-\d{3,}/g;

const PM_ADMIN_REPORT_FILENAME_RE =
  /^REPORT-(\d{8})-(\d{3})-PM-to-ADMIN(?:-[a-z][a-z0-9-]*[a-z0-9])?\.md$/i;

/**
 * PM→ADMIN 报告文件名与 ADMIN→PM 主线 task 共用 date-seq（REPORT-…-004-PM-to-ADMIN ↔ TASK-…-004）。
 * 用于 ack-only 正文无 TASK 引用时的 ledger / panel 挂树。
 */
export function inferReportTaskIdFromFilename(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "");
  const m = base.match(PM_ADMIN_REPORT_FILENAME_RE);
  if (!m) return "";
  return `TASK-${m[1]}-${m[2]}`;
}

/** Infer TASK id from report body when frontmatter lacks task_id/references. */
export function inferLabeledRootTaskFromBody(content: string): string {
  const fmClose = content.indexOf("\n---", 3);
  const body = fmClose >= 0 ? content.slice(fmClose + 4) : content;
  for (const re of ROOT_TASK_BODY_PATTERNS) {
    const m = body.match(re);
    if (m?.[1]) return m[1].replace(/\.md$/i, "").trim();
  }
  return "";
}

/** Infer TASK id from report body when frontmatter lacks task_id/references. */
export function inferReportTaskIdFromBody(content: string): string {
  const labeled = inferLabeledRootTaskFromBody(content);
  if (labeled) return labeled;

  const fmClose = content.indexOf("\n---", 3);
  const body = fmClose >= 0 ? content.slice(fmClose + 4) : content;
  const longMatches = [...body.matchAll(TASK_ID_LONG_RE)];
  const adminToPm = longMatches.find((m) => /-ADMIN-to-PM$/i.test(m[0]!));
  if (adminToPm) return adminToPm[0]!.replace(/\.md$/i, "").trim();
  if (longMatches[0]) return longMatches[0]![0].replace(/\.md$/i, "").trim();
  for (const m of body.matchAll(TASK_ID_SHORT_RE)) {
    return m[0]!.trim();
  }
  return "";
}

const TASK_PARENT_BODY_PATTERNS: RegExp[] = [
  /父任务引用[：:]\s*(?:\*{0,2}\s*)?(TASK-\d{8}-\d{3,})/i,
  /parent\s*task\s*[：:]\s*(?:\*{0,2}\s*)?(TASK-\d{8}-\d{3,})/i,
  /\breferences?\s*[：:=]\s*(TASK-\d{8}-\d{3,})/i,
  /\bparent\s*[：:=]\s*(TASK-\d{8}-\d{3,})/i,
];

const ROOT_TASK_BODY_PATTERNS: RegExp[] = [
  /主任务[：:]\s*`?(TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+)?)`?/i,
  /(?:root|main)\s*task\s*[：:]\s*`?(TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+)?)`?/i,
];

/** Infer parent TASK id from task body when frontmatter parent/references is missing. */
export function inferTaskParentFromBody(
  content: string,
  selfTaskId: string,
): string {
  const fmClose = content.indexOf("\n---", 3);
  const body = fmClose >= 0 ? content.slice(fmClose + 4) : content;
  const selfShort =
    selfTaskId
      .replace(/\.md$/i, "")
      .match(/^TASK-\d{8}-\d{3,}/i)?.[0]
      ?.toUpperCase() ?? "";
  for (const re of TASK_PARENT_BODY_PATTERNS) {
    const m = body.match(re);
    if (m?.[1]) {
      const id = m[1].toUpperCase();
      if (id !== selfShort) return id;
    }
  }
  return "";
}

/** Resolve linked TASK id from report frontmatter (task_id, else first references[]). */
export function resolveReportTaskId(fm: Record<string, unknown>): string {
  const direct = strField(fm, "task_id").replace(/\.md$/i, "").trim();
  if (direct) return direct;
  const references = listField(fm, "references");
  if (references.length) {
    return references[0]!.replace(/\.md$/i, "").trim();
  }
  return "";
}

/** Frontmatter first, then body, then PM-to-ADMIN filename date-seq. */
export function resolveReportTaskIdFromContent(
  fm: Record<string, unknown>,
  content: string,
  filename?: string,
): string {
  const fromFm = resolveReportTaskId(fm);
  if (fromFm) return fromFm;
  const fromBody = inferReportTaskIdFromBody(content);
  if (fromBody) return fromBody;
  if (filename) return inferReportTaskIdFromFilename(filename);
  return "";
}
