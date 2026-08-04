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

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeRepo(value: unknown): string {
  const repo = String(value ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
  return repo;
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
  const candidates = [
    { path: join(projectRoot, ".codeflowmu", "issue-promotion-target.json"), key: "target_repo", source: ".codeflowmu/issue-promotion-target.json" },
    { path: join(projectRoot, "editions", "open-dev-team", "manifest.json"), key: "sourceRepository", source: "editions/open-dev-team/manifest.json" },
    { path: join(projectRoot, "package.json"), key: "repository", source: "package.json" },
  ];
  for (const candidate of candidates) {
    const row = readJson(candidate.path);
    if (!row) continue;
    const repoValue = candidate.key === "repository" && row.repository && typeof row.repository === "object"
      ? (row.repository as Record<string, unknown>).url
      : row[candidate.key];
    const repo = normalizeRepo(repoValue);
    if (repo) {
      const labels = Array.isArray(row.labels) ? row.labels.map(String).map((value) => value.trim()).filter(Boolean) : ["runtime", "evidence"];
      return { target_repo: repo, labels, source: candidate.source };
    }
  }
  throw new IssueClosureError(
    "GITHUB_TARGET_NOT_CONFIGURED",
    "No explicit CodeFlowMu mother repository is configured for issue promotion",
    422,
  );
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
      return "<REDACTED_LOCAL_PATH>";
    })
    .replace(/\/(?:home|Users)\/[^\s`"')]+/g, () => {
      changed = true;
      return "<REDACTED_LOCAL_PATH>";
    });
  return { value, changed };
}

function promotionId(issueId: string, closureDigest: string): string {
  return `ISSUE-PROMOTION-${issueId.replace(/^ISSUE-/i, "")}-${closureDigest.replace(/^sha256:/, "").slice(0, 12)}`;
}

function titleFromIssue(issue: Record<string, unknown>): string {
  const bodyHeading = String(issue.body ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const summary = String(issue.summary ?? issue.title ?? bodyHeading).trim();
  return summary ? `[Issue evidence] ${summary.slice(0, 140)}` : `[Issue evidence] ${String(issue.issue_id ?? issue.filename ?? "runtime issue")}`;
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
      `Source closure digest: ${closureDigest}`,
    ].join("\n\n"),
    whyRepo: "The observed behavior belongs to the configured CodeFlowMu mother product and requires maintainer tracking.",
    targetLabel: "CodeFlowMu",
    rawProposal: String(closure.follow_up_reference ?? closure.follow_up_target ?? ""),
  });
  const forbidden = scanIssueBodyForForbiddenTerms(publicDraft.body);
  const publicSafe = forbidden.length === 0;
  if (!publicSafe) {
    throw new IssueClosureError(
      "ISSUE_PROMOTION_REDACTION_FAILED",
      `The mother issue draft is not safe to export: ${forbidden.join(", ")}`,
      422,
      { forbidden },
    );
  }

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
    "status: draft",
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
    warnings: [...new Set(publicDraft.redactionReasons)],
    public_safe: true,
  };
  const closureCopy = normalizedClosure.value;
  const files = [
    { path: "closure.md", body: closureCopy },
    { path: draftFilename, body: draftRaw },
    { path: "evidence-index.json", body: `${JSON.stringify(evidenceIndex, null, 2)}\n` },
    { path: "REDACTION-REPORT.md", body: `# Redaction report\n\n- Secrets found: 0\n- Paths normalized: ${redaction.paths_normalized}\n- Public safe: true\n- Warnings: ${redaction.warnings.join("; ") || "none"}\n` },
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
    target_kind: "mother_issue_evidence",
    target_repo: config.target_repo,
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
    labels: config.labels,
    draft_file: `${bundleRel}/${draftFilename}`,
    draft_title: title,
    draft_body: publicDraft.body,
    draft_body_digest: sha256(publicDraft.body),
    redaction,
    status: "draft_created",
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

export function buildIssueGithubApprovalInput(input: {
  projectRoot: string;
  promotion_id: string;
  actor: string;
}): PrepareOperationInput {
  const { row } = loadPromotionRecord(input.projectRoot, input.promotion_id);
  const targetRepo = normalizeRepo(row.target_repo);
  if (!targetRepo) throw new IssueClosureError("GITHUB_TARGET_NOT_CONFIGURED", "Promotion has no configured target repository", 422);
  const actor = String(input.actor ?? "").trim().toUpperCase();
  if (actor !== "ADMIN") throw new IssueClosureError("ISSUE_PROMOTION_AUTHORITY_REQUIRED", "GitHub publication requires ADMIN", 403);
  const bodyDigest = String(row.draft_body_digest ?? "");
  return {
    request: {
      subject: { actor, role: "ADMIN", project_id: basename(resolve(input.projectRoot)) },
      action: { capability: "github.issue.write", operation: "create_private_mother_issue", executor: "github.issue.create" },
      resource: {
        type: "github_issue",
        targets: [`https://github.com/${targetRepo}/issues`],
        scope: {
          project_root: resolve(input.projectRoot),
          promotion_id: input.promotion_id,
          target_repo: targetRepo,
          closure_digest: row.closure_digest,
          promotion_digest: row.promotion_digest,
          title: row.draft_title,
          body_digest: bodyDigest,
          labels: row.labels,
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
        title: row.draft_title,
        full_body: row.draft_body,
        body_digest: bodyDigest,
        labels: row.labels,
        redaction: row.redaction,
        closure_digest: row.closure_digest,
        promotion_digest: row.promotion_digest,
      },
    },
    reason: "Publish the reviewed, redacted evidence draft to the configured CodeFlowMu mother GitHub Issues",
    effects: [`create one issue in ${targetRepo}`],
    non_effects: ["does not modify local mother worktree", "does not push git", "does not close or reopen source issue", "does not stop task or session"],
    recovery: "Publication failure is retryable; retain the local closure and evidence bundle",
    rule_ids: ["NEG.EXTERNAL.WRITE"],
    executor_status: "ready",
    suggested_executor: "github.issue.create",
    decision_mode: "ADMIN_MANUAL",
    comment_required: true,
  };
}

export function recomputeIssueGithubApprovalRequest(record: OperationApprovalRecord): PrepareOperationInput["request"] {
  const scope = record.request.resource.scope ?? {};
  const current = buildIssueGithubApprovalInput({
    projectRoot: String(scope.project_root ?? record.project_root),
    promotion_id: String(scope.promotion_id ?? ""),
    actor: "ADMIN",
  });
  return current.request;
}

export function preflightGithubIssueTarget(targetRepo: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = String(execFileSync("gh", ["api", `repos/${targetRepo}`], { encoding: "utf8", timeout: 30_000, windowsHide: true }));
  } catch (error) {
    throw new IssueClosureError("GITHUB_REPO_ACCESS_DENIED", `GitHub repository access preflight failed for ${targetRepo}: ${error instanceof Error ? error.message : String(error)}`, 403);
  }
  const repo = JSON.parse(raw) as Record<string, unknown>;
  return validateGithubIssueTargetMetadata(targetRepo, repo);
}

export function validateGithubIssueTargetMetadata(
  targetRepo: string,
  repo: Record<string, unknown>,
): Record<string, unknown> {
  if (repo.private !== true) {
    throw new IssueClosureError("GITHUB_PRIVATE_REPO_REQUIRED", `Configured mother repository must be private: ${targetRepo}`, 422);
  }
  if (repo.has_issues === false) throw new IssueClosureError("GITHUB_ISSUES_DISABLED", `GitHub Issues are disabled for ${targetRepo}`, 422);
  const permissions = repo.permissions && typeof repo.permissions === "object" ? repo.permissions as Record<string, unknown> : {};
  if (!(permissions.admin || permissions.maintain || permissions.push)) {
    throw new IssueClosureError("GITHUB_REPO_ACCESS_DENIED", `Current GitHub identity lacks write access to ${targetRepo}`, 403);
  }
  return { full_name: repo.full_name, private: repo.private, has_issues: repo.has_issues, permissions };
}

export type IssueGithubExecutorDependencies = {
  preflight: (targetRepo: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  createIssue: (input: { targetRepo: string; title: string; body: string; labels: string[] }) => string | Promise<string>;
};

const defaultGithubExecutorDependencies: IssueGithubExecutorDependencies = {
  preflight: preflightGithubIssueTarget,
  createIssue({ targetRepo, title, body, labels }) {
    const args = ["issue", "create", "--repo", targetRepo, "--title", title, "--body", body];
    for (const label of labels) args.push("--label", label);
    return String(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, windowsHide: true })).trim();
  },
};

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
  const targetRepo = normalizeRepo(row.target_repo);
  const closureDigest = String(row.closure_digest ?? "");
  const body = String(row.draft_body ?? "");
  const title = String(row.draft_title ?? "");
  if (String(scope.closure_digest ?? "") !== closureDigest || String(scope.body_digest ?? "") !== sha256(body)) {
    throw new IssueClosureError("APPROVAL_STALE", "Promotion content changed after approval preview", 409);
  }
  if (row.target_issue_url) {
    return { status: "succeeded", evidence: [{ executor: "github.issue.create", deduplicated: true, target_repo: targetRepo, issue_url: row.target_issue_url, issue_number: row.target_issue_number }] };
  }
  const preflight = await dependencies.preflight(targetRepo);
  let url: string;
  try {
    url = String(await dependencies.createIssue({
      targetRepo,
      title,
      body,
      labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    })).trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/i.test(url)) {
      throw new IssueClosureError("GITHUB_ISSUE_RECEIPT_INVALID", "GitHub issue creation returned an invalid receipt URL", 502);
    }
  } catch (error) {
    const failed = { ...row, status: "publish_failed_retryable", publish_error: error instanceof Error ? error.message : String(error), publish_failed_at: new Date().toISOString() };
    await atomicWriteJson(loaded.path, `${JSON.stringify(failed, null, 2)}\n`);
    throw error;
  }
  const number = Number(url.match(/\/issues\/(\d+)\s*$/)?.[1] ?? 0) || undefined;
  const publishedAt = new Date().toISOString();
  const updated = {
    ...row,
    status: "published",
    target_type: "github_issue",
    target_issue_number: number,
    target_issue_url: url,
    published_body_digest: sha256(body),
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
    evidence: [{ executor: "github.issue.create", target_repo: targetRepo, issue_url: url, issue_number: number, published_body_digest: sha256(body), preflight }],
  };
}

export async function executeIssueGithubApproval(record: OperationApprovalRecord): Promise<{ status: "succeeded"; evidence: Array<Record<string, unknown>> }> {
  return publishIssuePromotionWithExecutor(record, defaultGithubExecutorDependencies);
}

export function readIssuePromotion(projectRoot: string, promotionId: string): Record<string, unknown> {
  return loadPromotionRecord(projectRoot, promotionId).row;
}

export function listIssuePromotions(projectRoot: string): Array<Record<string, unknown>> {
  const root = resolve(projectRoot);
  const promotionsDir = join(root, "fcop", "internal", "issue-promotions");
  if (!existsSync(promotionsDir)) return [];
  return readdirSync(promotionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ISSUE-PROMOTION-[A-Za-z0-9_.-]+$/.test(entry.name))
    .map((entry) => readJson(join(promotionsDir, entry.name, "promotion.json")))
    .filter((row): row is Record<string, unknown> => Boolean(row))
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
