import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MobileDeviceRecord, MobileDevicesFile } from "./types.ts";

export const MOBILE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashMobileSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateMobileDeviceId(): string {
  return `mobile_${randomBytes(8).toString("hex")}`;
}

export function generateMobileSessionToken(): string {
  return `mst_${randomBytes(24).toString("base64url")}`;
}

export class MobileDeviceStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "mobile-devices.json");
  }

  private load(): MobileDevicesFile {
    if (!existsSync(this.filePath)) {
      return { devices: [] };
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as MobileDevicesFile;
      if (!parsed || !Array.isArray(parsed.devices)) {
        return { devices: [] };
      }
      return parsed;
    } catch {
      return { devices: [] };
    }
  }

  private save(data: MobileDevicesFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  listDevices(): MobileDeviceRecord[] {
    return this.load().devices;
  }

  findByDeviceId(deviceId: string): MobileDeviceRecord | undefined {
    return this.load().devices.find((d) => d.device_id === deviceId);
  }

  findBySessionToken(token: string): MobileDeviceRecord | undefined {
    const hash = hashMobileSessionToken(token);
    const now = Date.now();
    return this.load().devices.find((d) => {
      if (!d.enabled) return false;
      if (!d.session_token_hash || d.session_token_hash !== hash) return false;
      if (d.session_expires_at) {
        const exp = Date.parse(d.session_expires_at);
        if (!Number.isFinite(exp) || exp <= now) return false;
      }
      return true;
    });
  }

  bindDevice(input: {
    device_name: string;
    device_id?: string;
    session_token: string;
    ttlMs?: number;
  }): { device: MobileDeviceRecord; expires_at: string } {
    const now = new Date();
    const ttlMs = input.ttlMs ?? MOBILE_SESSION_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttlMs);
    const device: MobileDeviceRecord = {
      device_id: input.device_id ?? generateMobileDeviceId(),
      device_name: input.device_name.trim() || "Mobile Device",
      bound_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      enabled: true,
      session_token_hash: hashMobileSessionToken(input.session_token),
      session_expires_at: expiresAt.toISOString(),
    };
    const data = this.load();
    data.devices.push(device);
    this.save(data);
    return { device, expires_at: expiresAt.toISOString() };
  }

  touchLastSeen(deviceId: string): void {
    const data = this.load();
    const idx = data.devices.findIndex((d) => d.device_id === deviceId);
    if (idx < 0) return;
    data.devices[idx]!.last_seen_at = new Date().toISOString();
    this.save(data);
  }

  revokeDevice(deviceId: string): boolean {
    const data = this.load();
    const idx = data.devices.findIndex((d) => d.device_id === deviceId);
    if (idx < 0) return false;
    data.devices[idx]!.enabled = false;
    delete data.devices[idx]!.session_token_hash;
    delete data.devices[idx]!.session_expires_at;
    this.save(data);
    return true;
  }

  /** Revoke every enabled device except `keepDeviceId` (defaults to most recently seen). */
  revokeAllExcept(keepDeviceId?: string): { kept: string | null; revoked: string[] } {
    const data = this.load();
    const enabled = data.devices.filter((d) => d.enabled !== false);
    if (!enabled.length) {
      return { kept: null, revoked: [] };
    }
    let keepId = (keepDeviceId ?? "").trim();
    if (!keepId) {
      const sorted = [...enabled].sort((a, b) => {
        const ta = Date.parse(a.last_seen_at ?? a.bound_at ?? "") || 0;
        const tb = Date.parse(b.last_seen_at ?? b.bound_at ?? "") || 0;
        return tb - ta;
      });
      keepId = sorted[0]!.device_id;
    }
    const revoked: string[] = [];
    for (const d of data.devices) {
      if (d.enabled === false || d.device_id === keepId) continue;
      d.enabled = false;
      delete d.session_token_hash;
      delete d.session_expires_at;
      revoked.push(d.device_id);
    }
    if (revoked.length) this.save(data);
    const keptExists = data.devices.some((d) => d.device_id === keepId && d.enabled !== false);
    return { kept: keptExists ? keepId : null, revoked };
  }

  /** Remove disabled device rows from disk (audit history is dropped). */
  purgeRevokedDevices(): number {
    const data = this.load();
    const before = data.devices.length;
    data.devices = data.devices.filter((d) => d.enabled !== false);
    const removed = before - data.devices.length;
    if (removed > 0) this.save(data);
    return removed;
  }
}
