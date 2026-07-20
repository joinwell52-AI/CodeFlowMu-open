import { WindowsUseProvider } from "./WindowsUseProvider.ts";
import {
  WINDOWS_USE_TOOL_NAMES,
  WindowsUseError,
  type WindowsUseToolName,
} from "./types.ts";

type ToolDeclaration = {
  name: WindowsUseToolName;
  description: string;
  parameters: Record<string, unknown>;
};

const targetProperties = {
  app_id: { type: "STRING", description: "Application id from windows.list_apps" },
  window_id: { type: "STRING", description: "Window id from windows.list_apps" },
};

export function isWindowsUseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEFLOW_WINDOWS_USE_ENABLED === "1";
}

export function isWindowsUseTool(name: string): name is WindowsUseToolName {
  return (WINDOWS_USE_TOOL_NAMES as readonly string[]).includes(name);
}

export function buildWindowsUseToolDeclarations(): ToolDeclaration[] {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "OBJECT",
    properties,
    ...(required.length ? { required } : {}),
  });
  return [
    { name: "windows.capabilities", description: "Inspect Windows Use host capabilities and optional dependencies.", parameters: object({}) },
    { name: "windows.list_apps", description: "List visible top-level applications and windows on the active Windows desktop.", parameters: object({}) },
    { name: "windows.screenshot", description: "Capture an approved visible application window as PNG base64.", parameters: object(targetProperties, ["app_id", "window_id"]) },
    { name: "windows.inspect_ui", description: "Inspect UI Automation elements in an approved window.", parameters: object({ ...targetProperties, limit: { type: "NUMBER" } }, ["app_id", "window_id"]) },
    { name: "windows.click", description: "Click window-relative coordinates in an approved foreground application.", parameters: object({ ...targetProperties, x: { type: "NUMBER" }, y: { type: "NUMBER" }, button: { type: "STRING", enum: ["left", "right"] } }, ["app_id", "window_id", "x", "y"]) },
    { name: "windows.type_text", description: "Type Unicode text into an approved foreground application. Never use for secrets without the user present.", parameters: object({ ...targetProperties, text: { type: "STRING" } }, ["app_id", "window_id", "text"]) },
    { name: "windows.keypress", description: "Send a keyboard chord such as CTRL+S to an approved application.", parameters: object({ ...targetProperties, keys: { type: "ARRAY", items: { type: "STRING" } } }, ["app_id", "window_id", "keys"]) },
    { name: "windows.scroll", description: "Scroll inside an approved application window.", parameters: object({ ...targetProperties, delta: { type: "NUMBER" }, x: { type: "NUMBER" }, y: { type: "NUMBER" } }, ["app_id", "window_id", "delta"]) },
    { name: "windows.invoke_ui", description: "Invoke an approved UI Automation control by selector.", parameters: object({ ...targetProperties, selector: { type: "OBJECT", properties: { automation_id: { type: "STRING" }, title: { type: "STRING" }, control_type: { type: "STRING" } } } }, ["app_id", "window_id", "selector"]) },
    { name: "windows.cancel", description: "Cancel the active Windows Use operation.", parameters: object({}) },
  ];
}

const providers = new Map<string, WindowsUseProvider>();

function providerFor(projectRoot: string): WindowsUseProvider {
  let provider = providers.get(projectRoot);
  if (!provider) {
    provider = new WindowsUseProvider({ projectRoot });
    providers.set(projectRoot, provider);
  }
  return provider;
}

export async function invokeWindowsUseTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isWindowsUseTool(toolName)) throw new Error(`Not a Windows Use tool: ${toolName}`);
  try {
    const result = await providerFor(projectRoot).execute(toolName, args);
    return JSON.stringify({ ok: true, result });
  } catch (error) {
    const code = error instanceof WindowsUseError ? error.code : "WINDOWS_USE_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ ok: false, error: { code, message } });
  }
}
