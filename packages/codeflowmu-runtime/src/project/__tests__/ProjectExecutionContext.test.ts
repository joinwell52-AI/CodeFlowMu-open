import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertProjectExecutionContext,
  createProjectExecutionContext,
} from "../ProjectExecutionContext.ts";

test("one immutable project context binds task, proof, submission, lifecycle and evidence roots", () => {
  const root = resolve("D:/example-active-project");
  const context = createProjectExecutionContext({
    projectRoot: root,
    hostRoot: "D:/codeflowmu",
    runtimeInstanceId: "cfm-stable",
    registryPath: "D:/codeflowmu/.codeflowmu/projects-registry.json",
    dataRoot: join(root, ".codeflowmu"),
    requestId: "request-1",
  });
  assert.equal(context.project_root, root);
  assert.equal(context.host_root, resolve("D:/codeflowmu"));
  assert.equal(context.task_spec_admission_root, join(root, ".codeflowmu", "task-spec-admission"));
  assert.equal(context.task_submission_root, join(root, ".codeflowmu", "task-submissions"));
  assert.equal(context.lifecycle_root, join(root, "fcop", "_lifecycle"));
  assert.equal(context.evidence_root, join(root, "fcop", "logs", "runtime"));
  assert.ok(Object.isFrozen(context));
  assertProjectExecutionContext(context, root);
  assert.throws(
    () => assertProjectExecutionContext(context, "D:/other-clone"),
    /PROJECT_EXECUTION_CONTEXT_MISMATCH/,
  );
});
