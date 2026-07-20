export const WINDOWS_USE_TOOL_NAMES = [
  "windows.capabilities",
  "windows.list_apps",
  "windows.screenshot",
  "windows.inspect_ui",
  "windows.click",
  "windows.type_text",
  "windows.keypress",
  "windows.scroll",
  "windows.invoke_ui",
  "windows.cancel",
] as const;

export type WindowsUseToolName = (typeof WINDOWS_USE_TOOL_NAMES)[number];

export interface ComputerUseProvider {
  execute(
    toolName: WindowsUseToolName,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  cancel(): Promise<void>;
}

export interface WindowsUseHostRequest {
  command: string;
  args: Record<string, unknown>;
}

export interface WindowsUseHostResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface WindowsUsePolicyOptions {
  alwaysAllowedAppIds?: readonly string[];
  blockedAppIds?: readonly string[];
}

export class WindowsUseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WindowsUseError";
  }
}
