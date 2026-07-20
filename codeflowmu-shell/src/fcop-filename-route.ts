/**
 * FCoP TASK/REPORT filename routing (sender / recipient).
 * ADR-0033: optional trailing slug starts with [a-z] and must not be merged into recipient.
 */

export type TaskRoute = { sender: string; recipient: string };

/** Parse `TASK|REPORT-YYYYMMDD-NNN-SENDER-to-RECIPIENT[-slug].md` */
export function taskRouteFromFilename(fn: string): TaskRoute | null {
  const base = String(fn || "").replace(/\.md$/i, "");
  const parts = base.split("-");
  if (parts.length < 6) return null;

  const kind = parts[0]!.toUpperCase();
  if (kind !== "TASK" && kind !== "REPORT") return null;
  if (!/^\d{8}$/.test(parts[1]!) || !/^\d{3}$/.test(parts[2]!)) return null;

  const toIdx = parts.findIndex((p, i) => i >= 3 && p === "to");
  if (toIdx < 4 || toIdx + 1 >= parts.length) return null;

  const sender = parts.slice(3, toIdx).join("-").toUpperCase();
  if (!sender) return null;

  const recipientParts: string[] = [];
  for (let i = toIdx + 1; i < parts.length; i++) {
    const seg = parts[i]!;
    if (recipientParts.length > 0 && /^[a-z]/.test(seg)) break;
    recipientParts.push(seg);
  }
  if (recipientParts.length === 0) return null;

  const recipient = recipientParts.join("-").split(".")[0]!.toUpperCase();
  return { sender, recipient };
}

/** JS panel inline export name */
export const taskRouteFromFn = taskRouteFromFilename;
