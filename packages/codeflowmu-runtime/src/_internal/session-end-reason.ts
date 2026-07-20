/**
 * Normalize session end reason for log center / observability.
 */

import { TRANSIENT_SDK_DELAYED } from "./transient-sdk-error.ts";

export function normalizeSessionEndReason(opts: {
  protocolStatus: string;
  failureCode?: string | null;
  settlementReason?: string;
  cancelReason?: string;
  errorMessage?: string;
}): string {
  const fc = opts.failureCode?.trim();
  if (fc === "TURN_LIMIT") return "TURN_LIMIT";
  if (fc === TRANSIENT_SDK_DELAYED) return "TRANSIENT_SDK_DELAYED";

  const sr = (opts.settlementReason ?? "").toLowerCase();
  if (sr.includes("transient")) return "TRANSIENT_SDK_DELAYED";
  if (sr.includes("turn") || sr.includes("max_tool")) return "TURN_LIMIT";

  if (opts.protocolStatus === "completed") return "COMPLETED";

  if (opts.protocolStatus === "cancelled") {
    const cr = (opts.cancelReason ?? "").toLowerCase();
    if (cr.includes("max_tool") || cr.includes("turn_limit")) return "TURN_LIMIT";
    if (cr.includes("user") || cr.includes("user_stop")) return "USER_STOP";
    return "SDK_CANCELLED";
  }

  if (opts.protocolStatus === "failed") {
    const err = (opts.errorMessage ?? "").toLowerCase();
    if (err.includes("timeout")) return "TIMEOUT";
    if (fc) return fc;
    return "ERROR";
  }

  return "UNKNOWN";
}
