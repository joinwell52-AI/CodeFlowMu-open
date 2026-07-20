import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MOBILE_CHAT_DISK_CAP = 300;
export const MOBILE_CHAT_DEFAULT_LIMIT = 100;
export const MOBILE_CHAT_MAX_LIMIT = 200;

export interface MobileChatMessage {
  role: string;
  content: string;
  created_at: string;
  agentId?: string;
  source?: string;
  client?: string;
  attachments?: Array<{
    type?: string;
    url?: string;
    local_path?: string;
    absolute_path?: string;
    mime?: string;
    original_name?: string;
    size?: number;
    sha256?: string;
  }>;
}

/** Mobile chat log — persisted under dataDir only; never writes FCoP lifecycle files. */
export class MobileChatStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    const dir = join(dataDir, "mobile-chat");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "messages.jsonl");
  }

  listMessages(limit = MOBILE_CHAT_DEFAULT_LIMIT): MobileChatMessage[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim());
    const messages: MobileChatMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as MobileChatMessage;
        if (parsed && typeof parsed.content === "string") {
          messages.push(parsed);
        }
      } catch {
        // skip corrupt line
      }
    }
    if (messages.length <= limit) return messages;
    return messages.slice(-limit);
  }

  appendUserMessage(
    content: string,
    attachments?: MobileChatMessage["attachments"],
    meta?: Pick<MobileChatMessage, "source" | "client">,
  ): MobileChatMessage {
    const message: MobileChatMessage = {
      role: "user",
      content: content.trim(),
      created_at: new Date().toISOString(),
    };
    if (meta?.source) message.source = meta.source;
    if (meta?.client) message.client = meta.client;
    if (Array.isArray(attachments) && attachments.length) {
      message.attachments = attachments;
    }
    appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, "utf-8");
    this.trimDiskToCap();
    return message;
  }

  /** Keep only the newest MOBILE_CHAT_DISK_CAP JSONL lines on disk. */
  private trimDiskToCap(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim());
    if (lines.length <= MOBILE_CHAT_DISK_CAP) return;
    const kept = lines.slice(-MOBILE_CHAT_DISK_CAP);
    writeFileSync(this.filePath, `${kept.join("\n")}\n`, "utf-8");
  }
}
