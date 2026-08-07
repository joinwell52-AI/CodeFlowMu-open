import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  OperationApprovalRecord,
  PrepareOperationInput,
} from "@codeflowmu/runtime";
import { atomicWriteJson } from "@codeflowmu/runtime";

import {
  buildGithubReadyIssueBody,
  scanIssueBodyForForbiddenTerms,
} from "./eval-promotion.ts";
import {
  digestIssueClosureText,
  IssueClosureError,
  IssueClosureService,
} from "./issue-closure.ts";

export type IssuePromotionConfig = {
  target_repo: string;
  visibility_policy: "public_issue" | "private_mother_issue" | "local_only";
  labels: string[];
  source: string;
};

export type IssuePromotionBundleResult = {
  ok: true;
  deduplicated: boolean;
  promotion_id: string;
  promotion_record: string;
  bundle_path: string;
  target_repo: string;
  closure_digest: string;
  promotion_digest: string;
  draft_file: string;
  draft_title: string;
  draft_body: string;
  draft_body_digest: string;
  redaction: {
    secrets_found: number;
    paths_normalized: boolean;
    warnings: string[];
    public_safe: boolean;
  };
  status: string;
};

const SECRET_PATTERNS: Array<{ label: string; matcher: RegExp }> = [
  { label: "OpenAI-style API key", matcher: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub token", matcher: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { label: "Bearer token", matcher: /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi },
  { label: "private key", matcher: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

export const DEFAULT_OPEN_ISSUE_REPOSITORY = "joinwell52-AI/CodeFlowMu-open";
const LEGACY_OPEN_ISSUE_REPOSITORY = "joinwell52-AI/codeflowmu1.2.21";

function normalizeVisibilityPolicy(value: unknown): IssuePromotionConfig["visibility_policy"] | "" {
  const policy = String(value ?? "").trim().toLowerCase();
  return policy === "public_issue" || policy === "private_mother_issue" || policy === "local_only"
    ? policy
    : "";
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeRepo(value: unknown): string {
  const repo = String(value ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
  return repo;
}

function repoFromPublishedIssueUrl(value: unknown): string {
  const match = String(value ?? "").trim().match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+(?:[/?#].*)?$/i);
  return normalizeRepo(match?.[1]);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function loadIssuePromotionConfig(projectRoot: string): IssuePromotionConfig {
  const source = ".codeflowmu/issue-promotion-target.json";
  const row = readJson(join(projectRoot, ".codeflowmu", "issue-promotion-target.json"));
  if (row) {
    const configuredRepo = normalizeRepo(row.target_repo);
    const isLegacyOpenDefault = configuredRepo.toLowerCase() === LEGACY_OPEN_ISSUE_REPOSITORY.toLowerCase();
    const repo = isLegacyOpenDefault ? DEFAULT_OPEN_ISSUE_REPOSITORY : configuredRepo;
    if (repo) {
      const configuredPolicy = normalizeVisibilityPolicy(row.visibility_policy);
      const visibilityPolicy = configuredPolicy || (
        repo.toLowerCase() === DEFAULT_OPEN_ISSUE_REPOSITORY.toLowerCase()
          ? "public_issue"
          : "private_mother_issue"
      );
      const labels = isLegacyOpenDefault
        ? []
        : Array.isArray(row.labels)
          ? row.labels.map(String).map((value) => value.trim()).filter(Boolean)
          : [];
      return { target_repo: repo, visibility_policy: visibilityPolicy, labels, source };
    }
  }
  throw new IssueClosureError(
    "GITHUB_TARGET_NOT_CONFIGURED",
    `未配置有效的母版目标仓库，请在 ${source} 中明确设置 target_repo。系统不会从 package.json 或当前项目仓库猜测目标。`,
    422,
    { config_path: source },
  );
}

function sanitizePublicIssueTitle(raw: string): string {
  const normalized = normalizeSensitivePaths(raw).value
    .replace(/\bTASK-[A-Za-z0-9_.-]+\b/gi, "a local task")
    .replace(/\bREPORT-[A-Za-z0-9_.-]+\b/gi, "a local report")
    .replace(/\bISSUE-[A-Za-z0-9_.-]+\b/gi, "a local issue")
    .replace(/\b(?:thread|session)[-_ :]+[A-Za-z0-9_.-]+\b/gi, "local runtime context")
    .replace(/sha256:[a-f0-9]{64}/gi, "")
    .replace(/[`\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const forbidden = scanIssueBodyForForbiddenTerms(normalized);
  const secrets = secretFindings(normalized);
  if (!normalized || forbidden.length || secrets.length) return "CodeFlowMu Open product issue";
  return normalized.slice(0, 160);
}

export function inspectPublicIssueDraft(title: string, body: string): string[] {
  const findings = new Set<string>([
    ...scanIssueBodyForForbiddenTerms(title),
    ...scanIssueBodyForForbiddenTerms(body),
    ...secretFindings(`${title}\n${body}`),
  ]);
  const combined = `${title}\n${body}`;
  if (/(^|[^`])``([^`]|$)/m.test(combined)) findings.add("空反引号");
  if (/\[[^\]]*\]\(\s*\)/.test(combined)) findings.add("空链接");
  if (/\b(?:source closure digest|closure digest|operation digest)\s*:/i.test(combined)) findings.add("内部摘要标识");
  if (/\b(?:thread_key|session_id|task_id|report_id|issue_id)\s*:/i.test(combined)) findings.add("内部协作字段");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(combined)) findings.add("电子邮箱");
  if (/(?:身份证|id\s*card)\s*[:：]?\s*\d{15,18}/i.test(combined)) findings.add("身份证字段");
  if (/\b(?:username|account|账号|用户名)\s*[:：=]\s*\S+/i.test(combined)) findings.add("账号信息");
  if (/\b(?:customer|client|客户)(?:[_ -]?(?:id|name|data)|数据|姓名)\s*[:：=]/i.test(combined)) findings.add("客户业务数据");
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /^#{1,6}\s/.test(text) || /^[-*]\s+\[[ xX]\]/.test(text)) continue;
    if (/(?:[:：,，;；、]|\b(?:and|or)|(?:以及|并且|或者|和|与))$/.test(text)) {
      findings.add("疑似残缺句子");
      break;
    }
  }
  return [...findings];
}

function secretFindings(raw: string): string[] {
  const findings: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.matcher.test(raw)) findings.push(pattern.label);
    pattern.matcher.lastIndex = 0;
  }
  return findings;
}

function normalizeSensitivePaths(raw: string): { value: string; changed: boolean } {
  let changed = false;
  const value = raw
    .replace(/[A-Za-z]:\\[^\s`"')]+/g, () => {
      changed = true;
      return "the local project directory";
    })
    .replace(/\/(?:home|Users)\/[^\s`"')]+/g, () => {
      changed = true;
      return "the local project directory";
    });
  return { value, changed };
}

function promotionId(issueId: string, closureDigest: string): string {
  return `ISSUE-PROMOTION-${issueId.replace(/^ISSUE-/i, "")}-${closureDigest.replace(/^sha256:/, "").slice(0, 12)}`;
}

function titleFromIssue(issue: Record<string, unknown>): string {
  const bodyHeading = String(issue.body ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const summary = String(issue.summary ?? issue.title ?? bodyHeading).trim();
  return summary
    ? `[CodeFlowMu Open] ${sanitizePublicIssueTitle(summary).slice(0, 140)}`
    : "[CodeFlowMu Open] Product issue report";
}

function existingBundle(finalDir: string): IssuePromotionBundleResult | null {
  const record = readJson(join(finalDir, "promotion.json"));
  const manifest = readJson(join(finalDir, "manifest.json"));
  if (!record || !manifest) return null;
  return {
    ok: true,
    deduplicated: true,
    promotion_id: String(record.promotion_id ?? ""),
    promotion_record: String(record.promotion_record ?? ""),
    bundle_path: String(record.bundle_path ?? ""),
    target_repo: String(record.target_repo ?? ""),
    closure_digest: String(record.closure_digest ?? ""),
    promotion_digest: String(record.promotion_digest ?? ""),
    draft_file: String(record.draft_file ?? ""),
    draft_title: String(record.draft_title ?? ""),
    draft_body: String(record.draft_body ?? ""),
    draft_body_digest: String(record.draft_body_digest ?? ""),
    redaction: record.redaction as IssuePromotionBundleResult["redaction"],
    status: String(record.status ?? "draft_created"),
  };
}

export async function generateIssuePromotionBundle(input: {
  projectRoot: string;
  filename: string;
  actor: string;
  expected_closure_digest: string;
}): Promise<IssuePromotionBundleResult> {
  const root = resolve(input.projectRoot);
  const service = new IssueClosureService({ projectRoot: root });
  const issue = service.detail(input.filename);
  const closure = issue.current_closure as Record<string, unknown> | null;
  if (!closure) throw new IssueClosureError("ISSUE_STRUCTURED_CLOSURE_REQUIRED", "A structured closure is required before promotion", 422);
  const closureDigest = String(closure.closure_digest ?? "").trim();
  if (!closureDigest || closureDigest !== input.expected_closure_digest) {
    throw new IssueClosureError("ISSUE_CLOSURE_CHANGED_REVIEW_AGAIN", "Closure changed after review", 409);
  }
  const actor = String(input.actor ?? "").trim().toUpperCase();
  if (actor !== "ADMIN") throw new IssueClosureError("ISSUE_PROMOTION_AUTHORITY_REQUIRED", "Mother evidence promotion requires ADMIN", 403);
  const config = loadIssuePromotionConfig(root);
  const issueId = String(issue.issue_id ?? input.filename.replace(/\.md$/i, ""));
  const id = promotionId(issueId, closureDigest);
  const bundleRel = `fcop/internal/issue-promotions/${id}`;
  const finalDir = join(root, ...bundleRel.split("/"));
  const prior = existingBundle(finalDir);
  if (prior) return prior;

  const closureRaw = readFileSync(join(root, ...String(closure.path ?? issue.closure_record).split("/")), "utf8");
  const secrets = secretFindings(closureRaw);
  if (secrets.length) {
    const closureSource = String(closure.path ?? issue.closure_record);
    throw new IssueClosureError(
      "ISSUE_PROMOTION_SECRET_DETECTED",
      `Evidence export blocked because secrets were detected in ${closureSource}: ${secrets.join(", ")}`,
      422,
      { findings: secrets, files: [closureSource] },
    );
  }
  const normalizedClosure = normalizeSensitivePaths(closureRaw);
  const title = titleFromIssue(issue);
  const publicDraft = buildGithubReadyIssueBody({
    title,
    rawProblem: [
      String(issue.body ?? ""),
      String(closure.body ?? ""),
      `Root cause status: ${String(closure.root_cause_status ?? "unknown")}`,
      `Residual risk: ${String(closure.residual_risk ?? "not recorded")}`,
    ].join("\n\n"),
    whyRepo: "The observed behavior belongs to CodeFlowMu Open and requires public maintainer tracking.",
    targetLabel: "CodeFlowMu Open",
    rawProposal: String(closure.follow_up_reference ?? closure.follow_up_target ?? ""),
  });
  const forbidden = inspectPublicIssueDraft(title, publicDraft.body);
  const publicSafe = forbidden.length === 0;

  const generatedAt = new Date().toISOString();
  const draftFilename = `CODEFLOWMU-ISSUE-DRAFT-${id.replace(/^ISSUE-PROMOTION-/, "")}.md`;
  const draftRaw = [
    "---",
    "kind: github_issue_draft",
    "schema_version: 1",
    `promotion_id: ${id}`,
    `source_issue_id: ${issueId}`,
    `closure_digest: ${closureDigest}`,
    `target_repo: ${config.target_repo}`,
    `visibility_policy: ${config.visibility_policy}`,
    `public_safe: ${publicSafe ? "true" : "false"}`,
    `status: ${publicSafe ? "draft" : "draft_unsafe"}`,
    "admin_approved: false",
    `generated_at: ${generatedAt}`,
    "---",
    "",
    publicDraft.body.trim(),
    "",
  ].join("\n");
  const evidence = Array.isArray(closure.evidence) ? closure.evidence : [];
  const evidenceIndex = {
    schema_version: 1,
    promotion_id: id,
    source_issue_id: issueId,
    closure_digest: closureDigest,
    evidence: evidence.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : { ref: String(item) };
      const normalized = normalizeSensitivePaths(String(row.ref ?? ""));
      return { type: String(row.type ?? "reference"), ref: normalized.value, ref_digest: digestIssueClosureText(String(row.ref ?? "")) };
    }),
  };
  const redaction = {
    secrets_found: 0,
    paths_normalized: normalizedClosure.changed,
    warnings: [...new Set([...publicDraft.redactionReasons, ...forbidden])],
    public_safe: publicSafe,
  };
  const closureCopy = normalizedClosure.value;
  const files = [
    { path: "closure.md", body: closureCopy },
    { path: draftFilename, body: draftRaw },
    { path: "evidence-index.json", body: `${JSON.stringify(evidenceIndex, null, 2)}\n` },
    { path: "REDACTION-REPORT.md", body: `# Redaction report\n\n- Secrets found: 0\n- Paths normalized: ${redaction.paths_normalized}\n- Public safe: ${redaction.public_safe}\n- Warnings: ${redaction.warnings.join("; ") || "none"}\n` },
  ];
  const manifestBase = {
    schema_version: 1,
    promotion_id: id,
    source_project_id: String(issue.project_id ?? basename(root)),
    source_issue_id: issueId,
    source_issue_digest: String(closure.source_issue_digest ?? ""),
    closure_id: String(closure.closure_id ?? ""),
    closure_digest: closureDigest,
    target_product: "CodeFlowMu",
    target_kind: config.visibility_policy,
    target_repo: config.target_repo,
    visibility_policy: config.visibility_policy,
    target_config_source: config.source,
    root_cause_status: String(closure.root_cause_status ?? "unknown"),
    generated_at: generatedAt,
    generated_by: actor,
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.body) })),
    redaction,
  };
  const promotionDigest = sha256(JSON.stringify(manifestBase));
  const manifest = { ...manifestBase, promotion_digest: promotionDigest };
  const promotionRecordRel = `${bundleRel}/promotion.json`;
  const promotionRecord = {
    schema_version: 1,
    promotion_id: id,
    promotion_record: promotionRecordRel,
    bundle_path: bundleRel,
    source_issue_id: issueId,
    source_issue_filename: input.filename,
    closure_digest: closureDigest,
    promotion_digest: promotionDigest,
    target_repo: config.target_repo,
    visibility_policy: config.visibility_policy,
    target_config_source: config.source,
    labels: config.labels,
    draft_file: `${bundleRel}/${draftFilename}`,
    draft_title: title,
    draft_body: publicDraft.body,
    draft_body_digest: sha256(publicDraft.body),
    redaction,
    status: publicSafe ? "draft_created" : "draft_unsafe",
    generated_at: generatedAt,
    generated_by: actor,
  };

  const tempDir = `${finalDir}.building-${process.pid}-${Date.now()}`;
  mkdirSync(tempDir, { recursive: true });
  try {
    for (const file of files) writeFileSync(join(tempDir, file.path), file.body, "utf8");
    writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(join(tempDir, "promotion.json"), `${JSON.stringify(promotionRecord, null, 2)}\n`, "utf8");
    mkdirSync(join(root, "fcop", "internal", "issue-promotions"), { recursive: true });
    renameSync(tempDir, finalDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  try {
    await service.updatePromotionProjection(input.filename, {
      expected_closure_digest: closureDigest,
      status: "draft_created",
      promotion_record: promotionRecordRel,
    });
  } catch (error) {
    rmSync(finalDir, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, deduplicated: false, ...promotionRecord } as IssuePromotionBundleResult;
}

function loadPromotionRecord(projectRoot: string, promotionId: string): { path: string; row: Record<string, unknown> } {
  if (!/^ISSUE-PROMOTION-[A-Za-z0-9_.-]+$/.test(promotionId)) {
    throw new IssueClosureError("INVALID_ISSUE_PROMOTION_ID", "Invalid issue promotion id", 400);
  }
  const path = join(resolve(projectRoot), "fcop", "internal", "issue-promotions", promotionId, "promotion.json");
  const row = readJson(path);
  if (!row) throw new IssueClosureError("ISSUE_PROMOTION_NOT_FOUND", promotionId, 404);
  return { path, row };
}

function effectivePromotionConfig(projectRoot: string, row: Record<string, unknown>): IssuePromotionConfig {
  const targetRepo = normalizeRepo(row.target_repo) || repoFromPublishedIssueUrl(row.target_issue_url);
  const legacyOpen = targetRepo.toLowerCase() === LEGACY_OPEN_ISSUE_REPOSITORY.toLowerCase();
  if (legacyOpen || !targetRepo) return loadIssuePromotionConfig(projectRoot);
  const policy = normalizeVisibilityPolicy(row.visibility_policy) || (
    targetRepo.toLowerCase() === DEFAULT_OPEN_ISSUE_REPOSITORY.toLowerCase()
      ? "public_issue"
      : "private_mother_issue"
  );
  return {
    target_repo: targetRepo,
    visibility_policy: policy,
    labels: Array.isArray(row.labels) ? row.labels.map(String).map((value) => value.trim()).filter(Boolean) : [],
    source: String(row.target_config_source ?? ".codeflowmu/issue-promotion-target.json"),
  };
}

function assertPromotionPublicSafe(row: Record<string, unknown>): void {
  const redaction = row.redaction && typeof row.redaction === "object"
    ? row.redaction as Record<string, unknown>
    : {};
  const findings = inspectPublicIssueDraft(String(row.draft_title ?? ""), String(row.draft_body ?? ""));
  if (redaction.public_safe !== true || findings.length > 0) {
    throw new IssueClosureError(
      "ISSUE_PROMOTION_PUBLIC_DRAFT_UNSAFE",
      "公开 Issue 草稿仍含内部标识、敏感信息或损坏的 Markdown，不能申请发布。",
      422,
      { findings: [...new Set([...(Array.isArray(redaction.warnings) ? redaction.warnings.map(String) : []), ...findings])] },
    );
  }
}

export function buildIssueGithubApprovalInput(input: {
  projectRoot: string;
  promotion_id: string;
  actor: string;
  target_preflight?: Record<string, unknown>;
}): PrepareOperationInput {
  const { row } = loadPromotionRecord(input.projectRoot, input.promotion_id);
  assertPromotionPublicSafe(row);
  const config = effectivePromotionConfig(input.projectRoot, row);
  const targetRepo = config.target_repo;
  if (!targetRepo) throw new IssueClosureError("GITHUB_TARGET_NOT_CONFIGURED", "Promotion has no configured target repository", 422);
  if (config.visibility_policy === "local_only") {
    throw new IssueClosureError("GITHUB_PUBLICATION_DISABLED", "当前目标策略仅允许保留本地草稿。", 422);
  }
  const actor = String(input.actor ?? "").trim().toUpperCase();
  if (actor !== "ADMIN") throw new IssueClosureError("ISSUE_PROMOTION_AUTHORITY_REQUIRED", "GitHub publication requires ADMIN", 403);
  const bodyDigest = String(row.draft_body_digest ?? "");
  const operation = config.visibility_policy === "public_issue"
    ? "create_public_product_issue"
    : "create_private_mother_issue";
  return {
    request: {
      subject: { actor, role: "ADMIN", project_id: basename(resolve(input.projectRoot)) },
      action: { capability: "github.issue.write", operation, executor: "github.issue.create" },
      resource: {
        type: "github_issue",
        targets: [`https://github.com/${targetRepo}/issues`],
        scope: {
          project_root: resolve(input.projectRoot),
          promotion_id: input.promotion_id,
          target_repo: targetRepo,
          visibility_policy: config.visibility_policy,
          closure_digest: row.closure_digest,
          promotion_digest: row.promotion_digest,
          title: row.draft_title,
          body_digest: bodyDigest,
          labels: config.labels,
          target_preflight: input.target_preflight ?? null,
        },
      },
      context: {
        workspace: resolve(input.projectRoot),
        environment: "local_desktop",
        initiated_by: "user",
        authorization_source: "none",
      },
      effect: { external_write: true },
      snapshot: {
        target_repo: targetRepo,
        visibility_policy: config.visibility_policy,
        title: row.draft_title,
        full_body: row.draft_body,
        body_digest: bodyDigest,
        labels: config.labels,
        target_preflight: input.target_preflight ?? null,
        redaction: row.redaction,
        closure_digest: row.closure_digest,
        promotion_digest: row.promotion_digest,
      },
    },
    reason: `申请向 ${config.visibility_policy === "public_issue" ? "公共" : "私有维护"}仓库 ${targetRepo} 提交已审阅、已脱敏的 Issue 草稿《${String(row.draft_title ?? "")}》。`,
    effects: [`将在 GitHub 仓库 ${targetRepo} 新建 1 个 Issue，标题为《${String(row.draft_title ?? "")}》`],
    non_effects: ["不会修改本地母版工作树", "不会推送 Git 提交", "不会关闭或重新打开来源 ISSUE", "不会完成、归档、解除或停止关联 TASK/Session"],
    recovery: "发布失败时保留本地结案记录和证据包；修复 GitHub 登录、权限、网络或标签后可重新申请或重试。",
    rule_ids: ["NEG.EXTERNAL.WRITE"],
    executor_status: "ready",
    suggested_executor: "github.issue.create",
    decision_mode: "ADMIN_MANUAL",
    comment_required: true,
  };
}

export type GithubIssueTargetPreflightInput = {
  targetRepo: string;
  visibilityPolicy: IssuePromotionConfig["visibility_policy"];
  labels: string[];
};

export type GithubAuthenticationStatus = {
  connected: boolean;
  code: string;
  message: string;
};

export function getGithubAuthenticationStatus(): GithubAuthenticationStatus {
  try {
    execFileSync("gh", ["auth", "status", "--hostname", "github.com"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { connected: true, code: "GITHUB_AUTHENTICATED", message: "GitHub 已连接，可以申请发布公共 Issue。" };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const cliMissing = /ENOENT|not recognized|找不到/i.test(text);
    return {
      connected: false,
      code: cliMissing ? "GITHUB_CLI_UNAVAILABLE" : "GITHUB_NOT_AUTHENTICATED",
      message: cliMissing
        ? "未安装 GitHub CLI，当前仅可本地查看和下载证据包。"
        : "尚未连接 GitHub，当前仅可本地查看和下载证据包。",
    };
  }
}

function githubCommandError(error: unknown, fallbackCode: string, fallbackMessage: string): IssueClosureError {
  if (error instanceof IssueClosureError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  if (/not logged|authentication|auth login|401|bad credentials/i.test(raw)) {
    return new IssueClosureError("GITHUB_NOT_AUTHENTICATED", "尚未连接 GitHub，请先完成登录。", 401, { retryable: true, action: "connect_github" });
  }
  if (/could not resolve|timed out|timeout|network|connection|TLS|ECONN/i.test(raw)) {
    return new IssueClosureError("GITHUB_NETWORK_FAILED", "无法连接 GitHub，请检查网络后重试。", 503, { retryable: true });
  }
  if (/interaction.*limit|blocked|abuse detection|secondary rate limit/i.test(raw)) {
    return new IssueClosureError("GITHUB_INTERACTION_RESTRICTED", "当前 GitHub 身份受到仓库交互限制，暂时不能创建 Issue。", 403, { retryable: true });
  }
  if (/issues (?:are )?disabled|has issues disabled/i.test(raw)) {
    return new IssueClosureError("GITHUB_ISSUES_DISABLED", "目标仓库已关闭 Issues。", 422, { retryable: true });
  }
  if (/label.*(?:not found|does not exist|invalid)|could not resolve to a label/i.test(raw)) {
    return new IssueClosureError("GITHUB_LABELS_MISSING", "目标仓库缺少配置标签，请移除标签、由管理员创建标签，或取消发布。", 422, { retryable: true });
  }
  if (/resource not accessible|forbidden|403|permission/i.test(raw)) {
    return new IssueClosureError("GITHUB_ISSUE_PERMISSION_DENIED", "当前 GitHub 身份没有创建 Issue 所需的权限。", 403, { retryable: true });
  }
  return new IssueClosureError(fallbackCode, fallbackMessage, 403, { retryable: true });
}

export function preflightGithubIssueTarget(input: GithubIssueTargetPreflightInput): Record<string, unknown> {
  const auth = getGithubAuthenticationStatus();
  if (!auth.connected) {
    throw new IssueClosureError(auth.code, auth.message, auth.code === "GITHUB_CLI_UNAVAILABLE" ? 503 : 401, {
      retryable: true,
      action: "connect_github",
    });
  }
  let raw: string;
  try {
    raw = String(execFileSync("gh", ["api", `repos/${input.targetRepo}`], { encoding: "utf8", timeout: 30_000, windowsHide: true }));
  } catch (error) {
    throw githubCommandError(error, "GITHUB_REPO_ACCESS_DENIED", `当前 GitHub 身份无法访问仓库 ${input.targetRepo}。`);
  }
  const repo = JSON.parse(raw) as Record<string, unknown>;
  let labelRaw = "";
  try {
    labelRaw = String(execFileSync(
      "gh",
      ["api", `repos/${input.targetRepo}/labels`, "--paginate", "--jq", ".[].name"],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    ));
  } catch (error) {
    throw githubCommandError(error, "GITHUB_LABEL_PREFLIGHT_FAILED", "无法读取目标仓库标签，请稍后重试。");
  }
  const availableLabels = labelRaw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return validateGithubIssueTargetMetadata(input.targetRepo, repo, {
    visibility_policy: input.visibilityPolicy,
    requested_labels: input.labels,
    available_labels: availableLabels,
  });
}

export function validateGithubIssueTargetMetadata(
  targetRepo: string,
  repo: Record<string, unknown>,
  options: {
    visibility_policy?: IssuePromotionConfig["visibility_policy"];
    requested_labels?: string[];
    available_labels?: string[];
  } = {},
): Record<string, unknown> {
  const policy = options.visibility_policy ?? "private_mother_issue";
  if (policy === "public_issue" && repo.private === true) {
    throw new IssueClosureError("GITHUB_PUBLIC_REPO_REQUIRED", `公共 Issue 策略要求公开仓库：${targetRepo}`, 422);
  }
  if (policy === "private_mother_issue" && repo.private !== true) {
    throw new IssueClosureError("GITHUB_PRIVATE_REPO_REQUIRED", `私有维护 Issue 策略要求私有仓库：${targetRepo}`, 422);
  }
  if (repo.has_issues === false) throw new IssueClosureError("GITHUB_ISSUES_DISABLED", `仓库 ${targetRepo} 已关闭 Issues。`, 422, { retryable: true });
  const permissions = repo.permissions && typeof repo.permissions === "object" ? repo.permissions as Record<string, unknown> : {};
  if (policy === "private_mother_issue" && !(permissions.admin || permissions.maintain || permissions.push)) {
    throw new IssueClosureError("GITHUB_REPO_ACCESS_DENIED", `当前 GitHub 身份没有私有维护仓库 ${targetRepo} 的写入权限。`, 403);
  }
  const available = new Set((options.available_labels ?? []).map((label) => label.toLowerCase()));
  const missingLabels = (options.requested_labels ?? []).filter((label) => !available.has(label.toLowerCase()));
  if (missingLabels.length > 0) {
    throw new IssueClosureError(
      "GITHUB_LABELS_MISSING",
      `目标仓库缺少标签：${missingLabels.join("、")}。请选择移除标签、由仓库管理员创建标签，或取消发布。`,
      422,
      {
        missing_labels: missingLabels,
        choices: ["remove_labels", "ask_admin_to_create", "cancel"],
        retryable: true,
      },
    );
  }
  return {
    authenticated: true,
    can_create_issue: true,
    full_name: repo.full_name ?? targetRepo,
    visibility_policy: policy,
    private: repo.private,
    has_issues: repo.has_issues,
    requested_labels: options.requested_labels ?? [],
    missing_labels: [],
    permissions: policy === "public_issue" ? { issue_submission: "authenticated_user" } : permissions,
  };
}

export type IssueGithubExecutorDependencies = {
  preflight: (input: GithubIssueTargetPreflightInput) => Record<string, unknown> | Promise<Record<string, unknown>>;
  createIssue: (input: { targetRepo: string; title: string; body: string; labels: string[] }) => string | Promise<string>;
};

export const defaultGithubExecutorDependencies: IssueGithubExecutorDependencies = {
  preflight: preflightGithubIssueTarget,
  createIssue({ targetRepo, title, body, labels }) {
    const args = ["issue", "create", "--repo", targetRepo, "--title", title, "--body", body];
    for (const label of labels) args.push("--label", label);
    return String(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, windowsHide: true })).trim();
  },
};

export async function prepareIssueGithubApprovalInput(input: {
  projectRoot: string;
  promotion_id: string;
  actor: string;
}, dependencies: Pick<IssueGithubExecutorDependencies, "preflight"> = defaultGithubExecutorDependencies): Promise<PrepareOperationInput> {
  const loaded = loadPromotionRecord(input.projectRoot, input.promotion_id);
  assertPromotionPublicSafe(loaded.row);
  const config = effectivePromotionConfig(input.projectRoot, loaded.row);
  const targetPreflight = await dependencies.preflight({
    targetRepo: config.target_repo,
    visibilityPolicy: config.visibility_policy,
    labels: config.labels,
  });
  return buildIssueGithubApprovalInput({ ...input, target_preflight: targetPreflight });
}

export async function recomputeIssueGithubApprovalRequest(
  record: OperationApprovalRecord,
  dependencies: Pick<IssueGithubExecutorDependencies, "preflight"> = defaultGithubExecutorDependencies,
): Promise<PrepareOperationInput["request"]> {
  const scope = record.request.resource.scope ?? {};
  const current = await prepareIssueGithubApprovalInput({
    projectRoot: String(scope.project_root ?? record.project_root),
    promotion_id: String(scope.promotion_id ?? ""),
    actor: "ADMIN",
  }, dependencies);
  return current.request;
}

export async function publishIssuePromotionWithExecutor(
  record: OperationApprovalRecord,
  dependencies: IssueGithubExecutorDependencies,
): Promise<{ status: "succeeded"; evidence: Array<Record<string, unknown>> }> {
  if (record.request.action.executor !== "github.issue.create") throw new Error("unsupported executor");
  const scope = record.request.resource.scope ?? {};
  const projectRoot = String(scope.project_root ?? record.project_root);
  const promotionId = String(scope.promotion_id ?? "");
  const loaded = loadPromotionRecord(projectRoot, promotionId);
  const row = loaded.row;
  assertPromotionPublicSafe(row);
  const config = effectivePromotionConfig(projectRoot, row);
  const targetRepo = config.target_repo;
  const closureDigest = String(row.closure_digest ?? "");
  const body = String(row.draft_body ?? "");
  const title = String(row.draft_title ?? "");
  if (String(scope.closure_digest ?? "") !== closureDigest || String(scope.body_digest ?? "") !== sha256(body)) {
    throw new IssueClosureError("APPROVAL_STALE", "Promotion content changed after approval preview", 409);
  }
  if (row.target_issue_url) {
    return { status: "succeeded", evidence: [{ executor: "github.issue.create", deduplicated: true, target_repo: targetRepo, issue_url: row.target_issue_url, issue_number: row.target_issue_number }] };
  }
  const executionStartedAt = new Date().toISOString();
  let preflight: Record<string, unknown>;
  try {
    preflight = await dependencies.preflight({
      targetRepo,
      visibilityPolicy: config.visibility_policy,
      labels: config.labels,
    });
  } catch (error) {
    const mapped = githubCommandError(error, "GITHUB_TARGET_PREFLIGHT_FAILED", "GitHub 目标预检失败，请修复登录、权限、仓库或标签配置后重试。");
    const failedAt = new Date().toISOString();
    await atomicWriteJson(loaded.path, `${JSON.stringify({
      ...row,
      target_repo: targetRepo,
      visibility_policy: config.visibility_policy,
      labels: config.labels,
      status: "publish_failed_retryable",
      execution_started_at: executionStartedAt,
      execution_finished_at: failedAt,
      target_preflight: { ok: false, code: mapped.code, message: mapped.message, details: mapped.details },
      publish_error_code: mapped.code,
      publish_error: mapped.message,
      publish_error_details: mapped.details,
      publish_failed_at: failedAt,
    }, null, 2)}\n`);
    throw mapped;
  }
  await atomicWriteJson(loaded.path, `${JSON.stringify({
    ...row,
    target_repo: targetRepo,
    visibility_policy: config.visibility_policy,
    labels: config.labels,
    status: "publishing",
    execution_started_at: executionStartedAt,
    target_preflight: preflight,
    publish_error: null,
    publish_error_code: null,
  }, null, 2)}\n`);
  let url: string;
  try {
    url = String(await dependencies.createIssue({
      targetRepo,
      title,
      body,
      labels: config.labels,
    })).trim();
    let receipt: URL | null = null;
    try { receipt = new URL(url); } catch { receipt = null; }
    const expectedPathPrefix = `/${targetRepo.toLowerCase()}/issues/`;
    if (
      !receipt
      || receipt.protocol !== "https:"
      || receipt.hostname.toLowerCase() !== "github.com"
      || !receipt.pathname.toLowerCase().startsWith(expectedPathPrefix)
      || !/^\d+\/?$/.test(receipt.pathname.slice(expectedPathPrefix.length))
    ) {
      throw new IssueClosureError("GITHUB_ISSUE_RECEIPT_INVALID", "GitHub issue creation returned an invalid receipt URL", 502);
    }
  } catch (error) {
    const mapped = githubCommandError(error, "GITHUB_ISSUE_CREATE_FAILED", "GitHub Issue 创建失败，请检查权限、仓库交互限制或网络后重试。");
    const failedAt = new Date().toISOString();
    const failed = {
      ...row,
      target_repo: targetRepo,
      visibility_policy: config.visibility_policy,
      labels: config.labels,
      status: "publish_failed_retryable",
      execution_started_at: executionStartedAt,
      execution_finished_at: failedAt,
      target_preflight: preflight,
      publish_error_code: mapped.code,
      publish_error: mapped.message,
      publish_error_details: mapped.details,
      publish_failed_at: failedAt,
    };
    await atomicWriteJson(loaded.path, `${JSON.stringify(failed, null, 2)}\n`);
    throw mapped;
  }
  const number = Number(url.match(/\/issues\/(\d+)\s*$/)?.[1] ?? 0) || undefined;
  const publishedAt = new Date().toISOString();
  const updated = {
    ...row,
    target_repo: targetRepo,
    visibility_policy: config.visibility_policy,
    labels: config.labels,
    status: "published",
    target_type: "github_issue",
    target_issue_number: number,
    target_issue_url: url,
    published_body_digest: sha256(body),
    published_body_summary: body.replace(/\s+/g, " ").trim().slice(0, 500),
    target_preflight: preflight,
    execution_started_at: executionStartedAt,
    execution_finished_at: publishedAt,
    published_at: publishedAt,
    published_by: "ADMIN",
  };
  await atomicWriteJson(loaded.path, `${JSON.stringify(updated, null, 2)}\n`);
  const sourceFilename = String(row.source_issue_filename ?? "");
  if (sourceFilename) {
    await new IssueClosureService({ projectRoot }).updatePromotionProjection(sourceFilename, {
      expected_closure_digest: closureDigest,
      status: "published",
      promotion_record: String(row.promotion_record ?? ""),
    });
  }
  return {
    status: "succeeded",
    evidence: [{
      executor: "github.issue.create",
      target_repo: targetRepo,
      issue_url: url,
      issue_number: number,
      published_body_digest: sha256(body),
      published_body_summary: body.replace(/\s+/g, " ").trim().slice(0, 500),
      execution_started_at: executionStartedAt,
      execution_finished_at: publishedAt,
      preflight,
    }],
  };
}

export async function executeIssueGithubApproval(record: OperationApprovalRecord): Promise<{ status: "succeeded"; evidence: Array<Record<string, unknown>> }> {
  return publishIssuePromotionWithExecutor(record, defaultGithubExecutorDependencies);
}

export async function syncIssuePromotionApprovalStatus(
  record: OperationApprovalRecord,
): Promise<Record<string, unknown> | null> {
  if (record.request.action.executor !== "github.issue.create") return null;
  const approvalScope = record.request.resource.scope ?? {};
  const promotionId = String(approvalScope.promotion_id ?? "");
  if (!promotionId) return null;
  const loaded = loadPromotionRecord(record.project_root, promotionId);
  const current = loaded.row;
  if (current.target_issue_url || String(current.status ?? "") === "published") return current;
  const mappedStatus = record.status === "pending_approval" || record.status === "pending_executor"
    ? "pending_approval"
    : record.status === "approved"
      ? "approved_pending_execution"
      : record.status === "executing"
        ? "publishing"
        : record.status === "failed" || record.status === "partial_failed"
          ? "publish_failed_retryable"
          : record.status === "rejected"
            ? "rejected"
            : record.status === "cancelled" || record.status === "expired" || record.status === "stale"
              ? "draft_created"
              : String(current.status ?? "draft_created");
  const updated = {
    ...current,
    status: mappedStatus,
    approval_id: record.approval_id,
    approval_status: record.status,
    authorization_status: record.authorization?.status ?? null,
    approval_requested_at: current.approval_requested_at ?? record.requested_at,
    approval_decided_at: record.decision?.at ?? null,
    approval_execution: record.execution,
    ...(record.execution.error ? {
      publish_error_code: current.publish_error_code ?? "GITHUB_ISSUE_PUBLISH_FAILED",
      publish_error: current.publish_error ?? record.execution.error,
    } : {}),
  };
  await atomicWriteJson(loaded.path, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export function readIssuePromotion(projectRoot: string, promotionId: string): Record<string, unknown> {
  const row = loadPromotionRecord(projectRoot, promotionId).row;
  const config = effectivePromotionConfig(projectRoot, row);
  return { ...row, target_repo: config.target_repo, visibility_policy: config.visibility_policy, labels: config.labels };
}

export function listIssuePromotions(projectRoot: string): Array<Record<string, unknown>> {
  const root = resolve(projectRoot);
  const promotionsDir = join(root, "fcop", "internal", "issue-promotions");
  if (!existsSync(promotionsDir)) return [];
  return readdirSync(promotionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ISSUE-PROMOTION-[A-Za-z0-9_.-]+$/.test(entry.name))
    .map((entry) => readJson(join(promotionsDir, entry.name, "promotion.json")))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => {
      const config = effectivePromotionConfig(projectRoot, row);
      return { ...row, target_repo: config.target_repo, visibility_policy: config.visibility_policy, labels: config.labels } as Record<string, unknown>;
    })
    .sort((a, b) => String(b.published_at ?? b.generated_at ?? "").localeCompare(String(a.published_at ?? a.generated_at ?? "")));
}

export function readIssuePromotionExport(projectRoot: string, promotionId: string): {
  ok: true;
  promotion_id: string;
  filename: string;
  files: Array<{ path: string; content: string; sha256: string }>;
} {
  const loaded = loadPromotionRecord(projectRoot, promotionId);
  const bundleDir = dirname(loaded.path);
  const files = readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(bundleDir, entry.name);
      const size = statSync(path).size;
      if (size > 2 * 1024 * 1024) {
        throw new IssueClosureError("ISSUE_PROMOTION_EXPORT_TOO_LARGE", `Evidence file is too large to export: ${entry.name}`, 422);
      }
      const content = readFileSync(path, "utf8");
      return { path: entry.name, content, sha256: sha256(content) };
    });
  return {
    ok: true,
    promotion_id: promotionId,
    filename: `${promotionId}.zip`,
    files,
  };
}

export async function exportIssuePromotionBundle(input: {
  projectRoot: string;
  promotion_id: string;
  actor: string;
}): Promise<ReturnType<typeof readIssuePromotionExport> & { status: string }> {
  const actor = String(input.actor ?? "").trim().toUpperCase();
  if (actor !== "ADMIN") {
    throw new IssueClosureError("ISSUE_PROMOTION_AUTHORITY_REQUIRED", "Evidence bundle export requires ADMIN", 403);
  }
  const loaded = loadPromotionRecord(input.projectRoot, input.promotion_id);
  const previous = `${JSON.stringify(loaded.row, null, 2)}\n`;
  const status = String(loaded.row.status ?? "draft_created") === "published" ? "published" : "exported";
  const updated = {
    ...loaded.row,
    status,
    exported_at: new Date().toISOString(),
    exported_by: actor,
  };
  await atomicWriteJson(loaded.path, `${JSON.stringify(updated, null, 2)}\n`);
  try {
    const sourceFilename = String(loaded.row.source_issue_filename ?? "");
    if (sourceFilename && status === "exported") {
      await new IssueClosureService({ projectRoot: input.projectRoot }).updatePromotionProjection(sourceFilename, {
        expected_closure_digest: String(loaded.row.closure_digest ?? ""),
        status,
        promotion_record: String(loaded.row.promotion_record ?? ""),
      });
    }
  } catch (error) {
    await atomicWriteJson(loaded.path, previous);
    throw error;
  }
  return { ...readIssuePromotionExport(input.projectRoot, input.promotion_id), status };
}
