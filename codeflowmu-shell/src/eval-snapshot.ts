import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  listEvalAuditFiles,
  type EvalAuditListItem,
} from "./fcop-governance.ts";

type Priority = "P0" | "P1" | "P2" | "P3";

export type EvalFindingSnapshot = {
  id: string;
  priority: Priority;
  message: string;
  root_key: string;
};

export type EvalReportSnapshot = EvalAuditListItem & {
  findings: EvalFindingSnapshot[];
  scan: {
    files_checked: number;
    assets_checked: number;
    completed: boolean;
    parse_failures: number;
  };
  score_detail: {
    value: number | null;
    status: "scored" | "insufficient_evidence";
    formula_version: "eval-v2.0";
  };
  review: { status: string; reviewed_by: string | null };
};

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function priority(token: string): Priority {
  const value = token.toUpperCase();
  if (value === "P0" || value === "CRITICAL") return "P0";
  if (value === "P1" || value === "HIGH") return "P1";
  if (value === "P2" || value === "MEDIUM") return "P2";
  return "P3";
}

function rootKey(message: string, index: number): string {
  return (
    message.match(/(?:root-fault-[a-f0-9]+|TASK-\d{8}-\d{3,})/i)?.[0].toUpperCase() ??
    `legacy-${index}-${message.replace(/\W+/g, "-").slice(0, 48).toLowerCase()}`
  );
}

function parseFindings(
  fm: Record<string, unknown>,
  raw: string,
): EvalFindingSnapshot[] {
  const node =
    fm.findings && typeof fm.findings === "object" && !Array.isArray(fm.findings)
      ? (fm.findings as Record<string, unknown>)
      : {};
  const structured = Array.isArray(node.items)
    ? (node.items as Array<Record<string, unknown>>).map((item, index) => ({
        id: String(item.id ?? `finding-${index + 1}`),
        priority: priority(String(item.priority ?? "P3")),
        message: String(item.message ?? "").trim(),
        root_key: String(
          item.root_key ?? rootKey(String(item.message ?? ""), index),
        ),
      }))
    : [];
  const legacy = [
    ...raw.matchAll(
      /^\s*[-*]\s+(?:\*\*)?(P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)(?:\*\*)?\s*[:：-]\s*(.+)$/gim,
    ),
  ].map((match, index) => ({
    id: `legacy-${index + 1}`,
    priority: priority(match[1] ?? "P3"),
    message: String(match[2] ?? "").trim(),
    root_key: rootKey(String(match[2] ?? ""), index),
  }));
  const deduped = new Map<string, EvalFindingSnapshot>();
  for (const finding of [...structured, ...legacy]) {
    if (finding.message && !deduped.has(finding.root_key)) {
      deduped.set(finding.root_key, finding);
    }
  }
  return [...deduped.values()];
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateScore(
  findings: EvalFindingSnapshot[],
  scan: EvalReportSnapshot["scan"],
): EvalReportSnapshot["score_detail"] {
  if (!scan.completed || scan.files_checked <= 0 || scan.assets_checked <= 0) {
    return {
      value: null,
      status: "insufficient_evidence",
      formula_version: "eval-v2.0",
    };
  }
  const penalty: Record<Priority, number> = { P0: 30, P1: 15, P2: 6, P3: 2 };
  const value = Math.max(
    0,
    100 -
      findings.reduce((sum, finding) => sum + penalty[finding.priority], 0) -
      scan.parse_failures * 5,
  );
  return { value, status: "scored", formula_version: "eval-v2.0" };
}

function readReport(projectRoot: string, item: EvalAuditListItem): EvalReportSnapshot {
  const full = join(projectRoot, ...item.rel_path.split("/"));
  const raw = existsSync(full) ? readFileSync(full, "utf-8") : "";
  const fm = parseFrontmatter(raw);
  const scanNode =
    fm.scan && typeof fm.scan === "object"
      ? (fm.scan as Record<string, unknown>)
      : {};
  const scan = {
    files_checked: numberValue(scanNode.files_checked),
    assets_checked: numberValue(scanNode.assets_checked),
    completed: scanNode.completed === true,
    parse_failures: numberValue(scanNode.parse_failures),
  };
  const findings = parseFindings(fm, raw);
  const scoreDetail = calculateScore(findings, scan);
  const reviewNode =
    fm.review && typeof fm.review === "object"
      ? (fm.review as Record<string, unknown>)
      : {};
  return {
    ...item,
    score: scoreDetail.value,
    findings,
    scan,
    score_detail: scoreDetail,
    review: {
      status: String(reviewNode.status ?? "draft"),
      reviewed_by: reviewNode.reviewed_by
        ? String(reviewNode.reviewed_by)
        : null,
    },
  };
}

export function buildEvalUnifiedSnapshot(projectRoot: string, limit = 200) {
  const reports = listEvalAuditFiles(projectRoot, limit).map((item) =>
    readReport(projectRoot, item),
  );
  const latest = reports[0] ?? null;
  const byDate = new Map<string, EvalReportSnapshot[]>();
  for (const report of reports) {
    const timestamp = report.created_at || report.mtime_at;
    if (!timestamp) continue;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), report]);
  }
  const history = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rows]) => {
      const report = rows[0]!;
      return {
        date,
        score: report.score_detail.value,
        score_status: report.score_detail.status,
        violations: report.findings.length,
        files_checked: report.scan.files_checked,
        filename: report.filename,
        rel_path: report.rel_path,
      };
    });
  return {
    generated_at: new Date().toISOString(),
    reports,
    summary: {
      ok: true,
      last_run: latest?.created_at ?? latest?.mtime_at ?? null,
      files_checked: latest?.scan.files_checked ?? 0,
      violations_count: latest?.findings.length ?? 0,
      violations: latest?.findings ?? [],
      score: latest?.score_detail.value ?? null,
      score_status: latest?.score_detail.status ?? "insufficient_evidence",
      formula_version: "eval-v2.0",
      review: latest?.review ?? { status: "draft", reviewed_by: null },
    },
    history,
  };
}
