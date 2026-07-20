import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { enrichIssueMetadata } from "../issue-enrichment.ts";

function parseFmYaml(raw: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return fm;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
    if (kv) {
      let v = kv[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[kv[1]!] = v;
    }
  }
  return fm;
}

function firstBodyParagraph(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return "";
}

function issueStatusOpen(fm: Record<string, string>): boolean {
  const st = String(fm["status"] ?? "open").trim().toLowerCase();
  return st !== "closed";
}

export function scanMobileIssues(
  issuesDir: string,
  opts: { status?: string; limit: number; projectRoot: string },
): Record<string, unknown>[] {
  if (!issuesDir || !existsSync(issuesDir)) return [];
  const statusFilter = String(opts.status ?? "open").toLowerCase();
  const files = readdirSync(issuesDir)
    .filter((f) => f.startsWith("ISSUE-") && f.endsWith(".md"))
    .sort()
    .reverse();
  const issues: Record<string, unknown>[] = [];
  for (const f of files) {
    if (issues.length >= opts.limit) break;
    try {
      const raw = readFileSync(join(issuesDir, f), "utf-8");
      const fm = parseFmYaml(raw);
      const isOpen = issueStatusOpen(fm);
      if (statusFilter === "open" && !isOpen) continue;
      if (statusFilter === "closed" && isOpen) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      const preview = firstBodyParagraph(body).slice(0, 160);
      const enrichment = enrichIssueMetadata(opts.projectRoot, fm, body);
      issues.push({
        filename: f,
        issue_id: f.match(/^(ISSUE-\d{8}-\d{3})/i)?.[1] ?? f.replace(/\.md$/i, ""),
        ...fm,
        ...enrichment,
        preview,
      });
    } catch {
      /* skip malformed */
    }
  }
  return issues;
}

export function slimMobileIssue(row: Record<string, unknown>): Record<string, unknown> {
  return {
    filename: row.filename,
    issue_id: row.issue_id,
    status: row.status ?? "open",
    severity: row.severity,
    title: row.title ?? row.preview,
    preview: row.preview,
    updated_at: row.updated_at,
  };
}
