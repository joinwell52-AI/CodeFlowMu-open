/**
 * Load fcop/adopted/*.md and fcop/adopted/pending/*.md clauses with
 * runtime_effective: true into Agent primer / recycle context (not formal FCoP spec).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** API / 文档用 POSIX 路径（勿用 path.join，Windows 会变成反斜杠）。 */
const ADOPTED_DIR_REL = "fcop/adopted";
const PENDING_DIR_REL = "fcop/adopted/pending";

function adoptedAbsDir(projectRoot: string): string {
  return join(projectRoot, "fcop", "adopted");
}

function pendingAbsDir(projectRoot: string): string {
  return join(adoptedAbsDir(projectRoot), "pending");
}

export interface AdoptedPendingClause {
  id: string;
  title: string;
  filename: string;
  relativePath: string;
  status: string | null;
  runtimeEffective: boolean;
  currentProtocol: string | null;
  targetVersion: string | null;
  updatedAt: string | null;
  /** 正文（自首个 `#` 标题起） */
  bodyMarkdown: string;
  /** `## …最终规则` 小节（若存在） */
  finalRulesMarkdown: string | null;
}

export interface AdoptedPendingReport {
  dir: string;
  intro: string;
  clauses: AdoptedPendingClause[];
  runtimeEffectiveCount: number;
}

function fmValue(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.replace(/^["']|["']$/g, "").trim();
}

function runtimeEffective(raw: string): boolean {
  return /^runtime_effective:\s*true\s*$/m.test(raw);
}

function bodyFromRaw(raw: string): string {
  const hash = raw.indexOf("\n# ");
  return hash >= 0 ? raw.slice(hash).trimEnd() : raw.trimEnd();
}

/** 提取 `## …最终规则` 至下一同级 `##` 或 EOF。 */
export function extractFinalRulesSection(body: string): string | null {
  const headerRe = /^##\s+[^\n]*最终规则[^\n]*$/m;
  const match = headerRe.exec(body);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const afterHeader = start + match[0].length;
  const rest = body.slice(afterHeader);
  const nextIdx = rest.search(/^##\s+/m);
  const end = nextIdx >= 0 ? afterHeader + nextIdx : body.length;
  return body.slice(start, end).trim() || null;
}

function parseClauseFile(absPath: string, relativePath: string, filename: string): AdoptedPendingClause | null {
  try {
    const raw = readFileSync(absPath, "utf-8");
    const body = bodyFromRaw(raw);
    return {
      id: fmValue(raw, "id") ?? filename.replace(/\.md$/, ""),
      title: fmValue(raw, "title") ?? filename,
      filename,
      relativePath,
      status: fmValue(raw, "status") ?? null,
      runtimeEffective: runtimeEffective(raw),
      currentProtocol: fmValue(raw, "current_protocol") ?? null,
      targetVersion: fmValue(raw, "target_version") ?? null,
      updatedAt: fmValue(raw, "updated_at") ?? null,
      bodyMarkdown: body,
      finalRulesMarkdown: extractFinalRulesSection(body),
    };
  } catch {
    return null;
  }
}

function listAdoptedRootClauses(projectRoot: string): AdoptedPendingClause[] {
  const absDir = adoptedAbsDir(projectRoot);
  if (!existsSync(absDir)) return [];

  return readdirSync(absDir)
    .filter((name) => {
      if (!name.endsWith(".md") || name === "README.md") return false;
      try {
        return statSync(join(absDir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) =>
      parseClauseFile(join(absDir, name), `${ADOPTED_DIR_REL}/${name}`, name),
    )
    .filter((c): c is AdoptedPendingClause => c !== null);
}

function listPendingClauses(projectRoot: string): AdoptedPendingClause[] {
  const absDir = pendingAbsDir(projectRoot);
  if (!existsSync(absDir)) return [];

  return readdirSync(absDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((name) =>
      parseClauseFile(join(absDir, name), `${PENDING_DIR_REL}/${name}`, name),
    )
    .filter((c): c is AdoptedPendingClause => c !== null);
}

/** 供 Desktop / health API：列出 adopted 根目录 + pending 条款全文与摘要。 */
export function loadAdoptedPendingReport(projectRoot: string): AdoptedPendingReport {
  const dir = ADOPTED_DIR_REL;
  const intro =
    "已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版（含 fcop/adopted/ 与 fcop/adopted/pending/）。" +
    "Agent / PM 须遵守；不随 redeploy_rules() 覆盖；正式 bundled 版本号不变。";

  const clauses = [...listAdoptedRootClauses(projectRoot), ...listPendingClauses(projectRoot)].sort(
    (a, b) => a.filename.localeCompare(b.filename),
  );

  return {
    dir,
    intro,
    clauses,
    runtimeEffectiveCount: clauses.filter((c) => c.runtimeEffective).length,
  };
}

function clauseSummaryBlock(clause: AdoptedPendingClause, maxBodyChars: number): string {
  if (clause.finalRulesMarkdown) {
    return `\n--- ${clause.id}: ${clause.title} (${clause.relativePath}) · 最终规则 ---\n${clause.finalRulesMarkdown}\n`;
  }
  const slice = clause.bodyMarkdown.slice(0, Math.min(maxBodyChars, clause.bodyMarkdown.length));
  return `\n--- ${clause.id}: ${clause.title} (${clause.relativePath}) ---\n${slice}\n`;
}

/** Summarize adopted + pending clauses for Agent prompt injection. */
export function loadRuntimeEffectivePendingSummary(
  projectRoot: string,
  maxChars = 4500,
): string {
  const report = loadAdoptedPendingReport(projectRoot);
  if (!report.clauses.length) return "";

  const intro =
    "以下 fcop/adopted/ 与 fcop/adopted/pending/ 内容为已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版的补充条款；" +
    "Agent 必须遵守。正式 FCoP bundled 规则版本号不变；是否并入正式版（如 3.2.6）由 ADMIN 决定。" +
    "条款可能被修改、合并或撤回。有「最终规则」小节时优先注入该节。\n";

  const chunks: string[] = [intro];
  let used = intro.length;

  for (const clause of report.clauses) {
    if (!clause.runtimeEffective) continue;

    const block = clauseSummaryBlock(clause, 1800);

    if (used + block.length > maxChars) {
      chunks.push(`\n（完整条文见 ${clause.relativePath}）\n`);
      break;
    }
    chunks.push(block);
    used += block.length;
  }

  return chunks.length > 1 ? chunks.join("") : "";
}

/** Wake / recycle primer 用：带标题的 adopted + pending 运行时生效块。 */
export function formatAdoptedRuntimeEffectiveWakeSection(projectRoot: string): string {
  try {
    const pendingBlock = loadRuntimeEffectivePendingSummary(projectRoot);
    if (!pendingBlock) return "";
    return (
      `## adopted · 已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版\n${pendingBlock}\n\n`
    );
  } catch {
    return "";
  }
}
