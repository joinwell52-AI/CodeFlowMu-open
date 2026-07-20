import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fcopPathToRel,
  resolveTaskRelPath,
  stageFromRelPath,
  physicalScopeFromTaskInput,
} from "../panel-task-path.ts";

test("fcopPathToRel extracts fcop/ segment from absolute path", () => {
  assert.equal(
    fcopPathToRel("D:/proj/fcop/_lifecycle/review/TASK-20260604-004-PM-to-DEV.md"),
    "fcop/_lifecycle/review/TASK-20260604-004-PM-to-DEV.md",
  );
});

test("resolveTaskRelPath prefers physical_scope over stale inbox ledger path", () => {
  const rel = resolveTaskRelPath({
    filename: "TASK-20260604-004-PM-to-DEV.md",
    path: "fcop/_lifecycle/inbox/TASK-20260604-004-PM-to-DEV.md",
    physical_scope: "review",
  });
  assert.equal(rel, "fcop/_lifecycle/review/TASK-20260604-004-PM-to-DEV.md");
  assert.equal(stageFromRelPath(rel), "review");
});

test("resolveTaskRelPath uses absolute_path when aligned", () => {
  const rel = resolveTaskRelPath({
    filename: "TASK-20260604-004-PM-to-DEV.md",
    absolute_path: "D:/x/fcop/_lifecycle/review/TASK-20260604-004-PM-to-DEV.md",
    path: "fcop/_lifecycle/inbox/TASK-20260604-004-PM-to-DEV.md",
    physical_scope: "review",
  });
  assert.equal(rel, "fcop/_lifecycle/review/TASK-20260604-004-PM-to-DEV.md");
});

test("resolveTaskRelPath does not default to inbox without scope", () => {
  const rel = resolveTaskRelPath({
    filename: "TASK-20260501-001-PM-to-DEV.md",
    bucket: "tasks",
  });
  assert.equal(rel, "fcop/tasks/TASK-20260501-001-PM-to-DEV.md");
  assert.ok(!rel.includes("/inbox/"));
});

test("physicalScopeFromTaskInput reads stage from path", () => {
  assert.equal(
    physicalScopeFromTaskInput({
      path: "fcop/_lifecycle/active/TASK-x.md",
    }),
    "active",
  );
});
