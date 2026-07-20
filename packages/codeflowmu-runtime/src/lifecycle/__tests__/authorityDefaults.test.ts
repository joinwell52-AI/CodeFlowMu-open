import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  inferTaskLine,
  resolveArchiveAuthority,
  resolveDoneAuthority,
  resolveDriver,
  resolveReviewer,
  taskRouteRoles,
} from "../authorityDefaults.ts";
import type { TaskFm } from "../types.ts";

describe("authorityDefaults", () => {
  it("从 task_id 解析路由", () => {
    const roles = taskRouteRoles({
      task_id: "TASK-20260530-002-ADMIN-to-PM",
    } as TaskFm);
    assert.equal(roles.from, "ADMIN");
    assert.equal(roles.to, "PM");
  });

  it("主线默认 done/archive 为 ADMIN", () => {
    const task: TaskFm = {
      task_id: "TASK-20260530-002-ADMIN-to-PM",
      sender: "ADMIN",
      recipient: "PM",
    };
    assert.equal(inferTaskLine(task), "main");
    assert.equal(resolveDriver(task), "PM");
    assert.equal(resolveReviewer(task), "ADMIN");
    assert.equal(resolveDoneAuthority(task), "ADMIN");
    assert.equal(resolveArchiveAuthority(task), "ADMIN");
  });

  it("支线默认 done/archive 为 PM", () => {
    const task: TaskFm = {
      task_id: "TASK-20260530-003-PM-to-OPS",
      sender: "PM",
      recipient: "OPS",
    };
    assert.equal(inferTaskLine(task), "branch");
    assert.equal(resolveDriver(task), "OPS");
    assert.equal(resolveReviewer(task), "PM");
    assert.equal(resolveDoneAuthority(task), "PM");
    assert.equal(resolveArchiveAuthority(task), "PM");
  });

  it("to/from 为 lifecycle 桶名时回退 recipient/sender", () => {
    const task: TaskFm = {
      task_id: "TASK-20260608-003-PM-to-OPS",
      sender: "PM",
      recipient: "OPS",
      to: "inbox",
      from: undefined,
    };
    const roles = taskRouteRoles(task);
    assert.equal(roles.from, "PM");
    assert.equal(roles.to, "OPS");
    assert.equal(resolveDriver(task), "OPS");
  });

  it("delegated_done 时 done 为 PM、archive 仍为 ADMIN", () => {
    const task: TaskFm = {
      task_id: "TASK-20260530-001-ADMIN-to-PM",
      sender: "ADMIN",
      recipient: "PM",
      delegated_done: true,
    };
    assert.equal(resolveDoneAuthority(task), "PM");
    assert.equal(resolveArchiveAuthority(task), "ADMIN");
  });
});
