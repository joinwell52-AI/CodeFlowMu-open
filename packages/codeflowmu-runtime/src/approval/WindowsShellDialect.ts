import { basename } from "node:path";

export type WindowsShellDialect = "powershell5" | "powershell7" | "cmd";

export interface WindowsShellDialectResult {
  dialect: WindowsShellDialect | null;
  source: "command" | "argument" | "environment" | "platform_default" | "non_windows";
}

function executableName(value: string): string {
  return basename(value.trim().replace(/^&\s*/, ""))
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
}

function dialectFromExecutable(value: string): WindowsShellDialect | null {
  const name = executableName(value);
  if (name === "powershell") return "powershell5";
  if (name === "pwsh") return "powershell7";
  if (name === "cmd") return "cmd";
  return null;
}

export function identifyWindowsShellDialect(input: {
  command: string;
  args?: Record<string, unknown>;
  platform?: NodeJS.Platform;
  configuredDialect?: string;
}): WindowsShellDialectResult {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { dialect: null, source: "non_windows" };
  }

  const commandExecutable = input.command
    .trim()
    .match(/^(?:&\s*)?("[^"]+"|'[^']+'|[^\s]+)/)?.[1]
    ?.replace(/^["']|["']$/g, "");
  const fromCommand = commandExecutable
    ? dialectFromExecutable(commandExecutable)
    : null;
  if (fromCommand) return { dialect: fromCommand, source: "command" };

  for (const key of ["shell", "shell_path", "executable", "interpreter"]) {
    const value = input.args?.[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const fromArgument = dialectFromExecutable(value);
    if (fromArgument) return { dialect: fromArgument, source: "argument" };
  }

  const configured = String(
    input.configuredDialect ??
      process.env["CODEFLOWMU_WINDOWS_SHELL_DIALECT"] ??
      "",
  ).toLowerCase();
  if (/^(?:powershell5|powershell|windows-powershell)$/.test(configured)) {
    return { dialect: "powershell5", source: "environment" };
  }
  if (/^(?:powershell7|pwsh)$/.test(configured)) {
    return { dialect: "powershell7", source: "environment" };
  }
  if (/^(?:cmd|cmd.exe)$/.test(configured)) {
    return { dialect: "cmd", source: "environment" };
  }

  // CodeFlowMu Desktop's legacy Windows native shell is Windows PowerShell.
  // Callers can declare pwsh/cmd explicitly or set the environment override.
  return { dialect: "powershell5", source: "platform_default" };
}

export function validateWindowsShellCommand(input: {
  command: string;
  args?: Record<string, unknown>;
  platform?: NodeJS.Platform;
  configuredDialect?: string;
}):
  | { ok: true; dialect: WindowsShellDialect | null }
  | { ok: false; dialect: "powershell5"; reason: string; next_safe_action: string } {
  const identified = identifyWindowsShellDialect(input);
  if (identified.dialect === "powershell5" && /&&/.test(input.command)) {
    return {
      ok: false,
      dialect: "powershell5",
      reason: "powershell5_unsupported_and_chain",
      next_safe_action:
        "Run the commands as separate tool calls, or use '; if ($LASTEXITCODE -eq 0) { ... }'.",
    };
  }
  return { ok: true, dialect: identified.dialect };
}

export function windowsUtf8Prelude(
  dialect: WindowsShellDialect,
): string {
  if (dialect === "cmd") return "chcp 65001 > nul";
  return [
    "[Console]::InputEncoding = [Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
    "$OutputEncoding = [Text.UTF8Encoding]::new()",
  ].join("; ");
}
