import { WindowsUseError, type WindowsUsePolicyOptions } from "./types.ts";

export const DEFAULT_BLOCKED_WINDOWS_APPS = [
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
] as const;

function normalizeAppId(value: string): string {
  return value.trim().replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function envAllowedApps(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CODEFLOW_WINDOWS_USE_ALLOW_APPS ?? "")
    .split(",")
    .map(normalizeAppId)
    .filter(Boolean);
}

export class WindowsUsePolicy {
  private readonly allowed: Set<string>;
  private readonly blocked: Set<string>;

  constructor(options: WindowsUsePolicyOptions = {}) {
    this.allowed = new Set([
      ...envAllowedApps(),
      ...(options.alwaysAllowedAppIds ?? []).map(normalizeAppId),
    ]);
    this.blocked = new Set([
      ...DEFAULT_BLOCKED_WINDOWS_APPS,
      ...(options.blockedAppIds ?? []).map(normalizeAppId),
    ]);
  }

  assertAppAllowed(appId: unknown): string {
    const normalized = normalizeAppId(String(appId ?? ""));
    if (!normalized) {
      throw new WindowsUseError(
        "APP_ID_REQUIRED",
        "Windows Use actions require app_id from windows.list_apps",
      );
    }
    if (this.blocked.has(normalized)) {
      throw new WindowsUseError(
        "APP_BLOCKED",
        `Windows Use is not allowed to control ${normalized}`,
      );
    }
    if (!this.allowed.has(normalized)) {
      throw new WindowsUseError(
        "APP_APPROVAL_REQUIRED",
        `User approval is required before controlling ${normalized}`,
      );
    }
    return normalized;
  }
}
