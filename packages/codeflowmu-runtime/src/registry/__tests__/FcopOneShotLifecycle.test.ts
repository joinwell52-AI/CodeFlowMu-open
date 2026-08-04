import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const script = resolve("scripts", "fcop_invoke_once.py");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(stage = "active") {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-fcop-one-shot-"));
  roots.push(root);
  const lifecycle = join(root, "fcop", "_lifecycle", stage);
  await mkdir(lifecycle, { recursive: true });
  await mkdir(join(root, "fcop", "reports"), { recursive: true });
  await mkdir(join(root, "fcop", "ledger"), { recursive: true });
  const taskId = "TASK-20260730-101";
  const taskPath = join(lifecycle, `${taskId}-PM-to-DEV.md`);
  await writeFile(
    taskPath,
    `---
task_id: ${taskId}
sender: PM
recipient: DEV
thread_key: runtime-eval-fix
state: ${stage}
---
# Task
`,
    "utf-8",
  );
  return { root, taskId, taskPath };
}

async function invoke(
  root: string,
  tool: string,
  args: Record<string, unknown>,
) {
  try {
    const result = await execFileAsync(
      process.env.FCOP_PYTHON_BIN || "python",
      [script, root, JSON.stringify({ tool, arguments: args })],
      { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: Number(failure.code ?? 1),
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function reportFiles(root: string) {
  return readdir(join(root, "fcop", "reports"));
}

describe("fcop one-shot lifecycle resolver", () => {
  it("reads an active task through the shared five-bucket resolver", async () => {
    const { root, taskId } = await fixture("active");
    const result = await invoke(root, "read_task", { task_id: taskId });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /# Task/);
  });

  it("rejects missing, archived, participant and thread mismatches with zero writes", async () => {
    const active = await fixture("active");
    const cases = [
      {
        task_id: "TASK-20260730-999",
        reporter: "DEV",
        recipient: "PM",
        thread_key: "runtime-eval-fix",
        code: "TASK_NOT_FOUND",
      },
      {
        task_id: active.taskId,
        reporter: "QA",
        recipient: "PM",
        thread_key: "runtime-eval-fix",
        code: "REPORTER_MISMATCH",
      },
      {
        task_id: active.taskId,
        reporter: "DEV",
        recipient: "ADMIN",
        thread_key: "runtime-eval-fix",
        code: "REPORT_RECIPIENT_MISMATCH",
      },
      {
        task_id: active.taskId,
        reporter: "DEV",
        recipient: "PM",
        thread_key: "wrong-thread",
        code: "THREAD_KEY_MISMATCH",
      },
    ];
    for (const testCase of cases) {
      const result = await invoke(active.root, "write_report", {
        ...testCase,
        status: "done",
        body: "# Result",
      });
      assert.notEqual(result.code, 0);
      const envelope = JSON.parse(result.stderr.trim()) as {
        isError: boolean;
        error: { code: string };
        file_created: boolean;
        ledger_appended: boolean;
      };
      assert.equal(envelope.isError, true);
      assert.equal(envelope.error.code, testCase.code);
      assert.equal(envelope.file_created, false);
      assert.equal(envelope.ledger_appended, false);
      assert.deepEqual(await reportFiles(active.root), []);
      assert.equal(
        await readFile(join(active.root, "fcop", "ledger", "reports.jsonl"), "utf-8")
          .catch(() => ""),
        "",
      );
    }

    const archived = await fixture("archive");
    const result = await invoke(archived.root, "write_report", {
      task_id: archived.taskId,
      reporter: "DEV",
      recipient: "PM",
      thread_key: "runtime-eval-fix",
      status: "done",
      body: "# Result",
    });
    assert.notEqual(result.code, 0);
    assert.equal(
      (JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code,
      "TASK_ARCHIVED",
    );
    assert.deepEqual(await reportFiles(archived.root), []);
  });

  it("writes one validated report for an active task", async () => {
    const active = await fixture("active");
    const result = await invoke(active.root, "write_report", {
      task_id: active.taskId,
      reporter: "DEV",
      recipient: "PM",
      thread_key: "runtime-eval-fix",
      status: "done",
      body: "# Verified result",
    });
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout.trim()) as {
      status: string;
      isError: boolean;
      writer: string;
      path: string;
    };
    assert.equal(payload.status, "success");
    assert.equal(payload.isError, false);
    assert.equal(payload.writer, "validated_lifecycle_writer");
    const files = await reportFiles(active.root);
    assert.equal(files.length, 1);
    assert.match(await readFile(payload.path, "utf-8"), /# Verified result/);
  });

  it("rejects an empty report body without creating a file", async () => {
    const active = await fixture("active");
    const result = await invoke(active.root, "write_report", {
      task_id: active.taskId,
      reporter: "DEV",
      recipient: "PM",
      thread_key: "runtime-eval-fix",
      status: "done",
      body: "   \n",
    });
    assert.notEqual(result.code, 0);
    const envelope = JSON.parse(result.stderr.trim()) as { error: { code: string } };
    assert.equal(envelope.error.code, "REPORT_BODY_REQUIRED");
    assert.deepEqual(await reportFiles(active.root), []);
  });

  it("rejects a forged Runtime-bound session before report creation", async () => {
    const active = await fixture("active");
    const result = await invoke(active.root, "write_report", {
      task_id: active.taskId,
      reporter: "DEV",
      recipient: "PM",
      thread_key: "runtime-eval-fix",
      status: "done",
      body: "# Real body with forged context",
      runtime_bound: true,
      session_id: "missing-runtime-session",
      agent_id: "DEV-01",
      caller_role: "DEV-01",
    });
    assert.notEqual(result.code, 0);
    const envelope = JSON.parse(result.stderr.trim()) as { error: { code: string } };
    assert.equal(envelope.error.code, "REPORT_SESSION_NOT_FOUND");
    assert.deepEqual(await reportFiles(active.root), []);
  });
});
