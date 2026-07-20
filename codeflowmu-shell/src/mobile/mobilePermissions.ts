import type { NextFunction, Request, Response } from "express";

import { MobileDeviceStore } from "./mobileDeviceStore.ts";
import type { MobileAuthContext } from "./types.ts";

const MOBILE_OPERATOR_ROLE = "mobile_operator" as const;

declare module "express-serve-static-core" {
  interface Request {
    mobileAuth?: MobileAuthContext;
  }
}

function parseBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

export function createMobileAuthMiddleware(deviceStore: MobileDeviceStore) {
  return function mobileAuth(req: Request, res: Response, next: NextFunction): void {
    const token = parseBearerToken(req);
    if (!token) {
      res.status(403).json({ ok: false, error: "MOBILE_AUTH_REQUIRED" });
      return;
    }
    const device = deviceStore.findBySessionToken(token);
    if (!device || !device.enabled) {
      res.status(403).json({ ok: false, error: "MOBILE_AUTH_FORBIDDEN" });
      return;
    }
    deviceStore.touchLastSeen(device.device_id);
    req.mobileAuth = {
      device_id: device.device_id,
      role: MOBILE_OPERATOR_ROLE,
    };
    next();
  };
}

export function getMobileOperatorRole(): typeof MOBILE_OPERATOR_ROLE {
  return MOBILE_OPERATOR_ROLE;
}
