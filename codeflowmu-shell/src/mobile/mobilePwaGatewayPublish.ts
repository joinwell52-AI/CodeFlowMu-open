import {
  fetchPwaGatewaySyncStatus,
  type PwaGatewaySyncStatus,
} from "./mobilePwaGatewaySync.ts";

export type PwaGatewayPublishStep = {
  id: string;
  ok: boolean;
  message?: string;
  log_tail?: string;
};

export type PwaGatewayPublishResult = {
  ok: boolean;
  error: string | null;
  mode: "already_aligned" | "remote_push" | "dry_run";
  steps: PwaGatewayPublishStep[];
  pwa_gateway: PwaGatewaySyncStatus | null;
};

export function isRemoteGatewayPublishAvailable(_projectRoot?: string): boolean {
  return false;
}

export function isPwaGatewayPublishReadOnly(): boolean {
  return true;
}

export async function publishPwaToGateway(
  projectRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PwaGatewayPublishResult> {
  return {
    ok: false,
    error: "PWA_GATEWAY_PUBLISH_AUTHORITY_EXTERNAL",
    mode: "dry_run",
    steps: [
      {
        id: "open_edition_disabled",
        ok: false,
        message: "PWA_GATEWAY_PUBLISH_AUTHORITY_EXTERNAL",
      },
    ],
    pwa_gateway: await fetchPwaGatewaySyncStatus(projectRoot, fetchImpl),
  };
}
