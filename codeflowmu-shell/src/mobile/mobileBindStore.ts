import { hashMobileSessionToken } from "./mobileDeviceStore.ts";

interface PendingBind {
  bind_id: string;
  token_hash: string;
  expires_at: number;
}

interface CompletedBind {
  token_hash: string;
  device_id: string;
  mobile_session_token: string;
  expires_at: string;
  completed_at: number;
}

export type BindConfirmResult =
  | {
      kind: "replay";
      device_id: string;
      mobile_session_token: string;
      expires_at: string;
    }
  | { kind: "pending" }
  | { kind: "invalid" };

export class MobileBindStore {
  private readonly pending = new Map<string, PendingBind>();
  private readonly completed = new Map<string, CompletedBind>();
  /** WeChat / double-fetch replay window */
  private readonly replayTtlMs = 10 * 60 * 1000;

  register(bindId: string, token: string, ttlMs: number): void {
    const expires_at = Date.now() + ttlMs;
    this.pending.set(bindId, {
      bind_id: bindId,
      token_hash: hashMobileSessionToken(token),
      expires_at,
    });
  }

  tryConfirm(bindId: string, token: string): BindConfirmResult {
    const tokenHash = hashMobileSessionToken(token);
    const replay = this.completed.get(bindId);
    if (replay) {
      if (replay.completed_at + this.replayTtlMs < Date.now()) {
        this.completed.delete(bindId);
      } else if (replay.token_hash === tokenHash) {
        return {
          kind: "replay",
          device_id: replay.device_id,
          mobile_session_token: replay.mobile_session_token,
          expires_at: replay.expires_at,
        };
      }
    }
    const row = this.pending.get(bindId);
    if (!row) return { kind: "invalid" };
    if (row.expires_at <= Date.now()) {
      this.pending.delete(bindId);
      return { kind: "invalid" };
    }
    if (row.token_hash !== tokenHash) return { kind: "invalid" };
    this.pending.delete(bindId);
    return { kind: "pending" };
  }

  recordSuccess(
    bindId: string,
    token: string,
    payload: { device_id: string; mobile_session_token: string; expires_at: string },
  ): void {
    this.completed.set(bindId, {
      token_hash: hashMobileSessionToken(token),
      device_id: payload.device_id,
      mobile_session_token: payload.mobile_session_token,
      expires_at: payload.expires_at,
      completed_at: Date.now(),
    });
  }

  /** @deprecated use tryConfirm + recordSuccess */
  consume(bindId: string, token: string): boolean {
    return this.tryConfirm(bindId, token).kind === "pending";
  }
}
