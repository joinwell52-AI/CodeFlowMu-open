import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  currentPlanningGrant,
  issuePlanningGrant,
  planningGrantAllows,
} from "../PlanningGrantStore.ts";

test("planning grant is immutable, scoped, restart-safe, and stale on brief change", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-planning-grant-"));
  try {
    const input = {
      projectRoot: root,
      rootTaskId: "TASK-20260805-001",
      briefRevision: 3,
      briefDigest: "sha256:brief",
      validationDigest: "sha256:validation",
      approvedWpScope: ["WP-00", "WP-01"],
      childContractDigest: "sha256:child-contract",
      decisionId: "PLANNING-DECISION-1",
      approvedAt: "2026-08-05T00:00:00.000Z",
    };
    const first = await issuePlanningGrant(input);
    const replay = await issuePlanningGrant(input);
    assert.equal(first.grant_id, replay.grant_id);
    const restored = await currentPlanningGrant(root, input.rootTaskId);
    assert.ok(restored);
    assert.equal(planningGrantAllows(restored, "WP-01"), true);
    assert.equal(planningGrantAllows(restored, "WP-02"), false);
    const stale = await currentPlanningGrant(root, input.rootTaskId, { briefRevision: 4 });
    assert.equal(stale?.status, "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
