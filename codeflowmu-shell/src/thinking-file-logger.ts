/**
 * Auto-archive sdk.thinking / sdk.tool_call / sdk.assistant to fcop/logs/thinking/.
 *
 * Layout:
 *   fcop/logs/thinking/chat/thinking-YYYYMMDD.jsonl  — ADMIN↔Agent 聊天会话
 *   fcop/logs/thinking/task/thinking-YYYYMMDD.jsonl  — 派单 / 唤醒 / 巡查等任务会话
 *
 * Legacy flat files under fcop/logs/thinking/*.jsonl (pre-split) remain readable via listFiles().
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { AnalyticsDimensions } from "./analytics-ledger.ts";
import { analyticsFieldsFromDimensions } from "./analytics-ledger.ts";

export type ThinkingChannel = "chat" | "task";

export interface ThinkingLogFileMeta {
  filename: string;
  date: string;
  size_bytes: number;
  path: string;
  channel: ThinkingChannel | "legacy";
}

export class ThinkingFileLogger {
  private readonly _rootDir: string;
  private readonly _channelDirs: Record<ThinkingChannel, string>;
  private _currentDate = "";
  private readonly _currentPaths: Record<ThinkingChannel, string> = {
    chat: "",
    task: "",
  };

  constructor(projectRoot: string) {
    this._rootDir = join(projectRoot, "fcop", "logs", "thinking");
    this._channelDirs = {
      chat: join(this._rootDir, "chat"),
      task: join(this._rootDir, "task"),
    };
    try {
      mkdirSync(this._rootDir, { recursive: true });
      mkdirSync(this._channelDirs.chat, { recursive: true });
      mkdirSync(this._channelDirs.task, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  /** Root fcop/logs/thinking/ (parent of chat/ and task/). */
  get rootDir(): string {
    return this._rootDir;
  }

  channelDir(channel: ThinkingChannel): string {
    return this._channelDirs[channel];
  }

  append(
    channel: ThinkingChannel,
    event: Record<string, unknown>,
    dims?: AnalyticsDimensions,
  ): void {
    try {
      const path = this._pathFor(channel);
      const line = JSON.stringify({
        ts: Date.now(),
        at: new Date().toISOString(),
        channel,
        event_type: event["event_type"] ?? "unknown",
        agent_id: event["agent_id"] ?? "",
        session_id: event["session_id"] ?? "",
        ...(dims ? analyticsFieldsFromDimensions(dims) : {}),
        payload: event["payload"] ?? {},
      });
      setImmediate(() => {
        try {
          appendFileSync(path, line + "\n", "utf-8");
        } catch {
          /* best-effort */
        }
      });
    } catch {
      /* never crash runtime for log failure */
    }
  }

  /** All files: chat + task + legacy root-level (newest first). */
  listFiles(): ThinkingLogFileMeta[] {
    const out: ThinkingLogFileMeta[] = [
      ...this._listChannelFiles("chat"),
      ...this._listChannelFiles("task"),
      ...this._listLegacyFiles(),
    ];
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  listByChannel(): Record<ThinkingChannel, ThinkingLogFileMeta[]> {
    return {
      chat: this._listChannelFiles("chat"),
      task: this._listChannelFiles("task"),
    };
  }

  private _pathFor(channel: ThinkingChannel): string {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (today !== this._currentDate) {
      this._currentDate = today;
      this._currentPaths.chat = join(
        this._channelDirs.chat,
        `thinking-${today}.jsonl`,
      );
      this._currentPaths.task = join(
        this._channelDirs.task,
        `thinking-${today}.jsonl`,
      );
    }
    return this._currentPaths[channel];
  }

  private _listChannelFiles(channel: ThinkingChannel): ThinkingLogFileMeta[] {
    return this._listJsonlInDir(this._channelDirs[channel], channel);
  }

  private _listLegacyFiles(): ThinkingLogFileMeta[] {
    try {
      return readdirSync(this._rootDir)
        .filter((f) => f.startsWith("thinking-") && f.endsWith(".jsonl"))
        .map((f) => {
          const full = join(this._rootDir, f);
          const stat = statSync(full);
          return {
            filename: f,
            date: f.replace("thinking-", "").replace(".jsonl", ""),
            size_bytes: stat.size,
            path: full,
            channel: "legacy" as const,
          };
        });
    } catch {
      return [];
    }
  }

  private _listJsonlInDir(
    dir: string,
    channel: ThinkingChannel,
  ): ThinkingLogFileMeta[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.startsWith("thinking-") && f.endsWith(".jsonl"))
        .map((f) => {
          const full = join(dir, f);
          const stat = statSync(full);
          return {
            filename: f,
            date: f.replace("thinking-", "").replace(".jsonl", ""),
            size_bytes: stat.size,
            path: full,
            channel,
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  }
}
