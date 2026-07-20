import type { LedgerTaskRecord } from "./types.ts";
import { strField } from "./frontmatter.ts";

/** Narrow probe/sandbox bootstrap markers (aligned with controlled-emergence-observer). */
export function hasProbeBootstrapMarkers(
  body: string,
  fm: Record<string, unknown>,
): boolean {
  const subject = String(fm.subject ?? "");
  const threadKey = String(fm.thread_key ?? "");
  const hay = `${subject}\n${body}`;

  if (/TASK-MCP-PROBE/i.test(hay)) return true;
  if (/Logical id:\s*TASK-MCP-PROBE/i.test(body)) return true;
  if (/\[MCP-PROBE\s+sandbox/i.test(body)) return true;
  if (/ISSUE-MCP-PROBE/i.test(hay)) return true;
  if (threadKey === "mcp-tool-probe") return true;
  if (/fcop\/_sandbox\/mcp-tool-probe/i.test(body)) return true;
  return false;
}

/** UI / ledger view filter: MCP-PROBE self-bootstrap tasks (not formal dispatch). */
export function isProbeBootstrapLedgerTask(
  t: Pick<
    LedgerTaskRecord,
    "sender" | "recipient" | "yaml" | "thread_key" | "filename"
  >,
  body = "",
): boolean {
  const fm: Record<string, unknown> = {
    ...(t.yaml ?? {}),
    subject: strField(t.yaml ?? {}, "subject"),
    thread_key: t.thread_key ?? strField(t.yaml ?? {}, "thread_key"),
  };
  return hasProbeBootstrapMarkers(body, fm);
}
