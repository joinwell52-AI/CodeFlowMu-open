/**
 * 产品开发根「干净初始化」——仅删除 runbook 白名单内的运行现场路径。
 * 见 docs/CODEFLOWMU_CLEAN_INIT_RUNBOOK.md
 */

import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, resolve as pathResolve, relative, normalize } from "node:path";

/** 必删：运行现场（相对产品开发根） */
export const CLEAN_RUNTIME_REQUIRED = ["fcop", ".fcop", ".codeflowmu"] as const;

/** 可选：临时 / 测试（相对产品开发根） */
export const CLEAN_RUNTIME_OPTIONAL = [
  ".pytest_cache",
  "testtemp",
  "scratch",
  "workspace",
  "fcop_events.jsonl",
  ".tmp-manual-extract.txt",
] as const;

export interface CleanRuntimeTarget {
  rel: string;
  required: boolean;
  exists: boolean;
  kind: "directory" | "file";
}

export interface CleanRuntimeResult {
  ok: boolean;
  root: string;
  deleted: string[];
  notFound: string[];
  errors: { path: string; message: string }[];
  /** 逐项删除进度（存在则按顺序删除） */
  steps: CleanRuntimeStep[];
}

export type CleanRuntimeStepStatus = "deleted" | "skipped" | "error";

export interface CleanRuntimeStep {
  rel: string;
  status: CleanRuntimeStepStatus;
  message?: string;
}

function isSafeRelativeEntry(rel: string): boolean {
  const n = normalize(rel).replace(/\\/g, "/");
  if (!n || n === "." || n.startsWith("..") || n.includes("/..")) return false;
  return true;
}

function resolveUnderRoot(root: string, rel: string): string | null {
  if (!isSafeRelativeEntry(rel)) return null;
  const abs = pathResolve(root, rel);
  const relCheck = relative(pathResolve(root), abs);
  const norm = normalize(relCheck).replace(/\\/g, "/");
  if (norm.startsWith("..") || norm.includes("/..")) return null;
  return abs;
}

const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 300,
} as const;

/** Windows：Shell watcher 占用时先 rename 再删，并启用 rmSync 重试。 */
function removePathAggressive(base: string, rel: string): void {
  const abs = resolveUnderRoot(base, rel);
  if (!abs || !existsSync(abs)) return;
  try {
    rmSync(abs, RM_OPTS);
    return;
  } catch (first) {
    const stamp = Date.now();
    const trashName = `.${basename(rel)}.__cfmu_trash_${stamp}`;
    const trashAbs = pathResolve(base, trashName);
    try {
      renameSync(abs, trashAbs);
      rmSync(trashAbs, RM_OPTS);
      return;
    } catch {
      throw first;
    }
  }
}

export function listCleanRuntimeTargets(
  root: string,
  includeOptional: boolean,
): CleanRuntimeTarget[] {
  const base = pathResolve(root);
  const rels: { rel: string; required: boolean }[] = [
    ...CLEAN_RUNTIME_REQUIRED.map((rel) => ({ rel, required: true })),
    ...(includeOptional
      ? CLEAN_RUNTIME_OPTIONAL.map((rel) => ({ rel, required: false }))
      : []),
  ];
  const out: CleanRuntimeTarget[] = [];
  for (const { rel, required } of rels) {
    const abs = resolveUnderRoot(base, rel);
    if (!abs) continue;
    if (!existsSync(abs)) {
      out.push({ rel, required, exists: false, kind: "directory" });
      continue;
    }
    const st = statSync(abs);
    out.push({
      rel,
      required,
      exists: true,
      kind: st.isDirectory() ? "directory" : "file",
    });
  }
  return out;
}

export function cleanProjectRuntime(
  root: string,
  includeOptional: boolean,
): CleanRuntimeResult {
  const base = pathResolve(root);
  const targets = listCleanRuntimeTargets(base, includeOptional).filter(
    (t) => t.exists,
  );
  const deleted: string[] = [];
  const notFound: string[] = [];
  const errors: { path: string; message: string }[] = [];
  const steps: CleanRuntimeStep[] = [];

  for (const t of listCleanRuntimeTargets(base, includeOptional)) {
    if (!t.exists) {
      notFound.push(t.rel);
      steps.push({ rel: t.rel, status: "skipped", message: "不存在" });
    }
  }

  for (const t of targets) {
    const abs = resolveUnderRoot(base, t.rel);
    if (!abs) {
      errors.push({ path: t.rel, message: "invalid relative path" });
      steps.push({ rel: t.rel, status: "error", message: "invalid relative path" });
      continue;
    }
    try {
      removePathAggressive(base, t.rel);
      deleted.push(t.rel);
      steps.push({ rel: t.rel, status: "deleted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: t.rel, message });
      steps.push({ rel: t.rel, status: "error", message });
    }
  }

  return {
    ok: errors.length === 0,
    root: base,
    deleted,
    notFound,
    errors,
    steps,
  };
}

export interface PostCleanVerifyItem {
  id: string;
  name: string;
  status: "ok" | "fail";
  detail: string;
}

/** 清理完成后验收：必删路径应不存在，fcop.json 应消失。 */
export function verifyPostCleanRuntime(root: string): {
  ok: boolean;
  root: string;
  items: PostCleanVerifyItem[];
  summary: string;
} {
  const base = pathResolve(root);
  const items: PostCleanVerifyItem[] = [];
  const failures: string[] = [];

  for (const rel of CLEAN_RUNTIME_REQUIRED) {
    const abs = resolveUnderRoot(base, rel);
    const stillThere = abs ? existsSync(abs) : false;
    if (stillThere) {
      const detail = `${rel}/ 仍存在 — 清理未完全生效`;
      items.push({ id: `absent_${rel}`, name: rel, status: "fail", detail });
      failures.push(detail);
    } else {
      items.push({
        id: `absent_${rel}`,
        name: rel,
        status: "ok",
        detail: "已删除或原本不存在",
      });
    }
  }

  const fcopJson = resolveUnderRoot(base, "fcop/fcop.json");
  if (fcopJson && existsSync(fcopJson)) {
    const detail = "fcop/fcop.json 仍存在 — FCoP 未回到未初始化状态";
    items.push({ id: "no_fcop_json", name: "fcop/fcop.json", status: "fail", detail });
    failures.push(detail);
  } else {
    items.push({
      id: "no_fcop_json",
      name: "fcop/fcop.json",
      status: "ok",
      detail: "不存在（符合干净初始化预期）",
    });
  }

  const ok = failures.length === 0;
  return {
    ok,
    root: base,
    items,
    summary: ok
      ? "清理验收通过 — 可在「环境预检」对当前产品开发根一键 init"
      : failures[0] ?? "清理验收未通过",
  };
}
