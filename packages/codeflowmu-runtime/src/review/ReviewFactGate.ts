import type { EvidenceSummary } from "./ReviewEvidenceResolver.ts";

export type FactCheckVerdict = "pass" | "fail" | "needs_admin";

export type FactCheckReasonCode =
  | "missing_test_evidence"
  | "missing_data_evidence"
  | "missing_file_evidence"
  | "missing_row_count_evidence"
  | "missing_stats_evidence"
  | "test_exit_code_mismatch"
  | "evidence_inconclusive"
  | "session_evidence_gap"
  | "no_claims_detected"
  | "evidence_verified"
  | "ack_only_done_report"
  | "qa_acceptance_evidence_missing"
  | "browser_evidence_required";

export type ReportClaims = {
  claimsTestRun: boolean;
  claimsTestPassed: boolean;
  claimsDataQuery: boolean;
  claimsFileChange: boolean;
  claimsNumericStats: boolean;
  claimsMarkdownTable: boolean;
};

export type FactCheckResult = {
  verdict: FactCheckVerdict;
  reason_code: FactCheckReasonCode;
  unsupported_claims: string[];
  required_changes: string[];
  claims: ReportClaims;
};

const TEST_RUN_PATTERNS = [
  /\b(npm test|pnpm test|yarn test|pytest|jest|vitest|mocha|cargo test|go test)\b/i,
  /跑(了)?(过)?测试/,
  /单元测试/,
  /集成测试/,
  /tests?\s+(were\s+)?run/i,
  /ran\s+tests?/i,
];

const TEST_PASSED_PATTERNS = [
  /测试(全部)?通过/,
  /tests?\s+pass(ed)?/i,
  /all tests pass/i,
  /0 failed/i,
  /测试成功/,
];

/** 正文里明确声称「查了库 / 跑了 SQL / 有 row_count 结果」——不含 Action Evidence 日志类型标签 */
const EXPLICIT_DATA_QUERY_PATTERNS = [
  /数据查询/,
  /查询(了)?数据/,
  /row_count/i,
  /\bSELECT\b/i,
  /查到\s*\d+/,
];

/**
 * 引用动作日志事件类型（如 **data.query 摘要**）≠ 声称执行了数据库查询。
 * 仅整行是「类型名 + 摘要/原始输出见…」时视为 citation，不参与 claimsDataQuery。
 */
function isActionLogTypeCitationLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;

  const logTypeSummary =
    /\b(?:command\.run|file\.(?:read|edit|write)|data\.query)\s*摘要\b/i;
  if (logTypeSummary.test(t)) return true;

  if (
    /(?:动作日志|Action Evidence|action evidence|event_type|动作类型)/i.test(t) &&
    /data\.query/i.test(t) &&
    !/\bSELECT\b|数据查询|查询数据|查到\s*\d+/i.test(t)
  ) {
    return true;
  }

  return false;
}

function bodyWithoutLogTypeCitations(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !isActionLogTypeCitationLine(line))
    .join("\n");
}

/** 去掉日志类型引用行后，是否仍含可审计的数据库/SQL 查询声明 */
function claimsExplicitDatabaseQuery(body: string): boolean {
  const scrubbed = bodyWithoutLogTypeCitations(body);
  if (hasPattern(scrubbed, EXPLICIT_DATA_QUERY_PATTERNS)) return true;

  if (!/data\.query/i.test(scrubbed)) return false;

  // 正文中仍出现 data.query 且带执行/结果语义（非路径片段）
  return (
    /(?:执行|记录|补充|缺少|无)\s*[`']?data\.query/i.test(scrubbed) ||
    /data\.query\s*(?:动作|证据|事件|返回|结果)/i.test(scrubbed) ||
    /data\.query[^`\n]*row_count/i.test(scrubbed)
  );
}

const FILE_CHANGE_PATTERNS = [
  /修改(了)?(文件|代码)/,
  /更新(了)?文件/,
  /改了\s*[`']?[\w./-]+/,
  /file(s)?\s+(changed|modified|updated|written)/i,
  /编辑(了)?\s*[`']?[\w./-]+/,
];

const NUMERIC_STATS_PATTERNS = [
  /\d+\s*条(记录|数据|结果)?/,
  /共\s*\d+\s*条/,
  /total[:\s]+\d+/i,
  /count[:\s]+\d+/i,
  /\d+\s*passed/i,
];

function hasPattern(body: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(body));
}

function hasMarkdownDataTable(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let tableLines = 0;
  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) tableLines += 1;
  }
  return tableLines >= 2;
}

/** Heuristic claim detection from REPORT body (frontmatter already stripped). */
export function detectReportClaims(reportBody: string): ReportClaims {
  const body = reportBody.trim();
  return {
    claimsTestRun: hasPattern(body, TEST_RUN_PATTERNS),
    claimsTestPassed: hasPattern(body, TEST_PASSED_PATTERNS),
    claimsDataQuery: claimsExplicitDatabaseQuery(body),
    claimsFileChange: hasPattern(body, FILE_CHANGE_PATTERNS),
    claimsNumericStats: hasPattern(body, NUMERIC_STATS_PATTERNS),
    claimsMarkdownTable: hasMarkdownDataTable(body),
  };
}

function hasRowCountEvidence(evidence: EvidenceSummary): boolean {
  return evidence.data_queries.some((q) => q.row_count != null && q.row_count >= 0);
}

/** 非库统计/表格：command、file.read、或任意 data.query 均可作为合理执行证据 */
function hasStatsSupportingEvidence(evidence: EvidenceSummary): boolean {
  if (hasRowCountEvidence(evidence)) return true;
  if (evidence.data_queries.length > 0) return true;

  const hasOkCommand = evidence.commands.some(
    (c) => c.exit_code == null || c.exit_code === 0,
  );
  if (hasOkCommand) return true;

  if (evidence.files.read.length > 0) return true;

  return false;
}

function hasAnyClaim(claims: ReportClaims): boolean {
  return (
    claims.claimsTestRun ||
    claims.claimsTestPassed ||
    claims.claimsDataQuery ||
    claims.claimsFileChange ||
    claims.claimsNumericStats
  );
}

const DONE_REPORT_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "finished",
  "success",
  "succeeded",
]);

const ACK_ONLY_BODY_PATTERNS = [
  /已收到任务/,
  /正在分析/,
  /准备执行/,
  /准备进行/,
  /正在派发/,
  /准备系统/,
  /\backnowledged\b/i,
  /\binitiating\b/i,
  /\breceived\s+task\b/i,
];

const NON_ACK_COMPLETION_PATTERNS = [
  /fcop_check|fcop_report|grep_files|list_tasks|write_task/i,
  /交付|验收|证据|evidence|完成项|测试通过|探针|probe|blocked|阻塞|派单|汇总|结论|deliverable/i,
  /##\s*(结果|交付|验收|证据|summary|evidence|deliverable|findings)/i,
];

/** status=done 但正文仅为 ack/进行中措辞 — 不能作为完成依据。 */
export function isAckOnlyReportBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  if (!ACK_ONLY_BODY_PATTERNS.some((re) => re.test(trimmed))) return false;
  if (NON_ACK_COMPLETION_PATTERNS.some((re) => re.test(trimmed))) return false;
  return true;
}

function isDoneReportStatus(status: unknown): boolean {
  const norm = String(status ?? "")
    .trim()
    .toLowerCase();
  return DONE_REPORT_STATUSES.has(norm);
}

/**
 * P2 fact gate: evidence_summary + REPORT body → pass | fail | needs_admin.
 * Does not auto-approve business completion; only gates lifecycle submit.
 */
export function evaluateReviewFactGate(
  evidence: EvidenceSummary,
  reportBody: string,
  opts?: {
    session_id?: string;
    report_status?: string;
    reporter_role?: string;
  },
): FactCheckResult {
  const claims = detectReportClaims(reportBody);
  const unsupported: string[] = [];
  const required: string[] = [];
  const isQa = String(opts?.reporter_role ?? "").trim().toUpperCase() === "QA";
  let qaReportBackedExecutionEvidence = false;

  if (isQa && isDoneReportStatus(opts?.report_status)) {
    const qaChecklist: Array<{ label: string; pattern: RegExp }> = [
      {
        label: "测试数据或隔离环境",
        pattern: /测试数据|隔离(?:测试)?数据|临时目录|种子数据|fixture|test\s*data/i,
      },
      {
        label: "模拟用户操作",
        pattern: /模拟(?:用户)?操作|用户操作|操作步骤|user\s*(?:action|flow)|interaction/i,
      },
      { label: "预期结果", pattern: /预期(?:结果)?|expected/i },
      { label: "实际结果", pattern: /实际(?:结果)?|actual/i },
      { label: "可追溯证据", pattern: /证据|evidence|命令输出|测试输出/i },
    ];
    const missing = qaChecklist
      .filter(({ pattern }) => !pattern.test(reportBody))
      .map(({ label }) => label);
    const qaAssets = [
      ...evidence.files.read,
      ...evidence.files.changed,
    ].map((path) => path.replace(/\\/g, "/").toLowerCase());
    const hasStructuredQaAsset = qaAssets.some(
      (path) =>
        /(?:^|\/)(?:qa-evidence|evidence)\/.+\.(?:json|jsonl|csv)$/i.test(path) ||
        /(?:test-data|test[_-]?cases|result[_-]?(?:summary|results)|qa[_-]?regression[_-]?results|browser[_-]?actions|command[_-]?results)\.(?:json|jsonl|csv)$/i.test(
          path,
        ),
    );
    const successfulCommands = evidence.commands.filter(
      ({ exit_code }) => exit_code === 0 || exit_code === undefined || exit_code === null,
    );
    const hasSuccessfulTestCommand = successfulCommands.some(({ command }) =>
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|cargo\s+test|go\s+test)\b/i.test(
        command,
      ),
    );
    const hasSuccessfulBrowserCommand = successfulCommands.some(({ command }) =>
      /\b(?:playwright\s+test|cypress\s+(?:run|open)|webdriverio|wdio)\b/i.test(command),
    );
    const hasBrowserAction = (evidence.browser_actions?.length ?? 0) > 0;
    // The formal REPORT is part of the auditable evidence chain. Manual or
    // recovered sessions may not project every tool event onto the original
    // task id, so session evidence is corroboration rather than the sole
    // source of truth for QA execution.
    const normalizedReport = reportBody.replace(/\\/g, "/");
    const hasStructuredQaAssetInReport =
      /(?:^|[\s`"'(])(?:workspace\/[^\s`"')]+\/)?(?:qa-evidence|evidence)\/[^\s`"')]+\.(?:json|jsonl|csv)\b/im.test(
        normalizedReport,
      );
    const reportClaimsSuccessfulResult =
      /(?:\bpass(?:ed)?\b|\b\d+\s*\/\s*\d+\b|通过|成功)/i.test(reportBody);
    const hasSuccessfulTestClaim =
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|cargo\s+test|go\s+test)\b/i.test(
        reportBody,
      ) && reportClaimsSuccessfulResult;
    const hasSuccessfulBrowserClaim =
      /\b(?:playwright\s+test|cypress\s+(?:run|open)|webdriverio|wdio)\b/i.test(reportBody) &&
      reportClaimsSuccessfulResult;
    const hasScreenshotClaim = /(?:截图|screenshot|[^\s`"')]+\.png\b)/i.test(
      normalizedReport,
    );
    const hasReportBackedExecutionEvidence =
      hasStructuredQaAssetInReport && hasSuccessfulTestClaim;
    qaReportBackedExecutionEvidence = hasReportBackedExecutionEvidence;
    const hasExecutionEvidence =
      hasStructuredQaAsset ||
      hasSuccessfulTestCommand ||
      hasSuccessfulBrowserCommand ||
      hasBrowserAction ||
      hasReportBackedExecutionEvidence;
    const hasCommandEvidence =
      evidence.commands.length > 0 || hasReportBackedExecutionEvidence;
    if (
      !hasCommandEvidence ||
      !hasExecutionEvidence
    ) {
      const evidenceGaps = [
        ...(evidence.commands.length === 0 ? ["执行命令"] : []),
        ...(!hasExecutionEvidence ? ["测试命令、浏览器动作或结构化验收资产"] : []),
      ];
      return {
        verdict: "fail",
        reason_code: "qa_acceptance_evidence_missing",
        unsupported_claims: [
          `QA 完成报告缺少：${evidenceGaps.join("、")}`,
        ],
        required_changes: [
          `补充${evidenceGaps.join("、")}后重新提交 QA 验收报告`,
        ],
        claims,
      };
    }

    const claimsRealBrowserAcceptance =
      /真实浏览器|playwright|响应式|移动端|布局|下载行为|截图|responsive|mobile|layout|download|screenshot/i.test(
        reportBody,
      );
    const hasReportBackedBrowserEvidence =
      hasSuccessfulBrowserClaim &&
      (hasScreenshotClaim || hasStructuredQaAssetInReport);
    if (
      claimsRealBrowserAcceptance &&
      !hasBrowserAction &&
      !hasSuccessfulBrowserCommand &&
      !hasReportBackedBrowserEvidence
    ) {
      return {
        verdict: "fail",
        reason_code: "browser_evidence_required",
        unsupported_claims: [
          "jsdom/DOM 测试不能证明真实布局、响应式或下载行为，且未找到浏览器动作证据",
        ],
        required_changes: [
          "使用 Playwright、Cypress 或真实浏览器执行验收，并保留成功命令、browser actions、截图或导出文件",
        ],
        claims,
      };
    }
  }

  if (isDoneReportStatus(opts?.report_status) && isAckOnlyReportBody(reportBody)) {
    return {
      verdict: "fail",
      reason_code: "ack_only_done_report",
      unsupported_claims: [
        "REPORT status=done 但正文仅为 ack/进行中措辞，不能作为完成依据",
      ],
      required_changes: [
        "补充真实交付、探针结果与 evidence 后再写 status=done 终版 REPORT",
      ],
      claims,
    };
  }

  if (!hasAnyClaim(claims)) {
    if (claims.claimsMarkdownTable && hasStatsSupportingEvidence(evidence)) {
      return {
        verdict: "pass",
        reason_code: "evidence_verified",
        unsupported_claims: [],
        required_changes: [],
        claims,
      };
    }
    return {
      verdict: "pass",
      reason_code: "no_claims_detected",
      unsupported_claims: [],
      required_changes: [],
      claims,
    };
  }

  const sessionExpected = Boolean(opts?.session_id?.trim());
  if (
    sessionExpected &&
    !evidence.session.found &&
    !qaReportBackedExecutionEvidence
  ) {
    return {
      verdict: isQa ? "fail" : "needs_admin",
      reason_code: "session_evidence_gap",
      unsupported_claims: ["报告声明了 session，但动作日志中未找到对应 session 证据"],
      required_changes: ["请 ADMIN 人工核对是否在本机外执行，或补录 session_id 对应动作日志"],
      claims,
    };
  }

  if (evidence.warnings.length > 0) {
    const inconclusive = evidence.warnings.some((w) =>
      /missing|unavailable|corrupt|parse/i.test(w),
    );
    if (inconclusive && !qaReportBackedExecutionEvidence) {
      return {
        verdict: "needs_admin",
        reason_code: "evidence_inconclusive",
        unsupported_claims: [...evidence.warnings],
        required_changes: ["动作日志不完整或不可读，需人工核对报告结论"],
        claims,
      };
    }
  }

  if (claims.claimsTestRun || claims.claimsTestPassed) {
    if (evidence.commands.length === 0 && !qaReportBackedExecutionEvidence) {
      unsupported.push("报告声称执行测试，但无 command.run 动作证据");
      required.push("补充 command.run 记录，或从报告中删除测试相关声明");
      return {
        verdict: "fail",
        reason_code: "missing_test_evidence",
        unsupported_claims: unsupported,
        required_changes: required,
        claims,
      };
    }
    if (claims.claimsTestPassed) {
      const failed = evidence.commands.find(
        (c) => c.exit_code != null && c.exit_code !== 0,
      );
      if (failed) {
        unsupported.push(
          `报告声称测试通过，但 command.run exit_code=${failed.exit_code}`,
        );
        required.push("修正报告结论，或重新运行测试并更新证据");
        return {
          verdict: "fail",
          reason_code: "test_exit_code_mismatch",
          unsupported_claims: unsupported,
          required_changes: required,
          claims,
        };
      }
    }
  }

  if (claims.claimsDataQuery) {
    if (evidence.data_queries.length === 0) {
      unsupported.push(
        "报告明确声称数据库/SQL 查询（非仅动作日志类型标签），但无 data.query 动作证据",
      );
      required.push(
        "补充 data.query（含 query_summary 与 row_count），或删除数据库查询相关声明",
      );
      return {
        verdict: "fail",
        reason_code: "missing_data_evidence",
        unsupported_claims: unsupported,
        required_changes: required,
        claims,
      };
    }
    if (!hasRowCountEvidence(evidence)) {
      unsupported.push("报告声称数据库查询，但 data.query 缺少 row_count");
      required.push("补充带 row_count 的 data.query（最好含 SQL/query_summary）");
      return {
        verdict: "fail",
        reason_code: "missing_row_count_evidence",
        unsupported_claims: unsupported,
        required_changes: required,
        claims,
      };
    }
  }

  if (claims.claimsFileChange) {
    if (evidence.files.changed.length === 0) {
      unsupported.push("报告声称修改文件，但无 file.edit/file.write 动作证据");
      required.push("补充文件变更证据，或删除文件修改相关声明");
      return {
        verdict: "fail",
        reason_code: "missing_file_evidence",
        unsupported_claims: unsupported,
        required_changes: required,
        claims,
      };
    }
  }

  // 表格/数字统计：未明确声称查库时，接受 command.run / file.read / data.query 等合理证据
  if (claims.claimsNumericStats) {
    if (!hasStatsSupportingEvidence(evidence)) {
      unsupported.push(
        "报告含统计数据或表格，但动作日志中无支撑证据（无 data.query、command.run 或 file.read）",
      );
      required.push(
        "补充巡检/统计的执行证据（command.run、file.read，或带 row_count 的 data.query）；Markdown 表格本身不构成证据",
      );
      return {
        verdict: "fail",
        reason_code: "missing_stats_evidence",
        unsupported_claims: unsupported,
        required_changes: required,
        claims,
      };
    }
  }

  return {
    verdict: "pass",
    reason_code: "evidence_verified",
    unsupported_claims: [],
    required_changes: [],
    claims,
  };
}
