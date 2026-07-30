import type { Server } from "node:http";

export type BoundedServerCloseResult = {
  forced: boolean;
};

/**
 * Stop accepting new HTTP connections and wait a bounded amount of time for
 * active requests to drain. Long-lived SSE/keep-alive connections are forcibly
 * closed after the deadline so shutdown can always make progress.
 */
export function closeHttpServerBounded(
  server: Server,
  timeoutMs = 3_000,
): Promise<BoundedServerCloseResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (
      error: Error | null,
      result: BoundedServerCloseResult,
    ): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    forceTimer = setTimeout(() => {
      server.closeAllConnections();
      finish(null, { forced: true });
    }, Math.max(1, timeoutMs));

    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        finish(error, { forced: false });
        return;
      }
      finish(null, { forced: false });
    });
    server.closeIdleConnections();
  });
}
