import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveMobilePublicApiBase } from "./mobileInstance.ts";
import { readCodeflowmuVersionManifest } from "./mobileVersion.ts";

export type PwaGatewaySyncStatus = {
  /** Local authoritative PWA app_version (version.json, then manifest mobile_pwa). */
  local_app_version: string | null;
  /** app_version from Gateway-hosted mobile/version.json (null if unreachable). */
  gateway_online_app_version: string | null;
  /** true when both sides exist and match (case-sensitive). */
  aligned: boolean;
  /** Full URL used for the online check. */
  check_url: string;
  /** Non-null when fetch/parse failed or local version missing. */
  error: string | null;
};

const FETCH_TIMEOUT_MS = 12_000;

function readLocalMobileVersionJson(projectRoot: string): string | null {
  const path = join(projectRoot, "codeflowmu-desktop", "mobile", "version.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { app_version?: unknown };
    const v = typeof raw.app_version === "string" ? raw.app_version.trim() : "";
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function resolveLocalAppVersion(projectRoot: string): string | null {
  return readLocalMobileVersionJson(projectRoot) ?? readCodeflowmuVersionManifest()?.mobile_pwa ?? null;
}

export async function fetchPwaGatewaySyncStatus(
  projectRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PwaGatewaySyncStatus> {
  const local = resolveLocalAppVersion(projectRoot);
  const checkUrl = `${resolveMobilePublicApiBase(projectRoot)}/mobile/version.json`;

  if (!local) {
    return {
      local_app_version: null,
      gateway_online_app_version: null,
      aligned: false,
      check_url: checkUrl,
      error: "LOCAL_PWA_VERSION_UNAVAILABLE",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();

  try {
    const resp = await fetchImpl(checkUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        local_app_version: local,
        gateway_online_app_version: null,
        aligned: false,
        check_url: checkUrl,
        error: `HTTP_${resp.status}`,
      };
    }
    const body = (await resp.json()) as { app_version?: unknown };
    const online =
      typeof body.app_version === "string" && body.app_version.trim().length > 0
        ? body.app_version.trim()
        : null;
    if (!online) {
      return {
        local_app_version: local,
        gateway_online_app_version: null,
        aligned: false,
        check_url: checkUrl,
        error: "ONLINE_VERSION_MISSING",
      };
    }
    return {
      local_app_version: local,
      gateway_online_app_version: online,
      aligned: online === local,
      check_url: checkUrl,
      error: null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const error =
      err instanceof Error && err.name === "AbortError" ? "FETCH_TIMEOUT" : `FETCH_FAILED:${detail}`;
    return {
      local_app_version: local,
      gateway_online_app_version: null,
      aligned: false,
      check_url: checkUrl,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}
