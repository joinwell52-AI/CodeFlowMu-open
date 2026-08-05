import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

export const PROJECT_EXECUTION_CONTEXT_VERSION = 1 as const;

export interface ProjectExecutionContextInput {
  projectRoot: string;
  runtimeInstanceId?: string;
  hostRoot?: string;
  registryPath?: string;
  dataRoot?: string;
  requestId?: string;
}

export interface ProjectExecutionContext {
  readonly schema_version: typeof PROJECT_EXECUTION_CONTEXT_VERSION;
  readonly context_id: string;
  readonly context_digest: string;
  readonly project_root: string;
  readonly runtime_instance_id: string | null;
  readonly host_root: string | null;
  readonly registry_path: string | null;
  readonly data_root: string;
  readonly task_spec_admission_root: string;
  readonly task_submission_root: string;
  readonly lifecycle_root: string;
  readonly evidence_root: string;
}

function absolute(value: string | undefined, base: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return resolve(isAbsolute(text) ? text : join(base, text));
}

/**
 * Immutable request-scoped binding shared by task, proof, lifecycle and
 * evidence readers. Callers create it once at the request boundary and pass
 * it down; components must not independently rediscover a project root.
 */
export function createProjectExecutionContext(
  input: ProjectExecutionContextInput,
): ProjectExecutionContext {
  const projectRoot = resolve(input.projectRoot);
  const dataRoot = absolute(input.dataRoot, projectRoot) ?? join(projectRoot, ".codeflowmu");
  const identity = {
    project_root: projectRoot,
    runtime_instance_id: String(input.runtimeInstanceId ?? "").trim() || null,
    host_root: absolute(input.hostRoot, projectRoot),
    registry_path: absolute(input.registryPath, projectRoot),
    data_root: dataRoot,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return Object.freeze({
    schema_version: PROJECT_EXECUTION_CONTEXT_VERSION,
    context_id: String(input.requestId ?? "").trim() || randomUUID(),
    context_digest: `sha256:${digest}`,
    ...identity,
    task_spec_admission_root: join(projectRoot, ".codeflowmu", "task-spec-admission"),
    task_submission_root: join(projectRoot, ".codeflowmu", "task-submissions"),
    lifecycle_root: join(projectRoot, "fcop", "_lifecycle"),
    evidence_root: join(projectRoot, "fcop", "logs", "runtime"),
  });
}

export function assertProjectExecutionContext(
  context: ProjectExecutionContext,
  expectedProjectRoot: string,
): void {
  const expected = resolve(expectedProjectRoot);
  if (context.project_root.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `PROJECT_EXECUTION_CONTEXT_MISMATCH: context=${context.project_root}; expected=${expected}`,
    );
  }
}
