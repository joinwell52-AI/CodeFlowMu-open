/**
 * EVAL 观察员治理配置（项目级 `.codeflowmu/eval-observer.json`）
 * 默认：不自启 watcher、创建任务不触发、定时关闭。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { initEvalRunProgress } from "./eval-run-progress.ts";

export interface EvalObserverConfig {
  /** 面板启动时是否拉起 packages/evaluator/watcher.js */
  watcher_auto_start: boolean;
  /** ADMIN 经面板创建任务后是否自动 spawn eval-01 */
  trigger_on_task_create: boolean;
  /** 是否按 schedule_time 每日触发一次 eval-01 */
  schedule_enabled: boolean;
  /** 本地时区 HH:mm，如 09:00 */
  schedule_time: string;
  /** 上次定时触发日期 YYYY-MM-DD，防重复 */
  schedule_last_run_date: string;
}

export const EVAL_OBSERVER_CONFIG_DEFAULTS: EvalObserverConfig = {
  watcher_auto_start: false,
  trigger_on_task_create: false,
  schedule_enabled: false,
  schedule_time: "09:00",
  schedule_last_run_date: "",
};

function configPath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "eval-observer.json");
}

function lockPath(projectRoot: string): string {
  return join(projectRoot, "fcop", "pipes", "eval-watcher.lock");
}

export function readEvalObserverConfig(projectRoot: string): EvalObserverConfig {
  const p = configPath(projectRoot);
  if (!existsSync(p)) {
    return { ...EVAL_OBSERVER_CONFIG_DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<EvalObserverConfig>;
    return {
      ...EVAL_OBSERVER_CONFIG_DEFAULTS,
      ...raw,
      schedule_time:
        typeof raw.schedule_time === "string" && /^\d{2}:\d{2}$/.test(raw.schedule_time)
          ? raw.schedule_time
          : EVAL_OBSERVER_CONFIG_DEFAULTS.schedule_time,
    };
  } catch {
    return { ...EVAL_OBSERVER_CONFIG_DEFAULTS };
  }
}

export function writeEvalObserverConfig(
  projectRoot: string,
  patch: Partial<EvalObserverConfig>,
): EvalObserverConfig {
  const dir = join(projectRoot, ".codeflowmu");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = { ...readEvalObserverConfig(projectRoot), ...patch };
  writeFileSync(configPath(projectRoot), JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

/** 停止常驻 watcher：读 lock → 杀进程 → 删 lock */
export function stopEvalWatcher(projectRoot: string): {
  stopped: boolean;
  pid: number | null;
  message: string;
} {
  const lp = lockPath(projectRoot);
  if (!existsSync(lp)) {
    return { stopped: true, pid: null, message: "无运行中的 watcher（无 lock 文件）" };
  }
  let pid: number | null = null;
  try {
    const raw = readFileSync(lp, "utf-8").trim();
    try {
      const lock = JSON.parse(raw) as { pid?: number };
      pid = typeof lock.pid === "number" ? lock.pid : null;
    } catch {
      const n = parseInt(raw, 10);
      pid = Number.isFinite(n) ? n : null;
    }
  } catch {
    /* stale lock */
  }
  if (pid && isPidAlive(pid)) {
    killPid(pid);
  }
  try {
    unlinkSync(lp);
  } catch {
    /* ignore */
  }
  return {
    stopped: true,
    pid,
    message: pid ? `已请求停止 watcher (pid ${pid})` : "已清除 watcher 锁文件",
  };
}

export function getEvalWatcherStatus(projectRoot: string): {
  running: boolean;
  pid: number | null;
  lock_path: string;
} {
  const lp = lockPath(projectRoot);
  if (!existsSync(lp)) {
    return { running: false, pid: null, lock_path: lp };
  }
  let pid: number | null = null;
  try {
    const raw = readFileSync(lp, "utf-8").trim();
    try {
      const lock = JSON.parse(raw) as { pid?: number };
      pid = typeof lock.pid === "number" ? lock.pid : null;
    } catch {
      const n = parseInt(raw, 10);
      pid = Number.isFinite(n) ? n : null;
    }
  } catch {
    return { running: false, pid: null, lock_path: lp };
  }
  return { running: pid !== null && isPidAlive(pid), pid, lock_path: lp };
}

/** 手动或定时：写 doorbell + spawn eval-01.js */
export async function spawnEval01(
  projectRoot: string,
  taskId?: string,
): Promise<{ run_id: string; task_id: string }> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const doorbellDir = join(projectRoot, "fcop", "pipes");
  await mkdir(doorbellDir, { recursive: true });
  const doorbellPath = join(doorbellDir, "doorbell.eval");
  const tid = taskId || `MANUAL-EVAL-${Date.now()}`;
  const runId = `run-${Date.now()}`;
  initEvalRunProgress(projectRoot, runId, tid);
  await writeFile(
    doorbellPath,
    JSON.stringify({ action: "awaken", task_id: tid, run_id: runId }),
    "utf-8",
  );
  const evalProcess = spawn(process.execPath, ["packages/evaluator/eval-01.js"], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  evalProcess.unref();
  return { run_id: runId, task_id: tid };
}

/** 仅当配置允许时拉起 watcher.js */
export function startEvalWatcherIfConfigured(
  projectRoot: string,
  log?: { info: (m: string) => void; warn: (m: string) => void },
): void {
  const cfg = readEvalObserverConfig(projectRoot);
  if (!cfg.watcher_auto_start) {
    log?.info("[eval] watcher 自启已关闭（eval-observer.json）");
    return;
  }
  const status = getEvalWatcherStatus(projectRoot);
  if (status.running) {
    log?.info(`[eval] watcher 已在运行 (pid ${status.pid})`);
    return;
  }
  try {
    const watcherProcess = spawn(process.execPath, ["packages/evaluator/watcher.js"], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    watcherProcess.unref();
    log?.info("[eval] watcher.js 已按配置自启");
  } catch (err) {
    log?.warn(`[eval] watcher 启动失败: ${String(err)}`);
  }
}

function localDateYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localTimeHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 每分钟检查是否到达定时评估时刻（同日仅一次） */
export function createEvalScheduleChecker(
  getProjectRoot: () => string,
  log?: { info: (m: string) => void },
): () => void {
  return () => {
    const projectRoot = getProjectRoot();
    const cfg = readEvalObserverConfig(projectRoot);
    if (!cfg.schedule_enabled) return;
    const nowHm = localTimeHm();
    if (nowHm !== cfg.schedule_time) return;
    const today = localDateYmd();
    if (cfg.schedule_last_run_date === today) return;
    writeEvalObserverConfig(projectRoot, { schedule_last_run_date: today });
    void spawnEval01(projectRoot, `SCHEDULED-EVAL-${today}-${nowHm.replace(":", "")}`).then(
      () => {
        log?.info(`[eval] 定时观察已触发 (${cfg.schedule_time})`);
      },
    );
  };
}
