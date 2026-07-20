/**
 * PM dev cold-dispatch policy: read-only workspace + patch-in-DEV-task, no write_file.
 */

import {
  EXECUTOR_TOOLS,
  LEADER_RUNTIME_HOT_PATH_TOOLS,
} from "../skill/FcopToolProfile.ts";

export const PM_DEV_COLD_DISPATCH_WORKSPACE_READ = [
  "read_file",
  "grep_files",
  "list_dir",
] as const;

/** FCOP tools for PM runtime dispatch when not on Hot Path / pm_self_report_only. */
export const PM_DEV_COLD_DISPATCH_FCOP_TOOLS = [
  ...EXECUTOR_TOOLS,
  ...LEADER_RUNTIME_HOT_PATH_TOOLS,
  "fcop_check",
  "pm.summarize_thread",
  "pm.detect_thread_stall",
  "pm.close_admin_task",
  "pm.wake_downstream",
  "pm.review_check",
] as const;

/** Defense-in-depth: PM must not mutate project files on dev cold dispatch. */
export const PM_DEV_COLD_DISPATCH_BLOCKED = new Set<string>(["write_file"]);

export function filterPmDevColdDispatchTools(allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return PM_DEV_COLD_DISPATCH_FCOP_TOOLS.filter((n) => allowedSet.has(n));
}

export function extendAdminRejectColdPathWithWorkspaceRead(
  tools: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  const out = [...tools];
  for (const name of PM_DEV_COLD_DISPATCH_WORKSPACE_READ) {
    if (allowedSet.has(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}
