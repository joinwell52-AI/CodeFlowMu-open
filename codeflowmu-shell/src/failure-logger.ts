/**
 * FailureLogger — writes system-level failure records to fcop/internal/failures/.
 *
 * Captures events that fall outside the FCoP protocol (model hangs, network
 * drops, process crashes, API timeouts, MCP errors) and persists them as
 * FAILURE-YYYYMMDD-NNN-{type}.md files for traceability and audit.
 *
 * Design:
 *   - Runs alongside the runtime, not part of the FCoP protocol layer.
 *   - Files are human-readable Markdown + YAML frontmatter.
 *   - Sequence numbers are per-day (resets on date change).
 *   - Complementary to fcop/issues/ (agent-visible blocks via protocol).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FailureType =
  | "model_hang"
  | "network_drop"
  | "process_crash"
  | "api_timeout"
  | "mcp_error"
  | "unknown";

export interface FailureRecord {
  failure_type: FailureType;
  agent_id?: string;
  description: string;
  duration_before_detect_s?: number;
  recovered: boolean;
  recovery_action?: string;
  related_task?: string;
}

export class FailureLogger {
  private readonly _dir: string;

  constructor(failuresDir: string) {
    this._dir = failuresDir;
  }

  /** Write a failure record to fcop/internal/failures/FAILURE-YYYYMMDD-NNN-{type}.md */
  write(record: FailureRecord): string | null {
    try {
      mkdirSync(this._dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const seq = this._nextSeq(date);
      const filename = `FAILURE-${date}-${seq}-${record.failure_type}.md`;
      const filepath = join(this._dir, filename);
      const ts = new Date().toISOString();

      const content = [
        "---",
        "protocol: fcop",
        'version: "1.0"',
        "doc_type: failure",
        `failure_type: ${record.failure_type}`,
        record.agent_id ? `agent_id: ${record.agent_id}` : "",
        `timestamp: "${ts}"`,
        record.duration_before_detect_s !== undefined
          ? `duration_before_detect_s: ${record.duration_before_detect_s}`
          : "",
        `recovered: ${record.recovered}`,
        record.recovery_action ? `recovery_action: ${record.recovery_action}` : "",
        record.related_task ? `related_task: ${record.related_task}` : "",
        "---",
        "",
        "## 故障描述",
        "",
        record.description,
        "",
        "## 自动处理",
        "",
        record.recovered
          ? `已自动恢复（${record.recovery_action ?? "unknown"}）。`
          : "未自动恢复，需人工介入。",
      ]
        .filter((l) => l !== null && l !== undefined)
        .join("\n");

      writeFileSync(filepath, content, "utf-8");
      return filename;
    } catch {
      return null;
    }
  }

  private _nextSeq(date: string): string {
    if (!existsSync(this._dir)) return "001";
    const existing = readdirSync(this._dir).filter((f) =>
      f.startsWith(`FAILURE-${date}-`),
    );
    return String(existing.length + 1).padStart(3, "0");
  }
}
