import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type PickExecutableResult =
  | { ok: true; path: string; productName: string; fileDescription: string; companyName: string; fileVersion: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export function sanitizeExecutablePickerInitialPath(initialPath?: string): string {
  const candidate = initialPath?.trim() ?? "";
  if (!candidate || /^https?:\/\//i.test(candidate) || !isAbsolute(candidate)) return "";
  return candidate;
}

export async function pickExecutableNative(initialPath?: string): Promise<PickExecutableResult> {
  if (process.platform !== "win32") {
    return { ok: false, cancelled: false, error: "Executable picker is only available on Windows" };
  }
  const scriptPath = join(SHELL_PKG_ROOT, "scripts", "pick-executable-win.ps1");
  if (!existsSync(scriptPath)) {
    return { ok: false, cancelled: false, error: `missing picker script: ${scriptPath}` };
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ], {
        encoding: "utf8",
        timeout: 300_000,
        windowsHide: false,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CFM_PICK_INITIAL: sanitizeExecutablePickerInitialPath(initialPath) },
      }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }).then((value) => value.replace(/\r?\n/g, "").trim());
    if (!out || out === "__CANCELLED__") return { ok: false, cancelled: true };
    let selected: Record<string, unknown>;
    try { selected = JSON.parse(out) as Record<string, unknown>; } catch { selected = { path: out }; }
    const selectedPath = String(selected["path"] ?? "").trim();
    if (!selectedPath.toLowerCase().endsWith(".exe") || !existsSync(selectedPath)) {
      return { ok: false, cancelled: false, error: "Selected file is not an existing Windows executable" };
    }
    return {
      ok: true,
      path: selectedPath,
      productName: String(selected["productName"] ?? "").trim(),
      fileDescription: String(selected["fileDescription"] ?? "").trim(),
      companyName: String(selected["companyName"] ?? "").trim(),
      fileVersion: String(selected["fileVersion"] ?? "").trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancelled|canceled|__CANCELLED__/i.test(message)) return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, error: message };
  }
}
