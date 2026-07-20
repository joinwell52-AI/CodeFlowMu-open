/**
 * Task unstick orchestration outcome (Panel「一键解除卡死」).
 */

export type UnstickStepName = "cancel" | "release" | "switch" | "rewake";

export type UnstickStepResult = {
  name: UnstickStepName;
  ok: boolean;
  status?: number;
  message?: string;
};

export type UnstickOutcome = {
  ok: boolean;
  partial: boolean;
  criticalFailed: boolean;
  steps: UnstickStepResult[];
};

/** At least one of cancel / rewake must succeed unless both fail. */
export function evaluateUnstickOutcome(steps: UnstickStepResult[]): UnstickOutcome {
  const cancel = steps.find((s) => s.name === "cancel");
  const rewake = steps.find((s) => s.name === "rewake");
  const cancelOk = Boolean(cancel?.ok);
  const rewakeOk = Boolean(rewake?.ok);
  const criticalFailed = !cancelOk && !rewakeOk;
  const ok = !criticalFailed;
  const partial = ok && steps.some((s) => !s.ok);
  return { ok, partial, criticalFailed, steps };
}

export function unstickToastKey(outcome: UnstickOutcome): "ok" | "partial" | "fail" {
  if (outcome.criticalFailed) return "fail";
  if (outcome.partial) return "partial";
  return "ok";
}
