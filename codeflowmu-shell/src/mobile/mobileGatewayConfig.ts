import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";

import {
  defaultGatewayEnabled,
  loadRuntimeInstance,
} from "../runtime-instance.ts";

export interface MobileGatewayConfig {
  enabled: boolean;
  mode: string;
  gateway_url: string;
  public_base_url: string;
  runtime_instance_id: string;
  instance_id: string;
  instance_secret: string;
  auto_connect: boolean;
}

const CONFIG_REL = join(".codeflowmu", "mobile-gateway.json");
const EXAMPLE_CONFIG_REL = join(
  ".codeflowmu",
  "mobile-gateway.example.json",
);
const ADOPTED_SERVER_TEMPLATE_REL = join(
  "adoptedSource",
  "gateway",
  "mobile-gateway.server.json",
);

type GatewayTemplate = Omit<
  MobileGatewayConfig,
  "runtime_instance_id" | "instance_id" | "instance_secret"
>;

const DEFAULT_LOCAL: GatewayTemplate = {
  enabled: true,
  mode: "local_gateway",
  gateway_url: "ws://127.0.0.1:5262/gateway/pc",
  public_base_url: "http://127.0.0.1:5262",
  auto_connect: true,
};

function mobileGatewayOwnerRoot(projectRoot: string): string {
  const hostRoot = process.env["CODEFLOWMU_HOST_ROOT"]?.trim();
  return pathResolve(hostRoot || projectRoot);
}

export function mobileGatewayConfigPath(projectRoot: string): string {
  return join(mobileGatewayOwnerRoot(projectRoot), CONFIG_REL);
}

function adoptedServerGatewayTemplatePath(projectRoot: string): string {
  return join(projectRoot, ADOPTED_SERVER_TEMPLATE_REL);
}

function openEditionGatewayTemplatePath(): string | null {
  if (process.env["CODEFLOW_OPEN_EDITION"] !== "1") {
    return null;
  }
  const hostRoot = process.env["CODEFLOW_OPEN_HOST_ROOT"]?.trim();
  return hostRoot ? join(hostRoot, EXAMPLE_CONFIG_REL) : null;
}

function parseGatewayTemplate(
  parsed: Partial<GatewayTemplate> | null | undefined,
  fallback: GatewayTemplate,
): GatewayTemplate | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return {
    enabled: parsed.enabled !== false,
    mode:
      typeof parsed.mode === "string" && parsed.mode.length > 0 ? parsed.mode : fallback.mode,
    gateway_url:
      typeof parsed.gateway_url === "string" && parsed.gateway_url.length > 0
        ? parsed.gateway_url
        : fallback.gateway_url,
    public_base_url:
      typeof parsed.public_base_url === "string" && parsed.public_base_url.length > 0
        ? parsed.public_base_url.replace(/\/$/, "")
        : fallback.public_base_url,
    auto_connect: parsed.auto_connect !== false,
  };
}

/** Server-side gateway defaults shipped with the product (no instance credentials). */
function loadAdoptedServerGatewayTemplate(projectRoot: string): GatewayTemplate | null {
  const filePath = adoptedServerGatewayTemplatePath(projectRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayTemplate>;
    return parseGatewayTemplate(parsed, DEFAULT_LOCAL);
  } catch {
    return null;
  }
}

/** Product-controlled Gateway endpoint for the open edition (never contains instance credentials). */
function loadOpenEditionGatewayTemplate(): GatewayTemplate | null {
  const filePath = openEditionGatewayTemplatePath();
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayTemplate>;
    return parseGatewayTemplate(parsed, DEFAULT_LOCAL);
  } catch {
    return null;
  }
}

function resolveDefaultGatewayTemplate(projectRoot: string): GatewayTemplate {
  return (
    loadOpenEditionGatewayTemplate() ??
    loadAdoptedServerGatewayTemplate(projectRoot) ??
    DEFAULT_LOCAL
  );
}

function generateInstanceId(): string {
  return `pc_${randomBytes(8).toString("hex")}`;
}

function generateInstanceSecret(): string {
  return `secret_${randomBytes(24).toString("base64url")}`;
}

function currentRuntimeInstanceId(projectRoot: string): string {
  const envId = process.env["CODEFLOWMU_RUNTIME_INSTANCE_ID"]?.trim();
  if (envId) return envId;
  const ownerRoot = mobileGatewayOwnerRoot(projectRoot);
  const local = loadRuntimeInstance(ownerRoot);
  if (local?.instance_id) return local.instance_id;
  const normalizedOwnerRoot =
    process.platform === "win32" ? ownerRoot.toLowerCase() : ownerRoot;
  const digest = createHash("sha256")
    .update(`codeflowmu-runtime-legacy-v1:${normalizedOwnerRoot}`)
    .digest("hex");
  return `legacy-${digest.slice(0, 24)}`;
}

export function loadMobileGatewayConfig(projectRoot: string): MobileGatewayConfig | null {
  const filePath = mobileGatewayConfigPath(projectRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MobileGatewayConfig>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      enabled: parsed.enabled !== false,
      mode: typeof parsed.mode === "string" ? parsed.mode : DEFAULT_LOCAL.mode,
      gateway_url:
        typeof parsed.gateway_url === "string" && parsed.gateway_url.length > 0
          ? parsed.gateway_url
          : DEFAULT_LOCAL.gateway_url,
      public_base_url:
        typeof parsed.public_base_url === "string" && parsed.public_base_url.length > 0
          ? parsed.public_base_url.replace(/\/$/, "")
          : DEFAULT_LOCAL.public_base_url,
      runtime_instance_id:
        typeof parsed.runtime_instance_id === "string"
          ? parsed.runtime_instance_id
          : "",
      instance_id: typeof parsed.instance_id === "string" ? parsed.instance_id : "",
      instance_secret: typeof parsed.instance_secret === "string" ? parsed.instance_secret : "",
      auto_connect: parsed.auto_connect !== false,
    };
  } catch {
    return null;
  }
}

export function saveMobileGatewayConfig(projectRoot: string, config: MobileGatewayConfig): void {
  const filePath = mobileGatewayConfigPath(projectRoot);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Load config or create defaults with generated instance_id / instance_secret. */
export function ensureMobileGatewayCredentials(projectRoot: string): MobileGatewayConfig {
  const existing = loadMobileGatewayConfig(projectRoot);
  const openEditionTemplate = loadOpenEditionGatewayTemplate();
  const runtime_instance_id = currentRuntimeInstanceId(projectRoot);
  const instanceRole =
    process.env["CODEFLOWMU_INSTANCE_ROLE"]?.trim() || "stable";
  const base = openEditionTemplate
    ? {
        ...openEditionTemplate,
        ...(existing
          ? {
              enabled: existing.enabled,
              auto_connect: existing.auto_connect,
            }
          : {}),
        runtime_instance_id: existing?.runtime_instance_id ?? "",
        instance_id: existing?.instance_id ?? "",
        instance_secret: existing?.instance_secret ?? "",
      }
    : existing ?? {
        ...resolveDefaultGatewayTemplate(projectRoot),
        runtime_instance_id: "",
        instance_id: "",
        instance_secret: "",
      };
  let changed = existing === null;
  const unboundLegacyCredentials =
    base.runtime_instance_id.length === 0 &&
    (base.instance_id.length > 0 || base.instance_secret.length > 0);
  const copiedCredentials =
    unboundLegacyCredentials ||
    (base.runtime_instance_id.length > 0 &&
      base.runtime_instance_id !== runtime_instance_id);
  const instance_id =
    !copiedCredentials && base.instance_id.length > 0
      ? base.instance_id
      : generateInstanceId();
  const instance_secret =
    !copiedCredentials && base.instance_secret.length > 0
      ? base.instance_secret
      : generateInstanceSecret();
  if (
    instance_id !== base.instance_id ||
    instance_secret !== base.instance_secret ||
    runtime_instance_id !== base.runtime_instance_id
  ) {
    changed = true;
  }
  const firstRunGatewayEnabled =
    (!copiedCredentials &&
      existing !== null &&
      base.runtime_instance_id.length > 0) ||
    defaultGatewayEnabled(instanceRole);
  const config: MobileGatewayConfig = {
    enabled: firstRunGatewayEnabled ? base.enabled : false,
    mode: base.mode,
    gateway_url: base.gateway_url,
    public_base_url: base.public_base_url,
    runtime_instance_id,
    instance_id,
    instance_secret,
    auto_connect: firstRunGatewayEnabled ? base.auto_connect : false,
  };
  if (
    existing &&
    (existing.enabled !== config.enabled ||
      existing.mode !== config.mode ||
      existing.gateway_url !== config.gateway_url ||
      existing.public_base_url !== config.public_base_url ||
      existing.auto_connect !== config.auto_connect)
  ) {
    changed = true;
  }
  if (changed) {
    saveMobileGatewayConfig(projectRoot, config);
  }
  return config;
}

/** Recover from a confirmed duplicate live connection using the same credentials. */
export function rotateMobileGatewayCredentials(projectRoot: string): MobileGatewayConfig {
  const current = ensureMobileGatewayCredentials(projectRoot);
  const rotated: MobileGatewayConfig = {
    ...current,
    instance_id: generateInstanceId(),
    instance_secret: generateInstanceSecret(),
  };
  saveMobileGatewayConfig(projectRoot, rotated);
  return rotated;
}

export function resolvePublicBaseUrl(projectRoot: string): string {
  const env = process.env.CODEFLOWMU_GATEWAY_PUBLIC_BASE?.trim();
  if (env && env.length > 0) {
    return env.replace(/\/$/, "");
  }
  const cfg = loadMobileGatewayConfig(projectRoot);
  if (cfg?.public_base_url) {
    return cfg.public_base_url.replace(/\/$/, "");
  }
  return "https://ai.chedian.cc/codeflowmu";
}
