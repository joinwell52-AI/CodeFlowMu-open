import { createHash } from "node:crypto";

import { loadMobileGatewayConfig, resolvePublicBaseUrl } from "./mobileGatewayConfig.ts";

/** Stable per-project instance id (used in Gateway bind URLs). */
export function getMobileInstanceId(projectRoot: string): string {
  const cfg = loadMobileGatewayConfig(projectRoot);
  if (cfg?.instance_id && cfg.instance_id.length > 0) {
    return cfg.instance_id;
  }
  return createHash("sha256").update(projectRoot, "utf8").digest("hex").slice(0, 16);
}

/** Public HTTPS API root for this project: `{public_base}/m/{instance_id}`. */
export function resolveMobilePublicApiBase(projectRoot: string): string {
  const publicBase = resolvePublicBaseUrl(projectRoot).replace(/\/$/, "");
  return `${publicBase}/m/${getMobileInstanceId(projectRoot)}`;
}
