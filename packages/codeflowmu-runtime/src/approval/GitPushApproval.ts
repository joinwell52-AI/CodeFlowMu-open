import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { CapabilityRequest, PrepareOperationInput } from "./OperationApprovalService.ts";

const execFile = promisify(execFileCallback);

export type GitPushSubject = CapabilityRequest["subject"];

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile("git", args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
}

function normalizeRemoteUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

export async function buildGitPushApprovalInput(input: {
  cwd: string;
  branch: string;
  subject: GitPushSubject;
}): Promise<PrepareOperationInput> {
  const branch = input.branch.trim();
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error("invalid git branch");
  }
  const remoteUrl = normalizeRemoteUrl((await git(input.cwd, ["remote", "get-url", "origin"])).stdout);
  if (!remoteUrl) throw new Error("origin remote URL is required");
  const afterSha = (await git(input.cwd, ["rev-parse", branch])).stdout;
  const remoteRef = `refs/heads/${branch}`;
  const lsRemote = (await git(input.cwd, ["ls-remote", "origin", remoteRef])).stdout;
  const beforeSha = lsRemote.split(/\s+/)[0] || "absent";
  const request: CapabilityRequest = {
    subject: input.subject,
    action: { capability: "git.remote.push", operation: "push_branch", executor: "git.push" },
    resource: {
      type: "git_branch",
      targets: [`origin/${branch}`],
      scope: { cwd: input.cwd, remote: "origin", remote_url: remoteUrl, branch },
    },
    context: {
      workspace: input.cwd,
      environment: "external_git_remote",
      initiated_by: "agent",
      authorization_source: "none",
      human_confirmation_id: null,
    },
    effect: { external_write: true },
    snapshot: { before_sha: beforeSha, after_sha: afterSha, remote_url: remoteUrl, branch },
  };
  return {
    request,
    reason: `向 origin/${branch} 推送本地提交 ${afterSha.slice(0, 12)}`,
    effects: [
      beforeSha === "absent"
        ? `远端将创建分支 origin/${branch}`
        : `远端分支 origin/${branch} 将从 ${beforeSha.slice(0, 12)} 更新到 ${afterSha.slice(0, 12)}`,
    ],
    non_effects: ["不会合并分支", "不会创建发布", "不会修改生产环境"],
    recovery: "可通过新的反向提交恢复；不会自动强制改写远端历史",
  };
}
