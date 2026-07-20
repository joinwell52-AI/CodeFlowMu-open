import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fcopV3Paths } from "../fcop-v3-paths.ts";
import {
  promoteEvalToLocalTask,
  promoteEvalToCodeflowMuIssueDraft,
  promoteEvalToFcopIssueDraft,
  submitEvalIssueDraft,
  submitEvalLocalTaskDraft,
  deleteEvalPromotionDraft,
  parsePromotionBlock,
  parseEvalFileMetadata,
  readEvalPromotionState,
  canPromoteEvalToTask,
  formatEvalTaskPromoteGateError,
  EVAL_TASK_PROMOTE_GATE_PREFIX,
  buildGithubReadyIssueBody,
  scanIssueBodyForInternalIds,
  isPmSummaryCoverageGap,
  extendEvalPromotionStateForTest,
} from "../eval-promotion.ts";

const SAMPLE_EVAL = `---
protocol: fcop
version: "1"
kind: eval
eval_type: scheduled
sender: SYSTEM
recipient: ADMIN
subject: 测试观察（merged 格式）
observed_at: "2026-06-02T12:00:00+08:00"
assets_analyzed: code_changes,fcop_files,team_tasks
promotion:
  status: pending
  action: null
  target_type: null
  target_file: null
  target_repo: null
---

# CodeFlowMu · EVAL 观察报告

## 1. 结论

Panel 与 ledger 存在不一致风险。

## 4. 发现问题

- P1：示例问题条目
`;

/** 含实质修复范围与验收标准，可通过 task 晋升门禁 */
const ACTIONABLE_GAP = `---
protocol: fcop
version: "1"
kind: eval
eval_type: gap
sender: SYSTEM
recipient: ADMIN
subject: EVAL 可执行缺口 · 晋升门禁
severity: P1
promotion:
  status: pending
  action: null
  target_type: null
  target_file: null
  target_repo: null
---

# CodeFlowMu · EVAL 可执行缺口（晋升门禁）

## 1. 结论

面板 EVAL「转为本地任务」此前缺少门禁，观察文档可能被无条件复制进 lifecycle TASK，违反先判定再改写原则。

## 4. 发现问题

- P1：未校验修复范围与验收标准即可生成 task 草稿

## 修复范围

仅限 codeflowmu-shell 的 eval-promotion 模块与 desktop panel 展示层。
不得改动 FCoP 协议包或 lifecycle 语义；须实现 canPromoteEvalToTask 后再允许 promote。

## 验收标准

- panel-scan 类 GAP 点击「转为本地任务」被拒绝并展示 gate 原因
- actionable GAP 可生成草稿，ADMIN 勾选后提交 inbox TASK
- 同 source_eval 仅允许一次 task promotion
`;

/** 含高风险关键词，晋升 task 时应标记 risk_level: high */
const HIGH_RISK_GAP = `---
protocol: fcop
version: "1"
kind: eval
eval_type: gap
sender: SYSTEM
recipient: ADMIN
subject: EVAL 高风险关键词 · 晋升标记
severity: P1
promotion:
  status: pending
  action: null
  target_type: null
  target_file: null
  target_repo: null
---

# CodeFlowMu · EVAL 高风险关键词（晋升标记）

## 1. 结论

观察发现需 archive 旧 task 并 redeploy 配置，涉及 token 与 .env 路径引用，不得自动执行。

## 4. 发现问题

- P1：历史 archive_task 流程与 token 配置未隔离

## 修复范围

仅限 codeflowmu-shell eval-promotion 模块；不得直接调用 archive_task 或 redeploy rules。
需 ADMIN 确认后再派发。

## 验收标准

- 命中 archive/redeploy/token 关键词时 task 草稿 risk_level=high
- PM 不得直接执行，需 ADMIN 确认
`;

/** panel-scan 文件名 + 观察语义，门禁应拒绝 lifecycle task */
const PANEL_SCAN_GAP = `---
protocol: fcop
version: "1"
kind: eval
eval_type: gap
sender: SYSTEM
recipient: ADMIN
subject: [EVAL] 面板扫描 · 2026-06-12
promotion:
  status: pending
---

# CodeFlowMu · EVAL 观察（panel-scan）

## 1. 结论

扫描九类资产后发现若干待跟进项，本报告为 panel-scan 自动生成摘要，仅供留档。

## 修复范围

仅用于记录扫描结果，不定义可执行修复范围。不应晋升 lifecycle task。

## 验收标准

panel-scan 无独立验收标准；仅 GAP 留档或 issue draft。
`;

/** PM summary 旁路观察：含内部编号与 covers_all_child_tasks:false */
const PM_SUMMARY_OBSERVATION = `---
protocol: fcop
version: 1
kind: eval-observation
observation_id: OBSERVATION-20260612-010
source_report: REPORT-20260612-038-PM-to-ADMIN
main_task_id: TASK-20260612-029
thread_key: eval-promotion-20260612-029
promotion:
  status: pending
---

# EVAL 任务观察 / Task Observation

Source PM report: REPORT-20260612-038-PM-to-ADMIN
Main task: TASK-20260612-029
Thread: eval-promotion-20260612-029

## Findings

- PM 总报告未覆盖子任务：TASK-20260612-027

## PM Summary Consistency

- covers_all_child_tasks: false
- covers_all_worker_reports: true
`;

const INTERNAL_ID_RE =
  /\b(TASK-\d{8}-\d+|REPORT-\d{8}-\d+|ISSUE-\d{8}-\d+|Thread\s*:|Source\s+PM\s+report|Main\s+task\s*:|eval-promotion-|source_eval)/i;

function writeEvalSample(root: string, basename: string, body = SAMPLE_EVAL): string {
  const evalDir = join(root, "fcop", "internal", "eval");
  mkdirSync(evalDir, { recursive: true });
  const rel = `fcop/internal/eval/${basename}`;
  writeFileSync(join(root, ...rel.split("/")), body, "utf-8");
  return rel;
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-promo-"));
  const v3 = fcopV3Paths(root);
  mkdirSync(v3.inbox, { recursive: true });
  writeEvalSample(root, "OBSERVATION-20260602-099-test-promo.md");
  return root;
}

function writeActionableEvalSample(root: string, basename: string): string {
  return writeEvalSample(root, basename, ACTIONABLE_GAP);
}

function writeHighRiskEvalSample(root: string, basename: string): string {
  return writeEvalSample(root, basename, HIGH_RISK_GAP);
}

test("parsePromotionBlock reads nested promotion fields", () => {
  const fm = `kind: eval
promotion:
  status: promoted
  target_type: task
  target_file: fcop/_lifecycle/inbox/TASK-20260602-001-ADMIN-to-PM.md
`;
  const p = parsePromotionBlock(fm);
  assert.equal(p.status, "promoted");
  assert.equal(p.target_type, "task");
  assert.match(p.target_file, /TASK-/);
});

test("readEvalPromotionState prefers nested promotion over legacy flat", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-nested-"));
  try {
    const v3 = fcopV3Paths(root);
    mkdirSync(v3.inbox, { recursive: true });
    const nestedEval = `---
protocol: fcop
version: "1"
kind: eval
eval_type: gap
sender: SYSTEM
recipient: ADMIN
subject: nested promotion 优先于 legacy flat
promotion:
  status: promoted
  target_type: task
  target_file: fcop/_lifecycle/inbox/TASK-legacy-should-ignore.md
  task:
    status: pending
  issue:
    status: pending
---

# nested vs flat

## 修复范围

仅限 codeflowmu-shell 的 eval-promotion 模块：嵌套 promotion.task/issue 分支须覆盖 legacy flat 字段，不得误读 flat promoted 为已晋升。

## 验收标准

- readEvalPromotionState 在同时存在 flat promoted 与 branch pending 时返回 task_status/issue_status 为空
- can_promote_task 仍按正文门禁判定，不受 legacy flat 误锁
`;
    const rel = "fcop/internal/eval/GAP-20260602-200-nested.md";
    mkdirSync(join(root, "fcop", "internal", "eval"), { recursive: true });
    writeFileSync(join(root, ...rel.split("/")), nestedEval, "utf-8");
    const st = readEvalPromotionState(root, rel);
    assert.equal(st.status, "pending");
    assert.equal(st.legacy_flat, false);
    assert.equal(st.task_status, "");
    assert.equal(st.issue_status, "");
    assert.equal(st.can_promote_task, true);
    assert.equal(st.classification, "actionable_gap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canPromoteEvalToTask allows actionable gap with fix scope and acceptance", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-gate-ok-"));
  try {
    const v3 = fcopV3Paths(root);
    mkdirSync(v3.inbox, { recursive: true });
    const rel = writeActionableEvalSample(root, "GAP-20260612-401-actionable.md");
    const gate = canPromoteEvalToTask(root, rel);
    assert.equal(gate.allowed, true);
    assert.deepEqual(gate.reasons, []);
    assert.equal(gate.classification, "actionable_gap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canPromoteEvalToTask rejects SAMPLE_EVAL missing fix scope and acceptance", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-gate-sample-"));
  try {
    const v3 = fcopV3Paths(root);
    mkdirSync(v3.inbox, { recursive: true });
    const rel = writeEvalSample(root, "OBSERVATION-20260612-402-obs-only.md");
    const gate = canPromoteEvalToTask(root, rel);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((r) => /修复范围/.test(r)));
    assert.ok(gate.reasons.some((r) => /验收标准/.test(r)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canPromoteEvalToTask rejects panel-scan eval", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-gate-panel-"));
  try {
    const v3 = fcopV3Paths(root);
    mkdirSync(v3.inbox, { recursive: true });
    const rel = writeEvalSample(root, "GAP-20260612-013-panel-scan.md", PANEL_SCAN_GAP);
    const gate = canPromoteEvalToTask(root, rel);
    assert.equal(gate.allowed, false);
    assert.equal(gate.classification, "observation_only");
    assert.ok(gate.reasons.some((r) => /panel-scan/.test(r)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canPromoteEvalToTask blocks duplicate source_eval lifecycle task", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-gate-dup-"));
  try {
    const v3 = fcopV3Paths(root);
    mkdirSync(v3.inbox, { recursive: true });
    const rel = writeActionableEvalSample(root, "GAP-20260612-501-dup.md");
    const taskFm = `---
protocol: fcop
version: 1
kind: task
task_id: TASK-20260612-501
sender: ADMIN
recipient: PM
source_eval: ${rel}
---

# Existing promoted task
`;
    writeFileSync(join(v3.inbox, "TASK-20260612-501-ADMIN-to-PM.md"), taskFm, "utf-8");
    const gate = canPromoteEvalToTask(root, rel);
    assert.equal(gate.allowed, false);
    assert.equal(gate.existing_task_id, "TASK-20260612-501");
    assert.match(gate.existing_task_file || "", /inbox\/TASK-20260612-501/);
    assert.ok(gate.reasons.some((r) => /同 source_eval/.test(r)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatEvalTaskPromoteGateError maps gate prefix to HTTP 400", () => {
  const err = new Error(`${EVAL_TASK_PROMOTE_GATE_PREFIX}: 缺少明确的修复范围；缺少明确的验收标准`);
  const { status, body } = formatEvalTaskPromoteGateError(err);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.deepEqual(body.reasons, ["缺少明确的修复范围", "缺少明确的验收标准"]);
});

test("formatEvalTaskPromoteGateError leaves non-gate errors as 500", () => {
  const { status, body } = formatEvalTaskPromoteGateError(new Error("unexpected"));
  assert.equal(status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, "unexpected");
});

let seq = 1;
function allocSeq(_date: string): string {
  return String(seq++).padStart(3, "0");
}

test("promoteEvalToLocalTask rejects observation-only SAMPLE_EVAL at gate", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-100-gate-block.md");
    assert.throws(
      () =>
        promoteEvalToLocalTask({
          projectRoot: root,
          adminInboxDir: v3.inbox,
          evalRelPath: rel,
          allocateTaskSeq: allocSeq,
        }),
      /EVAL 不满足本地任务晋升条件/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToLocalTask writes task draft and promotion block", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260602-101-task.md");
    const result = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(result.action, "task");
    assert.match(result.target_file, /fcop\/internal\/eval\/task-drafts\/TASK-DRAFT-/);
    const draftPath = join(root, ...result.target_file.split("/"));
    assert.ok(existsSync(draftPath));
    assert.equal(existsSync(join(v3.inbox, result.filename)), false);
    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /task:\s*\n\s+status: draft_created/);
    assert.match(evalRaw, /target_type: local_task_draft/);
    assert.match(evalRaw, /planned_inbox_path: fcop\/_lifecycle\/inbox\/TASK-/);
    const draftRaw = readFileSync(draftPath, "utf-8");
    assert.match(draftRaw, /kind: local_task_draft/);
    assert.match(draftRaw, /source_eval: fcop\/internal\/eval\/GAP-20260602-101-task\.md/);
    assert.match(draftRaw, /auto_generated: true/);
    assert.match(draftRaw, /risk_review_required: true/);
    assert.match(draftRaw, /risk_level: review_required/);
    assert.match(draftRaw, /自动生成任务草稿/);
    assert.match(draftRaw, /高风险操作检查/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToLocalTask marks high risk when keywords detected", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeHighRiskEvalSample(root, "GAP-20260612-104-high-risk.md");
    const result = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const draftPath = join(root, ...result.target_file.split("/"));
    const draftRaw = readFileSync(draftPath, "utf-8");
    assert.match(draftRaw, /risk_level: high/);
    assert.match(draftRaw, /risk_flags: .*archive/);
    assert.match(draftRaw, /risk_flags: .*redeploy/);
    assert.match(draftRaw, /risk_flags: .*token/);
    assert.match(draftRaw, /高风险自动任务草稿/);
    assert.match(draftRaw, /PM 不得直接执行。需 ADMIN 明确确认后再派发。/);
    assert.doesNotMatch(draftRaw, /⚠️ 自动生成任务草稿/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToLocalTask high risk still generates draft without blocking", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeHighRiskEvalSample(root, "GAP-20260612-105-high-risk-block.md");
    const result = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(result.action, "task");
    assert.ok(existsSync(join(root, ...result.target_file.split("/"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue draft promotion unaffected by task risk markers", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeHighRiskEvalSample(root, "GAP-20260612-106-issue-unaffected.md");
    const result = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const draftPath = join(root, ...result.target_file.split("/"));
    const raw = readFileSync(draftPath, "utf-8");
    assert.match(raw, /kind: github_issue_draft/);
    assert.doesNotMatch(raw, /auto_generated: true/);
    assert.doesNotMatch(raw, /risk_review_required: true/);
    assert.doesNotMatch(raw, /risk_level: high/);
    assert.doesNotMatch(raw, /自动生成任务草稿/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToCodeflowMuIssueDraft writes issue-drafts file", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-102-cfm.md");
    const result = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(result.target_repo, "joinwell52-AI/CodeFlowMu");
    const draftPath = join(root, ...result.target_file.split("/"));
    assert.ok(existsSync(draftPath));
    const raw = readFileSync(draftPath, "utf-8");
    assert.match(raw, /kind: github_issue_draft/);
    assert.match(raw, /target_repo: joinwell52-AI\/CodeFlowMu/);
    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /task:\s*\n\s+status: pending/);
    assert.match(evalRaw, /codeflowmu_issue:\s*\n\s+status: promoted/);
    assert.match(evalRaw, /target_type: github_issue_draft/);
    assert.match(evalRaw, /promoted_at:/);
    assert.doesNotMatch(evalRaw, /draft_created_at:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToFcopIssueDraft writes FCOP draft", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-103-fcop.md");
    const result = promoteEvalToFcopIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(result.target_repo, "joinwell52-AI/FCoP");
    assert.match(result.filename, /^FCOP-ISSUE-DRAFT-/);
    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /task:\s*\n\s+status: pending/);
    assert.match(evalRaw, /fcop_issue:\s*\n\s+status: promoted/);
    assert.match(evalRaw, /promoted_at:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToCodeflowMuIssueDraft rejects duplicate draft", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-104-dup.md");
    const opts = {
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    };
    promoteEvalToCodeflowMuIssueDraft(opts);
    assert.throws(
      () => promoteEvalToCodeflowMuIssueDraft(opts),
      /已生成 Issue 草稿/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue draft first still allows local task promotion", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260602-105-issue-then-task.md");
    promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const taskResult = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(taskResult.action, "task");
    const st = readEvalPromotionState(root, rel);
    assert.equal(st.issue_status, "promoted");
    assert.equal(st.task_status, "draft_created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local task draft first still allows issue draft promotion", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260602-106-task-then-issue.md");
    promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const issueResult = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(issueResult.target_repo, "joinwell52-AI/CodeFlowMu");
    const st = readEvalPromotionState(root, rel);
    assert.equal(st.task_status, "draft_created");
    assert.equal(st.issue_status, "promoted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToLocalTask rejects duplicate local task draft", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260602-107-dup-task.md");
    const opts = {
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    };
    promoteEvalToLocalTask(opts);
    assert.throws(() => promoteEvalToLocalTask(opts), /已生成本地任务/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy flat promotion target_type task maps to task_status promoted", () => {
  const fm = `kind: eval
promotion:
  status: promoted
  target_type: task
  target_file: fcop/_lifecycle/inbox/TASK-20260602-001-ADMIN-to-PM.md
`;
  const p = parsePromotionBlock(fm);
  assert.equal(p.task.status, "promoted");
  assert.equal(p.task.target_file, "fcop/_lifecycle/inbox/TASK-20260602-001-ADMIN-to-PM.md");
  assert.equal(p.legacy_flat, true);
  const st = extendEvalPromotionStateForTest(p);
  assert.equal(st.task_status, "promoted");
  assert.equal(st.issue_status, "");
});

test("legacy flat promotion target_type github_issue_draft maps to issue_status promoted", () => {
  const fm = `kind: eval
promotion:
  status: promoted
  target_type: github_issue_draft
  target_file: fcop/internal/eval/issue-drafts/CODEFLOWMU-ISSUE-DRAFT-20260602-001.md
  target_repo: joinwell52-AI/CodeFlowMu
`;
  const p = parsePromotionBlock(fm);
  assert.equal(p.issue.status, "promoted");
  assert.match(p.issue.target_file, /issue-drafts/);
  assert.equal(p.codeflowmu_issue.status, "promoted");
  const st = extendEvalPromotionStateForTest(p);
  assert.equal(st.issue_status, "promoted");
  assert.equal(st.task_status, "");
  assert.equal(st.codeflowmu_issue.promoted, true);
  assert.equal(st.fcop_issue.promoted, false);
});

test("readEvalPromotionState exposes task_status and issue_status", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-200-status-fields.md");
    const st0 = readEvalPromotionState(root, rel);
    assert.equal(st0.task_status, "");
    assert.equal(st0.issue_status, "");
    assert.equal(st0.status, "pending");

    promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const st1 = readEvalPromotionState(root, rel);
    assert.equal(st1.issue_status, "promoted");
    assert.match(st1.issue_target_file, /issue-drafts/);
    assert.equal(st1.task_status, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalLocalTaskDraft requires admin_approved", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260612-301-task-gate.md");
    promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.throws(
      () =>
        submitEvalLocalTaskDraft({
          projectRoot: root,
          adminInboxDir: v3.inbox,
          evalRelPath: rel,
          adminApproved: false,
        }),
      /admin_approved/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalLocalTaskDraft lands inbox TASK and updates promotion", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260612-302-task-submit.md");
    const draft = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const result = submitEvalLocalTaskDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      adminApproved: true,
    });
    assert.match(result.target_file, /fcop\/_lifecycle\/inbox\/TASK-/);
    assert.ok(existsSync(join(v3.inbox, result.filename)));
    const taskRaw = readFileSync(join(v3.inbox, result.filename), "utf-8");
    assert.match(taskRaw, /kind: task/);
    assert.match(taskRaw, /source_type: eval_promotion/);

    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /task:\s*\n\s+status: promoted/);
    assert.match(evalRaw, /target_type: task/);

    const draftRaw = readFileSync(join(root, ...draft.target_file.split("/")), "utf-8");
    assert.match(draftRaw, /status: submitted/);

    const st = readEvalPromotionState(root, rel);
    assert.equal(st.task_status, "promoted");
    assert.equal(st.task_target_file, result.target_file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteEvalPromotionDraft removes draft and resets promotion", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260612-303-delete-draft.md");
    const draft = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const deleted = deleteEvalPromotionDraft({
      projectRoot: root,
      evalRelPath: rel,
    });
    assert.equal(deleted.deleted_file, draft.target_file);
    assert.equal(existsSync(join(root, ...draft.target_file.split("/"))), false);
    const st = readEvalPromotionState(root, rel);
    assert.equal(st.task_status, "");
    assert.equal(st.status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalIssueDraft requires admin_approved", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-201-submit-gate.md");
    promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.throws(
      () =>
        submitEvalIssueDraft({
          projectRoot: root,
          evalRelPath: rel,
          adminApproved: false,
        }),
      /admin_approved/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalIssueDraft creates github issue and updates promotion", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-202-submit-ok.md");
    const draft = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const result = submitEvalIssueDraft({
      projectRoot: root,
      evalRelPath: rel,
      adminApproved: true,
      createGithubIssue: () => "https://github.com/joinwell52-AI/CodeFlowMu/issues/42",
    });
    assert.equal(result.github_url, "https://github.com/joinwell52-AI/CodeFlowMu/issues/42");
    assert.equal(result.github_issue_number, 42);
    assert.equal(result.target_file, draft.target_file);

    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /status: submitted/);
    assert.match(evalRaw, /target_type: github_issue/);
    assert.match(evalRaw, /github_url: https:\/\/github\.com\/joinwell52-AI\/CodeFlowMu\/issues\/42/);

    const draftRaw = readFileSync(join(root, ...draft.target_file.split("/")), "utf-8");
    assert.match(draftRaw, /status: submitted/);

    const st = readEvalPromotionState(root, rel);
    assert.equal(st.status, "submitted");
    assert.equal(st.target_type, "github_issue");
    assert.equal(st.github_url, "https://github.com/joinwell52-AI/CodeFlowMu/issues/42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalIssueDraft rejects duplicate submit", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-203-submit-dup.md");
    promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    submitEvalIssueDraft({
      projectRoot: root,
      evalRelPath: rel,
      adminApproved: true,
      createGithubIssue: () => "https://github.com/joinwell52-AI/CodeFlowMu/issues/1",
    });
    assert.throws(
      () =>
        submitEvalIssueDraft({
          projectRoot: root,
          evalRelPath: rel,
          adminApproved: true,
          createGithubIssue: () => "https://github.com/joinwell52-AI/CodeFlowMu/issues/2",
        }),
      /无待提交的 Issue 草稿|已提交/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildGithubReadyIssueBody redacts INTERNAL ONLY from output", () => {
  const result = buildGithubReadyIssueBody({
    title: "Panel lifecycle drift",
    rawProblem: "INTERNAL ONLY · 内部档案说明：Panel 与 ledger 不一致。",
    whyRepo: "应在公仓跟踪宿主行为。",
    targetLabel: "CodeFlowMu",
  });
  assert.doesNotMatch(result.body, /INTERNAL\s+ONLY/i);
  assert.match(result.body, /^# Panel lifecycle drift/m);
  assert.match(result.body, /## Problem/);
  assert.doesNotMatch(result.body, /PUBLIC UNSAFE DRAFT/);
  assert.equal(result.redacted, true);
});

test("buildGithubReadyIssueBody redacts fcop/internal/eval paths", () => {
  const result = buildGithubReadyIssueBody({
    title: "Eval path leak",
    rawProblem: "见 fcop/internal/eval/GAP-20260612-011-panel-scan.md 中的结论。",
    whyRepo: "公开跟踪。",
    targetLabel: "CodeFlowMu",
  });
  assert.doesNotMatch(result.body, /fcop\/internal\/eval/i);
});

test("buildGithubReadyIssueBody redacts MANUAL-EVAL references", () => {
  const result = buildGithubReadyIssueBody({
    title: "Manual eval ref",
    rawProblem: "关联 MANUAL-EVAL-20260612-001 的手工观察。",
    whyRepo: "公开跟踪。",
    targetLabel: "FCoP",
  });
  assert.doesNotMatch(result.body, /MANUAL-EVAL-/i);
});

test("buildGithubReadyIssueBody redacts fcop/logs paths", () => {
  const result = buildGithubReadyIssueBody({
    title: "Log path leak",
    rawProblem: "详见 fcop/logs/audit/scan.jsonl 中的条目。",
    whyRepo: "公开跟踪。",
    targetLabel: "CodeFlowMu",
  });
  assert.doesNotMatch(result.body, /fcop\/logs/i);
});

test("promoteEvalToIssueDraft writes github_ready public_safe frontmatter", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260602-201-github-ready.md");
    const result = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const draftPath = join(root, ...result.target_file.split("/"));
    const draftFile = readFileSync(draftPath, "utf-8");
    assert.match(draftFile, /public_candidate: true/);
    assert.match(draftFile, /public_safe: true/);
    assert.match(draftFile, /redacted: true/);
    assert.match(draftFile, /redaction_status: github_ready/);
    assert.match(draftFile, /admin_approved: false/);
    assert.match(draftFile, /## Problem/);
    assert.doesNotMatch(draftFile, /INTERNAL\s+ONLY/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildGithubReadyIssueBody marks unsafe when forbidden terms remain", () => {
  const result = buildGithubReadyIssueBody({
    title: "Stubborn internal marker",
    rawProblem: "After scrubbing, internal/eval marker still appears in public text.",
    whyRepo: "Track publicly.",
    targetLabel: "CodeFlowMu",
  });
  assert.match(result.body, /PUBLIC UNSAFE DRAFT/);
  assert.match(result.redactionReasons.join(" "), /unsafe_after_redaction/);
});

test("buildGithubReadyIssueBody strips internal TASK/REPORT/Thread from rawProblem", () => {
  const rawProblem = [
    "Source PM report: REPORT-20260612-038-PM-to-ADMIN",
    "Main task: TASK-20260612-029",
    "Thread: eval-promotion-20260612-029",
    "PM 总报告未覆盖子任务：TASK-20260612-027",
  ].join("\n");
  const result = buildGithubReadyIssueBody({
    title: "EVAL 任务观察 / Task Observation",
    rawProblem,
    whyRepo: "Track in CodeFlowMu repository.",
    targetLabel: "CodeFlowMu",
  });
  assert.doesNotMatch(result.body, INTERNAL_ID_RE);
  assert.equal(scanIssueBodyForInternalIds(result.body).length, 0);
  assert.doesNotMatch(result.body, /Source PM report/i);
  assert.doesNotMatch(result.body, /Main task:/i);
});

test("buildGithubReadyIssueBody uses PM summary coverage template when child tasks missing", () => {
  assert.equal(isPmSummaryCoverageGap(PM_SUMMARY_OBSERVATION), true);
  const result = buildGithubReadyIssueBody({
    title: "EVAL 任务观察 / Task Observation",
    rawProblem: PM_SUMMARY_OBSERVATION,
    whyRepo: "Track in CodeFlowMu repository.",
    targetLabel: "CodeFlowMu",
  });
  assert.match(
    result.body,
    /^# PM summary should explicitly cover all child tasks before review/m,
  );
  assert.match(result.body, /consistency gap between the child-task lifecycle/);
  assert.match(result.body, /Every child task in the thread must be mentioned/);
  assert.doesNotMatch(result.body, INTERNAL_ID_RE);
  assert.doesNotMatch(result.body, /Source PM report/i);
  assert.doesNotMatch(result.body, /Main task:/i);
  assert.doesNotMatch(result.body, /Thread:/i);
});

test("PM summary coverage template Proposal does not repeat source metadata", () => {
  const result = buildGithubReadyIssueBody({
    title: "EVAL 任务观察 / Task Observation",
    rawProblem: PM_SUMMARY_OBSERVATION,
    whyRepo: "Source PM report: REPORT-20260612-038-PM-to-ADMIN",
    targetLabel: "CodeFlowMu",
    rawProposal: "Main task: TASK-20260612-029\nThread: eval-promotion-20260612-029",
  });
  const proposalSection = result.body.split("## Proposal")[1]?.split("## Acceptance Criteria")[0] ?? "";
  assert.doesNotMatch(proposalSection, /Source PM report/i);
  assert.doesNotMatch(proposalSection, /Main task:/i);
  assert.doesNotMatch(proposalSection, /Thread:/i);
  assert.doesNotMatch(proposalSection, INTERNAL_ID_RE);
});

test("PM summary coverage template Acceptance Criteria match consistency requirements", () => {
  const result = buildGithubReadyIssueBody({
    title: "EVAL 任务观察 / Task Observation",
    rawProblem: "covers_all_child_tasks: false\nPM Summary Consistency",
    whyRepo: "Track publicly.",
    targetLabel: "CodeFlowMu",
  });
  assert.match(result.body, /PM final report coverage is checked against all child tasks/);
  assert.match(result.body, /Missing child-task coverage blocks or flags parent review/);
  assert.match(result.body, /Panel shows an ADMIN-facing warning when coverage is incomplete/);
  assert.match(
    result.body,
    /Public issue contains no internal task IDs, report IDs, thread keys, paths, or private logs/,
  );
});

test("promoteEvalToIssueDraft pm-summary observation is public_safe with no internal ids", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-010-pm-summary.md", PM_SUMMARY_OBSERVATION);
    const result = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const draftPath = join(root, ...result.target_file.split("/"));
    const draftFile = readFileSync(draftPath, "utf-8");
    const draftBody = draftFile.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    assert.match(draftFile, /public_safe: true/);
    assert.match(draftBody, /PM summary should explicitly cover all child tasks before review/);
    assert.doesNotMatch(draftBody, INTERNAL_ID_RE);
    assert.equal(scanIssueBodyForInternalIds(draftBody).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToIssueDraft sets public_safe false when redaction fails", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(
      root,
      "GAP-20260602-202-unsafe-issue.md",
      `---
protocol: fcop
version: "1"
kind: eval
eval_type: gap
promotion:
  status: pending
---

# 不可安全外发 Issue 测试

## 4. 发现问题

internal/eval marker must remain after naive copy for unsafe test.
`,
    );
    const result = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const draftPath = join(root, ...result.target_file.split("/"));
    const draftFile = readFileSync(draftPath, "utf-8");
    assert.match(draftFile, /public_safe: false/);
    assert.match(draftFile, /public_candidate: false/);
    assert.match(draftFile, /redaction_status: unsafe_after_redaction/);
    assert.match(draftFile, /PUBLIC UNSAFE DRAFT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToLocalTask unchanged when issue draft uses github-ready body", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260602-203-task-only.md");
    const result = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(result.action, "task");
    const draftPath = join(root, ...result.target_file.split("/"));
    const draftRaw = readFileSync(draftPath, "utf-8");
    assert.match(draftRaw, /kind: local_task_draft/);
    assert.match(draftRaw, /## 修复范围/);
    assert.doesNotMatch(draftRaw, /redaction_status: github_ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same EVAL can hold task codeflowmu_issue and fcop_issue drafts together", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeActionableEvalSample(root, "GAP-20260612-401-three-branches.md");
    const taskDraft = promoteEvalToLocalTask({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const cfmDraft = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const fcopDraft = promoteEvalToFcopIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    assert.equal(taskDraft.action, "task");
    assert.match(cfmDraft.filename, /^CODEFLOWMU-ISSUE-DRAFT-/);
    assert.match(fcopDraft.filename, /^FCOP-ISSUE-DRAFT-/);

    const st = readEvalPromotionState(root, rel);
    assert.equal(st.task_status, "draft_created");
    assert.equal(st.task.promoted, true);
    assert.equal(st.codeflowmu_issue.promoted, true);
    assert.equal(st.fcop_issue.promoted, true);
    assert.equal(st.task.target_file, taskDraft.target_file);
    assert.equal(st.codeflowmu_issue.target_file, cfmDraft.target_file);
    assert.equal(st.fcop_issue.target_file, fcopDraft.target_file);

    const evalRaw = readFileSync(join(root, ...rel.split("/")), "utf-8");
    assert.match(evalRaw, /task:\s*\n\s+status: draft_created/);
    assert.match(evalRaw, /codeflowmu_issue:\s*\n\s+status: promoted/);
    assert.match(evalRaw, /fcop_issue:\s*\n\s+status: promoted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoteEvalToFcopIssueDraft rejects duplicate draft", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-402-fcop-dup.md");
    const opts = {
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    };
    promoteEvalToFcopIssueDraft(opts);
    assert.throws(() => promoteEvalToFcopIssueDraft(opts), /已生成 Issue 草稿/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteEvalPromotionDraft with draftRelPath only resets matching issue branch", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-403-delete-one-issue.md");
    promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const fcopDraft = promoteEvalToFcopIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    const cfmSt = readEvalPromotionState(root, rel);
    const cfmDraftRel = cfmSt.codeflowmu_issue.target_file;
    assert.ok(cfmDraftRel);

    const deleted = deleteEvalPromotionDraft({
      projectRoot: root,
      evalRelPath: rel,
      draftRelPath: cfmDraftRel,
    });
    assert.equal(deleted.deleted_file, cfmDraftRel);
    assert.equal(existsSync(join(root, ...cfmDraftRel.split("/"))), false);
    assert.ok(existsSync(join(root, ...fcopDraft.target_file.split("/"))));

    const st = readEvalPromotionState(root, rel);
    assert.equal(st.codeflowmu_issue.promoted, false);
    assert.equal(st.codeflowmu_issue.target_file, "");
    assert.equal(st.fcop_issue.promoted, true);
    assert.equal(st.fcop_issue.target_file, fcopDraft.target_file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitEvalIssueDraft with draftRelPath submits only matching branch", () => {
  const root = setupProject();
  try {
    const v3 = fcopV3Paths(root);
    const rel = writeEvalSample(root, "OBSERVATION-20260612-404-submit-by-path.md");
    const cfmDraft = promoteEvalToCodeflowMuIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });
    promoteEvalToFcopIssueDraft({
      projectRoot: root,
      adminInboxDir: v3.inbox,
      evalRelPath: rel,
      allocateTaskSeq: allocSeq,
    });

    const result = submitEvalIssueDraft({
      projectRoot: root,
      evalRelPath: rel,
      draftRelPath: cfmDraft.target_file,
      adminApproved: true,
      createGithubIssue: () => "https://github.com/joinwell52-AI/CodeFlowMu/issues/99",
    });
    assert.equal(result.github_issue_number, 99);
    assert.equal(result.target_file, cfmDraft.target_file);

    const st = readEvalPromotionState(root, rel);
    assert.equal(st.codeflowmu_issue.promoted, true);
    assert.match(st.codeflowmu_issue.target_file, /issue-drafts/);
    assert.equal(st.fcop_issue.promoted, true);
    assert.match(st.fcop_issue.target_file, /FCOP-ISSUE-DRAFT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
