/**
 * ADMIN ↔ PM formal chat history — TASK (ADMIN-to-PM) + REPORT (PM-to-ADMIN)
 * across v3 lifecycle stages and fcop/reports/.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter, strField } from "@codeflowmu/runtime";

import { fcopV3Paths, fcopV3TaskSearchDirs } from "./fcop-v3-paths.ts";

export type FormalChatAttachment = {
  type?: "image" | "file";
  url?: string;
  local_path?: string;
  absolute_path?: string;
  mime?: string;
  original_name?: string;
  size?: number;
};

export type FormalChatHistoryEntry = {
  role: "admin" | "pm";
  filename: string;
  seq: number;
  sortKey: number;
  ts?: number;
  text: string;
  priority?: string;
  task_id?: string;
  attachments?: FormalChatAttachment[];
};

const ADMIN_TASK_RE = /^TASK-.*-ADMIN-to-PM.*\.md$/i;
const PM_REPORT_RE = /^REPORT-.*-PM-to-ADMIN.*\.md$/i;

export function stripMarkdownFrontmatter(raw: string): string {
  const m = raw.match(/^---[\s\S]*?---\n([\s\S]*)$/);
  return (m ? m[1]! : raw).trim();
}

export function parseFormalFilenameSortKey(fn: string): number {
  const m = fn.match(/(\d{8})-(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 1000 + Number(m[2]);
}

export function parseFormalFilenameSeq(fn: string): number {
  const m = fn.match(/\d{8}-(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseAttachmentsFromFm(fm: Record<string, unknown>): FormalChatAttachment[] {
  const raw = fm["attachments"];
  if (!Array.isArray(raw)) return [];
  const out: FormalChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    const localPath =
      typeof rec.local_path === "string" ? rec.local_path.trim() : "";
    const absolutePath =
      typeof rec.absolute_path === "string" ? rec.absolute_path.trim() : "";
    if (!url && !localPath && !absolutePath) continue;
    const typeRaw = String(rec.type ?? "").toLowerCase();
    const type =
      typeRaw === "file" ? "file" : typeRaw === "image" ? "image" : undefined;
    const mime = typeof rec.mime === "string" ? rec.mime.trim() : "";
    const inferredType: "image" | "file" | undefined =
      type ??
      (/^image\//i.test(mime) ||
      /\.(png|jpe?g|webp|gif)$/i.test(localPath || url || absolutePath)
        ? "image"
        : "file");
    out.push({
      type: inferredType,
      ...(url ? { url } : {}),
      ...(localPath ? { local_path: localPath } : {}),
      ...(absolutePath ? { absolute_path: absolutePath } : {}),
      ...(mime ? { mime } : {}),
      ...(typeof rec.original_name === "string"
        ? { original_name: rec.original_name.trim() }
        : {}),
      ...(typeof rec.size === "number" ? { size: rec.size } : {}),
    });
  }
  return out;
}

function parseIsoMs(value: string): number | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function entryFromFile(
  role: "admin" | "pm",
  filename: string,
  raw: string,
): FormalChatHistoryEntry {
  const fm = parseMarkdownFrontmatter(raw);
  const priority = strField(fm, "priority") || undefined;
  const taskId = strField(fm, "task_id") || undefined;
  const ts =
    parseIsoMs(strField(fm, "created_at")) ??
    parseIsoMs(strField(fm, "updated_at")) ??
    undefined;
  return {
    role,
    filename,
    seq: parseFormalFilenameSeq(filename),
    sortKey: parseFormalFilenameSortKey(filename),
    ...(ts !== undefined ? { ts } : {}),
    text: stripMarkdownFrontmatter(raw),
    ...(priority ? { priority } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    attachments: parseAttachmentsFromFm(fm),
  };
}

function listMatchingFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

/** Collect merged formal chat entries from lifecycle TASK dirs + fcop/reports. */
export function collectFormalChatHistory(
  projectRoot: string,
  limit = 60,
): FormalChatHistoryEntry[] {
  const v3 = fcopV3Paths(projectRoot);
  const byFilename = new Map<string, FormalChatHistoryEntry>();

  for (const dir of fcopV3TaskSearchDirs(v3)) {
    for (const fn of listMatchingFiles(dir, ADMIN_TASK_RE)) {
      if (byFilename.has(fn)) continue;
      try {
        const raw = readFileSync(join(dir, fn), "utf-8");
        byFilename.set(fn, entryFromFile("admin", fn, raw));
      } catch {
        /* skip unreadable */
      }
    }
  }

  for (const fn of listMatchingFiles(v3.reports, PM_REPORT_RE)) {
    if (byFilename.has(fn)) continue;
    try {
      const raw = readFileSync(join(v3.reports, fn), "utf-8");
      byFilename.set(fn, entryFromFile("pm", fn, raw));
    } catch {
      /* skip unreadable */
    }
  }

  const sorted = [...byFilename.values()].sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.filename.localeCompare(b.filename);
  });

  const cap = Math.min(Math.max(limit, 1), 200);
  return sorted.slice(-cap);
}
