import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveMobilePublicApiBase } from "./mobileInstance.ts";
import { MOBILE_PWA_IDENTITY } from "./mobilePwaIdentity.ts";
import { readCodeflowmuVersionManifest } from "./mobileVersion.ts";

export type PwaGatewaySyncStatus = {
  /** Local authoritative PWA app_version (version.json, then manifest mobile_pwa). */
  local_app_version: string | null;
  /** Stable product identity expected by this source line. */
  local_pwa_app_id: string;
  /** Runtime/API contract expected by this source line. */
  local_api_contract: string;
  /** app_version from Gateway-hosted mobile/version.json (null if unreachable). */
  gateway_online_app_version: string | null;
  /** pwa_app_id from Gateway-hosted mobile/version.json. */
  gateway_online_pwa_app_id: string | null;
  /** api_contract from Gateway-hosted mobile/version.json. */
  gateway_online_api_contract: string | null;
  /** true only when version, product identity and API contract all match. */
  aligned: boolean;
  /** Full URL used for the online check. */
  check_url: string;
  /** Non-null when fetch/parse failed or local version missing. */
  error: string | null;
};

const FETCH_TIMEOUT_MS = 12_000;

type LocalMobilePwaVersion = {
  appVersion: string | null;
  appId: string;
  apiContract: string;
};

function readLocalMobileVersionJson(projectRoot: string): LocalMobilePwaVersion | null {
  const path = join(projectRoot, "codeflowmu-desktop", "mobile", "version.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      app_version?: unknown;
      pwa_app_id?: unknown;
      api_contract?: unknown;
    };
    const v = typeof raw.app_version === "string" ? raw.app_version.trim() : "";
    const appId = typeof raw.pwa_app_id === "string" ? raw.pwa_app_id.trim() : "";
    const apiContract = typeof raw.api_contract === "string" ? raw.api_contract.trim() : "";
    return {
      appVersion: v || null,
      appId: appId || MOBILE_PWA_IDENTITY.app_id,
      apiContract: apiContract || MOBILE_PWA_IDENTITY.api_contract,
    };
  } catch {
    return null;
  }
}

function resolveLocalPwaVersion(projectRoot: string): LocalMobilePwaVersion {
  const local = readLocalMobileVersionJson(projectRoot);
  return {
    appVersion: local?.appVersion ?? readCodeflowmuVersionManifest()?.mobile_pwa ?? null,
    appId: local?.appId ?? MOBILE_PWA_IDENTITY.app_id,
    apiContract: local?.apiContract ?? MOBILE_PWA_IDENTITY.api_contract,
  };
}

export async function fetchPwaGatewaySyncStatus(
  projectRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PwaGatewaySyncStatus> {
  const local = resolveLocalPwaVersion(projectRoot);
  const checkUrl = `${resolveMobilePublicApiBase(projectRoot)}/mobile/version.json`;
  const base = {
    local_app_version: local.appVersion,
    local_pwa_app_id: local.appId,
    local_api_contract: local.apiContract,
    gateway_online_app_version: null,
    gateway_online_pwa_app_id: null,
    gateway_online_api_contract: null,
    aligned: false,
    check_url: checkUrl,
  };

  if (!local.appVersion) {
    return {
      ...base,
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
        ...base,
        error: `HTTP_${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      app_version?: unknown;
      pwa_app_id?: unknown;
      api_contract?: unknown;
    };
    const online =
      typeof body.app_version === "string" && body.app_version.trim().length > 0
        ? body.app_version.trim()
        : null;
    const onlineAppId =
      typeof body.pwa_app_id === "string" && body.pwa_app_id.trim().length > 0
        ? body.pwa_app_id.trim()
        : null;
    const onlineApiContract =
      typeof body.api_contract === "string" && body.api_contract.trim().length > 0
        ? body.api_contract.trim()
        : null;
    const onlineFields = {
      gateway_online_app_version: online,
      gateway_online_pwa_app_id: onlineAppId,
      gateway_online_api_contract: onlineApiContract,
    };
    if (!online) {
      return {
        ...base,
        ...onlineFields,
        error: "ONLINE_VERSION_MISSING",
      };
    }
    if (!onlineAppId || onlineAppId !== local.appId) {
      return {
        ...base,
        ...onlineFields,
        error: "PWA_METADATA_MISMATCH",
      };
    }
    if (!onlineApiContract || onlineApiContract !== local.apiContract) {
      return {
        ...base,
        ...onlineFields,
        error: "PWA_API_CONTRACT_MISMATCH",
      };
    }
    return {
      ...base,
      ...onlineFields,
      aligned: online === local.appVersion,
      error: null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const error =
      err instanceof Error && err.name === "AbortError" ? "FETCH_TIMEOUT" : `FETCH_FAILED:${detail}`;
    return {
      ...base,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}
