import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listWindowsUseTargets, normalizeWindowsAppId, resolveEffectiveWindowsUseSettings } from "./windows-use-settings.ts";

const SHELL_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOTHER_APPLICATION_ROOT = dirname(SHELL_PACKAGE_ROOT);

export function resolveWindowsUseHostPath(projectRoot: string): string | null {
  const configured = process.env["CODEFLOW_WINDOWS_USE_HOST"]?.trim();
  const root = resolve(projectRoot);
  const candidates = [
    configured ? (isAbsolute(configured) ? configured : resolve(MOTHER_APPLICATION_ROOT, configured)) : undefined,
    join(
      MOTHER_APPLICATION_ROOT,
      "packages",
      "codeflowmu-runtime",
      "src",
      "windows-use",
      "host",
      "windows_use_host.py",
    ),
    join(
      root,
      "packages",
      "codeflowmu-runtime",
      "src",
      "windows-use",
      "host",
      "windows_use_host.py",
    ),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function callWindowsUseHost(
  pythonBin: string,
  projectRoot: string,
  command: "capabilities" | "list_targets" | "list_apps" | "launch_target",
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (process.platform !== "win32") throw new Error("Windows Use is only available on Windows");
  const hostPath = resolveWindowsUseHostPath(projectRoot);
  if (!hostPath) throw new Error("Windows Use host was not found");
  const effective = resolveEffectiveWindowsUseSettings(projectRoot);
  const targetProfiles = listWindowsUseTargets(projectRoot)
    .filter((target) => target.type === "native"
      ? effective.alwaysAllowedAppIds.includes(normalizeWindowsAppId(target.target))
      : effective.allowedTargetIds.includes(target.id))
    .map(({ credentialRef: _credentialRef, username, ...target }) => ({ ...target, usernameSaved: Boolean(username) }));

  return await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-u", hostPath], {
      cwd: projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        FCOP_PROJECT_DIR: projectRoot,
        PYTHONUNBUFFERED: "1",
        CODEFLOW_WINDOWS_USE_ALLOW_APPS: effective.alwaysAllowedAppIds.join(","),
        CODEFLOW_WINDOWS_USE_ALLOW_PATHS_JSON: JSON.stringify(
          effective.targets.filter((target) => target.type === "native").map((target) => target.target),
        ),
        CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON: JSON.stringify(targetProfiles),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows Use host timed out"));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk.slice(0, 2_000_000); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk.slice(0, 20_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Windows Use host exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error("Windows Use host returned invalid JSON"));
      }
    });
    child.stdin.end(`${JSON.stringify({ command, args })}\n`);
  });
}
