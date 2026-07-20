import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { OperationApprovalRecord } from "@codeflowmu/runtime";

export { buildGitPushApprovalInput } from "@codeflowmu/runtime";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile("git", args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
}

export async function executeGitPushApproval(record: OperationApprovalRecord): Promise<{
  status: "succeeded";
  evidence: Array<Record<string, unknown>>;
}> {
  if (record.request.action.executor !== "git.push") throw new Error("unsupported executor");
  const scope = record.request.resource.scope ?? {};
  const cwd = String(scope["cwd"] ?? "").trim();
  const branch = String(scope["branch"] ?? "").trim();
  if (!cwd || !branch) throw new Error("approved git push is missing cwd or branch");
  const output = await git(cwd, ["push", "-u", "origin", branch]);
  const remoteHead = (await git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`])).stdout.split(/\s+/)[0] ?? "";
  return {
    status: "succeeded",
    evidence: [{
      executor: "git.push",
      remote: "origin",
      branch,
      remote_head: remoteHead,
      stdout: output.stdout.slice(-4000),
      stderr: output.stderr.slice(-4000),
    }],
  };
}
