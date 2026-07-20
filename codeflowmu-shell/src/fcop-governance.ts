/**
 * FCoP 治理层 vs 团队协作层边界。
 * EVAL / SYSTEM / AUTO-AUDIT 等观测输出不得进入 PM 整合环或团队 reports API。
 *
 * EVAL is an independent observer: outputs OBSERVATION (preferred) or legacy AUDIT-*;
 * not TASK, team REPORT, ISSUE, or lifecycle decisions. EVAL may recommend; ADMIN decides.
 */
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { parseEvalFileMetadata } from "./eval-promotion.js";

/** 不得触发 ReportWatcher → PM 整合 的发件方角色码 */
export const GOVERNANCE_REPORT_SENDERS = new Set(["EVAL", "SYSTEM", "AUTO-AUDIT"]);

/** 团队可见的 fcop/reports 文件名（排除治理层伪装成 REPORT-*-to-PM 的文件） */
export function isTeamVisibleReportFilename(filename: string): boolean {
  if (!filename.endsWith(".md")) return false;
  if (/^REPORT-.*-(EVAL|SYSTEM|AUTO-AUDIT)-to-/i.test(filename)) return false;
  if (/^AUDIT-/i.test(filename)) return false;
  if (/^OBSERVATION-/i.test(filename)) return false;
  return filename.startsWith("REPORT-") || filename.startsWith("MANUAL-");
}

export function isGovernanceReportFilename(filename: string): boolean {
  if (/^AUDIT-/i.test(filename) && filename.endsWith(".md")) return true;
  if (/^OBSERVATION-/i.test(filename) && filename.endsWith(".md")) return true;
  if (/^REPORT-.*-(EVAL|SYSTEM|AUTO-AUDIT)-to-/i.test(filename)) return true;
  return false;
}

export function fcopInternalEvalDir(projectRoot: string): string {
  return join(projectRoot, "fcop", "internal", "eval");
}

export function fcopLegacyEvalReportsDir(projectRoot: string): string {
  return join(projectRoot, "fcop", "reports");
}

export type EvalAuditListItem = {
  filename: string;
  /** 供 /api/v2/files/read 使用的相对路径 */
  rel_path: string;
  source: "internal" | "legacy";
  created_at?: string;
  subject?: string;
  score?: number;
  sender?: string;
  preview?: string;
  /** 文件 mtime（ISO），列表展示用 */
  mtime_at?: string;
  /** frontmatter kind（eval | observation | audit …） */
  kind?: string;
  eval_type?: string;
  promotion_status?: string;
  promotion_action?: string;
  promotion_target_type?: string;
  promotion_target_file?: string;
  promotion_target_repo?: string;
  assets_analyzed?: string;
};

function parseFmYaml(raw: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return fm;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return fm;
}

function scoreFromAuditBody(raw: string): number {
  const m = raw.match(/智能评级[^:：]*[:：]\s*\*?\*?(\d+)/);
  if (m) return Number(m[1]);
  if (/CRITICAL|极高/i.test(raw)) return 95;
  if (/HIGH|高/i.test(raw)) return 85;
  return 75;
}

function filenameDateIso(filename: string): string | undefined {
  const m =
    filename.match(/(?:AUDIT|OBSERVATION|GAP|RISK|GOVERNANCE|EMERGENCE)-(\d{4})(\d{2})(\d{2})/i) ||
    filename.match(/(\d{8})/);
  if (!m) return undefined;
  const ds = m[1]!.length === 8 ? m[1]! : `${m[1]}${m[2]}${m[3]}`;
  if (ds.length !== 8) return undefined;
  return new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8)).toISOString();
}

function itemSortTime(item: EvalAuditListItem): number {
  if (item.created_at) {
    const t = new Date(item.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (item.mtime_at) {
    const t = new Date(item.mtime_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const fromName = filenameDateIso(item.filename);
  if (fromName) return new Date(fromName).getTime();
  return 0;
}

/** ADMIN 面板用：只读 internal/eval 观察记录，不读团队 REPORT。 */
export function listEvalAuditFiles(projectRoot: string, limit = 50): EvalAuditListItem[] {
  const items: EvalAuditListItem[] = [];

  const internalDir = fcopInternalEvalDir(projectRoot);
  if (existsSync(internalDir)) {
    for (const f of readdirSync(internalDir).filter((n) =>
      /^(AUDIT|OBSERVATION|GAP|RISK|GOVERNANCE|EMERGENCE)-.*\.md$/i.test(n),
    )) {
      if (f.startsWith(".")) continue;
      const full = join(internalDir, f);
      let mtimeAt: string | undefined;
      try {
        mtimeAt = statSync(full).mtime.toISOString();
      } catch {
        /* ignore */
      }
      try {
        const raw = readFileSync(full, "utf-8");
        const fm = parseFmYaml(raw);
        const { flat, promotion } = parseEvalFileMetadata(raw);
        const created =
          flat.observed_at ||
          flat.audited_at ||
          flat.created_at ||
          fm.observed_at ||
          fm.audited_at ||
          fm.created_at ||
          mtimeAt ||
          filenameDateIso(f);
        const promoStatus =
          promotion.status || flat.promotion_status || fm.promotion_status || "";
        items.push({
          filename: f,
          rel_path: `fcop/internal/eval/${f}`,
          source: "internal",
          created_at: created,
          mtime_at: mtimeAt,
          subject: flat.subject || fm.subject,
          score: flat.score
            ? Number(flat.score)
            : fm.score
              ? Number(fm.score)
              : scoreFromAuditBody(raw),
          sender: flat.sender || fm.sender || "SYSTEM",
          preview: raw.slice(0, 200).replace(/\n/g, " "),
          kind: flat.kind || fm.kind,
          eval_type: flat.eval_type || fm.eval_type,
          promotion_status: promoStatus,
          promotion_action: promotion.action || flat.promotion_action || "",
          promotion_target_type: promotion.target_type || flat.promotion_target_type || "",
          promotion_target_file: promotion.target_file || flat.promotion_target_file || "",
          promotion_target_repo: promotion.target_repo || flat.promotion_target_repo || "",
          assets_analyzed: flat.assets_analyzed || fm.assets_analyzed,
        });
      } catch {
        items.push({
          filename: f,
          rel_path: `fcop/internal/eval/${f}`,
          source: "internal",
          created_at: mtimeAt || filenameDateIso(f),
          mtime_at: mtimeAt,
        });
      }
    }
  }

  return items.sort((a, b) => itemSortTime(b) - itemSortTime(a)).slice(0, limit);
}
