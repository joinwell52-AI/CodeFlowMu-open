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

export async function publishPwaToGateway(
  projectRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PwaGatewayPublishResult> {
  return {
    ok: false,
    error: "OPEN_EDITION_GATEWAY_PUBLISH_DISABLED",
    mode: "dry_run",
    steps: [
      {
        id: "open_edition_disabled",
        ok: false,
        message: "OPEN_EDITION_GATEWAY_PUBLISH_DISABLED",
      },
    ],
    pwa_gateway: await fetchPwaGatewaySyncStatus(projectRoot, fetchImpl),
  };
}
