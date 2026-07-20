import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export type WindowsUseLoginMethod =
  | "unspecified"
  | "none"
  | "username_password"
  | "qr_code"
  | "verification_code"
  | "username_password_verification_code"
  | "other";

export type WindowsUseVerificationChannel = "none" | "sms" | "email" | "authenticator" | "other";

export interface WindowsUseTarget {
  id: string;
  name: string;
  description: string;
  type: "native" | "web";
  target: string;
  browser?: "chrome" | "edge";
  loginMethod: WindowsUseLoginMethod;
  verificationChannel: WindowsUseVerificationChannel;
  loginInstruction: string;
  credentialRef: string;
}

export interface WindowsUseSettings {
  version: 1;
  enabled: boolean;
  alwaysAllowedAppIds: string[];
  allowedTargetIds: string[];
  targets: WindowsUseTarget[];
  updatedAt: string | null;
}

export interface EffectiveWindowsUseSettings extends WindowsUseSettings {
  source: "project" | "environment";
}

const SETTINGS_RELATIVE_PATH = join(".codeflowmu", "runtime", "windows-use.json");
const MAX_ALLOWED_APPS = 100;
const MAX_TARGETS = 100;
const LOGIN_METHODS = new Set<WindowsUseLoginMethod>([
  "unspecified", "none", "username_password", "qr_code", "verification_code",
  "username_password_verification_code", "other",
]);
const VERIFICATION_CHANNELS = new Set<WindowsUseVerificationChannel>(["none", "sms", "email", "authenticator", "other"]);
const HARD_BLOCKED_APP_IDS = new Set([
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "wt.exe",
  "windowsterminal.exe",
  "applicationframehost.exe",
  "clicktodo.exe",
  "textinputhost.exe",
  "msedgewebview2.exe",
  "chatgpt.exe",
  "codex.exe",
  "codeflowmu.exe",
]);

export function windowsUseSettingsPath(projectRoot: string): string {
  return join(projectRoot, SETTINGS_RELATIVE_PATH);
}

export function normalizeWindowsAppId(value: unknown): string {
  if (typeof value !== "string") return "";
  return basename(value.trim()).trim().toLowerCase();
}

function normalizeAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = [...new Set(value.map(normalizeWindowsAppId).filter(Boolean))];
  if (normalized.length > MAX_ALLOWED_APPS) {
    throw new Error(`Windows Use application allowlist cannot exceed ${MAX_ALLOWED_APPS} entries`);
  }
  const blocked = normalized.filter((appId) => HARD_BLOCKED_APP_IDS.has(appId));
  if (blocked.length > 0) {
    throw new Error(`Windows Use cannot approve protected applications: ${blocked.join(", ")}`);
  }
  return normalized.sort();
}

function normalizeTarget(value: unknown): WindowsUseTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows Use target must be an object");
  }
  const raw = value as Record<string, unknown>;
  const id = String(raw["id"] ?? "").trim().toLowerCase();
  const name = String(raw["name"] ?? "").trim();
  const description = String(raw["description"] ?? "").trim();
  const type = raw["type"] === "web" ? "web" : "native";
  const target = String(raw["target"] ?? "").trim();
  const rawLoginMethod = String(raw["loginMethod"] ?? "unspecified") as WindowsUseLoginMethod;
  const loginMethod = LOGIN_METHODS.has(rawLoginMethod) ? rawLoginMethod : "unspecified";
  const rawVerificationChannel = String(raw["verificationChannel"] ?? "none") as WindowsUseVerificationChannel;
  const verificationChannel = VERIFICATION_CHANNELS.has(rawVerificationChannel) ? rawVerificationChannel : "none";
  const loginInstruction = String(raw["loginInstruction"] ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Target id must use lowercase letters, numbers, and hyphens");
  if (!name || name.length > 100) throw new Error("Target name is required and must not exceed 100 characters");
  if (description.length > 500) throw new Error("Target description must not exceed 500 characters");
  if (loginInstruction.length > 500) throw new Error("Login instruction must not exceed 500 characters");
  if (type === "web") {
    let parsed: URL;
    try { parsed = new URL(target); } catch { throw new Error("Web target must be a valid HTTPS URL"); }
    if (parsed.protocol !== "https:") throw new Error("Web target must use HTTPS");
    if (parsed.username || parsed.password) throw new Error("Do not embed credentials in the target URL");
  } else {
    if (!isAbsolute(target) || !target.toLowerCase().endsWith(".exe")) {
      throw new Error("Native target must be an absolute .exe path");
    }
    const appId = normalizeWindowsAppId(target);
    if (HARD_BLOCKED_APP_IDS.has(appId)) throw new Error(`Protected application cannot be added: ${appId}`);
  }
  const browser = raw["browser"] === "edge" ? "edge" : "chrome";
  return {
    id,
    name,
    description,
    type,
    target,
    ...(type === "web" ? { browser } : {}),
    loginMethod,
    verificationChannel: loginMethod.includes("verification_code") ? verificationChannel : "none",
    loginInstruction,
    credentialRef: `CODEFLOW_WINDOWS_TARGET_${id.replace(/-/g, "_").toUpperCase()}`,
  };
}

function normalizeTargets(value: unknown): WindowsUseTarget[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TARGETS) throw new Error(`Windows Use targets cannot exceed ${MAX_TARGETS} entries`);
  const byId = new Map<string, WindowsUseTarget>();
  for (const item of value) {
    const target = normalizeTarget(item);
    if (byId.has(target.id)) throw new Error(`Duplicate Windows Use target id: ${target.id}`);
    byId.set(target.id, target);
  }
  return [...byId.values()];
}

function normalizeTargetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter((item) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(item)))].sort();
}

export function readWindowsUseSettings(projectRoot: string): WindowsUseSettings {
  const settingsPath = windowsUseSettingsPath(projectRoot);
  if (!existsSync(settingsPath)) {
    return { version: 1, enabled: false, alwaysAllowedAppIds: [], allowedTargetIds: [], targets: [], updatedAt: null };
  }
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return {
      version: 1,
      enabled: raw["enabled"] === true,
      alwaysAllowedAppIds: normalizeAllowlist(raw["alwaysAllowedAppIds"]),
      allowedTargetIds: normalizeTargetIds(raw["allowedTargetIds"]),
      targets: normalizeTargets(raw["targets"]),
      updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : null,
    };
  } catch {
    return { version: 1, enabled: false, alwaysAllowedAppIds: [], allowedTargetIds: [], targets: [], updatedAt: null };
  }
}

export function writeWindowsUseSettings(
  projectRoot: string,
  input: Pick<WindowsUseSettings, "enabled" | "alwaysAllowedAppIds">,
): WindowsUseSettings {
  const previous = readWindowsUseSettings(projectRoot);
  const settings: WindowsUseSettings = {
    version: 1,
    enabled: input.enabled === true,
    alwaysAllowedAppIds: normalizeAllowlist(input.alwaysAllowedAppIds),
    allowedTargetIds: previous.allowedTargetIds,
    targets: previous.targets,
    updatedAt: new Date().toISOString(),
  };
  const settingsPath = windowsUseSettingsPath(projectRoot);
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tempPath, settingsPath);
  return settings;
}

export function writeWindowsUseAllowedTargetIds(projectRoot: string, ids: unknown): WindowsUseSettings {
  const settings = readWindowsUseSettings(projectRoot);
  const valid = new Set(settings.targets.map((target) => target.id));
  const next: WindowsUseSettings = {
    ...settings,
    allowedTargetIds: normalizeTargetIds(ids).filter((id) => valid.has(id)),
    updatedAt: new Date().toISOString(),
  };
  const settingsPath = windowsUseSettingsPath(projectRoot);
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tempPath, settingsPath);
  return next;
}

function readEnvFile(projectRoot: string): { lines: string[]; values: Map<string, string> } {
  const envPath = join(projectRoot, ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const values = new Map<string, string>();
  for (const raw of lines) {
    const match = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    }
    values.set(match[1]!, value);
  }
  return { lines, values };
}

function writeEnvValues(projectRoot: string, updates: Map<string, string | null>): void {
  const envPath = join(projectRoot, ".env");
  const { lines } = readEnvFile(projectRoot);
  const keys = new Set(updates.keys());
  const kept = lines.filter((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    return !match || !keys.has(match[1]!);
  });
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  for (const [key, value] of updates) {
    if (value != null) kept.push(`${key}=${JSON.stringify(value)}`);
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  mkdirSync(dirname(envPath), { recursive: true });
  const tempPath = `${envPath}.${process.pid}.windows-use.tmp`;
  writeFileSync(tempPath, `${kept.join("\n")}\n`, "utf8");
  renameSync(tempPath, envPath);
}

export function windowsUseLoginGuidance(
  target: WindowsUseTarget,
  state: { username: string; hasPassword: boolean },
): { requiresUser: boolean; summary: string } {
  const channel = target.verificationChannel === "sms" ? "短信"
    : target.verificationChannel === "email" ? "邮箱"
    : target.verificationChannel === "authenticator" ? "身份验证器"
    : target.verificationChannel === "other" ? "指定渠道" : "";
  const credentials = `${state.username ? "账号已保存" : "账号未保存"}、${state.hasPassword ? "密码已保存" : "密码未保存"}`;
  switch (target.loginMethod) {
    case "none": return { requiresUser: false, summary: "无需登录，直接进入应用。" };
    case "username_password": return { requiresUser: !state.username || !state.hasPassword, summary: `使用账号密码登录；${credentials}。` };
    case "qr_code": return { requiresUser: true, summary: "需要用户本人扫码；Agent 应停在二维码页面并等待用户完成。" };
    case "verification_code": return { requiresUser: true, summary: `需要${channel || "验证码"}验证码；Agent 应等待用户提供或完成验证。` };
    case "username_password_verification_code": return { requiresUser: true, summary: `先使用账号密码（${credentials}），再等待用户完成${channel || "验证码"}验证。` };
    case "other": return { requiresUser: true, summary: "按登录说明执行；信息不足时先询问用户，不得自行猜测。" };
    default: return { requiresUser: true, summary: "登录特征尚未设置；Agent 必须先询问用户，不得自行判断。" };
  }
}

export function listWindowsUseTargets(projectRoot: string): Array<WindowsUseTarget & { username: string; hasPassword: boolean; requiresUser: boolean; loginSummary: string }> {
  const settings = readWindowsUseSettings(projectRoot);
  const { values } = readEnvFile(projectRoot);
  return settings.targets.map((target) => {
    const username = values.get(`${target.credentialRef}_USERNAME`) ?? "";
    const hasPassword = Boolean(values.get(`${target.credentialRef}_PASSWORD`));
    const guidance = windowsUseLoginGuidance(target, { username, hasPassword });
    return { ...target, username, hasPassword, requiresUser: guidance.requiresUser, loginSummary: guidance.summary };
  });
}

export function upsertWindowsUseTarget(
  projectRoot: string,
  input: unknown,
  credentials: { username?: string; password?: string },
): WindowsUseTarget {
  const target = normalizeTarget(input);
  if (target.loginMethod === "unspecified") {
    throw new Error("Login method must be selected so the Agent does not infer the authentication flow");
  }
  const settings = readWindowsUseSettings(projectRoot);
  const targets = settings.targets.filter((item) => item.id !== target.id);
  targets.push(target);
  const allowlist = new Set(settings.alwaysAllowedAppIds);
  if (target.type === "native") allowlist.add(normalizeWindowsAppId(target.target));
  const next: WindowsUseSettings = {
    ...settings,
    alwaysAllowedAppIds: normalizeAllowlist([...allowlist]),
    targets: normalizeTargets(targets),
    updatedAt: new Date().toISOString(),
  };
  const settingsPath = windowsUseSettingsPath(projectRoot);
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tempPath, settingsPath);

  const updates = new Map<string, string | null>();
  if (credentials.username !== undefined) updates.set(`${target.credentialRef}_USERNAME`, credentials.username);
  if (credentials.password) updates.set(`${target.credentialRef}_PASSWORD`, credentials.password);
  if (updates.size) writeEnvValues(projectRoot, updates);
  return target;
}

export function deleteWindowsUseTarget(projectRoot: string, id: string): boolean {
  const settings = readWindowsUseSettings(projectRoot);
  const target = settings.targets.find((item) => item.id === id);
  if (!target) return false;
  const targets = settings.targets.filter((item) => item.id !== id);
  const remainingNativeIds = new Set(targets.filter((item) => item.type === "native").map((item) => normalizeWindowsAppId(item.target)));
  const appId = target.type === "native" ? normalizeWindowsAppId(target.target) : "";
  const next: WindowsUseSettings = {
    ...settings,
    targets,
    allowedTargetIds: settings.allowedTargetIds.filter((targetId) => targetId !== id),
    alwaysAllowedAppIds: settings.alwaysAllowedAppIds.filter((item) => item !== appId || remainingNativeIds.has(item)),
    updatedAt: new Date().toISOString(),
  };
  const settingsPath = windowsUseSettingsPath(projectRoot);
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tempPath, settingsPath);
  writeEnvValues(projectRoot, new Map([
    [`${target.credentialRef}_USERNAME`, null],
    [`${target.credentialRef}_PASSWORD`, null],
  ]));
  return true;
}

function envEnabled(value: string | undefined): boolean | null {
  if (value == null || value.trim() === "") return null;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function resolveEffectiveWindowsUseSettings(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveWindowsUseSettings {
  const persisted = readWindowsUseSettings(projectRoot);
  const override = envEnabled(env["CODEFLOW_WINDOWS_USE_ENABLED"]);
  const envApps = (env["CODEFLOW_WINDOWS_USE_ALLOW_APPS"] ?? "")
    .split(",")
    .map(normalizeWindowsAppId)
    .filter(Boolean);
  const alwaysAllowedAppIds = normalizeAllowlist([
    ...persisted.alwaysAllowedAppIds,
    ...envApps,
  ]);
  return {
    ...persisted,
    enabled: override ?? persisted.enabled,
    alwaysAllowedAppIds,
    source: override == null && envApps.length === 0 ? "project" : "environment",
  };
}

export function isProtectedWindowsAppId(appId: string): boolean {
  return HARD_BLOCKED_APP_IDS.has(normalizeWindowsAppId(appId));
}
