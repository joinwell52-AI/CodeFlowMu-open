export type ProjectGraphNodeType =
  | "project"
  | "sprint"
  | "task"
  | "report"
  | "issue"
  | "review"
  | "approval"
  | "runtime_event"
  | "unlinked";

export type WorkflowStage =
  | "todo"
  | "doing"
  | "waiting_qa"
  | "waiting_admin"
  | "done";

export type ProjectGraphNode = {
  id: string;
  type: ProjectGraphNodeType;
  parent_id: string | null;
  project_id: string;
  label: string;
  task_id?: string;
  root_task_id?: string;
  sprint_id?: string;
  wp_id?: string;
  thread_key?: string;
  role?: string;
  priority?: string;
  lifecycle?: string;
  workflow_stage?: WorkflowStage;
  blocked?: boolean;
  status?: string;
  created_at?: string;
  updated_at?: string;
  anomaly?: string;
  source?: Record<string, unknown>;
};

export type ProjectGraphProjection = {
  schema_version: "1.0";
  project_id: string;
  generated_at: string;
  nodes: ProjectGraphNode[];
  edges: Array<{ from: string; to: string; relation: string }>;
  workflow_counts: Record<WorkflowStage, number>;
  anomaly_count: number;
};

export type ProjectGraphProjectionInput = {
  projectId: string;
  projectName?: string;
  tasks: Array<Record<string, unknown>>;
  reports?: Array<Record<string, unknown>>;
  issues?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  approvals?: Array<Record<string, unknown>>;
  runtimeEvents?: Array<Record<string, unknown>>;
  now?: string;
};

function text(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function bool(row: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => row[key] === true || String(row[key] ?? "").toLowerCase() === "true");
}

function taskId(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\.md$/i, "");
  return raw.match(/^TASK-\d{8}-\d{3,}/i)?.[0].toUpperCase() ?? raw.toUpperCase();
}

function rowTaskId(row: Record<string, unknown>): string {
  return taskId(row["task_id"] ?? row["filename"] ?? row["id"]);
}

function statusOf(row: Record<string, unknown>): string {
  return text(
    row,
    "workflow_stage",
    "display_status",
    "state",
    "status",
    "dispatch_state",
    "_state",
    "bucket",
    "scope",
  ).toLowerCase();
}

function linkedRows(
  rows: Array<Record<string, unknown>>,
  targetTaskId: string,
  rootTaskId: string,
): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const linked = taskId(
      row["task_id"] ?? row["target_task_id"] ?? row["subject_task_id"],
    );
    const root = taskId(row["root_task_id"]);
    return linked === targetTaskId || (!!rootTaskId && root === rootTaskId);
  });
}

function acceptedEvidence(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((row) => {
    const status = statusOf(row);
    const decision = text(row, "decision", "result", "review_status").toLowerCase();
    return (
      ["accepted", "approved", "passed", "done", "completed"].includes(status) ||
      ["accept", "accepted", "approve", "approved", "pass", "passed"].includes(decision) ||
      bool(row, "human_approved", "business_accepted", "qa_accepted")
    );
  });
}

function pendingEvidence(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((row) =>
    ["pending", "pending_approval", "waiting", "waiting_admin"].includes(statusOf(row)),
  );
}

export function computeWorkflowStage(input: {
  task: Record<string, unknown>;
  rootTaskId: string;
  reports: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  runtimeEvents: Array<Record<string, unknown>>;
}): WorkflowStage {
  const id = rowTaskId(input.task);
  const status = statusOf(input.task);
  const reports = linkedRows(input.reports, id, input.rootTaskId);
  const reviews = linkedRows(input.reviews, id, input.rootTaskId);
  const approvals = linkedRows(input.approvals, id, input.rootTaskId);
  const runtimeEvents = linkedRows(input.runtimeEvents, id, input.rootTaskId);
  const waitingAdmin =
    ["waiting_admin", "waiting_admin_decision", "needs_human"].includes(status) ||
    pendingEvidence(approvals) ||
    (!acceptedEvidence([input.task]) && reports.some((row) => {
      const reporter = text(row, "reporter", "sender", "role").toUpperCase();
      const recipient = text(row, "recipient", "to").toUpperCase();
      const reportKind = text(row, "report_kind").toLowerCase();
      return (
        reporter.startsWith("PM") &&
        (recipient === "ADMIN" || reportKind === "pm_to_admin_final") &&
        ["done", "completed", "finished"].includes(statusOf(row))
      );
    })) ||
    reviews.some((row) => {
      const reviewer = text(row, "reviewer", "approver", "recipient", "decision_owner").toUpperCase();
      return reviewer === "ADMIN" && pendingEvidence([row]);
    });
  if (waitingAdmin) return "waiting_admin";

  const devDone = reports.some((row) => {
    const reporter = text(row, "reporter", "sender", "role").toUpperCase();
    return reporter.startsWith("DEV") && ["done", "completed", "finished"].includes(statusOf(row));
  });
  const qaAccepted =
    acceptedEvidence(
      reports.filter((row) =>
        text(row, "reporter", "sender", "role").toUpperCase().startsWith("QA"),
      ),
    ) ||
    acceptedEvidence(
      reviews.filter((row) =>
        text(row, "reviewer", "approver", "role").toUpperCase().startsWith("QA"),
      ),
    );
  if (devDone && !qaAccepted) return "waiting_qa";

  const businessAccepted =
    bool(input.task, "business_completed", "business_accepted") ||
    (acceptedEvidence([input.task]) &&
      reports.some((row) =>
        ["done", "completed", "finished"].includes(statusOf(row)),
      )) ||
    (acceptedEvidence(reviews) &&
      reports.some((row) => ["done", "completed", "finished"].includes(statusOf(row))));
  if (businessAccepted) return "done";

  if (
    ["active", "doing", "dispatched", "running", "review"].includes(status) ||
    runtimeEvents.some((row) =>
      ["running", "started", "active"].includes(statusOf(row)),
    ) ||
    reports.length > 0
  ) {
    return "doing";
  }
  return "todo";
}

function leafNode(
  projectId: string,
  type: Exclude<ProjectGraphNodeType, "project" | "sprint" | "task" | "unlinked">,
  row: Record<string, unknown>,
  index: number,
  taskNodeId: string,
): ProjectGraphNode {
  const rawId = text(row, "approval_id", "review_id", "issue_id", "report_id", "id", "filename");
  return {
    id: `${type}:${rawId || index}`,
    type,
    parent_id: taskNodeId,
    project_id: projectId,
    label:
      text(row, "title", "subject", "summary", "filename", "approval_id") ||
      `${type} ${index + 1}`,
    task_id: taskId(row["task_id"] ?? row["target_task_id"]),
    root_task_id: taskId(row["root_task_id"]),
    role: text(row, "reporter", "sender", "reviewer", "requested_by"),
    status: statusOf(row),
    created_at: text(row, "created_at", "requested_at", "at"),
    updated_at: text(row, "updated_at", "decided_at", "at"),
    source: row,
  };
}

export function buildProjectGraphProjection(
  input: ProjectGraphProjectionInput,
): ProjectGraphProjection {
  const reports = input.reports ?? [];
  const issues = input.issues ?? [];
  const reviews = input.reviews ?? [];
  const approvals = input.approvals ?? [];
  const runtimeEvents = input.runtimeEvents ?? [];
  const projectNodeId = `project:${input.projectId}`;
  const unlinkedNodeId = `unlinked:${input.projectId}`;
  const taskMap = new Map<string, Record<string, unknown>>();
  for (const row of input.tasks) {
    const id = rowTaskId(row);
    if (id) taskMap.set(id, row);
  }

  const rootMemo = new Map<string, { root: string; anomaly?: string }>();
  const resolveRoot = (id: string): { root: string; anomaly?: string } => {
    const memo = rootMemo.get(id);
    if (memo) return memo;
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) {
        const result = { root: id, anomaly: "parent_cycle" };
        rootMemo.set(id, result);
        return result;
      }
      seen.add(current);
      const row = taskMap.get(current);
      if (!row) {
        const result = { root: id, anomaly: "task_missing" };
        rootMemo.set(id, result);
        return result;
      }
      const declaredRoot = taskId(row["root_task_id"]);
      if (declaredRoot && taskMap.has(declaredRoot)) {
        const result = { root: declaredRoot };
        rootMemo.set(id, result);
        return result;
      }
      const parent = taskId(row["parent"] ?? row["parent_task_id"]);
      if (!parent) {
        const result = { root: current };
        rootMemo.set(id, result);
        return result;
      }
      if (parent === current) {
        const result = { root: id, anomaly: "parent_self_reference" };
        rootMemo.set(id, result);
        return result;
      }
      if (!taskMap.has(parent)) {
        const result = { root: id, anomaly: `parent_missing:${parent}` };
        rootMemo.set(id, result);
        return result;
      }
      current = parent;
    }
  };

  const groups = new Map<string, { id: string; label: string }>();
  for (const [id, row] of taskMap) {
    const root = taskMap.get(resolveRoot(id).root) ?? row;
    const group = text(row, "sprint_id", "wp_id") || text(root, "sprint_id", "wp_id");
    if (group) groups.set(group, { id: `sprint:${group}`, label: group });
  }

  const nodes: ProjectGraphNode[] = [
    {
      id: projectNodeId,
      type: "project",
      parent_id: null,
      project_id: input.projectId,
      label: input.projectName ?? input.projectId,
    },
    ...[...groups.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((group) => ({
        id: group.id,
        type: "sprint" as const,
        parent_id: projectNodeId,
        project_id: input.projectId,
        label: group.label,
      })),
    {
      id: unlinkedNodeId,
      type: "unlinked",
      parent_id: projectNodeId,
      project_id: input.projectId,
      label: "未关联",
    },
  ];

  const taskNodes = new Map<string, ProjectGraphNode>();
  for (const [id, row] of taskMap) {
    const resolved = resolveRoot(id);
    const rootRow = taskMap.get(resolved.root) ?? row;
    const parent = taskId(row["parent"] ?? row["parent_task_id"]);
    const group = text(row, "sprint_id", "wp_id") || text(rootRow, "sprint_id", "wp_id");
    const anomaly = resolved.anomaly;
    const parentNodeId =
      anomaly || (parent && !taskMap.has(parent))
        ? unlinkedNodeId
        : parent
          ? `task:${parent}`
          : group
            ? `sprint:${group}`
            : projectNodeId;
    const node: ProjectGraphNode = {
      id: `task:${id}`,
      type: "task",
      parent_id: parentNodeId,
      project_id: input.projectId,
      label: text(row, "title", "subject", "filename") || id,
      task_id: id,
      root_task_id: resolved.root,
      sprint_id: text(row, "sprint_id") || undefined,
      wp_id: text(row, "wp_id") || undefined,
      thread_key: text(row, "thread_key") || undefined,
      role: text(row, "recipient", "assignee", "role") || undefined,
      priority: text(row, "priority") || undefined,
      lifecycle: text(row, "lifecycle", "scope", "bucket", "state") || undefined,
      workflow_stage: computeWorkflowStage({
        task: row,
        rootTaskId: resolved.root,
        reports,
        reviews,
        approvals,
        runtimeEvents,
      }),
      blocked:
        bool(row, "blocked") ||
        statusOf(row) === "blocked" ||
        (Array.isArray(row["blocked_by"]) && row["blocked_by"].length > 0),
      status: statusOf(row),
      created_at: text(row, "created_at"),
      updated_at: text(row, "updated_at", "last_transition_at"),
      ...(anomaly ? { anomaly } : {}),
      source: row,
    };
    taskNodes.set(id, node);
    nodes.push(node);
  }

  const leafSets: Array<{
    type: "report" | "issue" | "review" | "approval" | "runtime_event";
    rows: Array<Record<string, unknown>>;
  }> = [
    { type: "report", rows: reports },
    { type: "issue", rows: issues },
    { type: "review", rows: reviews },
    { type: "approval", rows: approvals },
    { type: "runtime_event", rows: runtimeEvents },
  ];
  for (const set of leafSets) {
    set.rows.forEach((row, index) => {
      const linked = taskId(row["task_id"] ?? row["target_task_id"] ?? row["subject_task_id"]);
      const parentNode = linked && taskNodes.has(linked) ? `task:${linked}` : unlinkedNodeId;
      const node = leafNode(input.projectId, set.type, row, index, parentNode);
      if (parentNode === unlinkedNodeId) node.anomaly = "formal_task_link_missing";
      nodes.push(node);
    });
  }

  const edges = nodes
    .filter((node) => node.parent_id)
    .map((node) => ({
      from: node.parent_id!,
      to: node.id,
      relation: node.type === "task" ? "contains_task" : "has_evidence",
    }));
  const workflowCounts: Record<WorkflowStage, number> = {
    todo: 0,
    doing: 0,
    waiting_qa: 0,
    waiting_admin: 0,
    done: 0,
  };
  for (const node of taskNodes.values()) {
    workflowCounts[node.workflow_stage ?? "todo"] += 1;
  }
  return {
    schema_version: "1.0",
    project_id: input.projectId,
    generated_at: input.now ?? new Date().toISOString(),
    nodes,
    edges,
    workflow_counts: workflowCounts,
    anomaly_count: nodes.filter((node) => node.anomaly).length,
  };
}
