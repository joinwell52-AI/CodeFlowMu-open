import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileAcceptanceContract,
  evaluateAcceptanceContract,
} from "../AcceptanceContract.ts";
import type { EvidenceSummary } from "../ReviewEvidenceResolver.ts";

function evidence(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    task_id: "TASK-20260805-001",
    report_id: "REPORT-20260805-001-QA-to-PM",
    session: { found: true, session_id: "session-1", run_id: "run-1" },
    files: { read: [], changed: [] },
    commands: [],
    report: { found: true },
    data_queries: [],
    browser_actions: [],
    warnings: [],
    ...overrides,
  };
}

test("non-UI command contract passes without invented browser evidence", async () => {
  const contract = compileAcceptanceContract({
    taskId: "TASK-20260805-001",
    taskBody: "# Contract change",
    taskFrontmatter: {
      acceptance_items: [{
        item_id: "typecheck",
        claim: "TypeScript contract closes",
        required_evidence_types: ["command"],
        validator_id: "command-exit-zero",
        validator_version: "1",
        requires_browser: false,
        source_path_or_command: "npm run typecheck",
      }],
    },
  });
  const result = await evaluateAcceptanceContract({
    projectRoot: process.cwd(),
    contract,
    evidence: evidence({
      commands: [{ command: "npm run typecheck", exit_code: 0 }],
    }),
    reportId: "REPORT-20260805-001-QA-to-PM",
    sessionId: "session-1",
    runId: "run-1",
  });
  assert.equal(result.state, "pass");
  assert.equal(result.envelopes.some((row) => row.evidence_type === "browser"), false);
});

test("browser evidence is required only when the formal item says so", async () => {
  const contract = compileAcceptanceContract({
    taskId: "TASK-20260805-001",
    taskBody: "# UI acceptance",
    taskFrontmatter: {
      acceptance_items: [{
        item_id: "ui-flow",
        claim: "The browser flow works",
        required_evidence_types: ["browser"],
        validator_id: "browser-action",
        requires_browser: true,
      }],
    },
  });
  const result = await evaluateAcceptanceContract({
    projectRoot: process.cwd(),
    contract,
    evidence: evidence(),
    reportId: "REPORT-20260805-001-QA-to-PM",
    sessionId: "session-1",
  });
  assert.equal(result.state, "deterministic_fail");
  assert.deepEqual(result.failed_item_ids, ["ui-flow"]);
});

test("explicit run binding deterministically rejects evidence from another run", async () => {
  const contract = compileAcceptanceContract({
    taskId: "TASK-20260805-001",
    taskBody: "# Run-bound acceptance",
    taskFrontmatter: {
      acceptance_items: [{
        item_id: "run-command",
        claim: "The bound run passed typecheck",
        required_evidence_types: ["command"],
        validator_id: "command-exit-zero",
        source_path_or_command: "npm run typecheck",
      }],
    },
  });
  const result = await evaluateAcceptanceContract({
    projectRoot: process.cwd(),
    contract,
    evidence: evidence({
      session: { found: true, session_id: "session-1", run_id: "run-other" },
      commands: [{ command: "npm run typecheck", exit_code: 0 }],
    }),
    reportId: "REPORT-20260805-001-QA-to-PM",
    sessionId: "session-1",
    runId: "run-required",
  });
  assert.equal(result.state, "deterministic_fail");
  assert.deepEqual(result.failed_item_ids, ["run-command"]);
});

test("unstructured acceptance text is routed to PM instead of creating requirements", () => {
  const contract = compileAcceptanceContract({
    taskId: "TASK-20260805-001",
    taskBody: "## 验收\n- 应当工作",
    taskFrontmatter: {},
  });
  assert.equal(contract.status, "needs_pm");
  assert.equal(contract.items.length, 0);
});

test("formal child writer can embed a machine-readable contract in the TASK body", () => {
  const contract = compileAcceptanceContract({
    taskId: "TASK-20260805-001",
    taskFrontmatter: {},
    taskBody: [
      "# Child task",
      "",
      "```acceptance-contract",
      JSON.stringify({
        contract_revision: 2,
        wp_id: "WP-03",
        items: [{
          item_id: "api-contract",
          claim: "API typecheck passes",
          required_evidence_types: ["command"],
          validator_id: "command-exit-zero",
        }],
      }),
      "```",
    ].join("\n"),
  });
  assert.equal(contract.status, "compiled");
  assert.equal(contract.wp_id, "WP-03");
  assert.equal(contract.contract_revision, 2);
});

test("JSON evidence validates real content, not the filename extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfm-contract-"));
  try {
    await mkdir(join(root, "evidence"), { recursive: true });
    await writeFile(join(root, "evidence", "result.json"), "not-json");
    const contract = compileAcceptanceContract({
      taskId: "TASK-20260805-001",
      taskBody: "# Data contract",
      taskFrontmatter: {
        acceptance_items: [{
          item_id: "json-result",
          claim: "Result JSON is valid",
          required_evidence_types: ["json"],
          validator_id: "json-parse",
          source_path_or_command: "evidence/result.json",
        }],
      },
    });
    const result = await evaluateAcceptanceContract({
      projectRoot: root,
      contract,
      evidence: evidence({ files: { read: [], changed: ["evidence/result.json"] } }),
      reportId: "REPORT-20260805-001-QA-to-PM",
      sessionId: "session-1",
    });
    assert.equal(result.state, "deterministic_fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
