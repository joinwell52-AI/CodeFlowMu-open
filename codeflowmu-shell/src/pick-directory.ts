/**
 * Open the OS native folder picker (Panel runs in browser; paths must be
 * chosen on the machine where the Shell process runs).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type PickDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

const CANCEL_TOKEN = "__CANCELLED__";

function pickWindows(initial: string): PickDirectoryResult {
  const scriptPath = join(SHELL_PKG_ROOT, "scripts", "pick-folder-win.ps1");
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      cancelled: false,
      error: `missing picker script: ${scriptPath}`,
    };
  }
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    {
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, CFM_PICK_INITIAL: initial },
      windowsHide: false,
    },
  )
    .replace(/\r?\n/g, "")
    .trim();
  if (!out || out === CANCEL_TOKEN) {
    return { ok: false, cancelled: true };
  }
  return { ok: true, path: out };
}

function pickDarwin(initial: string): PickDirectoryResult {
  const prompt = "Select product development root folder";
  let script: string;
  if (initial && existsSync(initial)) {
    const escaped = initial.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    script = `POSIX path of (choose folder with prompt "${prompt}" default location (POSIX file "${escaped}"))`;
  } else {
    script = `POSIX path of (choose folder with prompt "${prompt}")`;
  }
  try {
    const out = execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 300_000,
    }).trim();
    if (!out) return { ok: false, cancelled: true };
    return { ok: true, path: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/User canceled|User cancelled|-128/i.test(msg)) {
      return { ok: false, cancelled: true };
    }
    return { ok: false, cancelled: false, error: msg };
  }
}

function pickLinux(initial: string): PickDirectoryResult {
  try {
    execFileSync("which", ["zenity"], { encoding: "utf8" });
  } catch {
    return {
      ok: false,
      cancelled: false,
      error:
        "Linux 需安装 zenity 才能使用图形目录选择，或手动输入路径",
    };
  }
  const args = [
    "--file-selection",
    "--directory",
    "--title=Select product development root",
  ];
  if (initial && existsSync(initial)) {
    args.push(`--filename=${initial.replace(/\/$/, "")}/`);
  }
  try {
    const out = execFileSync("zenity", args, {
      encoding: "utf8",
      timeout: 300_000,
    }).trim();
    if (!out) return { ok: false, cancelled: true };
    return { ok: true, path: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancelled|canceled|exit code 1/i.test(msg)) {
      return { ok: false, cancelled: true };
    }
    return { ok: false, cancelled: false, error: msg };
  }
}

export function pickDirectoryNative(initialPath?: string): PickDirectoryResult {
  const initial = initialPath?.trim() ?? "";
  try {
    if (process.platform === "win32") return pickWindows(initial);
    if (process.platform === "darwin") return pickDarwin(initial);
    if (process.platform === "linux") return pickLinux(initial);
    return {
      ok: false,
      cancelled: false,
      error: `unsupported platform: ${process.platform}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CANCELLED|cancelled|canceled|User cancel/i.test(msg)) {
      return { ok: false, cancelled: true };
    }
    return { ok: false, cancelled: false, error: msg };
  }
}
