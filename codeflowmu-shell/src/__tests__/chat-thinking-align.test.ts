import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSdkThinkingText } from "../chat-thinking-align.ts";

describe("extractSdkThinkingText", () => {
  it("reads message.content array like sdk.assistant", () => {
    const text = extractSdkThinkingText({
      raw: {
        message: {
          content: [{ text: "You are Composer" }, { text: ", a language model." }],
        },
      },
    });
    assert.equal(text, "You are Composer, a language model.");
  });

  it("falls back to raw.text", () => {
    assert.equal(
      extractSdkThinkingText({ raw: { text: "hello" } }),
      "hello",
    );
  });
});
