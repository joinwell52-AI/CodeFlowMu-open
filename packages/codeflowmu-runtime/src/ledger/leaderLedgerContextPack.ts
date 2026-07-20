import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { isLeaderRoleAgentId } from "../skill/FcopToolProfile.ts";
import { listField } from "./frontmatter.ts";
import { resolveLedgerLayout } from "./paths.ts";

const MAX_VIEW_CHARS = 12_000;
const MAX_ENVELOPE_CHARS = 10_000;
const MAX_JOURNAL_LINES = 12;
const MAX_RELATED_ENVELOPES = 4;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…(truncated, ${text.length - max} chars omitted)`;
}

async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

async function findEnvelopeFile(
  projectRoot: string,
  id: string,
): Promise<string | null> {
  const norm = id.replace(/\.md$/i, "").trim();
  if (!norm) return null;
  const upper = norm.toUpperCase();
  const layout = resolveLedgerLayout(projectRoot);
  const dirs: string[] = [];

  if (upper.startsWith("TASK-")) {
    for (const stage of ["inbox", "active", "review", "done", "archive"] as const) {
      dirs.push(join(layout.lifecycleRoot, stage));
    }
    dirs.push(layout.tasksDir);
  } else if (upper.startsWith("REPORT-")) {
    dirs.push(layout.reportsDir);
    for (const stage of ["review", "done", "archive"] as const) {
      dirs.push(join(layout.lifecycleRoot, stage));
    }
  } else if (upper.startsWith("ISSUE-")) {
    dirs.push(layout.issuesDir);
  } else {
    return null;
  }

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const hit = entries.find((name) => {
      const stem = name.replace(/\.md$/i, "");
      return stem === norm || stem.startsWith(`${norm}-`) || name.startsWith(norm);
    });
    if (hit) return join(dir, hit);
  }
  return null;
}

async function loadEnvelopeSection(
  projectRoot: string,
  envelopeId: string,
): Promise<string | null> {
  const path = await findEnvelopeFile(projectRoot, envelopeId);
  if (!path) return null;
  const raw = await readTextIfExists(path);
  if (!raw) return null;
  const rel = path.replace(/\\/g, "/").split("/").slice(-3).join("/");
  return `### ${basename(path)}\n(path: \`${rel}\`)\n\n${truncate(raw, MAX_ENVELOPE_CHARS)}`;
}

async function loadRoleTodoView(projectRoot: string, role: string): Promise<string | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const viewPath = join(layout.ledgerDir, "views", `${role.toUpperCase()}.todo.md`);
  const raw = await readTextIfExists(viewPath);
  if (!raw) return null;
  return truncate(raw, MAX_VIEW_CHARS);
}

async function loadRecentJournal(
  projectRoot: string,
  threadKey: string | undefined,
  taskId: string,
): Promise<string | null> {
  const layout = resolveLedgerLayout(projectRoot);
  const journalPath = join(layout.ledgerDir, "journal.jsonl");
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean);
  const tail = lines.slice(-80);
  const needleThread = threadKey?.trim();
  const needleTask = taskId.replace(/\.md$/i, "").trim();
  const matched = tail.filter((line) => {
    if (needleThread && line.includes(needleThread)) return true;
    if (needleTask && line.includes(needleTask)) return true;
    return false;
  });
  const pick = (matched.length > 0 ? matched : tail.slice(-MAX_JOURNAL_LINES)).slice(
    -MAX_JOURNAL_LINES,
  );
  if (pick.length === 0) return null;
  return pick.join("\n");
}

export type LeaderContextPackInput = {
  projectRoot: string;
  agentId: string;
  role: string;
  taskId: string;
  threadKey?: string;
  frontmatter?: Record<string, unknown>;
};

/**
 * Pre-inject ledger context for PM/leader on Gemini long-context sessions.
 * Current TASK body is already in payload; this adds todo view, related envelopes, journal.
 */
export async function buildLeaderLedgerContextPack(
  input: LeaderContextPackInput,
): Promise<string | null> {
  const roleCode = input.role.trim().toUpperCase();
  if (!isLeaderRoleAgentId(input.agentId) && !isLeaderRoleAgentId(roleCode)) {
    return null;
  }

  const sections: string[] = [];
  const todo = await loadRoleTodoView(input.projectRoot, roleCode);
  if (todo) {
    sections.push(`## Ledger view · ${roleCode} todo\n\n${todo}`);
  }

  const fm = input.frontmatter ?? {};
  const relatedIds = [
    ...listField(fm, "related"),
    ...listField(fm, "parent"),
  ].filter((id) => id.replace(/\.md$/i, "") !== input.taskId.replace(/\.md$/i, ""));

  const seen = new Set<string>();
  const envelopeBlocks: string[] = [];
  for (const id of relatedIds) {
    const key = id.replace(/\.md$/i, "").toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const block = await loadEnvelopeSection(input.projectRoot, id);
    if (block) envelopeBlocks.push(block);
    if (envelopeBlocks.length >= MAX_RELATED_ENVELOPES) break;
  }
  if (envelopeBlocks.length > 0) {
    sections.push(
      `## Related FCoP envelopes (pre-loaded)\n\nUse \`read_task\` / \`read_report\` / \`list_issues\` for other ledger docs not listed here.\n\n${envelopeBlocks.join("\n\n")}`,
    );
  }

  const journal = await loadRecentJournal(
    input.projectRoot,
    input.threadKey ?? (typeof fm.thread_key === "string" ? fm.thread_key : undefined),
    input.taskId,
  );
  if (journal) {
    sections.push(`## Recent ledger journal (thread/task)\n\n\`\`\`\n${journal}\n\`\`\``);
  }

  if (sections.length === 0) return null;
  return `## Runtime ledger context pack (PM/leader)\n\n${sections.join("\n\n")}`;
}

/** Strip YAML frontmatter for inline issue/report snippets when loading by path. */
export function bodyAfterFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content;
  return content.slice(end + 4).trimStart();
}
