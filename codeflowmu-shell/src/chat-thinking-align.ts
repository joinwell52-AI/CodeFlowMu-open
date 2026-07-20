/**
 * Extract sdk.thinking text from runtime event payload (same shapes as sdk.assistant).
 */
export function extractSdkThinkingText(
  payload: Record<string, unknown> | undefined,
): string {
  if (!payload) return "";
  const raw = payload["raw"] as Record<string, unknown> | undefined;
  const contentArr = (raw?.["message"] as { content?: Array<{ text?: string }> } | undefined)
    ?.content;
  if (Array.isArray(contentArr) && contentArr.length > 0) {
    return contentArr.map((c) => c.text ?? "").join("");
  }
  return String(
    raw?.["text"] ?? raw?.["content"] ?? payload["text"] ?? payload["content"] ?? "",
  );
}
