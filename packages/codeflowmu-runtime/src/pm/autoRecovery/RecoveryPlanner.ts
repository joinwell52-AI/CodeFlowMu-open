/**
 * Map deadlock detections to safe recovery plans.
 */

import {
  getKindAttemptCount,
  isDedupBlocked,
  isRecoveryLimitReached,
} from "./autoRecoveryState.ts";
import {
  AUTO_RECOVERY_MIN_RETRY_MS,
  FIRST_TURN_ABORT_RETRY_1_MS,
  FIRST_TURN_ABORT_RETRY_2_MS,
  SESSION_UNSETTLED_RECOVER_MS,
  type DeadlockDetection,
  type RecoveryPlan,
  type RecoveryPlanAction,
} from "./deadlockTypes.ts";

export interface PlanRecoveryOpts {
  projectRoot: string;
  detection: DeadlockDetection;
  /** Block auto-cancel when session is actively running with output. */
  blockCancelForActiveOutput?: boolean;
}

function basePlan(
  detection: DeadlockDetection,
  action: RecoveryPlanAction,
  delayMs: number,
  reasonCode: string,
  countsTowardLimit: boolean,
  extra?: Partial<RecoveryPlan>,
): RecoveryPlan {
  return {
    detection,
    action,
    delayMs: Math.max(0, Math.floor(delayMs)),
    reasonCode,
    countsTowardLimit,
    ...extra,
  };
}

export function planRecovery(opts: PlanRecoveryOpts): RecoveryPlan | null {
  const { detection, projectRoot } = opts;
  const { taskId, agentId, kind } = detection;

  if (
    isDedupBlocked(projectRoot, taskId, agentId, `${kind}:${detection.reason}`)
  ) {
    return null;
  }

  switch (kind) {
    case "stale_failed_receipt":
      return basePlan(
        detection,
        "clear_guard",
        0,
        "auto_clear_stale_failed_receipt",
        false,
        { adminHint: "下游 REPORT 已落盘，自动清除 failed guard" },
      );

    case "retry_loop_risk": {
      const raw = Number(detection.meta?.retryDelayMs ?? 0);
      const delayMs = Math.max(AUTO_RECOVERY_MIN_RETRY_MS, raw);
      return basePlan(
        detection,
        "force_safe_delay",
        delayMs,
        "auto_retry_loop_safe_delay",
        false,
        { adminHint: `强制安全延迟 ${delayMs}ms 后重试` },
      );
    }

    case "sdk_cooldown": {
      const remaining = Math.max(
        AUTO_RECOVERY_MIN_RETRY_MS,
        Number(detection.meta?.remainingMs ?? AUTO_RECOVERY_MIN_RETRY_MS),
      );
      return basePlan(
        detection,
        "delayed_retry",
        remaining,
        "auto_sdk_cooldown_delayed",
        false,
        { adminHint: `SDK cooldown，${remaining}ms 后自动 wake` },
      );
    }

    case "stale_busy_no_session": {
      if (isRecoveryLimitReached(projectRoot, taskId, agentId)) {
        return basePlan(
          detection,
          "escalate_admin",
          0,
          "auto_stale_busy_limit",
          false,
          {
            escalate: true,
            adminHint:
              "stale_busy 自动恢复已达上限；可选：暂停当前任务 / 释放 agent / 恢复排队任务 / 强制归档",
          },
        );
      }
      return basePlan(
        detection,
        "release_and_recover",
        0,
        "auto_stale_busy_release_recover",
        true,
        { adminHint: "registry busy 无 session，自动 release + recover" },
      );
    }

    case "first_turn_abort": {
      const attempt = getKindAttemptCount(projectRoot, taskId, agentId, kind);
      if (attempt >= 2) {
        return basePlan(
          detection,
          "escalate_admin",
          0,
          "auto_first_turn_abort_limit",
          false,
          {
            escalate: true,
            adminHint: "first_turn_abort 第 3 次，升级 waiting_pm_attention",
          },
        );
      }
      if (attempt === 1) {
        return basePlan(
          detection,
          "recycle_and_delayed_retry",
          FIRST_TURN_ABORT_RETRY_2_MS,
          "auto_first_turn_abort_recycle",
          true,
          { adminHint: "first_turn_abort 第 2 次：recycle + 180s delayed retry" },
        );
      }
      return basePlan(
        detection,
        "delayed_retry",
        FIRST_TURN_ABORT_RETRY_1_MS,
        "auto_first_turn_abort_retry",
        true,
        { adminHint: "first_turn_abort 第 1 次：60s delayed retry" },
      );
    }

    case "session_unsettled": {
      const elapsed = Number(detection.meta?.elapsedMs ?? 0);
      if (opts.blockCancelForActiveOutput) {
        return basePlan(detection, "wait", 0, "auto_session_unsettled_wait", false, {
          adminHint: "session 仍在输出，暂不自动 cancel",
        });
      }
      if (elapsed < SESSION_UNSETTLED_RECOVER_MS) {
        return basePlan(
          detection,
          "wait",
          0,
          "auto_session_unsettled_suspected",
          false,
          { adminHint: "session 未 settle，继续观察" },
        );
      }
      if (isRecoveryLimitReached(projectRoot, taskId, agentId)) {
        return basePlan(
          detection,
          "escalate_admin",
          0,
          "auto_session_unsettled_limit",
          false,
          {
            escalate: true,
            adminHint: "session_unsettled 自动恢复已达上限",
          },
        );
      }
      return basePlan(
        detection,
        "cancel_release_recover",
        0,
        "auto_session_unsettled_recover",
        true,
        { adminHint: "session 超时未 settle，自动 cancel + recover" },
      );
    }

    default:
      return null;
  }
}
