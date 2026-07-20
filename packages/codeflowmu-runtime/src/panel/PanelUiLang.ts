/**
 * Panel UI language — drives agent thinking-stream and reply language.
 * Synced from desktop panel `localStorage['cf-lang']` via web-panel API.
 *
 * Runtime-facing language must follow the panel UI language. Identifiers,
 * file paths, commands, and code remain verbatim.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UiLang = "zh" | "en";

const DEFAULT_UI_LANG: UiLang = "zh";

/** Normalize arbitrary input to supported UI language. */
export function normalizeUiLang(value: unknown): UiLang {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "en" || raw.startsWith("en-") || raw === "english") return "en";
  return "zh";
}

/** Path: `<projectRoot>/.codeflowmu/panel-ui-lang.json` */
export function panelUiLangFilePath(projectRoot: string): string {
  return join(projectRoot, ".codeflowmu", "panel-ui-lang.json");
}

/** Read persisted panel UI language (defaults to zh). */
export function readPanelUiLang(projectRoot: string): UiLang {
  try {
    const fp = panelUiLangFilePath(projectRoot);
    if (!existsSync(fp)) return DEFAULT_UI_LANG;
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as { ui_lang?: unknown };
    return normalizeUiLang(parsed.ui_lang);
  } catch {
    return DEFAULT_UI_LANG;
  }
}

/** Persist panel UI language for TaskDispatcher / non-panel session starts. */
export function writePanelUiLang(projectRoot: string, lang: UiLang): void {
  const fp = panelUiLangFilePath(projectRoot);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(
    fp,
    JSON.stringify({ ui_lang: lang, updated_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

const ZH_UI_LANG_MARKER = "[界面语言 · 中文 · 思考流与回复统一]";
const LEGACY_ZH_UI_LANG_MARKER = "[界面语言 · 中文 · 实时思考流 LIVE]";
const LEGACY_ZH_SPLIT_MARKER = "[界面语言 · 中文 · 思考流与回复分离]";

/**
 * Prompt block injected at session start:
 * - UI=zh: Simplified Chinese thinking stream + Simplified Chinese replies
 * - UI=en: English thinking + English replies
 */
export function buildThinkingLanguageBlock(lang: UiLang): string {
  if (lang === "en") {
    return `[UI Language: English · thinking vs reply]
- Your **internal reasoning** (sdk.thinking / LIVE console) MUST stay in **English** (Cursor native).
- Final replies to ADMIN/PM MUST be in **English** and must **match** what you concluded in thinking — do not invent a different narrative in the reply.
- Keep tool names, file paths, API identifiers, and code snippets verbatim — do not translate those.`;
  }
  return `${ZH_UI_LANG_MARKER}
- **sdk.thinking（LIVE 实时思考流）**、工具调用前的计划说明、巡检过程说明、阶段性判断，都必须使用**简体中文**。
- 给 ADMIN/PM 的**正式聊天回复**也必须使用**简体中文**，并与实时思考流里的结论一致。
- 如果底层 SDK 或既有上下文里出现英文身份句、英文计划或英文结论，暴露到 LIVE 思考流/聊天回复前必须转述为简体中文。
- **身份/模型问答**：若底层信息是 "You are Composer, a language model developed by Cursor"，回复和思考流都应表达为「Composer，一个由 Cursor 开发的语言模型。」等等价中文；**禁止**用 wire、default、registry、modelUsage、设置页替代真实运行身份作答。
- 工具名、文件路径、API 标识符、代码片段保持原样，不必翻译。`;
}

/** Prepend thinking-language block once (skip if already present). */
export function applyThinkingLanguageToPrompt(text: string, lang: UiLang): string {
  const block = buildThinkingLanguageBlock(lang);
  if (
    text.includes(block) ||
    text.includes(ZH_UI_LANG_MARKER) ||
    text.includes(LEGACY_ZH_UI_LANG_MARKER) ||
    text.includes(LEGACY_ZH_SPLIT_MARKER) ||
    text.includes("[UI Language: English · thinking vs reply]")
  ) {
    return text;
  }
  return `${block}\n\n${text}`;
}

/** 用户是否在问模型/身份（用于服务端对齐兜底）。 */
export function isIdentityOrModelQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /你是什么模型|你是谁|什么模型|哪个模型|真实.*模型|对接.*模型|你是.*谁/i.test(t) ||
    /what model are you|who are you|which model|your identity/i.test(t)
  );
}

/** 从 thinking 英文自述提取身份句并译为简体中文（仅常见 Cursor 模式）。 */
export function translateIdentityFromThinking(thinking: string): string | null {
  const src = thinking.trim();
  if (!src) return null;

  const patterns: Array<{ re: RegExp; zh: (m: RegExpMatchArray) => string }> = [
    {
      re: /You are Composer,?\s*a language model developed by Cursor/i,
      zh: () => "Composer，一个由 Cursor 开发的语言模型。",
    },
    {
      re: /I'm Composer,?\s*a language model developed by Cursor/i,
      zh: () => "Composer，一个由 Cursor 开发的语言模型。",
    },
    {
      re: /You are ([A-Za-z0-9_.-]+),?\s*a language model developed by ([A-Za-z0-9 ]+)/i,
      zh: (m) => `${m[1]}，一个由 ${m[2]!.trim()} 开发的语言模型。`,
    },
    {
      re: /You are ([A-Za-z0-9_.-]+),?\s*a language model/i,
      zh: (m) => `${m[1]}，一个语言模型。`,
    },
  ];

  for (const { re, zh } of patterns) {
    const m = src.match(re);
    if (m) return zh(m);
  }
  return null;
}

/** 回复是否像在编造配置/wire 而非翻译 thinking（身份问答兜底用）。 */
export function replyLooksLikeConfigNarrative(reply: string): boolean {
  const r = reply.trim();
  if (!r) return false;
  return (
    /\b(default|modelUsage|registry|send wire|team\.json|wireModel|resolvedWire)\b/i.test(
      r,
    ) ||
    /默认模型|对接参数|账单|配置项|registry|modelUsage/i.test(r)
  );
}

/**
 * 界面中文 + 身份问答：若 thinking 能提取身份句且回复像在编配置，用 thinking 译文替换。
 */
export function alignChatReplyWithThinking(opts: {
  uiLang: UiLang;
  userMessage: string;
  thinking: string;
  assistantReply: string;
}): string {
  const reply = opts.assistantReply.trim();
  if (opts.uiLang !== "zh" || !isIdentityOrModelQuestion(opts.userMessage)) {
    return reply || "(无回复)";
  }

  const fromThinking = translateIdentityFromThinking(opts.thinking);
  if (!fromThinking) {
    return reply || "(无回复)";
  }

  if (!reply || replyLooksLikeConfigNarrative(reply)) {
    return fromThinking;
  }

  if (/Composer/i.test(opts.thinking) && !/Composer/i.test(reply)) {
    return fromThinking;
  }

  return reply;
}
