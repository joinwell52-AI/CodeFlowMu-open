/**
 * EVAL 观察报告生成进度（面板轮询用，不写 FCoP 协议文件）
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fcopInternalEvalDir } from "./fcop-governance.ts";

export type EvalRunPhase =
  | "idle"
  | "starting"
  | "reading"
  | "analyzing"
  | "generating"
  | "done"
  | "error";

export type EvalRunProgress = {
  run_id: string;
  phase: EvalRunPhase;
  message: string;
  task_id?: string;
  started_at: string;
  updated_at: string;
  result?: {
    filename: string;
    rel_path: string;
    observed_at: string;
    subject?: string;
  };
  error?: string;
};

export function evalRunProgressPath(projectRoot: string): string {
  return join(fcopInternalEvalDir(projectRoot), ".observation-run.json");
}

export function readEvalRunProgress(projectRoot: string): EvalRunProgress | null {
  const p = evalRunProgressPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as EvalRunProgress;
  } catch {
    return null;
  }
}

export function writeEvalRunProgress(projectRoot: string, progress: EvalRunProgress): void {
  const dir = fcopInternalEvalDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const p = evalRunProgressPath(projectRoot);
  writeFileSync(p, JSON.stringify({ ...progress, updated_at: new Date().toISOString() }, null, 2), "utf-8");
}

export function initEvalRunProgress(
  projectRoot: string,
  runId: string,
  taskId: string,
): EvalRunProgress {
  const progress: EvalRunProgress = {
    run_id: runId,
    phase: "starting",
    message: "正在启动观察员…",
    task_id: taskId,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeEvalRunProgress(projectRoot, progress);
  return progress;
}

export const EVAL_RUN_PHASE_LABELS: Record<EvalRunPhase, string> = {
  idle: "待命",
  starting: "正在启动…",
  reading: "正在读取协作账本与任务上下文…",
  analyzing: "正在分析涌现信号与合规性…",
  generating: "正在生成观察报告…",
  done: "生成完成！",
  error: "生成失败",
};
