import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PM_REWORK_RUNTIME_BODY_CHECKLIST_ZH = [
  "## Agent 运行时验收",
  "- 验证任务、工具调用、结果回灌、REPORT 与 ledger references/parent 一致。",
  "- 必须执行真实工具链；不得只检查若干文件或用口头说明代替运行证据。",
].join("\n");

export const PM_ADMIN_REJECT_TODO_HEADING = "## ADMIN 判定打回（待 PM 协调）";

const TASK_ID_PREFIX_RE = /TASK-\d{8}-\d{3,}/gi;

const LIFECYCLE_STAGES = ["inbox", "active", "review", "done", "archive"] as const;

export type AdminRejectExecutionMode = "hot" | "cold";

/** 从文本中提取 TASK-YYYYMMDD-NNN 前缀（去重、大写）。 */
export function extractTaskIdPrefixesFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(TASK_ID_PREFIX_RE)) {
    const id = m[0]!.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const PM_NO_DISPATCH_FORBIDDEN_RE =
  /不(?:调用|派)\s*write_task|禁止[^。\n]*write_task|不派\s*(?:DEV|OPS|QA|下游)|不派发下游|do not dispatch|do not write_task|not rework dispatch/i;

/** TASK 正文是否禁止 PM 向下游派发（含否定句，如「不调用 write_task」）。 */
export function isPmDispatchForbiddenBody(taskBody: string): boolean {
  return PM_NO_DISPATCH_FORBIDDEN_RE.test(taskBody.trim());
}

/** PM 自包含 / 最小闭环：Hot Path 或正文禁止派发 → runtime pm_self_report_only。 */
export function isPmSelfReportOnlyContext(
  role: string,
  taskBody: string,
): boolean {
  if (role.toUpperCase() !== "PM") return false;
  const body = taskBody.trim();
  if (!body) return false;
  return isTaskHotPathBody(body) || isPmDispatchForbiddenBody(body);
}

/** TASK 正文是否声明 Hot Path（PM 亲自执行、禁止派发子 task）。含 Google PM 最小闭环冒烟等自包含任务。 */
export function isTaskHotPathBody(taskBody: string): boolean {
  const text = taskBody.trim();
  if (!text) return false;

  if (
    /NOT ADMIN reject Cold Path|NOT rework dispatch|This is NOT ADMIN reject/i.test(
      text,
    )
  ) {
    return true;
  }

  const forbidsDispatch = isPmDispatchForbiddenBody(text);
  if (forbidsDispatch) {
    if (
      /Google PM 最小闭环|最小闭环冒烟|self-contained final report smoke/i.test(
        text,
      )
    ) {
      return true;
    }
    if (
      /不(?:调用|派).*write_task/i.test(text) &&
      /不派\s*(?:DEV|OPS|QA)/i.test(text)
    ) {
      return true;
    }
    if (/PM 不派发下游|仅.*write_report|只.*最终回执|PM 亲自/i.test(text)) {
      return true;
    }
  }

  const mentionsHot =
    /hot\s*path|热路径|hot-path/i.test(text) ||
    (/pm\s*主控|亲自执行|pm\s*亲自/i.test(text) &&
      /禁止.*派发|不得.*派发|不.*向下游|cold\s*path\s*不适用|cold\s*path.*禁止/i.test(
        text,
      ));
  if (!mentionsHot) return false;
  if (/cold\s*path|冷路径/i.test(text) && !/hot\s*path|热路径/i.test(text)) {
    return false;
  }
  return true;
}

function findTaskFilePathSync(projectRoot: string, taskIdPrefix: string): string | null {
  const stem = taskIdPrefix.replace(/\.md$/i, "").trim().toUpperCase();
  if (!stem) return null;
  for (const stage of LIFECYCLE_STAGES) {
    const dir = join(projectRoot, "fcop", "_lifecycle", stage);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const upper = name.toUpperCase();
        if (upper === `${stem}.MD` || upper.startsWith(`${stem}-`) || upper.startsWith(stem)) {
          return join(dir, name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 按 task id 前缀读取 TASK 正文（frontmatter 之后）。 */
export function readTaskBodyByIdPrefix(projectRoot: string, taskIdPrefix: string): string | null {
  const filePath = findTaskFilePathSync(projectRoot, taskIdPrefix);
  if (!filePath) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (raw.startsWith("---")) {
      const end = raw.indexOf("---", 3);
      if (end > 0) return raw.slice(end + 3).trim();
    }
    return raw.trim();
  } catch {
    return null;
  }
}

function primaryTaskIdFromSection(section: string): string | null {
  const ids = extractTaskIdPrefixesFromText(section);
  return ids[0] ?? null;
}

/**
 * 解析 ADMIN 打回后的执行模式：Hot Path（PM 亲自）或 Cold Path（派下游）。
 * 无打回区块时返回 null。
 */
export function resolveAdminRejectExecutionMode(opts: {
  projectRoot: string;
  adminRejectSection?: string | null;
  taskBody?: string | null;
  taskId?: string | null;
}): AdminRejectExecutionMode | null {
  const { projectRoot, adminRejectSection, taskBody, taskId } = opts;

  if (taskBody?.trim()) {
    if (isTaskHotPathBody(taskBody)) return "hot";
    if (adminRejectSection?.trim()) return "cold";
  }

  const section =
    adminRejectSection?.trim() || extractPmAdminRejectTodoSection(projectRoot);
  if (!section) return null;

  const id =
    taskId?.trim().toUpperCase() || primaryTaskIdFromSection(section);
  if (id) {
    const bodyFromDisk = readTaskBodyByIdPrefix(projectRoot, id);
    if (bodyFromDisk && isTaskHotPathBody(bodyFromDisk)) return "hot";
  }

  return "cold";
}

/**
 * 当 PM 在 Panel「聊天」通道提到打回任务时，升级为 Cold Path（非闲聊）。
 * 需已有 ledger「ADMIN 判定打回」区块；Hot Path 任务返回 false。
 */
export function shouldEscalatePmChatToAdminRejectColdPath(opts: {
  message: string;
  adminRejectSection: string;
  boundTaskId?: string;
  projectRoot?: string;
}): boolean {
  const { message, adminRejectSection, boundTaskId, projectRoot } = opts;
  const sectionUpper = adminRejectSection.toUpperCase();

  if (projectRoot) {
    const mode = resolveAdminRejectExecutionMode({
      projectRoot,
      adminRejectSection,
    });
    if (mode === "hot") return false;
  }

  if (boundTaskId?.trim()) {
    const bound = boundTaskId.replace(/\.md$/i, "").toUpperCase();
    if (bound.startsWith("TASK-") && sectionUpper.includes(bound)) return true;
  }

  for (const id of extractTaskIdPrefixesFromText(message)) {
    if (sectionUpper.includes(id)) return true;
  }

  if (
    /打回|重做|返工|协调返工|派.*下游|read_task|write_task|read_file|预载|007|死循环|循环|卡住|stuck|loop|又不/i.test(
      message,
    )
  ) {
    return true;
  }

  return false;
}

/** PM 聊天/巡检：是否升级为 ADMIN 打回 Hot Path（PM 亲自返工）。 */
export function shouldEscalatePmChatToAdminRejectHotPath(opts: {
  message: string;
  adminRejectSection: string;
  projectRoot?: string;
}): boolean {
  if (!opts.projectRoot) return false;
  const mode = resolveAdminRejectExecutionMode({
    projectRoot: opts.projectRoot,
    adminRejectSection: opts.adminRejectSection,
  });
  if (mode !== "hot") return false;

  const { message, adminRejectSection } = opts;
  const sectionUpper = adminRejectSection.toUpperCase();

  for (const id of extractTaskIdPrefixesFromText(message)) {
    if (sectionUpper.includes(id)) return true;
  }

  if (
    /打回|重做|返工|重新做|重新启动|协调返工|fcop_check|write_report|read_file|预载|冒烟|smoke|gemini|google/i.test(
      message,
    )
  ) {
    return true;
  }

  return false;
}

/** 从 PM.todo.md 提取「ADMIN 判定打回」区块正文（不含 ## 标题行）。 */
export function extractPmAdminRejectTodoSection(projectRoot: string): string | null {
  const todoPath = join(projectRoot, "fcop", "ledger", "views", "PM.todo.md");
  try {
    const raw = readFileSync(todoPath, "utf-8");
    const idx = raw.indexOf(PM_ADMIN_REJECT_TODO_HEADING);
    if (idx < 0) return null;
    const afterHeading = raw.slice(idx + PM_ADMIN_REJECT_TODO_HEADING.length);
    const nextHeading = afterHeading.search(/\n## [^\n]/);
    const body =
      nextHeading >= 0 ? afterHeading.slice(0, nextHeading).trim() : afterHeading.trim();
    if (!body || !/TASK-\d/.test(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function buildPmAdminRejectHotPathReworkPromptBlock(
  section: string,
  opts?: { taskBodyPreloaded?: boolean },
): string {
  const preloaded = opts?.taskBodyPreloaded === true;
  const step1 = preloaded
    ? "1. **跳过 read**：TASK 正文已在会话中预载 — **禁止** 再 read_task / read_file 同一 task_id"
    : "1. `read_file` 上列每个 TASK 的完整路径（ledger 行内 `file=` 或 `fcop/_lifecycle/review|active`）";

  return [
    "## 最高优先级 · ADMIN 判定打回（Hot Path · PM 亲自完成治理核查/协调，不代表可修改产品代码）",
    "",
    PM_ADMIN_REJECT_TODO_HEADING,
    "",
    section,
    "",
    "**必做（Hot Path — PM 治理核查，非产品代码落地）**：",
    step1,
    "2. MCP `fcop_report({ lang: \"zh\" })` — 项目/会话快照",
    "3. MCP `fcop_check` — 协议 drift 轻量审计",
    "4. 证据探针：只读 `read_file` / `grep_files` / 只读 shell（如 `Get-Content`、`git diff --stat`）",
    "5. MCP `write_report(status=done)` — **一次**最终回执（含证据路径），然后 submit_review / 等 ADMIN 再验收",
    "",
    "**PM Hot Path 允许**：`fcop_report`、`fcop_check`、read/grep 证据探针、`write_report`。",
    "**PM Hot Path 禁止**：edit 产品代码、shell 写入、创建补丁脚本、直接运行实现性修改。",
    "**若发现需要代码/UI/API/测试实现**：必须 MCP `write_task` 派发给责任角色（代码→DEV、运行态→OPS、验收→QA、审计→EVAL；按性质分派，不固定 DEV）。",
    "**禁止**：以「Hot Path / 亲自返工 / 当前只有我一个 agent」为借口直接 edit 或 shell 写产品文件。",
    "**无法唤醒目标角色时**：仍应 `write_task` 到对应角色 inbox，并向 ADMIN 报告等待执行。",
    "**禁止**：仅 `write_report` 向 ADMIN ack「收到打回」而不完成 fcop_check / 探针 / 最终 report",
    "**禁止**：重复 patrol 读 task/todo 导致工具循环熔断",
    "**禁止**：自行 `archive_task`",
    "",
    "完成上述步骤后停止，等待 ADMIN 验收。",
  ].join("\n");
}

function buildPmAdminRejectColdPathReworkPromptBlock(
  section: string,
  opts?: { taskBodyPreloaded?: boolean },
): string {
  const preloaded = opts?.taskBodyPreloaded === true;
  const step1 = preloaded
    ? "1. **跳过 read**：TASK 正文已在会话中预载 — **禁止** 再 read_task / read_file 同一 task_id"
    : "1. `read_file` 上列每个 TASK 的完整路径（ledger 行内 `file=` 或 `fcop/_lifecycle/review|active`）";
  return [
    "## 最高优先级 · ADMIN 判定打回（Cold Path · PM 派发责任角色，不是 PM 自己落地）",
    "",
    PM_ADMIN_REJECT_TODO_HEADING,
    "",
    section,
    "",
    "**Cold Path = PM 派发责任角色，不是 PM 自己 edit/shell 写产品代码。**",
    "",
    "**必做（打回条目未派下游前）**：",
    step1,
    preloaded
      ? "2. **第一动作**：按 TASK 正文 + ADMIN 打回原因选择必要责任角色并 MCP `write_task`；代码/UI/实现才派 DEV，独立验收/测试才派 QA，运行/发布/环境才派 OPS。**不要固定 DEV/QA/OPS 全派**。存在 DEV→QA 顺序时必须先创建 DEV、取得新 DEV task_id，再创建 QA，并在 QA 的 `references` 同时写父 id 与该新 DEV task_id（等价显式依赖；支持 `depends_on` 时也写同一 DEV id）。`parent` = 当前 ADMIN→PM 主线 task_id；`thread_key` 继承父任务；**body 仅 Markdown 正文，禁止 YAML/frontmatter**。"
      : "2. 按 TASK 正文 + ADMIN 打回原因选择必要责任角色并 MCP `write_task`；代码/UI/实现才派 DEV，独立验收/测试才派 QA，运行/发布/环境才派 OPS。**不要固定 DEV/QA/OPS 全派**。存在 DEV→QA 顺序时必须先创建 DEV、取得新 DEV task_id，再创建 QA，并在 QA 的 `references` 同时写父 id 与该新 DEV task_id（等价显式依赖；支持 `depends_on` 时也写同一 DEV id）。`parent` = 当前 ADMIN→PM 主线 task_id；`thread_key` 继承父任务；**body 仅 Markdown 正文，禁止 YAML/frontmatter**。",
    "",
    "**返工子任务 body 必须含（Google 工具运行时 / Adapter 验收）**：",
    "- **`parent` + `references` MCP 参数必填**（§8：`parent` 写强关系；`references` 可含同一父 id；`thread_key` 继承父任务；body 仅 Markdown，禁止 YAML/frontmatter）",
    "- **DEV→QA 顺序依赖必填**：QA 的 `references` 必须包含本轮新建 DEV task_id（不能只写父任务；不能引用同线程旧 DEV）；工具支持 `depends_on` 时同步写 `depends_on=[\"<本轮 DEV task_id>\"]`。",
    "- **回执强约束**：子任务正文必须写明：完成时 `write_report(task_id=\"<本子任务 task_id>\", recipient=\"PM\", status=\"done|blocked|failed\", references=[\"<本子任务 task_id>\", \"<父任务 task_id>\"])`；不得只引用父任务或漏写 task_id。",
    "- **禁止** 未尝试 MCP `write_task` / `write_report` / `read_file` 就 `write_report(status=blocked)`",
    "- blocked 须附：已调 tool 名、错误原文、缺失能力（禁止空泛「工具箱不可用」）",
    "",
    PM_REWORK_RUNTIME_BODY_CHECKLIST_ZH,
    "3. **禁止** 仅 `write_report` 向 ADMIN ack 打回而不派下游",
    "4. **禁止** 在聊天里口头说「我将 read_task」却不调 MCP 工具 — 要么 write_task，要么用 read_file 读磁盘路径",
    "",
    "完成下游派单后，再汇报巡检其余项；回复一次即可，勿重复空泛 acknowledgement。",
  ].join("\n");
}

/**
 * 当 ledger 存在 ADMIN 打回待办时，生成注入 PM wake/patrol 的 Hot/Cold Path 指令块。
 */
export function buildPmAdminRejectReworkPromptBlock(
  projectRoot: string,
  opts?: { taskBodyPreloaded?: boolean; taskBody?: string | null; taskId?: string | null },
): string | null {
  const section = extractPmAdminRejectTodoSection(projectRoot);
  if (!section) return null;

  const mode = resolveAdminRejectExecutionMode({
    projectRoot,
    adminRejectSection: section,
    taskBody: opts?.taskBody,
    taskId: opts?.taskId,
  });

  if (mode === "hot") {
    return buildPmAdminRejectHotPathReworkPromptBlock(section, opts);
  }
  return buildPmAdminRejectColdPathReworkPromptBlock(section, opts);
}
