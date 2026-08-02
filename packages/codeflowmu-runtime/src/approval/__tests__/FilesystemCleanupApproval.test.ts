import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FilesystemCleanupPreflightError,
  buildFilesystemCleanupApprovalInput,
  assessFilesystemCleanupRisk,
  executeFilesystemCleanupApproval,
  inspectFilesystemCleanup,
} from "../FilesystemCleanupApproval.ts";
import { OperationApprovalService } from "../OperationApprovalService.ts";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "cfm-cleanup-approval-"));
  execFileSync("git", ["init"], { cwd: value, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "cleanup@test.local"], { cwd: value });
  execFileSync("git", ["config", "user.name", "Cleanup Test"], { cwd: value });
  return value;
}

const subject = {
  actor: "PM-01",
  role: "PM",
  project_id: "project-1",
  agent_id: "PM-01",
  session_id: "session-1",
  task_id: "TASK-1",
};

test("cleanup preflight returns an exact manifest and approved execution quarantines it", async () => {
  const projectRoot = root();
  try {
    const cache = join(projectRoot, "build-cache");
    mkdirSync(join(cache, "nested"), { recursive: true });
    writeFileSync(join(cache, "a.log"), "1234");
    writeFileSync(join(cache, "nested", "b.tmp"), "12");

    const preparedInput = buildFilesystemCleanupApprovalInput({
      projectRoot,
      targets: [cache],
      subject,
    });
    assert.equal(preparedInput.request.snapshot["file_count"], 2);
    assert.equal(preparedInput.request.snapshot["total_size"], 6);
    assert.deepEqual(preparedInput.request.snapshot["file_types"], {
      ".log": 1,
      ".tmp": 1,
    });
    assert.equal(preparedInput.request.snapshot["recommended_mode"], "quarantine");
    assert.equal(preparedInput.request.snapshot["retention_days"], 14);
    assert.deepEqual(preparedInput.request.snapshot["protected_exclusions"], []);
    assert.equal(typeof preparedInput.request.snapshot["earliest_modified_at"], "string");
    assert.equal(typeof preparedInput.request.snapshot["latest_modified_at"], "string");
    const service = new OperationApprovalService({
      projectRoot,
      idFactory: () => "APPROVAL-CLEANUP-1",
    });
    const prepared = service.prepare(preparedInput);
    if (prepared.decision !== "REQUIRE_APPROVAL") assert.fail("approval expected");
    const approved = service.approve(
      prepared.approval.approval_id,
      "ADMIN",
      "move the exact cache manifest to quarantine",
    );
    const current = buildFilesystemCleanupApprovalInput({
      projectRoot,
      targets: [cache],
      subject,
    });
    const completed = await service.execute(
      prepared.approval.approval_id,
      approved.execution_token,
      current.request,
      executeFilesystemCleanupApproval,
    );
    assert.equal(completed.status, "succeeded");
    assert.equal(existsSync(cache), false);
    assert.equal(
      existsSync(
        join(
          projectRoot,
          ".codeflowmu",
          "quarantine",
          "APPROVAL-CLEANUP-1",
          "build-cache",
          "a.log",
        ),
      ),
      true,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cleanup refuses unbounded targets while Git-tracked content enters approval", () => {
  const projectRoot = root();
  try {
    const tracked = join(projectRoot, "tracked.txt");
    writeFileSync(tracked, "keep");
    execFileSync("git", ["add", "tracked.txt"], { cwd: projectRoot });
    execFileSync("git", ["commit", "-m", "tracked"], { cwd: projectRoot, stdio: "ignore" });

    for (const targets of [[projectRoot], ["build-*"]]) {
      assert.throws(
        () => inspectFilesystemCleanup({ projectRoot, targets }),
        (error: unknown) => error instanceof FilesystemCleanupPreflightError,
      );
    }
    const trackedPreflight = inspectFilesystemCleanup({
      projectRoot,
      targets: [tracked],
    });
    assert.deepEqual(trackedPreflight.protected_exclusions, ["tracked.txt"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cleanup risk allows one task-created temporary file and treats absence as idempotent", () => {
  const projectRoot = root();
  try {
    const taskDir = join(projectRoot, "workspace", "core-refactor-plan");
    mkdirSync(taskDir, { recursive: true });
    const target = join(taskDir, "_qa_wp00_spotcheck.py");
    writeFileSync(target, "print('spotcheck')\n");

    const allowed = assessFilesystemCleanupRisk({
      projectRoot,
      targets: [target],
    });
    assert.equal(allowed.decision, "ALLOW");
    assert.equal(allowed.reason, "task_temporary_untracked_file");

    rmSync(target);
    const absent = assessFilesystemCleanupRisk({
      projectRoot,
      targets: [target],
    });
    assert.equal(absent.decision, "ALREADY_ABSENT");
    assert.equal(absent.changed, false);
    assert.equal(absent.reason, "already_absent");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
