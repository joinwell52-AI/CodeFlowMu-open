import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { appendWindowsUseAudit, summarizeWindowsUseArgs } from "./audit.ts";
import { WindowsUsePolicy } from "./policy.ts";
import {
  WindowsUseError,
  type ComputerUseProvider,
  type WindowsUseHostRequest,
  type WindowsUseHostResponse,
  type WindowsUsePolicyOptions,
  type WindowsUseToolName,
} from "./types.ts";

export const WINDOWS_USE_HOST_PATH = fileURLToPath(
  new URL("./host/windows_use_host.py", import.meta.url),
);

export interface WindowsUseProviderOptions extends WindowsUsePolicyOptions {
  projectRoot: string;
  pythonBin?: string;
  hostPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  runHost?: (request: WindowsUseHostRequest) => Promise<WindowsUseHostResponse>;
}

const UNGATED_TOOLS = new Set<WindowsUseToolName>([
  "windows.capabilities",
  "windows.list_apps",
  "windows.cancel",
]);

export class WindowsUseProvider implements ComputerUseProvider {
  private readonly policy: WindowsUsePolicy;
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly options: WindowsUseProviderOptions) {
    this.policy = new WindowsUsePolicy(options);
  }

  async execute(
    toolName: WindowsUseToolName,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolName === "windows.cancel") {
      await this.cancel();
      return { cancelled: true };
    }

    const startedAt = new Date();
    const appId = UNGATED_TOOLS.has(toolName)
      ? undefined
      : this.policy.assertAppAllowed(args.app_id);
    const request: WindowsUseHostRequest = {
      command: toolName.replace(/^windows\./, ""),
      args,
    };

    try {
      const response = this.options.runHost
        ? await this.options.runHost(request)
        : await this.runNativeHost(request);
      if (!response.ok) {
        throw new WindowsUseError(
          response.error?.code ?? "HOST_FAILED",
          response.error?.message ?? "Windows Use host failed",
        );
      }
      await this.audit(toolName, args, appId, startedAt, true);
      return response.result ?? {};
    } catch (error) {
      const code = error instanceof WindowsUseError ? error.code : "HOST_FAILED";
      await this.audit(toolName, args, appId, startedAt, false, code);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    const child = this.activeChild;
    if (child && !child.killed) child.kill();
    this.activeChild = null;
  }

  private async audit(
    toolName: string,
    args: Record<string, unknown>,
    appId: string | undefined,
    startedAt: Date,
    ok: boolean,
    errorCode?: string,
  ): Promise<void> {
    try {
      await appendWindowsUseAudit(this.options.projectRoot, {
        at: new Date().toISOString(),
        event_type: "windows_use_action",
        tool: toolName,
        app_id: appId,
        window_id: args.window_id,
        ok,
        duration_ms: Date.now() - startedAt.getTime(),
        ...(errorCode ? { error_code: errorCode } : {}),
        args: summarizeWindowsUseArgs(args),
      });
    } catch {
      // Audit is best effort; action outcome remains truthful to the caller.
    }
  }

  private async runNativeHost(
    request: WindowsUseHostRequest,
  ): Promise<WindowsUseHostResponse> {
    if ((this.options.platform ?? process.platform) !== "win32") {
      throw new WindowsUseError("WINDOWS_ONLY", "Windows Use requires Windows");
    }

    return await new Promise<WindowsUseHostResponse>((resolve, reject) => {
      const child = spawn(
        this.options.pythonBin ?? process.env.PYTHON_BIN ?? "python",
        ["-u", this.options.hostPath ?? WINDOWS_USE_HOST_PATH],
        { cwd: this.options.projectRoot, windowsHide: true },
      );
      this.activeChild = child;
      let stdout = "";
      let stderr = "";
      const maxOutput = 16 * 1024 * 1024;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new WindowsUseError("HOST_TIMEOUT", "Windows Use host timed out"));
      }, this.options.timeoutMs ?? 30_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > maxOutput) child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        this.activeChild = null;
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        this.activeChild = null;
        if (code !== 0 && !stdout.trim()) {
          reject(
            new WindowsUseError(
              "HOST_FAILED",
              stderr.trim() || `Windows Use host exited with ${code}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as WindowsUseHostResponse);
        } catch {
          reject(
            new WindowsUseError(
              "HOST_PROTOCOL_ERROR",
              `Invalid Windows Use host response: ${stderr.trim() || stdout.slice(0, 200)}`,
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}
