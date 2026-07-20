/**
 * StateHistoryWriter — append-only audit trail writer for Task files.
 *
 * Scope (TASK-20260509-018 §主交付 3):
 *
 * - Writes are `appendFile`, not atomic-rename. Append-only by design:
 *   if a partial line is written during a crash, the next dispatch cycle
 *   re-runs and the audit row is regenerated — no durability invariant
 *   is broken (TASK-018 §主交付 3 implementation point line 150-151).
 * - We DO NOT touch the YAML front-matter `state_history` array.
 *   - Per `task.schema.json` line 47-60, that array's `items` schema is
 *     `{state, at, by}` with `additionalProperties: false`, while the
 *     entries this writer captures (`{at, by, from, to, note}`) carry
 *     more information than the schema allows. Modifying front-matter
 *     would also violate the `codeflowmu-project` rule "tasks/ files are
 *     append-only — never modify in place" + TASK-018 §不做 line 329.
 *   - Instead we append a markdown section to the END of the file body.
 *     Markdown body text is unconstrained by the protocol schema, so
 *     this preserves cross-reader compatibility while still leaving an
 *     audit trail visible to any human reading the file.
 * - On the FIRST append, the writer adds a separator (`\n---\n\n`) and
 *   the section heading (`## state_history (auto-appended by runtime)`).
 *   On subsequent appends, it skips the heading and only appends a new
 *   bullet (detected via a simple `String.includes` check).
 *
 * Reference: TASK-20260509-018 §主交付 3 + design doc §3.3 (Task Schema).
 */

import { promises as fs } from "node:fs";

import { TaskFileNotFoundError } from "../registry/errors.ts";

/**
 * One state-transition row, written as a markdown bullet.
 *
 * Field shape note: this is the RUNTIME's audit shape, NOT the FCoP
 * `state_history.items` schema (`{state, at, by}`). The two never overlap
 * by design — runtime entries live in markdown body, schema entries (when
 * the protocol-aware producers ever add them) live in front-matter.
 */
export interface StateHistoryEntry {
  /** ISO-8601 timestamp. */
  at: string;
  /** Who is making the transition (agent_id, "runtime", or "ADMIN"). */
  by: string;
  /** State at the start of this transition. */
  from: string;
  /** State at the end of this transition. */
  to: string;
  /** Optional free-text note (≤ 200 chars; we don't truncate, just guide). */
  note?: string;
}

/** The exact heading we look for to decide "is this the first append?". */
const SECTION_HEADING = "## state_history (auto-appended by runtime)";

export class StateHistoryWriter {
  /**
   * Append one state-transition entry to the markdown body of `filepath`.
   *
   * @throws `TaskFileNotFoundError` if the file is missing (likely a
   *   race: the file was unlinked between dispatch and settlement).
   *   Other read/write errors propagate as-is.
   */
  async append(filepath: string, entry: StateHistoryEntry): Promise<void> {
    let existing: string;
    try {
      existing = await fs.readFile(filepath, "utf-8");
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new TaskFileNotFoundError(filepath, { cause: err });
      }
      throw err;
    }

    const hasHeading = existing.includes(SECTION_HEADING);
    const needsTrailingNewline = !existing.endsWith("\n");

    const bullet = formatBullet(entry);
    let toAppend = "";

    if (needsTrailingNewline) {
      toAppend += "\n";
    }

    if (!hasHeading) {
      // First append: separator + heading.
      toAppend += `\n---\n\n${SECTION_HEADING}\n\n${bullet}\n`;
    } else {
      // Subsequent appends: just the bullet line. The previous append
      // already left a trailing newline after the bullet.
      toAppend += `${bullet}\n`;
    }

    await fs.appendFile(filepath, toAppend, "utf-8");
  }
}

function formatBullet(entry: StateHistoryEntry): string {
  const note = entry.note ? ` ${entry.note}` : "";
  return `- **${entry.at}** | by \`${entry.by}\` | \`${entry.from}\` → \`${entry.to}\`${note}`;
}

