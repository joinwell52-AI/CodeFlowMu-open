export type FcopClientCreateDiag = {
  workspaceRoot: string;
  fcopRoot: string;
  clientPackage: string;
  clientVersion: string;
  failedFunction: string;
  errorName: string;
  errorMessage: string;
  stackFirstLine: string;
};

const lastLoggedAt = new Map<string, number>();
const THROTTLE_MS = 60_000;

function stackFirstLine(err: unknown): string {
  if (!(err instanceof Error) || !err.stack) return "";
  const lines = err.stack.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[1] ?? lines[0] ?? "";
}

export function buildFcopClientCreateDiag(
  err: unknown,
  opts: {
    workspaceRoot: string;
    fcopRoot: string;
    fcopVersion?: string | null;
    failedFunction?: string;
  },
): FcopClientCreateDiag {
  const errorName = err instanceof Error ? err.name : "Error";
  const errorMessage = err instanceof Error ? err.message : String(err);
  return {
    workspaceRoot: opts.workspaceRoot,
    fcopRoot: opts.fcopRoot,
    clientPackage: "@codeflowmu/runtime/FcopProjectClient",
    clientVersion: opts.fcopVersion ?? "unknown",
    failedFunction: opts.failedFunction ?? "FcopProjectClient.create",
    errorName,
    errorMessage,
    stackFirstLine: stackFirstLine(err),
  };
}

export function formatFcopClientCreateDiag(diag: FcopClientCreateDiag): string {
  return (
    `[shell] FcopProjectClient.create failed — ` +
    `workspaceRoot=${diag.workspaceRoot} ` +
    `fcopRoot=${diag.fcopRoot} ` +
    `package=${diag.clientPackage}@${diag.clientVersion} ` +
    `fn=${diag.failedFunction} ` +
    `error=${diag.errorName}: ${diag.errorMessage}` +
    (diag.stackFirstLine ? ` | stack=${diag.stackFirstLine}` : "")
  );
}

export function logFcopClientCreateFailure(
  warn: (msg: string) => void,
  err: unknown,
  opts: Parameters<typeof buildFcopClientCreateDiag>[1],
): void {
  const key = `${opts.workspaceRoot}:${opts.failedFunction ?? "FcopProjectClient.create"}`;
  const now = Date.now();
  const prev = lastLoggedAt.get(key) ?? 0;
  if (now - prev < THROTTLE_MS) return;
  lastLoggedAt.set(key, now);
  const diag = buildFcopClientCreateDiag(err, opts);
  warn(formatFcopClientCreateDiag(diag));
}
