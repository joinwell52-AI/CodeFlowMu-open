import { randomBytes } from "node:crypto";
import type { Router } from "express";


import type { MobileBindStore } from "./mobileBindStore.ts";
import type { MobileDeviceStore } from "./mobileDeviceStore.ts";
import {
  getMobileGatewayStatus,
  reconnectMobileGatewayClient,
} from "./mobileGatewayClient.ts";
import { resolvePublicBaseUrl } from "./mobileGatewayConfig.ts";
import { getMobileInstanceId } from "./mobileInstance.ts";
import { isRemoteGatewayPublishAvailable, publishPwaToGateway } from "./mobilePwaGatewayPublish.ts";
import { fetchPwaGatewaySyncStatus } from "./mobilePwaGatewaySync.ts";
import { readCodeflowmuVersionHistory, readCodeflowmuVersionManifest } from "./mobileVersion.ts";
import type { MobilePanelContext } from "./types.ts";

export const MOBILE_BIND_PREPARE_TTL_MS = 10 * 60 * 1000;

function gatewayStatusFields(
  projectRoot: string,
  ctx: MobilePanelContext,
): Record<string, unknown> {
  const st = getMobileGatewayStatus();
  const ctxOnline = ctx.gatewayOnline?.() ?? false;
  return {
    gateway_online: st.online || ctxOnline,
    online: st.online || ctxOnline,
    reconnecting: st.reconnecting,
    instance_id: st.instance_id ?? getMobileInstanceId(projectRoot),
    last_connected_at: st.last_connected_at,
    last_seen_at: st.last_seen_at,
    last_error: st.last_error,
    gateway_url: st.gateway_url,
    public_base_url: resolvePublicBaseUrl(projectRoot),
  };
}

function generateBindId(): string {
  return `b_${randomBytes(6).toString("hex")}`;
}

function generateBindToken(): string {
  // 128 bits remains ample for a single-use token with a ten-minute TTL,
  // while producing a materially less dense screen-scanned QR code.
  return randomBytes(16).toString("base64url");
}

export function registerMobilePanelRoutes(
  router: Router,
  deps: {
    ctx: MobilePanelContext;
    bindStore: MobileBindStore;
    deviceStore: MobileDeviceStore;
  },
): void {
  router.get("/panel/version-info", async (_req, res) => {
    const versions = readCodeflowmuVersionManifest();
    if (!versions) {
      res.json({ ok: false, error: "VERSION_UNAVAILABLE" });
      return;
    }
    const projectRoot = deps.ctx.getProjectRoot();
    const pwa_gateway = await fetchPwaGatewaySyncStatus(projectRoot);
    const openReadOnly = process.env.CODEFLOW_OPEN_EDITION === "1";
    const pwa_gateway_publish = {
      available: isRemoteGatewayPublishAvailable(projectRoot),
      read_only: openReadOnly,
    };
    res.json({ ok: true, versions, pwa_gateway, pwa_gateway_publish });
  });

  router.post("/panel/publish-gateway", async (req, res) => {
    if (process.env.CODEFLOW_OPEN_EDITION === "1") {
      res.status(403).json({
        ok: false,
        error: "OPEN_EDITION_GATEWAY_PUBLISH_DISABLED",
      });
      return;
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ ok: false, error: "CONFIRM_REQUIRED" });
      return;
    }
    const projectRoot = deps.ctx.getProjectRoot();
    const result = await publishPwaToGateway(projectRoot);
    res.status(result.ok ? 200 : 502).json(result);
  });

  

  router.get("/panel/version-history", (_req, res) => {
    const items = readCodeflowmuVersionHistory();
    if (!items) {
      res.json({ ok: false, error: "version_history_unavailable" });
      return;
    }
    res.json({ ok: true, items });
  });

  router.get("/panel/status", (_req, res) => {
    const projectRoot = deps.ctx.getProjectRoot();
    res.json({
      ok: true,
      instance_id: getMobileInstanceId(projectRoot),
      ...gatewayStatusFields(projectRoot, deps.ctx),
    });
  });

  router.post("/panel/bind-prepare", (_req, res) => {
    const bindId = generateBindId();
    const token = generateBindToken();
    const ttlMs = MOBILE_BIND_PREPARE_TTL_MS;
    deps.bindStore.register(bindId, token, ttlMs);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const projectRoot = deps.ctx.getProjectRoot();
    res.json({
      ok: true,
      bind_id: bindId,
      token,
      expires_at: expiresAt,
      instance_id: getMobileInstanceId(projectRoot),
      ...gatewayStatusFields(projectRoot, deps.ctx),
    });
  });

  router.get("/panel/devices", (_req, res) => {
    const devices = deps.deviceStore.listDevices().map((d) => ({
      device_id: d.device_id,
      device_name: d.device_name,
      bound_at: d.bound_at,
      last_seen_at: d.last_seen_at,
      enabled: d.enabled,
    }));
    res.json({ ok: true, devices });
  });

  router.post("/panel/devices/:deviceId/revoke", (req, res) => {
    const deviceId = String(req.params.deviceId ?? "").trim();
    if (!deviceId) {
      res.status(400).json({ ok: false, error: "MISSING_DEVICE_ID" });
      return;
    }
    const ok = deps.deviceStore.revokeDevice(deviceId);
    if (!ok) {
      res.status(404).json({ ok: false, error: "DEVICE_NOT_FOUND" });
      return;
    }
    res.json({ ok: true, device_id: deviceId });
  });

  router.post("/panel/devices/revoke-others", (req, res) => {
    const keepDeviceId =
      typeof req.body?.keep_device_id === "string" ? req.body.keep_device_id.trim() : "";
    const { kept, revoked } = deps.deviceStore.revokeAllExcept(keepDeviceId || undefined);
    res.json({ ok: true, kept_device_id: kept, revoked_device_ids: revoked });
  });

  router.post("/panel/devices/purge-revoked", (_req, res) => {
    const removed = deps.deviceStore.purgeRevokedDevices();
    res.json({ ok: true, removed_count: removed });
  });

  router.get("/gateway/status", (_req, res) => {
    const projectRoot = deps.ctx.getProjectRoot();
    const st = getMobileGatewayStatus();
    res.json({
      ok: true,
      online: st.online,
      reconnecting: st.reconnecting,
      instance_id: st.instance_id ?? getMobileInstanceId(projectRoot),
      last_connected_at: st.last_connected_at,
      last_seen_at: st.last_seen_at,
      last_error: st.last_error,
      gateway_url: st.gateway_url,
      public_base_url: resolvePublicBaseUrl(projectRoot),
    });
  });

  router.post("/gateway/reconnect", async (_req, res) => {
    const result = await reconnectMobileGatewayClient();
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error ?? "RECONNECT_FAILED" });
      return;
    }
    const projectRoot = deps.ctx.getProjectRoot();
    const st = getMobileGatewayStatus();
    res.json({
      ok: true,
      online: st.online,
      reconnecting: st.reconnecting,
      instance_id: st.instance_id ?? getMobileInstanceId(projectRoot),
      last_connected_at: st.last_connected_at,
      last_error: st.last_error,
    });
  });
}
