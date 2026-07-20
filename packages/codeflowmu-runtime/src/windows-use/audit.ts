import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function dateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export function summarizeWindowsUseArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "text") {
      const text = String(value ?? "");
      summary.text_length = text.length;
      summary.text_sha256 = createHash("sha256").update(text).digest("hex");
      continue;
    }
    if (key === "screenshot" || key === "image" || key === "image_base64") {
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

export async function appendWindowsUseAudit(
  projectRoot: string,
  record: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectRoot, "fcop", "logs", "runtime");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `windows-use-${dateKey()}.jsonl`);
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}
