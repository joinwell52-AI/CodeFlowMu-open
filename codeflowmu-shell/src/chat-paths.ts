/**
 * fcop/chat — Direct chat append-only JSONL（按自然日分文件）
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { logsDateKey } from "./logs-paths.ts";

export function fcopChatDir(projectRoot: string): string {
  return join(projectRoot, "fcop", "chat");
}

export const LEGACY_CHAT_MONO = "chat.jsonl";

export function fcopChatPathForDate(projectRoot: string, dateKey?: string): string {
  const key = dateKey ?? logsDateKey();
  return join(fcopChatDir(projectRoot), `chat-${key}.jsonl`);
}

export function fcopChatLegacyMonolithPath(projectRoot: string): string {
  return join(fcopChatDir(projectRoot), LEGACY_CHAT_MONO);
}

/**
 * 读取顺序：按日文件（新 → 旧），最后兼容 legacy chat.jsonl。
 * 合并时应对 ts 排序后取 tail。
 */
export function listChatReadPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  const dir = fcopChatDir(projectRoot);
  try {
    const daily = readdirSync(dir)
      .filter((f) => /^chat-\d{8}\.jsonl$/.test(f))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => join(dir, f));
    paths.push(...daily);
  } catch {
    /* dir may not exist yet */
  }
  const mono = fcopChatLegacyMonolithPath(projectRoot);
  if (existsSync(mono)) paths.push(mono);
  return paths;
}
