import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchPwaGatewaySyncStatus } from "../mobile/mobilePwaGatewaySync.ts";

const APP_ID = "codeflowmu-1-2-21";
const API_CONTRACT = "codeflowmu-mobile-v2";

async function withPwaRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-pwa-sync-"));
  try {
    const mobileRoot = join(root, "codeflowmu-desktop", "mobile");
    await mkdir(mobileRoot, { recursive: true });
    await writeFile(
      join(mobileRoot, "version.json"),
      JSON.stringify({
        app_version: "V1.0.64",
        pwa_app_id: APP_ID,
        api_contract: API_CONTRACT,
      }),
      "utf8",
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

test("Gateway PWA sync requires version, app identity and API contract to align", async () => {
  await withPwaRoot(async (root) => {
    const status = await fetchPwaGatewaySyncStatus(
      root,
      (() => response({
        app_version: "V1.0.64",
        pwa_app_id: APP_ID,
        api_contract: API_CONTRACT,
      })) as typeof fetch,
    );

    assert.equal(status.aligned, true);
    assert.equal(status.error, null);
    assert.equal(status.gateway_online_pwa_app_id, APP_ID);
    assert.equal(status.gateway_online_api_contract, API_CONTRACT);
  });
});

test("Gateway PWA sync rejects a version response from another product line", async () => {
  await withPwaRoot(async (root) => {
    const status = await fetchPwaGatewaySyncStatus(
      root,
      (() => response({
        app_version: "V1.0.65",
        pwa_app_id: "codeflowmu-main",
        api_contract: API_CONTRACT,
      })) as typeof fetch,
    );

    assert.equal(status.aligned, false);
    assert.equal(status.error, "PWA_METADATA_MISMATCH");
    assert.equal(status.gateway_online_pwa_app_id, "codeflowmu-main");
  });
});

test("Gateway PWA sync rejects a missing or incompatible API contract", async () => {
  await withPwaRoot(async (root) => {
    const status = await fetchPwaGatewaySyncStatus(
      root,
      (() => response({
        app_version: "V1.0.64",
        pwa_app_id: APP_ID,
        api_contract: "codeflowmu-mobile-v1",
      })) as typeof fetch,
    );

    assert.equal(status.aligned, false);
    assert.equal(status.error, "PWA_API_CONTRACT_MISMATCH");
  });
});
