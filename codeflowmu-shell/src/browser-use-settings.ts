import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readWindowsUseSettings,
  type WindowsUseLoginMethod,
  type WindowsUseVerificationChannel,
} from "./windows-use-settings.ts";

export interface BrowserUseTarget {
  id: string;
  name: string;
  description: string;
  url: string;
  browser: "chrome" | "edge";
  loginMethod: WindowsUseLoginMethod;
  verificationChannel: WindowsUseVerificationChannel;
  loginInstruction: string;
  loginProfile: BrowserUseLoginProfile;
  credentialRef: string;
}

export interface BrowserUseLoginProfile {
  entryUrl: string;
  usernameLabel: string;
  passwordLabel: string;
  tenantLabel: string;
  tenantValue: string;
  verificationLabel: string;
  submitLabel: string;
  successUrlPrefix: string;
  successText: string;
}

export interface BrowserUseSettings {
  version: 1;
  enabled: boolean;
  allowedTargetIds: string[];
  targets: BrowserUseTarget[];
  updatedAt: string | null;
  migratedFromWindowsUse?: boolean;
}

const RELATIVE_PATH = join(".codeflowmu", "runtime", "browser-use.json");
const LOGIN_METHODS = new Set<WindowsUseLoginMethod>([
  "unspecified", "none", "username_password", "qr_code", "verification_code",
  "username_password_verification_code", "other",
]);
const CHANNELS = new Set<WindowsUseVerificationChannel>(["none", "sms", "email", "authenticator", "other"]);

export function browserUseSettingsPath(projectRoot: string): string {
  return join(projectRoot, RELATIVE_PATH);
}

function credentialRef(id: string): string {
  return `CODEFLOW_BROWSER_TARGET_${id.replace(/-/g, "_").toUpperCase()}`;
}

function normalizeTarget(value: unknown): BrowserUseTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser Use target must be an object");
  const raw = value as Record<string, unknown>;
  const id = String(raw["id"] ?? "").trim().toLowerCase();
  const name = String(raw["name"] ?? "").trim();
  const description = String(raw["description"] ?? "").trim();
  const url = String(raw["url"] ?? raw["target"] ?? "").trim();
  const browser = raw["browser"] === "edge" ? "edge" : "chrome";
  const method = String(raw["loginMethod"] ?? "unspecified") as WindowsUseLoginMethod;
  const channel = String(raw["verificationChannel"] ?? "none") as WindowsUseVerificationChannel;
  const loginInstruction = String(raw["loginInstruction"] ?? "").trim();
  const rawProfile = raw["loginProfile"] && typeof raw["loginProfile"] === "object" && !Array.isArray(raw["loginProfile"])
    ? raw["loginProfile"] as Record<string, unknown> : {};
  const loginProfile: BrowserUseLoginProfile = {
    entryUrl: String(rawProfile["entryUrl"] ?? "").trim(),
    usernameLabel: String(rawProfile["usernameLabel"] ?? "帐号").trim(),
    passwordLabel: String(rawProfile["passwordLabel"] ?? "密码").trim(),
    tenantLabel: String(rawProfile["tenantLabel"] ?? "").trim(),
    tenantValue: String(rawProfile["tenantValue"] ?? "").trim(),
    verificationLabel: String(rawProfile["verificationLabel"] ?? "验证码").trim(),
    submitLabel: String(rawProfile["submitLabel"] ?? "登录").trim(),
    successUrlPrefix: String(rawProfile["successUrlPrefix"] ?? raw["successUrlPrefix"] ?? "").trim(),
    successText: String(rawProfile["successText"] ?? "").trim(),
  };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Target id must use lowercase letters, numbers, and hyphens");
  if (!name || name.length > 100) throw new Error("Target name is required and must not exceed 100 characters");
  if (description.length > 500 || loginInstruction.length > 500) throw new Error("Description fields must not exceed 500 characters");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Browser target must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Browser target must use HTTPS without embedded credentials");
  for (const [key, value] of Object.entries(loginProfile)) if (value.length > 300) throw new Error(`Login profile field ${key} must not exceed 300 characters`);
  for (const [label, value] of [["Login entry URL", loginProfile.entryUrl], ["Login success URL", loginProfile.successUrlPrefix]] as const) if (value) {
    let success: URL;
    try { success = new URL(value); } catch { throw new Error(`${label} must be a valid HTTPS URL`); }
    if (success.protocol !== "https:" || success.origin !== parsed.origin) throw new Error(`${label} must use the same approved HTTPS origin`);
  }
  return {
    id, name, description, url, browser,
    loginMethod: LOGIN_METHODS.has(method) ? method : "unspecified",
    verificationChannel: method.includes("verification_code") && CHANNELS.has(channel) ? channel : "none",
    loginInstruction,
    loginProfile,
    credentialRef: credentialRef(id),
  };
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))].sort();
}

function migrateLegacy(projectRoot: string): BrowserUseSettings {
  const legacy = readWindowsUseSettings(projectRoot);
  const targets = legacy.targets.filter((item) => item.type === "web").map((item) => normalizeTarget(item));
  return {
    version: 1,
    enabled: legacy.enabled && targets.length > 0,
    allowedTargetIds: legacy.allowedTargetIds.filter((id) => targets.some((target) => target.id === id)),
    targets,
    updatedAt: legacy.updatedAt,
    migratedFromWindowsUse: targets.length > 0,
  };
}

export function readBrowserUseSettings(projectRoot: string): BrowserUseSettings {
  const path = browserUseSettingsPath(projectRoot);
  if (!existsSync(path)) return migrateLegacy(projectRoot);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const targets = Array.isArray(raw["targets"]) ? raw["targets"].map(normalizeTarget) : [];
    const valid = new Set(targets.map((target) => target.id));
    return {
      version: 1,
      enabled: raw["enabled"] === true,
      allowedTargetIds: normalizeIds(raw["allowedTargetIds"]).filter((id) => valid.has(id)),
      targets,
      updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : null,
    };
  } catch {
    return { version: 1, enabled: false, allowedTargetIds: [], targets: [], updatedAt: null };
  }
}

function persist(projectRoot: string, settings: BrowserUseSettings): BrowserUseSettings {
  const path = browserUseSettingsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const clean = { ...settings };
  delete clean.migratedFromWindowsUse;
  writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return clean;
}

export function writeBrowserUseSettings(projectRoot: string, input: { enabled?: unknown; allowedTargetIds?: unknown }): BrowserUseSettings {
  const current = readBrowserUseSettings(projectRoot);
  const valid = new Set(current.targets.map((target) => target.id));
  return persist(projectRoot, {
    ...current,
    enabled: input.enabled === true,
    allowedTargetIds: normalizeIds(input.allowedTargetIds).filter((id) => valid.has(id)),
    updatedAt: new Date().toISOString(),
  });
}

function readEnv(projectRoot: string): Map<string, string> {
  const path = join(projectRoot, ".env");
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    values.set(match[1]!, value);
  }
  return values;
}

function writeEnv(projectRoot: string, updates: Map<string, string | null>): void {
  const path = join(projectRoot, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const keys = new Set(updates.keys());
  const kept = lines.filter((line) => { const match = line.match(/^\s*([A-Z0-9_]+)\s*=/); return !match || !keys.has(match[1]!); });
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  for (const [key, value] of updates) if (value != null) kept.push(`${key}=${JSON.stringify(value)}`);
  const temp = `${path}.${process.pid}.browser-use.tmp`;
  writeFileSync(temp, `${kept.join("\n")}\n`, "utf8");
  renameSync(temp, path);
}

function legacyRef(id: string): string { return `CODEFLOW_WINDOWS_TARGET_${id.replace(/-/g, "_").toUpperCase()}`; }

export function readBrowserUseCredentials(projectRoot: string, target: BrowserUseTarget): { username: string; password: string } {
  const env = readEnv(projectRoot);
  return {
    username: env.get(`${target.credentialRef}_USERNAME`) ?? env.get(`${legacyRef(target.id)}_USERNAME`) ?? "",
    password: env.get(`${target.credentialRef}_PASSWORD`) ?? env.get(`${legacyRef(target.id)}_PASSWORD`) ?? "",
  };
}

export function listBrowserUseTargets(projectRoot: string): Array<BrowserUseTarget & { username: string; hasPassword: boolean }> {
  return readBrowserUseSettings(projectRoot).targets.map((target) => {
    const credentials = readBrowserUseCredentials(projectRoot, target);
    return { ...target, username: credentials.username, hasPassword: Boolean(credentials.password) };
  });
}

export function upsertBrowserUseTarget(projectRoot: string, input: unknown, credentials: { username?: string; password?: string }): BrowserUseTarget {
  const target = normalizeTarget(input);
  if (target.loginMethod === "unspecified") throw new Error("Login method must be selected");
  const current = readBrowserUseSettings(projectRoot);
  const targets = current.targets.filter((item) => item.id !== target.id).concat(target);
  persist(projectRoot, {
    ...current,
    targets,
    allowedTargetIds: [...new Set([...current.allowedTargetIds, target.id])].sort(),
    updatedAt: new Date().toISOString(),
  });
  const updates = new Map<string, string | null>();
  if (credentials.username !== undefined) updates.set(`${target.credentialRef}_USERNAME`, credentials.username);
  if (credentials.password) updates.set(`${target.credentialRef}_PASSWORD`, credentials.password);
  if (updates.size) writeEnv(projectRoot, updates);
  return target;
}

export function deleteBrowserUseTarget(projectRoot: string, id: string): boolean {
  const current = readBrowserUseSettings(projectRoot);
  const target = current.targets.find((item) => item.id === id);
  if (!target) return false;
  persist(projectRoot, {
    ...current,
    targets: current.targets.filter((item) => item.id !== id),
    allowedTargetIds: current.allowedTargetIds.filter((item) => item !== id),
    updatedAt: new Date().toISOString(),
  });
  writeEnv(projectRoot, new Map([[`${target.credentialRef}_USERNAME`, null], [`${target.credentialRef}_PASSWORD`, null]]));
  return true;
}
