/**
 * 从 Agent 运行时 sdk.tool_call（读文件等）推断 Playbook skill 调用并写入账本。
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  agentSkillsManifestProjectionPath,
  agentSkillsManifestSourcePath,
} from "../skills/AgentPlaybookManifest.ts";
import {
  recordSkillInvocation,
  type SkillInvocationChannel,
} from "./SkillInvocationJournal.ts";

const SKILL_PACKAGE_RE =
  /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
const PLAYBOOK_DOC_RE =
  /(?:^|[\\/])docs[\\/]skills[\\/][^\\/]+[\\/][^\\/]+\.md$/i;

export type PlaybookPathIndex = Map<string, string>;

function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/** 从 manifest 各 *\_skills 组构建 skill_package / doc / 默认包路径 → skill_id。 */
export function buildPlaybookPathIndex(
  manifest: Record<string, unknown>,
): PlaybookPathIndex {
  const index: PlaybookPathIndex = new Map();
  for (const [key, val] of Object.entries(manifest)) {
    if (key === "layers" || key === "version" || key === "kind" || key === "scope") {
      continue;
    }
    if (!Array.isArray(val)) continue;
    for (const raw of val) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const id = String(entry["id"] ?? "").trim();
      if (!id) continue;
      const pkg = entry["skill_package"];
      if (typeof pkg === "string" && pkg.trim()) {
        index.set(normalizePathKey(pkg.trim()), id);
      }
      const doc = entry["doc"];
      if (typeof doc === "string" && doc.trim()) {
        index.set(normalizePathKey(doc.trim()), id);
      }
      index.set(normalizePathKey(`skills/${id}/SKILL.md`), id);
    }
  }
  return index;
}

/** manifest 各 skill 组 → skill_id → display_name */
export function buildSkillDisplayNameMap(
  manifest: Record<string, unknown>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, val] of Object.entries(manifest)) {
    if (key === "layers" || key === "version" || key === "kind" || key === "scope") {
      continue;
    }
    if (!Array.isArray(val)) continue;
    for (const raw of val) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const id = String(entry["id"] ?? "").trim();
      if (!id) continue;
      const name = String(entry["display_name"] ?? "").trim();
      map.set(id, name || id);
    }
  }
  return map;
}

function skillIdFromPathString(pathStr: string): string | null {
  const norm = normalizePathKey(pathStr);
  const m = norm.match(SKILL_PACKAGE_RE);
  if (m?.[1]) return m[1].toLowerCase();
  return null;
}

export function resolveSkillIdFromFilePath(
  filePath: string,
  projectRoot: string,
  index: PlaybookPathIndex,
): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;

  let rel = trimmed;
  try {
    if (isAbsolute(trimmed)) {
      rel = relative(resolve(projectRoot), resolve(trimmed));
    }
  } catch {
    rel = trimmed;
  }
  const key = normalizePathKey(rel);
  const fromIndex = index.get(key);
  if (fromIndex) return fromIndex;

  const direct = skillIdFromPathString(key);
  if (direct) return direct;

  if (PLAYBOOK_DOC_RE.test(key)) {
    for (const [docKey, skillId] of index) {
      if (docKey === key) return skillId;
    }
  }
  return null;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (value.length > 2 && (value.includes("/") || value.includes("\\"))) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, depth + 1);
    }
  }
}

/** 从 sdk.tool_call 的 payload（含 raw）提取可能指向 Playbook 的文件路径。 */
export function extractPathsFromToolCallPayload(
  payload: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  const raw = payload["raw"];
  if (raw && typeof raw === "object") {
    collectStrings(raw, paths);
  }
  collectStrings(payload, paths);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paths) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (
      /\.md$/i.test(t) ||
      /skills[\\/]/i.test(t) ||
      /docs[\\/]skills[\\/]/i.test(t)
    ) {
      unique.push(t);
    }
  }
  return unique;
}

let manifestIndexCache: {
  projectRoot: string;
  mtimeKey: string;
  index: PlaybookPathIndex;
  displayNames: Map<string, string>;
} | null = null;

async function loadPlaybookPathIndex(
  projectRoot: string,
): Promise<PlaybookPathIndex> {
  const candidates = [
    agentSkillsManifestProjectionPath(projectRoot),
    agentSkillsManifestSourcePath(projectRoot),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const index = buildPlaybookPathIndex(data);
      manifestIndexCache = {
        projectRoot,
        mtimeKey: path,
        index,
        displayNames: buildSkillDisplayNameMap(data),
      };
      return index;
    } catch {
      /* try next */
    }
  }
  manifestIndexCache = {
    projectRoot,
    mtimeKey: "",
    index: buildPlaybookPathIndex({}),
    displayNames: new Map(),
  };
  return manifestIndexCache.index;
}

function displayNameForSkillId(skillId: string): string | undefined {
  const name = manifestIndexCache?.displayNames.get(skillId);
  if (!name || name === skillId) return undefined;
  return name;
}

const recentPlaybookReads = new Map<string, number>();
const DEDUPE_MS = 120_000;

function shouldRecord(sessionId: string, skillId: string): boolean {
  const key = `${sessionId}:${skillId}`;
  const now = Date.now();
  const prev = recentPlaybookReads.get(key);
  if (prev != null && now - prev < DEDUPE_MS) return false;
  recentPlaybookReads.set(key, now);
  if (recentPlaybookReads.size > 500) {
    for (const [k, ts] of recentPlaybookReads) {
      if (now - ts > DEDUPE_MS) recentPlaybookReads.delete(k);
    }
  }
  return true;
}

export interface MaybeRecordPlaybookSkillFromToolCallInput {
  projectRoot: string;
  agent_id: string;
  session_id: string;
  payload: Record<string, unknown>;
  thread_key?: string;
  task_id?: string;
  channel?: SkillInvocationChannel;
}

/**
 * 若 tool_call 读取了登记在 manifest 中的 Playbook 路径，追加一条 skill invocation。
 * 返回是否写入。
 */
export async function maybeRecordPlaybookSkillFromToolCall(
  input: MaybeRecordPlaybookSkillFromToolCallInput,
): Promise<string | null> {
  const paths = extractPathsFromToolCallPayload(input.payload);
  if (paths.length === 0) return null;

  let index = manifestIndexCache?.index;
  if (!index || manifestIndexCache?.projectRoot !== input.projectRoot) {
    index = await loadPlaybookPathIndex(input.projectRoot);
  }

  for (const p of paths) {
    const skillId = resolveSkillIdFromFilePath(
      p,
      input.projectRoot,
      index,
    );
    if (!skillId) continue;
    if (!shouldRecord(input.session_id, skillId)) continue;

    const rel = normalizePathKey(
      isAbsolute(p)
        ? relative(resolve(input.projectRoot), resolve(p))
        : p,
    );
    await recordSkillInvocation(input.projectRoot, {
      skill_id: skillId,
      ...(displayNameForSkillId(skillId)
        ? { skill_display_name: displayNameForSkillId(skillId) }
        : {}),
      channel: input.channel ?? "agent_runtime",
      outcome: "ok",
      summary: `Agent 读取 Playbook: ${rel}`,
      caller_role: input.agent_id,
      ...(input.thread_key ? { thread_key: input.thread_key } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      triggered_by: "sdk.tool_call",
    });
    return skillId;
  }
  return null;
}

/** @internal test helper */
export function resetPlaybookSkillDedupeForTests(): void {
  recentPlaybookReads.clear();
  manifestIndexCache = null;
}
