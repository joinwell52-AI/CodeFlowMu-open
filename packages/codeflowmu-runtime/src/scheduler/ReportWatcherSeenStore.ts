/**
 * Persistent dedup for ReportWatcher — same REPORT filename routes at most once
 * across process restarts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ReportWatcherSeenStore {
  private readonly _path: string;
  private readonly _seen = new Set<string>();

  constructor(projectRoot: string) {
    const dir = join(projectRoot, ".codeflowmu", "report-watcher");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
    this._path = join(dir, "seen-reports.jsonl");
  }

  /** Load historical seen filenames from disk (call before watcher starts). */
  load(): void {
    if (!existsSync(this._path)) return;
    try {
      const raw = readFileSync(this._path, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { filename?: string };
          if (rec.filename) this._seen.add(rec.filename);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* best-effort */
    }
  }

  has(filename: string): boolean {
    return this._seen.has(filename);
  }

  /** Mark filename as dispatched; append-only jsonl for restart safety. */
  mark(filename: string): void {
    if (this._seen.has(filename)) return;
    this._seen.add(filename);
    try {
      appendFileSync(
        this._path,
        JSON.stringify({
          ts: Date.now(),
          at: new Date().toISOString(),
          filename,
        }) + "\n",
        "utf-8",
      );
    } catch {
      /* best-effort */
    }
  }
}
