import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationApprovalRecord } from "@codeflowmu/runtime";

const SHELL_PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function confirmOperationImpactNative(input: {
  title: string;
  message: string;
}): Promise<boolean> {
  if (process.platform !== "win32") {
    throw new Error("trusted native operation confirmation is currently available on Windows only");
  }
  const scriptPath = join(SHELL_PKG_ROOT, "scripts", "confirm-operation-win.ps1");
  if (!existsSync(scriptPath)) throw new Error(`missing native confirmation script: ${scriptPath}`);
  const output = await new Promise<string>((resolve, reject) => {
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
      env: { ...process.env, CFM_CONFIRM_TITLE: input.title, CFM_CONFIRM_MESSAGE: input.message },
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout ?? "").trim()));
  });
  return output === "__CONFIRMED__";
}

export async function confirmOperationDecisionNative(
  record: OperationApprovalRecord,
  decision: "approve" | "reject",
  reason: string,
): Promise<boolean> {
  const verb = decision === "approve" ? "批准" : "拒绝";
  const message = [
    `${verb}以下尚未执行的操作？`,
    "",
    `类型：${record.primary_kind}`,
    `动作：${record.request.action.operation}`,
    `目标：${record.request.resource.targets.join(", ")}`,
    `影响：${record.effects.join("；")}`,
    `不影响：${record.non_effects.join("；")}`,
    `摘要：${record.operation_digest}`,
    `理由：${reason || "未填写"}`,
    "",
    decision === "approve" ? "确认后仅签发一次性执行凭证；此窗口不会直接执行操作。" : "确认后只拒绝本次操作，不会打回任务或作废报告。",
  ].join("\n");
  return confirmOperationImpactNative({ title: `CodeFlowMu 操作${verb}`, message });
}
