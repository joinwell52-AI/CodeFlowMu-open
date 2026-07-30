import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ParsedTask } from "../../scheduler/TaskParser.ts";
import {
  evaluateTaskSpecAdmission,
  persistTaskSpecAdmissionResult,
  taskSpecContentDigest,
  taskSpecAdmissionRecordPath,
  verifyTaskSpecAdmissionForDispatch,
} from "../TaskSpecAdmissionGate.ts";

function task(
  body: string,
  frontmatter: Record<string, unknown> = {},
): ParsedTask {
  const fm = {
    protocol: "fcop",
    task_id: "TASK-20260730-001",
    sender: "ADMIN",
    recipient: "PM",
    thread_key: "admission-test",
    ...frontmatter,
  };
  return {
    filepath: "TASK-20260730-001-ADMIN-to-PM.md",
    filename: "TASK-20260730-001-ADMIN-to-PM.md",
    frontmatter: fm,
    body,
    task_id: String(fm.task_id),
    sender: String(fm.sender),
    recipient: String(fm.recipient),
    thread_key: String(fm.thread_key),
  };
}

function findingIds(
  result: Awaited<ReturnType<typeof evaluateTaskSpecAdmission>>,
): string[] {
  return result.blocking_findings.map((finding) => finding.id);
}

test("accepts a consistent long-running PM task with decidable gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "architecture.md"), "# Architecture\n");
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task(
        `# Long-running cross-module implementation

Implement the cross-module refactor in several milestones.

## M0
- Input: approved task scope
- Evidence: Product Brief revision
- Approver: ADMIN
- Exit condition: Product Brief accepted

## M1
- Input: approved Product Brief
- Evidence: passing integration tests
- Approver: PM
- Exit condition: acceptance criteria pass
`,
        { required_paths: ["docs/architecture.md"] },
      ),
    });
    assert.equal(result.decision, "accepted");
    assert.equal(result.planning_level, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported formal tools and multiple authoritative planning artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task("生成8份正式规划文件，并交付一份正式 Product Brief。", {
        required_tools: ["pm.write_eight_formal_plans"],
        planning_artifacts: ["brief.md", "roadmap.md"],
      }),
    });
    assert.equal(result.decision, "rejected");
    assert.ok(findingIds(result).includes("TOOL_CAPABILITY_MISMATCH"));
    assert.ok(findingIds(result).includes("ARTIFACT_UNIQUENESS_CONFLICT"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects routing, thread, branch, port, and directory contradictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task(`
sender: DEV
recipient: QA
thread_key: another-thread
branch: release/a
branch: release/b
port: 18001
port: 18002
project_dir: D:/one
project_dir: D:/two
`),
    });
    assert.equal(result.decision, "rejected");
    assert.ok(
      result.blocking_findings.filter(
        (finding) => finding.id === "INTERNAL_INCONSISTENCY",
      ).length >= 5,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects permission, lifecycle, and local-candidate Git safety conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task(`
绕过权限并直接写入受控区域。
停止并等待 ADMIN 审批，同时继续派发下游子任务。
这是本地候选环境，但必须 git push、git tag 并发布正式版本。
`),
    });
    const ids = findingIds(result);
    assert.ok(ids.includes("PERMISSION_UNEXECUTABLE"));
    assert.ok(ids.includes("LIFECYCLE_CONFLICT"));
    assert.ok(ids.includes("GIT_SAFETY_VIOLATION"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects Level 0 for a long-running cross-module implementation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task("对跨模块架构重构做长期巡检，并完成实现和交付。", {
        planning_level: 0,
        override_by: "ADMIN",
        override_reason: "正文含巡检",
      }),
    });
    assert.equal(result.decision, "rejected");
    const finding = result.blocking_findings.find(
      (item) => item.id === "CLASSIFICATION_CONFLICT",
    );
    assert.equal(finding?.expected_level, 3);
    assert.equal(finding?.detected_level, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing environment references and non-decidable gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task(
        `# Feature implementation

## Gate M0
- Evidence: draft exists

读取文档 \`docs/also-missing.md\`。
`,
        {
          required_paths: ["docs/missing-spec.md"],
          gates: [
            {
              id: "M1",
              input: "M0 approved",
              evidence: "test report",
            },
          ],
        },
      ),
    });
    const ids = findingIds(result);
    assert.ok(ids.includes("ENVIRONMENT_REFERENCE_MISSING"));
    assert.ok(ids.includes("GATE_NOT_DECIDABLE"));
    const environment = result.blocking_findings.find(
      (finding) => finding.id === "ENVIRONMENT_REFERENCE_MISSING",
    );
    assert.deepEqual(environment?.missing?.sort(), [
      "docs/also-missing.md",
      "docs/missing-spec.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects project role, port, and root mismatches against the active team model", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    await writeFile(
      join(root, "codeflowmu.team.json"),
      JSON.stringify({
        panel_port: 18766,
        members: [{ role: "DEV" }, { role: "QA" }],
      }),
    );
    const result = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task("# Task", {
        panel_port: 19999,
        project_root: "another-project",
      }),
    });
    assert.equal(result.decision, "rejected");
    const fields = result.blocking_findings
      .filter((finding) => finding.id === "INTERNAL_INCONSISTENCY")
      .map((finding) => finding.field);
    assert.ok(fields.includes("recipient"));
    assert.ok(fields.includes("panel_port"));
    assert.ok(fields.includes("project_root"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing, closed, self, cyclic, and mismatched-thread parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  const active = join(root, "fcop", "_lifecycle", "active");
  const done = join(root, "fcop", "_lifecycle", "done");
  try {
    await mkdir(active, { recursive: true });
    await mkdir(done, { recursive: true });
    await writeFile(
      join(done, "TASK-20260730-010-ADMIN-to-PM.md"),
      `---\ntask_id: TASK-20260730-010\nsender: ADMIN\nrecipient: PM\nthread_key: parent-thread\nstate: done\n---\n# Closed\n`,
    );
    await writeFile(
      join(active, "TASK-20260730-011-PM-to-DEV.md"),
      `---\ntask_id: TASK-20260730-011\nsender: PM\nrecipient: DEV\nparent: TASK-20260730-012\nthread_key: parent-thread\nstate: active\n---\n# A\n`,
    );
    await writeFile(
      join(active, "TASK-20260730-012-PM-to-QA.md"),
      `---\ntask_id: TASK-20260730-012\nsender: PM\nrecipient: QA\nparent: TASK-20260730-011\nthread_key: parent-thread\nstate: active\n---\n# B\n`,
    );

    for (const [parent, expectedMessage] of [
      ["TASK-20260730-999", "does not exist"],
      ["TASK-20260730-001", "own parent"],
      ["TASK-20260730-010", "closed"],
      ["TASK-20260730-011", "cycle"],
    ] as const) {
      const result = await evaluateTaskSpecAdmission({
        projectRoot: root,
        task: task("# Child", { parent }),
      });
      assert.equal(result.decision, "rejected");
      assert.ok(
        result.blocking_findings.some(
          (finding) =>
            finding.id === "PARENT_INVALID" &&
            finding.message.includes(expectedMessage),
        ),
        `${parent} should be rejected as ${expectedMessage}`,
      );
    }

    const openParent = join(active, "TASK-20260730-020-ADMIN-to-PM.md");
    await writeFile(
      openParent,
      `---\ntask_id: TASK-20260730-020\nsender: ADMIN\nrecipient: PM\nthread_key: parent-thread\nstate: active\n---\n# Open\n`,
    );
    const mismatch = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task("# Child", { parent: "TASK-20260730-020" }),
    });
    assert.ok(findingIds(mismatch).includes("INTERNAL_INCONSISTENCY"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists structured results idempotently by authored-content digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const first = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: task("绕过权限。"),
    });
    const persisted1 = await persistTaskSpecAdmissionResult(root, first);
    const persisted2 = await persistTaskSpecAdmissionResult(root, first);
    assert.equal(persisted1.changed, true);
    assert.equal(persisted2.changed, false);
    assert.equal(
      persisted1.path,
      taskSpecAdmissionRecordPath(root, "TASK-20260730-001"),
    );
    const stored = JSON.parse(await readFile(persisted1.path, "utf8"));
    assert.equal(stored.decision, "rejected");
    assert.equal(stored.code, "TASK_SPEC_INVALID");
    assert.ok(Array.isArray(stored.blocking_findings));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch rejects a new formal task when its accepted submission proof is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const formal = task("Implement a small feature.", {
      submission_id: "SUBMISSION-20260730-001",
      admission_revision: 1,
    });
    formal.frontmatter["admission_digest"] = taskSpecContentDigest(formal);
    const result = await verifyTaskSpecAdmissionForDispatch({
      projectRoot: root,
      task: formal,
    });
    assert.equal(result.decision, "rejected");
    assert.equal(result.blocking_findings[0]?.id, "ADMISSION_PROOF_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch stays fail-closed while the submission transaction is formalizing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const submissionId = "SUBMISSION-20260730-002";
    const formal = task("Implement a small feature.", {
      submission_id: submissionId,
      admission_revision: 1,
    });
    const accepted = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: formal,
    });
    assert.equal(accepted.decision, "accepted");
    formal.frontmatter["admission_digest"] = accepted.content_digest;
    await persistTaskSpecAdmissionResult(root, accepted, {
      submission_id: submissionId,
      formal_task_id: "TASK-20260730-001",
      admission_revision: 1,
    });
    await mkdir(join(root, ".codeflowmu", "task-submissions"), {
      recursive: true,
    });
    await writeFile(
      join(
        root,
        ".codeflowmu",
        "task-submissions",
        `${submissionId}.json`,
      ),
      JSON.stringify({
        submission_id: submissionId,
        status: "formalizing",
        formal_task_id: null,
        admission_revision: 1,
        content_digest: accepted.content_digest,
      }),
    );

    const result = await verifyTaskSpecAdmissionForDispatch({
      projectRoot: root,
      task: formal,
    });
    assert.equal(result.decision, "rejected");
    assert.equal(result.blocking_findings[0]?.id, "ADMISSION_PROOF_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch accepts only a completed submission transaction with matching digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const submissionId = "SUBMISSION-20260730-003";
    const formal = task("Implement a small feature.", {
      submission_id: submissionId,
      admission_revision: 2,
    });
    const accepted = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: formal,
    });
    assert.equal(accepted.decision, "accepted");
    formal.frontmatter["admission_digest"] = accepted.content_digest;
    await persistTaskSpecAdmissionResult(root, accepted, {
      submission_id: submissionId,
      formal_task_id: "TASK-20260730-001",
      admission_revision: 2,
    });
    await mkdir(join(root, ".codeflowmu", "task-submissions"), {
      recursive: true,
    });
    await writeFile(
      join(
        root,
        ".codeflowmu",
        "task-submissions",
        `${submissionId}.json`,
      ),
      JSON.stringify({
        submission_id: submissionId,
        status: "created",
        formal_task_id: "TASK-20260730-001",
        admission_revision: 2,
        content_digest: accepted.content_digest,
      }),
    );

    const result = await verifyTaskSpecAdmissionForDispatch({
      projectRoot: root,
      task: formal,
    });
    assert.equal(result.decision, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch rejects content changed after an accepted submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-task-admission-"));
  try {
    const submissionId = "SUBMISSION-20260730-004";
    const formal = task("Implement a small feature.", {
      submission_id: submissionId,
      admission_revision: 1,
    });
    const accepted = await evaluateTaskSpecAdmission({
      projectRoot: root,
      task: formal,
    });
    assert.equal(accepted.decision, "accepted");
    formal.frontmatter["admission_digest"] = accepted.content_digest;
    await persistTaskSpecAdmissionResult(root, accepted, {
      submission_id: submissionId,
      formal_task_id: "TASK-20260730-001",
      admission_revision: 1,
    });
    await mkdir(join(root, ".codeflowmu", "task-submissions"), {
      recursive: true,
    });
    await writeFile(
      join(
        root,
        ".codeflowmu",
        "task-submissions",
        `${submissionId}.json`,
      ),
      JSON.stringify({
        submission_id: submissionId,
        status: "created",
        formal_task_id: "TASK-20260730-001",
        admission_revision: 1,
        content_digest: accepted.content_digest,
      }),
    );
    formal.body = "Implement a different feature.";

    const result = await verifyTaskSpecAdmissionForDispatch({
      projectRoot: root,
      task: formal,
    });
    assert.equal(result.decision, "rejected");
    assert.ok(
      result.blocking_findings.some(
        (finding) => finding.id === "ADMISSION_PROOF_MISSING",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
