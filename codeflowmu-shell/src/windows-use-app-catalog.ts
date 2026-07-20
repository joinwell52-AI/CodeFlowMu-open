import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

export interface WindowsUseAppCandidate {
  app_id: string;
  executable: string;
  source: "common";
}

interface CommonAppDefinition {
  appId: string;
  paths: (env: NodeJS.ProcessEnv) => string[];
}

function under(root: string | undefined, ...parts: string[]): string {
  return root ? join(root, ...parts) : "";
}

const COMMON_WINDOWS_APPS: CommonAppDefinition[] = [
  {
    appId: "explorer.exe",
    paths: (env) => [under(env["WINDIR"] || "C:\\Windows", "explorer.exe")],
  },
  {
    appId: "notepad.exe",
    paths: (env) => [under(env["WINDIR"] || "C:\\Windows", "System32", "notepad.exe")],
  },
  {
    appId: "mspaint.exe",
    paths: (env) => [under(env["WINDIR"] || "C:\\Windows", "System32", "mspaint.exe")],
  },
  {
    appId: "msedge.exe",
    paths: (env) => [
      under(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      under(env["PROGRAMFILES"], "Microsoft", "Edge", "Application", "msedge.exe"),
      under(env["LOCALAPPDATA"], "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
  },
  {
    appId: "chrome.exe",
    paths: (env) => [
      under(env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
      under(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      under(env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe"),
    ],
  },
  {
    appId: "firefox.exe",
    paths: (env) => [
      under(env["PROGRAMFILES"], "Mozilla Firefox", "firefox.exe"),
      under(env["PROGRAMFILES(X86)"], "Mozilla Firefox", "firefox.exe"),
    ],
  },
];

/**
 * Returns conservative, locally installed GUI application candidates.
 * Candidates are never approved automatically; the user must explicitly
 * select them in the Windows Use allowlist.
 */
export function listCommonWindowsUseAppCandidates(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): WindowsUseAppCandidate[] {
  const candidates: WindowsUseAppCandidate[] = [];
  for (const definition of COMMON_WINDOWS_APPS) {
    const executable = definition.paths(env)
      .filter(Boolean)
      .map((candidate) => normalize(candidate))
      .find((candidate) => fileExists(candidate));
    if (!executable) continue;
    candidates.push({ app_id: definition.appId, executable, source: "common" });
  }
  return candidates;
}
