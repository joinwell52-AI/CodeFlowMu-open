import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter, isReviewPendingHuman } from "@codeflowmu/runtime";

function stripMdBody(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function listMobileApprovals(reviewsDir: string | undefined): Record<string, unknown>[] {
  if (!reviewsDir || !existsSync(reviewsDir)) return [];
  const entries = ["", "approved", "rejected"].flatMap((subdir) => {
    const dir = subdir ? join(reviewsDir, subdir) : reviewsDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f.startsWith("REVIEW-"))
      .map((filename) => ({ filename, dir, subdir }));
  }).sort((a, b) => b.filename.localeCompare(a.filename));
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const f = entry.filename;
    if (seen.has(f)) continue;
    seen.add(f);
    try {
      const raw = readFileSync(join(entry.dir, f), "utf-8");
      const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
      const body = stripMdBody(raw);
      const preview = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(fm)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          flat[k] = String(v);
        }
      }
      const humanApproval = fm.human_approval && typeof fm.human_approval === "object"
        ? fm.human_approval as Record<string, unknown> : {};
      const stats = statSync(join(entry.dir, f));
      const status = entry.subdir === "approved" ? "approved"
        : entry.subdir === "rejected" ? "rejected"
          : isReviewPendingHuman(fm) ? "pending"
            : String(humanApproval.decision ?? fm.decision ?? "exception");
      rows.push({
        filename: f,
        review_id: f.replace(/\.md$/i, ""),
        preview,
        status,
        body,
        frontmatter: fm,
        ...flat,
        created_at: fm.created_at ?? stats.birthtime.toISOString(),
        updated_at: fm.updated_at ?? stats.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
  return rows;
}

export function readMobileApproval(
  reviewsDir: string | undefined,
  filename: string,
): Record<string, unknown> | null {
  if (!reviewsDir || !filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  for (const subdir of ["", "approved", "rejected"]) {
    const filepath = join(reviewsDir, subdir, filename);
    if (!existsSync(filepath)) continue;
    return listMobileApprovals(reviewsDir).find((row) => row.filename === filename) ?? null;
  }
  return null;
}

export async function confirmMobileApproval(
  reviewsDir: string | undefined,
  filename: string,
  body: { decision?: "approve" | "reject"; comment?: string; reason?: string },
  onAck?: (payload: Record<string, unknown>) => void,
): Promise<{ ok: boolean; status?: number; error?: string; [key: string]: unknown }> {
  if (!reviewsDir) {
    return { ok: false, status: 503, error: "REVIEWS_DIR_NOT_CONFIGURED" };
  }
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { ok: false, status: 400, error: "INVALID_FILENAME" };
  }
  const filepath = join(reviewsDir, filename);
  if (!existsSync(filepath)) {
    return { ok: false, status: 404, error: "REVIEW_NOT_FOUND" };
  }
  const raw = readFileSync(filepath, "utf-8");
  const fm = parseMarkdownFrontmatter(raw) as Record<string, unknown>;
  if (!isReviewPendingHuman(fm)) {
    return { ok: false, status: 409, error: "REVIEW_NOT_PENDING" };
  }
  const decision = body.decision === "reject" ? "reject" : "approve";
  const reason = String(body.reason ?? body.comment ?? "").trim();
  if (decision === "reject" && !reason) {
    return { ok: false, status: 400, error: "REJECT_REASON_REQUIRED" };
  }
  const now = new Date().toISOString();
  const comment = reason.replace(/'/g, "''");
  const haBlock = `human_approval:\n  approver: ADMIN\n  decision: ${decision}\n  approved_at: '${now}'\n  channel: mobile\n  comment: '${comment}'`;
  let updated: string;
  if (raw.includes("human_approval:")) {
    updated = raw.replace(/human_approval:[\s\S]*?(?=\n\w|\n---)/m, `${haBlock}\n`);
  } else {
    updated = raw.replace(/^(---\n[\s\S]*?)(---)/m, `$1${haBlock}\n$2`);
  }
  writeFileSync(filepath, updated, "utf-8");
  const destination = join(reviewsDir, decision === "approve" ? "approved" : "rejected");
  mkdirSync(destination, { recursive: true });
  renameSync(filepath, join(destination, filename));
  onAck?.({ filename, decision, approved_at: now });
  return { ok: true, filename, decision, approved_at: now };
}
