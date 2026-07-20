import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateUnstickOutcome,
  unstickToastKey,
  type UnstickStepResult,
} from "../task-unstick.ts";

test("unstick: ok when cancel succeeds even if rewake fails", () => {
  const steps: UnstickStepResult[] = [
    { name: "cancel", ok: true },
    { name: "release", ok: false, status: 404 },
    { name: "switch", ok: true },
    { name: "rewake", ok: false, message: "cooldown" },
  ];
  const out = evaluateUnstickOutcome(steps);
  assert.equal(out.ok, true);
  assert.equal(out.partial, true);
  assert.equal(out.criticalFailed, false);
  assert.equal(unstickToastKey(out), "partial");
});

test("unstick: fail only when cancel and rewake both fail", () => {
  const steps: UnstickStepResult[] = [
    { name: "cancel", ok: false },
    { name: "release", ok: true },
    { name: "switch", ok: false },
    { name: "rewake", ok: false },
  ];
  const out = evaluateUnstickOutcome(steps);
  assert.equal(out.ok, false);
  assert.equal(out.criticalFailed, true);
  assert.equal(unstickToastKey(out), "fail");
});

test("unstick: full success when all steps ok", () => {
  const steps: UnstickStepResult[] = [
    { name: "cancel", ok: true },
    { name: "release", ok: true },
    { name: "switch", ok: true },
    { name: "rewake", ok: true },
  ];
  const out = evaluateUnstickOutcome(steps);
  assert.equal(out.ok, true);
  assert.equal(out.partial, false);
  assert.equal(unstickToastKey(out), "ok");
});
