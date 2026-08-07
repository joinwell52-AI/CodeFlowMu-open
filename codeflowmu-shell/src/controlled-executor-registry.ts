import {
  ControlledExecutorRegistry,
  buildFilesystemCleanupApprovalInput,
  executeFilesystemCleanupApproval,
  type CapabilityRequest,
  type OperationApprovalRecord,
  type PrepareOperationInput,
} from "@codeflowmu/runtime";

import {
  buildGitPushApprovalInput,
  executeGitPushApproval,
} from "./git-operation-approval.ts";
import {
  executeIssueGithubApproval,
  prepareIssueGithubApprovalInput,
  publishIssuePromotionWithExecutor,
  recomputeIssueGithubApprovalRequest,
  type IssueGithubExecutorDependencies,
} from "./issue-promotion.ts";
import {
  buildWorkspaceOperationApprovalInput,
  executeWorkspaceOperation,
  workspaceInputFromRecord,
  type WorkspaceExecutorName,
  type WorkspaceOperationInput,
} from "./workspace-controlled-executors.ts";

type RegistryOptions = {
  projectRoot: () => string;
  gitRoot: () => string;
  buildReviewPolicyInput: (updates: Record<string, unknown>) => Promise<PrepareOperationInput>;
  saveReviewPolicy: (updates: Record<string, unknown>) => Promise<Record<string, unknown>>;
  issueGithubDependencies?: IssueGithubExecutorDependencies;
};

function scope(record: OperationApprovalRecord): Record<string, unknown> {
  return record.request.resource.scope ?? {};
}

export function createControlledExecutorRegistry(
  opts: RegistryOptions,
): ControlledExecutorRegistry {
  const registry = new ControlledExecutorRegistry();

  registry.register({
    name: "git.push",
    async prepare(raw: unknown) {
      const input = raw as { branch: string; subject: CapabilityRequest["subject"] };
      return buildGitPushApprovalInput({ cwd: opts.gitRoot(), branch: input.branch, subject: input.subject });
    },
    preview(raw: unknown) { return { executor: "git.push", ...(raw as object) }; },
    async recomputeRequest(record) {
      const current = await buildGitPushApprovalInput({
        cwd: String(scope(record)["cwd"] ?? ""),
        branch: String(scope(record)["branch"] ?? ""),
        subject: record.request.subject,
      });
      return current.request;
    },
    execute: executeGitPushApproval,
    recovery(record) { return { inspect: record.request.resource.targets, action: "verify_remote_ref" }; },
  });

  registry.register({
    name: "filesystem.cleanup",
    prepare(raw: unknown) {
      const input = raw as {
        targets: string[];
        subject: CapabilityRequest["subject"];
        mode?: "quarantine" | "permanent_delete";
        retention_days?: number;
        reason?: string;
        thread_key?: string;
      };
      return buildFilesystemCleanupApprovalInput({
        projectRoot: opts.projectRoot(),
        targets: input.targets,
        subject: input.subject,
        mode: input.mode ?? "quarantine",
        retentionDays: input.retention_days ?? 14,
        reason: input.reason,
        threadKey: input.thread_key,
      });
    },
    preview(raw: unknown) { return { executor: "filesystem.cleanup", ...(raw as object) }; },
    recomputeRequest(record) {
      const current = buildFilesystemCleanupApprovalInput({
        projectRoot: record.project_root,
        targets: record.request.resource.targets,
        subject: record.request.subject,
        mode: String(scope(record)["mode"] ?? "quarantine") === "permanent_delete" ? "permanent_delete" : "quarantine",
        retentionDays: Number(scope(record)["retention_days"] ?? 14),
        reason: record.reason,
        threadKey: record.thread_key,
      });
      return current.request;
    },
    execute: executeFilesystemCleanupApproval,
    recovery(record) { return { inspect: record.request.resource.targets, action: "inspect_quarantine_manifest" }; },
  });

  registry.register({
    name: "github.issue.create",
    async prepare(raw: unknown) {
      const input = raw as { promotion_id: string; actor?: string };
      return prepareIssueGithubApprovalInput({
        projectRoot: opts.projectRoot(),
        promotion_id: input.promotion_id,
        actor: input.actor ?? "ADMIN",
      }, opts.issueGithubDependencies);
    },
    preview(raw: unknown) {
      return { executor: "github.issue.create", ...(raw as object) };
    },
    recomputeRequest(record) {
      return recomputeIssueGithubApprovalRequest(record, opts.issueGithubDependencies);
    },
    execute(record) {
      return opts.issueGithubDependencies
        ? publishIssuePromotionWithExecutor(record, opts.issueGithubDependencies)
        : executeIssueGithubApproval(record);
    },
    recovery(record) {
      const scope = record.request.resource.scope ?? {};
      return {
        action: "retry_issue_publication_without_reopening_source_issue",
        promotion_id: scope["promotion_id"],
        target_repo: scope["target_repo"],
      };
    },
  });

  registry.register({
    name: "review.policy.save",
    prepare(raw: unknown) { return opts.buildReviewPolicyInput(raw as Record<string, unknown>); },
    preview(raw: unknown) { return { executor: "review.policy.save", updates: raw }; },
    async recomputeRequest(record) {
      const current = await opts.buildReviewPolicyInput((scope(record)["updates"] ?? {}) as Record<string, unknown>);
      return current.request;
    },
    async execute(record) {
      const policy = await opts.saveReviewPolicy((scope(record)["updates"] ?? {}) as Record<string, unknown>);
      return { evidence: [{ executor: "review.policy.save", policy }] };
    },
    recovery() { return { action: "reload_review_policy" }; },
  });

  for (const name of [
    "workspace.fs.write",
    "workspace.fs.mkdir",
    "workspace.fs.copy",
    "workspace.fs.move",
    "workspace.patch.apply",
  ] as WorkspaceExecutorName[]) {
    registry.register({
      name,
      prepare(raw: unknown) {
        return buildWorkspaceOperationApprovalInput({
          ...(raw as WorkspaceOperationInput),
          executor: name,
          projectRoot: opts.projectRoot(),
        });
      },
      preview(raw: unknown) {
        const input = raw as WorkspaceOperationInput;
        return { executor: name, target: input.target, targets: input.targets, source: input.source };
      },
      recomputeRequest(record) {
        return buildWorkspaceOperationApprovalInput(workspaceInputFromRecord(record)).request;
      },
      execute: executeWorkspaceOperation,
      recovery(record) { return { action: "inspect_bound_workspace_targets", targets: record.request.resource.targets }; },
    });
  }

  return registry;
}
