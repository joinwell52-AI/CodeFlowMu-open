import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type SessionLeaseKey = {
  project_id: string;
  agent_id: string;
  canonical_root_task_id: string;
};

export type SessionLeaseRecord = SessionLeaseKey & {
  owner_session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  ttl_ms: number;
};

export class SessionLeaseConflictError extends Error {
  readonly code = "SESSION_LEASE_CONFLICT";

  constructor(public readonly active: SessionLeaseRecord) {
    super(`active session lease is owned by ${active.owner_session_id}`);
    this.name = "SessionLeaseConflictError";
  }
}

function stableKey(key: SessionLeaseKey): string {
  return [key.project_id, key.agent_id, key.canonical_root_task_id]
    .map((part) => part.trim().toLowerCase())
    .join("\u0000");
}

function leaseFilename(key: SessionLeaseKey): string {
  return `${createHash("sha256").update(stableKey(key)).digest("hex")}.json`;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object"
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}

export class SessionLeaseStore {
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly options: {
      dir: string;
      ttlMs?: number;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async read(path: string): Promise<SessionLeaseRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path, "utf8")) as SessionLeaseRecord;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async acquire(key: SessionLeaseKey, ownerSessionId: string): Promise<SessionLeaseRecord> {
    await fs.mkdir(this.options.dir, { recursive: true });
    const path = join(this.options.dir, leaseFilename(key));
    const ttlMs = Math.max(5_000, this.options.ttlMs ?? 60_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = this.now();
      const record: SessionLeaseRecord = {
        ...key,
        owner_session_id: ownerSessionId,
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        ttl_ms: ttlMs,
      };
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(path, "wx");
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
        this.owners.set(ownerSessionId, path);
        return record;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const active = await this.read(path);
        if (active && Date.parse(active.expires_at) > now.getTime()) {
          throw new SessionLeaseConflictError(active);
        }
        await fs.unlink(path).catch((unlinkError) => {
          if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
        });
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }

    const active = await this.read(path);
    if (active) throw new SessionLeaseConflictError(active);
    throw new Error("session lease acquisition failed");
  }

  async heartbeat(ownerSessionId: string): Promise<boolean> {
    const path = this.owners.get(ownerSessionId);
    if (!path) return false;
    const current = await this.read(path);
    if (!current || current.owner_session_id !== ownerSessionId) return false;
    const now = this.now();
    const next = {
      ...current,
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + current.ttl_ms).toISOString(),
    };
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmp, path);
    return true;
  }

  async release(ownerSessionId: string): Promise<boolean> {
    const path = this.owners.get(ownerSessionId);
    if (!path) return false;
    const current = await this.read(path);
    if (current?.owner_session_id !== ownerSessionId) return false;
    await fs.unlink(path).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    this.owners.delete(ownerSessionId);
    return true;
  }
}
