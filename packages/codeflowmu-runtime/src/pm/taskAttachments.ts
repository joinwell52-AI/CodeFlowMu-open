/**
 * TASK / REPORT attachment refs — frontmatter → prompt + session images.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";
import type { SessionSdkImage } from "../registry/AgentSdkAdapter.ts";

export interface TaskAttachmentRef {
  type?: "image" | "file";
  url?: string;
  local_path?: string;
  absolute_path?: string;
  mime?: string;
  original_name?: string;
  size?: number;
  sha256?: string;
}

const IMAGE_MIME_RE = /^image\//i;

export function isImageAttachment(a: TaskAttachmentRef): boolean {
  if (a.type === "image") return true;
  if (a.type === "file") return false;
  const mime = String(a.mime ?? "");
  if (IMAGE_MIME_RE.test(mime)) return true;
  const name = String(a.original_name ?? a.local_path ?? "").toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(name);
}

export function normalizeAttachmentLocalPath(localPath: string): string {
  return localPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function resolveAttachmentAbsPath(
  projectRoot: string,
  localPath: string,
): string | null {
  const rel = normalizeAttachmentLocalPath(localPath);
  if (!rel) return null;
  const root = pathResolve(projectRoot);
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith("/")) {
    const abs = pathResolve(rel.replace(/\//g, "\\"));
    if (abs.startsWith(root + join("", "")) || abs === root) return abs;
    if (abs.toLowerCase().startsWith(root.toLowerCase())) return abs;
    return null;
  }
  if (rel.startsWith("fcop/")) return join(root, rel);
  if (rel.startsWith("attachments/")) return join(root, "fcop", rel);
  return null;
}

function parseFrontmatterBlock(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m?.[1]) return {};
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!kv?.[1] || !kv[2]) continue;
    fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

function findTaskFilePathSync(
  projectRoot: string,
  taskIdPrefix: string,
): string | null {
  const stem = taskIdPrefix.replace(/\.md$/i, "").trim().toUpperCase();
  if (!stem) return null;
  for (const stage of ["inbox", "active", "review", "done", "archive"] as const) {
    const dir = join(projectRoot, "fcop", "_lifecycle", stage);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const upper = name.toUpperCase();
        if (upper === `${stem}.MD` || upper.startsWith(`${stem}-`)) {
          return join(dir, name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function loadAttachmentsFromTaskFile(
  projectRoot: string,
  taskIdPrefix: string,
): Promise<TaskAttachmentRef[]> {
  const filePath = findTaskFilePathSync(projectRoot, taskIdPrefix);
  if (!filePath) return [];
  try {
    const raw = await readFile(filePath, "utf-8");
    return parseAttachmentsFromFrontmatter(parseFrontmatterBlock(raw));
  } catch {
    return [];
  }
}

/** Current task attachments + inherited ADMIN mainline attachments for PM branches. */
export async function resolveTaskAttachmentsForDispatch(
  projectRoot: string,
  frontmatter: Record<string, unknown>,
  filename: string,
): Promise<TaskAttachmentRef[]> {
  const own = parseAttachmentsFromFrontmatter(frontmatter);
  const parentId = parentTaskIdFromFrontmatter(frontmatter);
  if (!parentId) return own;
  const parentAtt = await loadAttachmentsFromTaskFile(projectRoot, parentId);
  return mergeAttachmentLists(parentAtt, own);
}

export function parseAttachmentsFromFrontmatter(
  fm: Record<string, unknown>,
): TaskAttachmentRef[] {
  const raw = fm["attachments"];
  if (!Array.isArray(raw)) return [];
  const out: TaskAttachmentRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const localPath =
      typeof rec.local_path === "string" ? rec.local_path.trim() : "";
    const absolutePath =
      typeof rec.absolute_path === "string" ? rec.absolute_path.trim() : "";
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!localPath && !absolutePath && !url) continue;
    const typeRaw = String(rec.type ?? "").toLowerCase();
    const type =
      typeRaw === "file" ? "file" : typeRaw === "image" ? "image" : undefined;
    out.push({
      ...(type ? { type } : {}),
      ...(url ? { url } : {}),
      ...(localPath ? { local_path: localPath } : {}),
      ...(absolutePath ? { absolute_path: absolutePath } : {}),
      ...(typeof rec.mime === "string" ? { mime: rec.mime.trim() } : {}),
      ...(typeof rec.original_name === "string"
        ? { original_name: rec.original_name.trim() }
        : {}),
      ...(typeof rec.size === "number" ? { size: rec.size } : {}),
      ...(typeof rec.sha256 === "string"
        ? { sha256: rec.sha256.trim() }
        : {}),
    });
  }
  return out;
}

export function mergeAttachmentLists(
  ...lists: TaskAttachmentRef[][]
): TaskAttachmentRef[] {
  const seen = new Set<string>();
  const out: TaskAttachmentRef[] = [];
  for (const list of lists) {
    for (const a of list) {
      const key =
        a.local_path?.trim() ||
        a.absolute_path?.trim() ||
        a.url?.trim() ||
        "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

export function formatTaskAttachmentPromptBlock(
  attachments: TaskAttachmentRef[] = [],
): string {
  if (!attachments.length) return "";
  const lines = [
    "本 TASK 含附件（frontmatter attachments[]；图片已通过多模态 inline 发送）：",
  ];
  for (const a of attachments) {
    const parts: string[] = [];
    if (a.original_name) parts.push(`原名 ${a.original_name}`);
    if (a.local_path) parts.push(`相对路径 ${a.local_path}`);
    if (a.absolute_path) parts.push(`绝对路径 ${a.absolute_path}`);
    if (a.url) parts.push(`URL ${a.url}`);
    const meta: string[] = [];
    if (a.mime) meta.push(a.mime);
    if (a.size != null) meta.push(`${a.size} bytes`);
    if (a.sha256) meta.push(`sha256 ${a.sha256.slice(0, 16)}…`);
    const suffix = meta.length ? ` (${meta.join(", ")})` : "";
    const kind = isImageAttachment(a) ? "image" : "file";
    lines.push(`- [${kind}] ${parts.join(" | ")}${suffix}`);
  }
  return lines.join("\n");
}

function guessImageMime(filePath: string, fallback?: string): string {
  const mime = fallback?.trim();
  if (mime?.startsWith("image/")) return mime;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return mime || "application/octet-stream";
}

export async function buildSessionImagesFromTaskAttachments(
  projectRoot: string,
  attachments: TaskAttachmentRef[],
): Promise<SessionSdkImage[]> {
  const images: SessionSdkImage[] = [];
  for (const a of attachments) {
    if (!isImageAttachment(a)) continue;
    if (a.url && /^https?:\/\//i.test(a.url)) {
      images.push({ url: a.url });
      continue;
    }
    const abs =
      a.absolute_path?.trim() ||
      (a.local_path
        ? resolveAttachmentAbsPath(projectRoot, a.local_path)
        : null);
    if (!abs || !existsSync(abs)) continue;
    try {
      const buf = await readFile(abs);
      images.push({
        data: buf.toString("base64"),
        mimeType: guessImageMime(abs, a.mime),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return images;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function taskIdFromFilename(fn: string): string {
  const m = String(fn).match(/^(TASK-\d{8}-\d{3,})/i);
  return m ? m[1]! : "";
}

export function parentTaskIdFromFrontmatter(
  fm: Record<string, unknown>,
): string {
  for (const key of ["parent", "references", "source_task"]) {
    const raw = String(fm[key] ?? "");
    const m = raw.match(/TASK-\d{8}-\d{3,}/);
    if (m?.[0]) return m[0];
  }
  return "";
}
