import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignChatReplyWithThinking,
  buildThinkingLanguageBlock,
  isIdentityOrModelQuestion,
  replyLooksLikeConfigNarrative,
  translateIdentityFromThinking,
} from "../PanelUiLang.ts";

describe("PanelUiLang · thinking/reply consistency", () => {
  it("zh block requires Simplified Chinese thinking and replies", () => {
    const block = buildThinkingLanguageBlock("zh");
    assert.match(block, /思考流与回复统一/);
    assert.match(block, /LIVE 实时思考流/);
    assert.match(block, /必须使用\*\*简体中文\*\*/);
    assert.doesNotMatch(block, /通常为英文/);
    assert.doesNotMatch(block, /保持 Cursor\/SDK/);
  });

  it("translateIdentityFromThinking maps Composer Cursor line", () => {
    const zh = translateIdentityFromThinking(
      "You are Composer, a language model developed by Cursor.",
    );
    assert.equal(zh, "Composer，一个由 Cursor 开发的语言模型。");
  });

  it("alignChatReplyWithThinking replaces config narrative on identity question", () => {
    const thinking = "You are Composer, a language model developed by Cursor.";
    const badReply =
      "当前 default 模型来自 registry，send wire 显示 modelUsage 为 gpt-4。";
    const aligned = alignChatReplyWithThinking({
      uiLang: "zh",
      userMessage: "你是什么模型？",
      thinking,
      assistantReply: badReply,
    });
    assert.equal(aligned, "Composer，一个由 Cursor 开发的语言模型。");
  });

  it("alignChatReplyWithThinking keeps good zh reply when not config narrative", () => {
    const thinking = "You are Composer, a language model developed by Cursor.";
    const goodReply = "我是 Composer，由 Cursor 开发的语言模型。";
    const aligned = alignChatReplyWithThinking({
      uiLang: "zh",
      userMessage: "你是谁？",
      thinking,
      assistantReply: goodReply,
    });
    assert.equal(aligned, goodReply);
  });

  it("isIdentityOrModelQuestion detects zh and en", () => {
    assert.equal(isIdentityOrModelQuestion("你是什么模型"), true);
    assert.equal(isIdentityOrModelQuestion("What model are you?"), true);
    assert.equal(isIdentityOrModelQuestion("今天天气怎么样"), false);
  });

  it("replyLooksLikeConfigNarrative flags wire/registry wording", () => {
    assert.equal(replyLooksLikeConfigNarrative("default 来自 team.json"), true);
    assert.equal(replyLooksLikeConfigNarrative("Composer，Cursor 的语言模型。"), false);
  });
});
