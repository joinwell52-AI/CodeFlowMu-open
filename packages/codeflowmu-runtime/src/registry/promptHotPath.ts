import { isTaskHotPathBody } from "../pm/pmAdminRejectPrompt.ts";
import { isLeaderRoleAgentId } from "../skill/FcopToolProfile.ts";

const ADMIN_REJECT_HOT_PATH_RE =
  /admin.*打回.*hot\s*path|admin\s*判定打回.*hot\s*path|admin\s*→\s*pm.*打回.*hot\s*path|hot path 由 pm 亲自完成治理核查|不代表可修改产品代码|admin reject hot path/i;

export function isAdminRejectHotPathPrompt(prompt: string, agentId?: string): boolean {
  if (!prompt.trim()) return false;
  const id = agentId ?? "";
  if (id && !isLeaderRoleAgentId(id)) return false;
  return ADMIN_REJECT_HOT_PATH_RE.test(`${id}\n${prompt}`);
}

export function isPmSelfExecuteHotPathPrompt(prompt: string, agentId?: string): boolean {
  if (!prompt.trim()) return false;
  const id = agentId ?? "";
  if (id && !isLeaderRoleAgentId(id)) return false;
  if (isAdminRejectHotPathPrompt(prompt, agentId)) return false;
  return isTaskHotPathBody(prompt);
}
